// Within budget: run one heavy job on this node as a resource-bounded unit.
//
// The node is part of the engineering problem: an 8 to 12 GB WSL machine shared by
// many agents fails by memory exhaustion, not by CPU, and every job's peaks stack
// because nothing allocates memory between them. A job here declares its memory
// budget and is
//   1. admitted only when the node's live telemetry (memory available, memory and
//      I/O stall pressure) leaves room for it beyond a fixed reserve, after
//      subtracting the budgets of jobs already admitted (a host-wide reservation
//      ledger, so two jobs never spend the same free memory);
//   2. contained in its own cgroup with that budget as a hard ceiling, no swap, and
//      low CPU and I/O weight, so exceeding it kills the job alone and never pushes
//      the node into thrashing;
//   3. measured: wall time, CPU time, peak memory and how it ended, so budgets are
//      set from what jobs cost rather than guessed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MB = 1024 * 1024;

export function parseSize(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([KMG]?)i?B?$/i.exec(String(text).trim());
  if (!m) throw new TypeError(`size must be like 1500M or 2G, got ${text}`);
  return Math.round(Number(m[1]) * { '': 1 / MB, K: 1 / 1024, M: 1, G: 1024 }[m[2].toUpperCase()] * 10) / 10;
}

// Live telemetry: memory available, and the share of the last 10 s in which every
// task was stalled on memory or on I/O (Linux pressure stall information).
export function readTelemetry(read = file => fs.readFileSync(file, 'utf8')) {
  const meminfo = read('/proc/meminfo');
  const kb = key => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] ?? 0);
  const full = file => Number(/^full avg10=([\d.]+)/m.exec(read(file))?.[1] ?? 0);
  return { availableMb: Math.floor(kb('MemAvailable') / 1024), memoryFullPct: full('/proc/pressure/memory'), ioFullPct: full('/proc/pressure/io') };
}

// Memory is the safety rule: exhausting it takes the whole node down. I/O stall only slows
// jobs, and each job already runs at low I/O weight, so it is recorded, never a gate:
// gating on it starved jobs for as long as other work kept the disk busy.
export const FLIGHT_RULES = { reserveMb: 1024, maxMemoryFullPct: 5 };

// Why a job of `memoryMb` may not start now, or null when it may.
// Under memory stall a budgeted job is admitted only alone: it waits while another
// budgeted job runs, so peaks never stack, but it is never starved. A host that stalls
// routinely (Bare Cedar Fog sat at 5-12% on 2026-10-30) would otherwise admit nothing.
export function admission(telemetry, reservedMb, memoryMb, rules = FLIGHT_RULES) {
  if (telemetry.memoryFullPct > rules.maxMemoryFullPct && reservedMb > 0)
    return `memory stalled ${telemetry.memoryFullPct}% > ${rules.maxMemoryFullPct}% while ${reservedMb} MB of other budgeted work runs`;
  const room = telemetry.availableMb - rules.reserveMb - reservedMb;
  if (room < memoryMb) return `${room} MB free beyond the ${rules.reserveMb} MB reserve and ${reservedMb} MB reserved, job needs ${memoryMb} MB`;
  return null;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The reservation ledger: one file per admitted job, named by its pid, holding its
// budget. A reservation whose process is gone no longer counts.
export function reservations(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).map(f => {
    const pid = Number(f.slice(0, -5));
    if (!alive(pid)) { fs.rmSync(path.join(dir, f), { force: true }); return 0; }
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).memoryMb || 0; } catch { return 0; }
  }).reduce((a, b) => a + b, 0);
}

function withLedgerLock(dir, fn) {
  const lock = path.join(dir, '.lock');
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmdirSync(lock); } catch { /* raced */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); } finally { fs.rmdirSync(lock); }
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const defaultLedger = () => path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'within-budget');

// Run `command` with `args` in `cwd` once admitted. Returns the child's exit status
// and output, and a `budget` record of what was waited for and what was spent.
export function withinBudget({ command, args = [], cwd = process.cwd(), env = process.env, memoryMb, name = 'job',
  cpuWeight = 20, ioWeight = 20, waitMs = 30 * 60_000, pollMs = 5000, timeoutMs, rules = FLIGHT_RULES,
  ledger = defaultLedger(), telemetry = readTelemetry }) {
  const started = Date.now();
  let held = null, atStart = null, lastHeld = null;
  fs.mkdirSync(ledger, { recursive: true });
  for (;;) {
    const admitted = withLedgerLock(ledger, () => {
      atStart = telemetry();
      held = admission(atStart, reservations(ledger), memoryMb, rules);
      if (!held) fs.writeFileSync(path.join(ledger, `${process.pid}.json`), JSON.stringify({ name, memoryMb, cwd, at: new Date().toISOString() }));
      return !held;
    });
    if (admitted) break;
    lastHeld = held;
    if (Date.now() - started > waitMs) return { status: null, output: '', budget: { name, memoryMb, state: 'not-admitted', held, waitedMs: Date.now() - started } };
    sleep(pollMs);
  }
  const waitedMs = Date.now() - started;
  try {
    // No soft limit: with swap off a job above MemoryHigh is throttled for minutes
    // before it dies. Over budget, it ends at once.
    const props = [`MemoryMax=${memoryMb}M`, 'MemorySwapMax=0',
      `CPUWeight=${cpuWeight}`, `IOWeight=${ioWeight}`, ...(timeoutMs ? [`RuntimeMaxSec=${Math.ceil(timeoutMs / 1000)}`] : [])];
    const setenv = Object.entries(env).filter(([k, v]) => v !== undefined && !k.includes('=') && k !== '_').flatMap(([k, v]) => ['-E', `${k}=${v}`]);
    // systemd reads the unit's memory peak after its cgroup has emptied and reports a
    // few hundred kilobytes for any job that exited by itself. The job's own cgroup
    // still holds the true peak just before the unit ends, so a wrapper records it
    // there; only a job killed before the wrapper runs falls back to systemd's figure,
    // which it reads before teardown.
    const peakFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'within-budget-peak-')), 'peak');
    const wrapper = `"$@"; rc=$?; cat "/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)/memory.peak" > ${JSON.stringify(peakFile)} 2>/dev/null; exit $rc`;
    const r = spawnSync('systemd-run', ['--user', '--wait', '--pipe', '--collect', `--working-directory=${cwd}`,
      `--description=within-budget ${name}`, ...props.flatMap(p => ['-p', p]), ...setenv, '--', '/bin/sh', '-c', wrapper, 'sh', command, ...args],
    { encoding: 'utf8', maxBuffer: 256 * MB, stdio: ['ignore', 'pipe', 'pipe'] });
    const summary = {};
    const kept = [];
    for (const line of (r.stderr || '').split('\n')) {
      const m = /^(Running as unit|Finished with result|Main processes terminated with|Service runtime|CPU time consumed|Memory peak|Memory swap peak): (.*)$/.exec(line);
      if (m) summary[m[1]] = m[2]; else kept.push(line);
    }
    let measured = null;
    try { measured = Number(fs.readFileSync(peakFile, 'utf8').trim()) / MB; } catch { /* killed before the wrapper wrote it */ }
    fs.rmSync(path.dirname(peakFile), { recursive: true, force: true });
    const peakMb = measured !== null && Number.isFinite(measured) ? Math.round(measured * 10) / 10
      : summary['Memory peak'] ? parseSize(summary['Memory peak']) : null;
    // systemd names a kill by the unit's memory ceiling, whichever process in it was killed.
    const killed = /oom-kill/.test(summary['Finished with result'] || '') ||
      (/status=KILL/.test(summary['Main processes terminated with'] || '') && peakMb >= memoryMb * 0.95);
    return { status: r.status, output: `${r.stdout || ''}${kept.join('\n')}`,
      budget: { name, memoryMb, state: killed ? 'over-budget' : 'ran', waitedMs, atStart,
        heldFor: lastHeld, runtime: summary['Service runtime'] || null, cpu: summary['CPU time consumed'] || null,
        peakMb, ended: summary['Main processes terminated with'] || summary['Finished with result'] || null } };
  } finally {
    fs.rmSync(path.join(ledger, `${process.pid}.json`), { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const split = args.indexOf('--');
  if (split < 1 && !args.includes('--memory')) {
    console.error('usage: within-budget.mjs --memory SIZE [--name NAME] [--wait MINUTES] -- COMMAND [ARGS...]');
    process.exit(2);
  }
  const own = args.slice(0, split);
  const opt = (k, d) => { const i = own.indexOf(k); return i < 0 ? d : own[i + 1]; };
  const [command, ...rest] = args.slice(split + 1);
  const result = withinBudget({ command, args: rest, memoryMb: parseSize(opt('--memory')), name: opt('--name', path.basename(command)),
    waitMs: Number(opt('--wait', '30')) * 60_000 });
  process.stdout.write(result.output);
  console.error(JSON.stringify({ withinBudget: result.budget }));
  process.exit(result.status ?? 75);
}
