// Pause (Monitor) for a host section's PACE-S loop: read the section's own substrate
// and return readings. Nothing here decides, stores a status or acts; every read is
// a port, so the same probes run against fixtures and against the live host.
//
// A reading is { probe, subject, ...observed }. The probes cover the places work was
// found held, failed or stale on Bare Cedar Fog on 2026-10-30, each of which had
// been found only by someone digging: failed units, units reporting active while
// their own journal says held, units running different deployment generations,
// state paths that name no live section, and the host's memory and disk margins.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GENERATION = /\/gnu\/store\/[0-9a-z]{32}-[A-Za-z0-9._+-]*deployment[A-Za-z0-9._+-]*/g;

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });

export const liveHost = {
  services: () => run('systemctl', ['--user', 'list-units', '--type=service', '--all', '--plain', '--no-legend', '--no-pager'])
    .split('\n').filter(Boolean).map(l => { const [unit, load, active, sub] = l.trim().split(/\s+/); return { unit, load, active, sub }; }),
  show: (unit, props) => Object.fromEntries(run('systemctl', ['--user', 'show', unit, '--no-pager', `--property=${props.join(',')}`])
    .trimEnd().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])),
  lastJournal: unit => { try { return run('journalctl', ['--user', '-u', unit, '-n', '1', '-o', 'cat', '--no-pager']).trim(); } catch { return ''; } },
  readFile: file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } },
  exists: file => fs.existsSync(file),
  // Only the exit status is read: listing a tracked directory can exceed any output buffer.
  tracked: (repository, rel) => spawnSync('git', ['-C', repository, 'ls-files', '--error-unmatch', '--', rel], { stdio: 'ignore', timeout: 20000 }).status === 0,
  // Ignored by a .gitignore the repository tracks. A local .git/info/exclude or a global
  // ignore is not the repository declaring runtime state: on 2026-10-30 one hid a stray tree.
  ignored: (repository, rel) => {
    const r = spawnSync('git', ['-C', repository, 'check-ignore', '-v', '--', rel], { encoding: 'utf8', timeout: 20000 });
    const source = r.status === 0 ? r.stdout.split(':')[0] : '';
    return Boolean(source) && !source.startsWith('.git/') && !path.isAbsolute(source);
  },
  toplevel: dir => { try { return run('git', ['-C', dir, 'rev-parse', '--show-toplevel']).trim(); } catch { return null; } },
  now: () => Date.now(),
};

export function failedUnits(host) {
  return host.services().filter(s => s.active === 'failed').map(s => ({ probe: 'unit-failed', subject: s.unit }));
}

// A unit whose own latest journal record says it is holding, while systemd reports it
// active: the case where every quantity reports healthy and nothing moves.
export function heldWhileActive(host, { olderThanMs = 60 * 60 * 1000 } = {}) {
  const out = [];
  for (const s of host.services().filter(x => x.active === 'active')) {
    const line = host.lastJournal(s.unit);
    let record; try { record = JSON.parse(line); } catch { continue; }
    if (record?.state !== 'held') continue;
    const since = Date.parse(record.since ?? record.at ?? '');
    if (Number.isFinite(since) && host.now() - since >= olderThanMs)
      out.push({ probe: 'unit-held', subject: s.unit, since: new Date(since).toISOString(), reason: record.reason ?? null, record });
  }
  return out;
}

// Which deployment generation each unit runs from, read from its command, working
// directory and environment files.
export function generations(host) {
  const byUnit = {};
  for (const s of host.services().filter(x => x.load === 'loaded')) {
    const p = host.show(s.unit, ['ExecStart', 'WorkingDirectory', 'EnvironmentFiles']);
    const found = [...new Set(`${p.ExecStart} ${p.WorkingDirectory} ${p.EnvironmentFiles}`.match(GENERATION) ?? [])];
    if (found.length) byUnit[s.unit] = { generations: found.map(g => path.basename(g)), active: s.active };
  }
  return [{ probe: 'generations', subject: 'host', byUnit }];
}

// Absolute paths a unit is given (its environment, and its environment files) that
// lie under the colony but at no live section: some directory on the way down is
// neither tracked nor mounted by its parent repository. Such a path was written by
// an older build or a renamed section, and whatever writes there rebuilds a dead tree.
export function strayStatePaths(host, { colony }) {
  const out = [];
  const root = path.resolve(colony);
  for (const s of host.services().filter(x => x.load === 'loaded')) {
    const p = host.show(s.unit, ['Environment', 'EnvironmentFiles']);
    const texts = [p.Environment ?? ''];
    for (const m of (p.EnvironmentFiles ?? '').matchAll(/(\/[^\s(]+)/g)) texts.push(host.readFile(m[1]) ?? '');
    // Values may be JSON inside an environment value, so escape characters are not part of a path.
    const values = new Set((texts.join('\n').match(new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^\\s"':;\\\\,\\]}]+`, 'g')) ?? []).map(v => v.replace(/\\+$/, '')));
    for (const value of values) {
      const dead = deadSegment(host, root, value);
      if (dead) out.push({ probe: 'state-path-stray', subject: s.unit, path: value, deadAt: dead });
    }
  }
  return out;
}

// The first directory on the way from the colony down to `target` that its enclosing
// repository neither tracks nor mounts, or null when every step is live.
export function deadSegment(host, root, target) {
  const parts = path.relative(root, target).split(path.sep);
  let at = root;
  for (const part of parts) {
    const next = path.join(at, part);
    if (!host.exists(next)) return next;
    const repository = host.toplevel(at);
    if (repository && host.toplevel(next) === repository) {
      // Live: tracked by its repository, or runtime state the repository declares ignored.
      const rel = path.relative(repository, next);
      if (host.tracked(repository, rel)) { at = next; continue; }
      return host.ignored?.(repository, rel) ? null : next;
    }
    at = next;
  }
  return null;
}

export function memoryPressure(host) {
  const text = host.readFile('/proc/pressure/memory') ?? '';
  const full = /^full avg10=([\d.]+) avg60=([\d.]+) avg300=([\d.]+)/m.exec(text);
  const meminfo = host.readFile('/proc/meminfo') ?? '';
  const kb = key => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] ?? 0);
  return [{ probe: 'memory', subject: 'host', fullAvg10: Number(full?.[1] ?? 0), fullAvg300: Number(full?.[3] ?? 0),
    availableMb: Math.floor(kb('MemAvailable') / 1024), swapFreeMb: Math.floor(kb('SwapFree') / 1024) }];
}

// Free physical capacity against the host's declared floor, read through the host's
// own capacity port (on WSL the guest's free blocks are not Windows capacity).
export function diskCapacity(host, { capacity }) {
  if (!capacity) return [];
  const c = capacity();
  return [{ probe: 'disk', subject: 'host', availableBytes: c.availableBytes, floorBytes: c.floorBytes }];
}

export function pause(host, { colony, capacity } = {}) {
  return [...failedUnits(host), ...heldWhileActive(host), ...generations(host), ...strayStatePaths(host, { colony }),
    ...memoryPressure(host), ...diskCapacity(host, { capacity })];
}
