// Lander (specifications/landing-requirements.md LD-2 to LD-6, LD-8, LD-11). Lands a
// change set, named as commits on refs in any git remote, through the section tree.
// Each touched section gets a merge commit of its proposal onto its target branch,
// each ancestor's gitlink advances to it, every touched section's test contract runs
// on exactly that composition, and only then are the targets pushed, deepest first.
// On a conflict or a failing test nothing is pushed. The lander never touches a
// working tree: candidates are built from git objects and tested in disposable
// worktrees, so agents keep using their checkouts while it runs.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSize, withinBudget } from './within-budget.mjs';

const git = (cwd, args, env) => execFileSync('git', args,
  { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, args, env) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  return { ok: r.status === 0, status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const tail = (text, lines = 60) => text.split('\n').slice(-lines).join('\n');

export function landerIdentity(host = os.hostname()) {
  const email = `lander@${host}.561.group`;
  return { GIT_AUTHOR_NAME: 'Lander', GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'Lander', GIT_COMMITTER_EMAIL: email };
}

// "path=remote:ref" -> { section, remote, ref }; the remote defaults to origin.
export function parseProposal(arg) {
  const m = /^([^=]+)=(?:([^:]+):)?(.+)$/.exec(arg);
  if (!m) throw new TypeError(`proposal must be section=remote:ref, got ${arg}`);
  return { section: m[1].replace(/\/+$/, ''), remote: m[2] || 'origin', ref: m[3] };
}

// The chain of repositories from a section up to the root, each with the path at
// which its parent mounts it. A section its parent does not mount as a gitlink is
// refused: an unmounted copy is a defect of the tree, not something to land around.
function chainOf(root, section) {
  const chain = [];
  let abs = path.resolve(root, section);
  const top = path.resolve(root);
  for (;;) {
    const repo = git(abs, ['rev-parse', '--show-toplevel']);
    if (path.resolve(repo) !== abs) throw new Error(`${path.relative(top, abs) || '.'} is not the top of a repository`);
    if (abs === top) { chain.push({ abs, parent: null, rel: null }); return chain; }
    const parent = path.resolve(git(path.dirname(abs), ['rev-parse', '--show-toplevel']));
    chain.push({ abs, parent, rel: path.relative(parent, abs) });
    abs = parent;
  }
}

function lock(gitDir, waitMs) {
  const file = path.join(gitDir, 'lander.lock');
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); return () => fs.rmSync(file, { force: true }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = Number(fs.readFileSync(file, 'utf8'));
      if (holder && !alive(holder)) { fs.rmSync(file, { force: true }); continue; }
      if (Date.now() > until) throw new Error(`${gitDir} is being landed by process ${holder}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// LD-8: the section's own test contract, read from its package.json. LD-11: when the
// candidate's lockfile equals the one installed in the section's checkout, the
// installed node_modules is linked rather than reinstalled.
//
// With a budget, each step runs through within-budget: admitted against the node's
// telemetry, contained to its memory, and measured. A step the node could not admit,
// or that its budget killed, is the environment's verdict, not the change's: the
// contract reports `environment` and the change is held, never refused for it.
function runContract(node, dir, { timeoutMs, budget }) {
  const manifest = path.join(dir, 'package.json');
  const pkg = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : null;
  if (!pkg?.scripts?.test) return { section: node.section, contract: 'none', ok: true };
  const lockName = ['package-lock.json', 'pnpm-lock.yaml'].find(f => fs.existsSync(path.join(dir, f)));
  const installed = path.join(node.abs, 'node_modules');
  const sameLock = lockName && fs.existsSync(installed) && fs.existsSync(path.join(node.abs, lockName)) &&
    fs.readFileSync(path.join(dir, lockName)).equals(fs.readFileSync(path.join(node.abs, lockName)));
  const steps = [];
  if (sameLock || (!lockName && fs.existsSync(installed))) fs.symlinkSync(installed, path.join(dir, 'node_modules'), 'dir');
  else if (lockName === 'package-lock.json') steps.push(['npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund']]);
  else if (lockName) steps.push(['pnpm', ['install', '--frozen-lockfile', '--prefer-offline']]);
  steps.push(['npm', ['test']]);
  // The contract runs as its own top-level process: a test runner's context inherited
  // from whatever runs the lander would make a nested runner report to it and exit 0.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const spent = [];
  for (const [cmd, args] of steps) {
    let status, output;
    if (budget) {
      const r = withinBudget({ command: cmd, args, cwd: dir, env: { ...env, CI: '1' }, memoryMb: budget.memoryMb,
        waitMs: budget.waitMs, telemetry: budget.telemetry, ledger: budget.ledger, rules: budget.rules, name: `${node.section} ${cmd} ${args[0]}`, timeoutMs });
      spent.push(r.budget);
      if (r.budget.state !== 'ran') return { section: node.section, contract: `${cmd} ${args.join(' ')}`, ok: false,
        environment: r.budget.state, budget: spent, log: tail(r.output) };
      ({ status, output } = r);
    } else {
      const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', timeout: timeoutMs, env: { ...env, CI: '1' } });
      status = r.status;
      output = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`;
    }
    if (status !== 0) return { section: node.section, contract: `${cmd} ${args.join(' ')}`, ok: false,
      failures: failingTests(output), log: tail(output), ...(budget && { budget: spent }) };
  }
  return { section: node.section, contract: 'npm test', ok: true, ...(budget && { budget: spent }) };
}

// Names of failing tests in node:test spec output (✖ name) and TAP (not ok N - name).
// Empty when the output names none, so an unnamed failure can never be excused.
export function failingTests(output) {
  const names = new Set();
  for (const line of output.split('\n')) {
    const m = /^\s*✖ (.+?)(?: \(\d[\d.]*m?s\))?$/.exec(line) || /^\s*not ok \d+ - (.+?)(?: # .*)?$/.exec(line);
    if (m && !/^failing tests:?$/.test(m[1])) names.add(m[1]);
  }
  return [...names].sort();
}

// A target that already fails its own contract would refuse every change forever.
// The candidate is judged against the target instead: it passes when every test
// failing on the candidate also fails, by name, on the target. The target's own
// failures are reported as that section's debt, not charged to the proposal.
//
// The target's result depends only on the target commit, so one run serves every
// proposal judged against it: `baselines` carries it across a drain.
function judgeAgainstTarget(node, candidate, scratch, worktrees, run) {
  if (candidate.ok || candidate.environment || !candidate.failures.length) return candidate;
  const key = `${path.resolve(node.abs, git(node.abs, ['rev-parse', '--git-common-dir']))} ${node.base}`;
  let base = run.baselines?.get(key);
  if (!base) {
    const dir = path.join(scratch, `wt-base-${worktrees.length}`);
    git(node.abs, ['worktree', 'add', '--quiet', '--detach', dir, node.base]);
    worktrees.push([node.abs, dir]);
    base = runContract(node, dir, run);
    if (base.environment) return { ...candidate, environment: base.environment, budget: base.budget };
    run.baselines?.set(key, base);
  }
  if (base.ok || !base.failures.length) return candidate;
  const known = new Set(base.failures);
  const introduced = candidate.failures.filter(name => !known.has(name));
  if (introduced.length) return { ...candidate, introduced };
  return { section: node.section, contract: candidate.contract, ok: true, targetFailures: base.failures,
    ...(candidate.budget && { budget: candidate.budget }) };
}

export function landChangeSet({ root, proposals, target = 'main', identity = landerIdentity(), dryRun = false,
  lockWaitMs = 10 * 60_000, testTimeoutMs = 30 * 60_000, budget, baselines }) {
  const run = { timeoutMs: testTimeoutMs, budget, baselines };
  const top = path.resolve(root);
  const nodes = new Map();
  for (const p of proposals) for (const link of chainOf(top, p.section)) {
    const node = nodes.get(link.abs) || { ...link, section: path.relative(top, link.abs) || '.', depth: path.relative(top, link.abs).split(path.sep).filter(Boolean).length, children: new Map() };
    nodes.set(link.abs, node);
    if (link.abs === path.resolve(top, p.section)) {
      if (node.proposal) throw new Error(`${node.section} is named twice in one change set`);
      node.proposal = p;
    }
  }
  const order = [...nodes.values()].sort((a, b) => b.depth - a.depth || a.abs.localeCompare(b.abs));
  const releases = [...order].sort((a, b) => a.abs.localeCompare(b.abs))
    .map(n => lock(path.resolve(n.abs, git(n.abs, ['rev-parse', '--git-common-dir'])), lockWaitMs));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lander-'));
  const worktrees = [];
  try {
    // Fetch each target, and each proposal, into refs only the lander writes.
    for (const n of order) {
      git(n.abs, ['fetch', '--quiet', 'origin', `+refs/heads/${target}:refs/lander/target`]);
      n.base = git(n.abs, ['rev-parse', 'refs/lander/target']);
      if (n.proposal) {
        git(n.abs, ['fetch', '--quiet', n.proposal.remote, `+${n.proposal.ref}:refs/lander/proposal`]);
        n.head = git(n.abs, ['rev-parse', 'refs/lander/proposal']);
      }
    }
    // Build candidates deepest first: the proposal merged onto the target, then the
    // gitlinks of every changed child set to that child's candidate.
    for (const n of order) {
      let tip = n.base;
      if (n.proposal && !tryGit(n.abs, ['merge-base', '--is-ancestor', n.head, n.base]).ok) {
        const merged = tryGit(n.abs, ['merge-tree', '--write-tree', '--name-only', '--no-messages', n.base, n.head]);
        if (!merged.ok) return { state: 'refused', reason: 'conflict', section: n.section,
          conflicts: merged.out.split('\n').slice(1).filter(Boolean) };
        tip = git(n.abs, ['commit-tree', merged.out.split('\n')[0], '-p', n.base, '-p', n.head,
          '-m', `Merge ${n.proposal.ref} from ${n.proposal.remote} into ${target}`], identity);
      }
      if (n.children.size) {
        const index = path.join(scratch, `index-${worktrees.length}-${n.depth}`);
        const env = { ...identity, GIT_INDEX_FILE: index };
        git(n.abs, ['read-tree', tip], env);
        for (const [rel, child] of n.children) {
          const entry = git(n.abs, ['ls-tree', tip, '--', rel]);
          if (!/^160000 commit [0-9a-f]+\t/.test(entry)) return { state: 'refused', reason: 'not-mounted',
            section: child.section, detail: `${n.section} does not mount ${rel} as a gitlink on ${target}` };
          const pinned = entry.split(/\s+/)[2];
          if (!tryGit(child.abs, ['merge-base', '--is-ancestor', pinned, child.candidate]).ok)
            return { state: 'refused', reason: 'pin-not-ancestor', section: child.section,
              detail: `${n.section} pins ${rel} at ${pinned}, which the landed ${child.candidate} does not contain` };
          git(n.abs, ['update-index', '--cacheinfo', `160000,${child.candidate},${rel}`], env);
        }
        tip = git(n.abs, ['commit-tree', git(n.abs, ['write-tree'], env), '-p', tip,
          '-m', `Land ${[...n.children.keys()].join(', ')}`], identity);
      }
      n.candidate = tip;
      if (n.parent) {
        const parent = nodes.get(n.parent);
        if (n.candidate !== n.base) parent.children.set(n.rel, n);
      }
    }
    // LD-4: test every proposed section on exactly the composition that would land.
    const results = [];
    for (const n of order.filter(o => o.proposal && o.candidate !== o.base)) {
      const dir = path.join(scratch, `wt-${worktrees.length}`);
      git(n.abs, ['worktree', 'add', '--quiet', '--detach', dir, n.candidate]);
      worktrees.push([n.abs, dir]);
      const result = judgeAgainstTarget(n, runContract(n, dir, run), scratch, worktrees, run);
      results.push(result);
      if (result.environment) return { state: 'held', reason: result.environment, section: n.section, command: result.contract,
        budget: result.budget, tested: results };
      if (!result.ok) return { state: 'refused', reason: 'test', section: n.section, command: result.contract,
        introduced: result.introduced || result.failures, log: result.log, tested: results };
    }
    const moves = order.filter(n => n.candidate !== n.base);
    if (dryRun || !moves.length) return { state: moves.length ? 'tested' : 'unchanged', tested: results,
      moves: moves.map(n => ({ section: n.section, from: n.base, to: n.candidate })) };
    // LD-5: push deepest first. A push is a fast-forward of the fetched target, so a
    // target that moved meanwhile refuses and the change set is landed again (LD-6).
    const landed = [];
    for (const n of moves) {
      const push = tryGit(n.abs, ['push', '--quiet', 'origin', `${n.candidate}:refs/heads/${target}`]);
      if (!push.ok) return { state: landed.length ? 'partial' : 'refused', reason: 'target-moved', section: n.section,
        detail: push.err, landed, tested: results };
      landed.push({ section: n.section, from: n.base, to: n.candidate });
    }
    return { state: 'landed', landed, tested: results };
  } finally {
    for (const [repo, dir] of worktrees) tryGit(repo, ['worktree', 'remove', '--force', dir]);
    for (const n of nodes.values()) for (const ref of ['refs/lander/target', 'refs/lander/proposal'])
      tryGit(n.abs, ['update-ref', '-d', ref]);
    fs.rmSync(scratch, { recursive: true, force: true });
    for (const release of releases) release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
  const flag = name => { const i = args.indexOf(name); return i >= 0 && args.splice(i, 1).length > 0; };
  const root = opt('--root') || process.cwd();
  const target = opt('--target') || 'main';
  const host = opt('--host');
  const dryRun = flag('--dry-run');
  const memory = opt('--memory');
  if (!args.length) {
    console.error('usage: land.mjs [--root DIR] [--target BRANCH] [--host NAME] [--memory SIZE] [--dry-run] SECTION=[REMOTE:]REF ...');
    process.exit(2);
  }
  const result = landChangeSet({ root, target, dryRun, budget: memory && { memoryMb: parseSize(memory) }, proposals: args.map(parseProposal), identity: landerIdentity(host) });
  console.log(JSON.stringify(result, null, 2));
  process.exit(['landed', 'tested', 'unchanged'].includes(result.state) ? 0 : 1);
}
