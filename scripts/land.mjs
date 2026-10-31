// Lander (specifications/landing-requirements.md LD-2 to LD-6, LD-8, LD-11, LD-13). Lands a
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
// An installer states its error first and then prints its usage (npm ci: a page of option help),
// so a long log keeps its first lines as well as its last.
const excerpt = (text, lines = 60, head = 15) => {
  const all = text.split('\n');
  return all.length <= lines ? text : [...all.slice(0, head), '...', ...all.slice(-(lines - head))].join('\n');
};

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

// Lake's standard test-contract declaration: top-level `testDriver = "..."` in
// lakefile.toml (before the first table header), `@[test_driver]` or `testDriver :=`
// in lakefile.lean. Comments are ignored.
export function declaresTestDriver(dir) {
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
  if (fs.existsSync(path.join(dir, 'lakefile.toml'))) {
    const top = read('lakefile.toml').split('\n').map(l => l.replace(/#.*$/, '')).join('\n').split(/^\s*\[/m)[0];
    if (/^\s*testDriver\s*=/m.test(top)) return true;
  }
  if (fs.existsSync(path.join(dir, 'lakefile.lean'))) {
    const lean = read('lakefile.lean').replace(/\/-[\s\S]*?-\//g, '').split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
    if (/@\[[^\]]*\btest_driver\b[^\]]*\]/.test(lean) || /\btestDriver\s*:=/.test(lean)) return true;
  }
  return false;
}

// elan's proxy, so the lean-toolchain pin is honored; lake on PATH when elan is absent.
const lakeBinary = () => {
  const proxy = path.join(process.env.ELAN_HOME || path.join(os.homedir(), '.elan'), 'bin', 'lake');
  return fs.existsSync(proxy) ? proxy : 'lake';
};

// LD-8: the section's own test contract, read from its package.json. LD-11: when the
// candidate's lockfile equals the one installed in the section's checkout, the
// installed node_modules is linked rather than reinstalled.
//
// LD-8 for Lake: a section with no package.json test script whose candidate tree has
// lakefile.toml or lakefile.lean at its root is a Lake package, and its contract is
// Lake's own: `lake build`, then `lake test` only when the lakefile declares a
// testDriver. Lake runs through elan so the repository's lean-toolchain pin is honored.
// LD-11: the checkout's .lake is copied (never linked: Lake rewrites outputs in place)
// into the candidate so Lake's trace hashes rebuild only the modules that changed.
// A section with neither contract lands on `contract: 'none'`, as before.
//
// With a budget, each step runs through within-budget: admitted against the node's
// telemetry, contained to its memory, and measured. A step the node could not admit,
// or that its budget killed, is the environment's verdict, not the change's: the
// contract reports `environment` and the change is held, never refused for it.
//
// With `dependencies` (another tree's directory), this tree's source runs on the
// node_modules installed there and installs nothing: the baseline fallback of
// judgeAgainstTarget, for a target that cannot be installed on its own.
function runContract(node, dir, { timeoutMs, budget, dependencies }) {
  const manifest = path.join(dir, 'package.json');
  const pkg = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : null;
  const lake = !pkg?.scripts?.test && ['lakefile.toml', 'lakefile.lean'].some(f => fs.existsSync(path.join(dir, f)));
  if (!pkg?.scripts?.test && !lake) return { section: node.section, contract: 'none', ok: true };
  const steps = [];
  let lockName, installed, sameLock;
  if (lake) {
    const cache = path.join(node.abs, '.lake');
    if (fs.existsSync(cache) && !fs.existsSync(path.join(dir, '.lake')))
      execFileSync('cp', ['-a', '--reflink=auto', cache, path.join(dir, '.lake')]);
    steps.push([lakeBinary(), ['build'], 'lake build']);
    if (declaresTestDriver(dir)) steps.push([lakeBinary(), ['test'], 'lake test']);
  } else {
    lockName = ['package-lock.json', 'pnpm-lock.yaml'].find(f => fs.existsSync(path.join(dir, f)));
    installed = path.join(node.abs, 'node_modules');
    sameLock = lockName && fs.existsSync(installed) && fs.existsSync(path.join(node.abs, lockName)) &&
      fs.readFileSync(path.join(dir, lockName)).equals(fs.readFileSync(path.join(node.abs, lockName)));
    if (dependencies) {
      const lent = path.join(dependencies, 'node_modules');
      if (fs.existsSync(lent)) fs.symlinkSync(fs.realpathSync(lent), path.join(dir, 'node_modules'), 'dir');
    } else if (sameLock || (!lockName && fs.existsSync(installed))) fs.symlinkSync(installed, path.join(dir, 'node_modules'), 'dir');
    else if (lockName === 'package-lock.json') steps.push(['npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund']]);
    else if (lockName) steps.push(['pnpm', ['install', '--frozen-lockfile', '--prefer-offline']]);
    steps.push(['npm', ['test']]);
  }
  // The contract runs as its own top-level process: a test runner's context inherited
  // from whatever runs the lander would make a nested runner report to it and exit 0.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const spent = [];
  for (const [cmd, args, label] of steps) {
    const shown = label || `${cmd} ${args.join(' ')}`;
    const ran = lake ? steps.slice(0, steps.findIndex(s => s[2] === label) + 1).map(s => s[2]).join('; ') : shown;
    let status, output;
    if (budget) {
      const r = withinBudget({ command: cmd, args, cwd: dir, env: { ...env, CI: '1' }, memoryMb: budget.memoryMb,
        waitMs: budget.waitMs, telemetry: budget.telemetry, ledger: budget.ledger, rules: budget.rules, name: `${node.section} ${label ? label : `${cmd} ${args[0]}`}`, timeoutMs });
      spent.push(r.budget);
      if (r.budget.state !== 'ran') return { section: node.section, contract: ran, ok: false,
        environment: r.budget.state, budget: spent, log: tail(r.output) };
      ({ status, output } = r);
    } else {
      const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', timeout: timeoutMs, env: { ...env, CI: '1' } });
      status = r.status;
      output = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`;
    }
    if (status !== 0) return { section: node.section, contract: ran, ok: false,
      failures: failingTests(output), log: !lake && args[0] !== 'test' ? excerpt(output) : tail(output), ...(budget && { budget: spent }) };
  }
  return { section: node.section, contract: lake ? steps.map(s => s[2]).join('; ') : 'npm test', ok: true, ...(budget && { budget: spent }) };
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
//
// A target that cannot produce a list of failures (its install is refused, or its test
// command does not run or names no test) is no baseline: judged against it, every
// failure of the candidate would count as introduced, and a change that repairs the
// target's install could never land. The target's source is then run again on the
// dependencies the candidate installed, which gives the failures the candidate's own
// code did not cause. That baseline depends on the candidate, so it is never shared.
// When that run cannot produce a list either, nothing can be judged: the target is
// untestable, and no failure is called introduced.
//
// The verdict says which baseline it used: `target`, or `target-on-candidate-dependencies`
// with `baselineReason`, the step that stopped the target alone and the tail of its log.
function judgeAgainstTarget(node, candidate, scratch, worktrees, run, candidateDir) {
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
  const judge = (failures, labels) => {
    const known = new Set(failures);
    const introduced = candidate.failures.filter(name => !known.has(name));
    if (introduced.length) return { ...candidate, introduced, ...labels };
    return { section: node.section, contract: candidate.contract, ok: true, targetFailures: failures, ...labels,
      ...(candidate.budget && { budget: candidate.budget }) };
  };
  if (base.ok) return judge([], { baseline: 'target' });
  if (base.failures.length) return judge(base.failures, { baseline: 'target' });
  const dir = path.join(scratch, `wt-deps-${worktrees.length}`);
  git(node.abs, ['worktree', 'add', '--quiet', '--detach', dir, node.base]);
  worktrees.push([node.abs, dir]);
  const fallback = runContract(node, dir, { ...run, dependencies: candidateDir });
  if (fallback.environment) return { ...candidate, environment: fallback.environment, budget: fallback.budget };
  const alone = { command: base.contract, log: base.log };
  if (!fallback.ok && !fallback.failures.length) return { ...candidate,
    untestable: { targetError: alone, fallbackError: { command: fallback.contract, log: fallback.log } } };
  return judge(fallback.failures || [], { baseline: 'target-on-candidate-dependencies', baselineReason: alone });
}

function landOnce({ root, proposals, target = 'main', identity = landerIdentity(), dryRun = false,
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
      const { untestable, ...result } = judgeAgainstTarget(n, runContract(n, dir, run), scratch, worktrees, run, dir);
      results.push(result);
      if (result.environment) return { state: 'held', reason: result.environment, section: n.section, command: result.contract,
        budget: result.budget, tested: results };
      if (untestable) return { state: 'refused', reason: 'target-untestable', section: n.section, command: result.contract,
        ...untestable, tested: results };
      if (!result.ok) return { state: 'refused', reason: 'test', section: n.section, command: result.contract,
        introduced: result.introduced || result.failures, ...(result.baseline && { baseline: result.baseline }),
        ...(result.baselineReason && { baselineReason: result.baselineReason }), log: result.log, tested: results };
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

// LD-6: a target that moved while a change set was being tested is not a verdict on the
// change. It is merged onto the new target and tested again, up to `retries` times; a
// partial landing is never retried, since part of it is already on its target.
export function landChangeSet(options) {
  const retries = options.retries ?? 3;
  let result;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    result = landOnce(options);
    if (result.reason !== 'target-moved' || result.landed?.length) return attempt > 1 ? { ...result, attempts: attempt } : result;
  }
  return { ...result, attempts: retries + 1 };
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
