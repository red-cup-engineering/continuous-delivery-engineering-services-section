import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { declaresTestDriver, landChangeSet, parseProposal } from '../scripts/land.mjs';

const author = { GIT_AUTHOR_NAME: 'Agent', GIT_AUTHOR_EMAIL: 'agent@test.561.group', GIT_COMMITTER_NAME: 'Agent', GIT_COMMITTER_EMAIL: 'agent@test.561.group' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'init.defaultBranch=main', ...a],
  { cwd, encoding: 'utf8', env: { ...process.env, ...author }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, file, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const identity = { GIT_AUTHOR_NAME: 'Lander', GIT_AUTHOR_EMAIL: 'lander@test.561.group', GIT_COMMITTER_NAME: 'Lander', GIT_COMMITTER_EMAIL: 'lander@test.561.group' };

// A colony root mounting one section at services/section, each behind a bare remote.
// The section's test contract passes while its `ok` file reads yes.
function forest(files) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'land-test-'));
  for (const name of ['section', 'root']) git(t, 'init', '--quiet', '--bare', `${name}.git`);
  const seed = path.join(t, 'seed');
  git(t, 'clone', '--quiet', path.join(t, 'section.git'), seed);
  if (files) for (const [file, text] of Object.entries(files)) write(seed, file, text);
  else {
    write(seed, 'package.json', JSON.stringify({ name: 'section', scripts: { test: 'node check.mjs' } }));
    write(seed, 'check.mjs', "import fs from 'node:fs'; process.exit(fs.readFileSync('ok', 'utf8').trim() === 'yes' ? 0 : 1);\n");
    write(seed, 'ok', 'yes\n');
  }
  write(seed, 'notes', 'one\n');
  git(seed, 'add', '.'); git(seed, 'commit', '--quiet', '-m', 'seed'); git(seed, 'push', '--quiet', 'origin', 'main');
  const root = path.join(t, 'colony');
  git(t, 'clone', '--quiet', path.join(t, 'root.git'), root);
  git(root, 'submodule', 'add', '--quiet', path.join(t, 'section.git'), 'services/section');
  git(root, 'commit', '--quiet', '-m', 'mount section'); git(root, 'push', '--quiet', 'origin', 'main');
  return { t, root, section: path.join(root, 'services/section') };
}
const remoteMain = (t, name) => git(t, '--git-dir', path.join(t, `${name}.git`), 'rev-parse', 'main');
const remoteGitlink = (t, rel) => git(t, '--git-dir', path.join(t, 'root.git'), 'ls-tree', 'main', '--', rel).split(/\s+/)[2];

function propose(section, branch, file, text, from = 'origin/main') {
  git(section, 'switch', '--quiet', '-c', branch, from);
  write(section, file, text);
  git(section, 'commit', '--quiet', '-am', `change ${file}`);
  git(section, 'push', '--quiet', 'origin', branch);
  return git(section, 'rev-parse', 'HEAD');
}

test('parses a proposal with and without a remote', () => {
  assert.deepEqual(parseProposal('services/a=origin:refs/pull/7/head'), { section: 'services/a', remote: 'origin', ref: 'refs/pull/7/head' });
  assert.deepEqual(parseProposal('services/a/=feature'), { section: 'services/a', remote: 'origin', ref: 'feature' });
});

test('lands a passing proposal as a merge commit and advances the root gitlink', () => {
  const { t, root, section } = forest();
  const head = propose(section, 'feature', 'notes', 'two\n');
  const result = landChangeSet({ root, identity, proposals: [parseProposal('services/section=feature')] });
  assert.equal(result.state, 'landed', JSON.stringify(result));
  const landed = remoteMain(t, 'section');
  assert.equal(git(section, 'rev-list', '--parents', '-n1', landed).split(' ').length, 3, 'a merge commit with two parents');
  assert.equal(git(section, 'log', '-1', '--format=%ce', landed), 'lander@test.561.group');
  assert.equal(git(section, 'log', '-1', '--format=%ae', head), 'agent@test.561.group', 'the proposal keeps its author');
  assert.equal(remoteGitlink(t, 'services/section'), landed);
  assert.deepEqual(result.tested.map(r => [r.section, r.contract, r.ok]), [['services/section', 'npm test', true]]);
});

test('a failing test contract advances nothing and names the section and command', () => {
  const { t, root, section } = forest();
  const before = [remoteMain(t, 'section'), remoteMain(t, 'root')];
  propose(section, 'broken', 'ok', 'no\n');
  const result = landChangeSet({ root, identity, proposals: [parseProposal('services/section=broken')] });
  assert.equal(result.state, 'refused');
  assert.equal(result.reason, 'test');
  assert.equal(result.section, 'services/section');
  assert.equal(result.command, 'npm test');
  assert.deepEqual([remoteMain(t, 'section'), remoteMain(t, 'root')], before);
});

test('a proposal that removes most of a section is refused unless a commit says it is meant', () => {
  const files = {
    'package.json': JSON.stringify({ name: 'section', scripts: { test: 'node check.mjs' } }),
    'check.mjs': "process.exit(0);\n",
    ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`data/d${i}`, `${i}\n`])),
  };
  const { t, root, section } = forest(files);
  const before = remoteMain(t, 'section');
  git(section, 'switch', '--quiet', '-c', 'empty', 'origin/main');
  git(section, 'rm', '--quiet', '-r', 'data');
  git(section, 'commit', '--quiet', '-m', 'drop data');
  git(section, 'push', '--quiet', 'origin', 'empty');
  const refused = landChangeSet({ root, identity, proposals: [parseProposal('services/section=empty')] });
  assert.equal(refused.state, 'refused', JSON.stringify(refused));
  assert.equal(refused.reason, 'mass-deletion');
  assert.equal(refused.removed, 12);
  assert.equal(remoteMain(t, 'section'), before, 'nothing is pushed');

  git(section, 'commit', '--quiet', '--allow-empty', '-m', 'Retire the data\n\nmass-deletion-intended: the data moved to its own repository');
  git(section, 'push', '--quiet', 'origin', 'empty');
  const landed = landChangeSet({ root, identity, proposals: [parseProposal('services/section=empty')] });
  assert.equal(landed.state, 'landed', JSON.stringify(landed));
});

test('a proposal that brings the first lockfile is judged against the target on its own dependencies', () => {
  // The target already fails `debt`; with no lockfile it has no declared dependencies, so it is run on
  // the candidate's, and the proposal, which fails nothing new, lands.
  const files = {
    'package.json': JSON.stringify({ name: 'section', scripts: { test: 'node check.mjs' } }),
    'check.mjs': "import { test } from 'node:test';\ntest('debt', () => { throw new Error('debt'); });\n",
  };
  const { t, root, section } = forest(files);
  git(section, 'switch', '--quiet', '-c', 'lock', 'origin/main');
  write(section, 'package-lock.json', JSON.stringify({ name: 'section', lockfileVersion: 3, requires: true, packages: { '': { name: 'section' } } }));
  git(section, 'add', 'package-lock.json'); git(section, 'commit', '--quiet', '-m', 'lock');
  git(section, 'push', '--quiet', 'origin', 'lock');
  const result = landChangeSet({ root, identity, proposals: [parseProposal('services/section=lock')] });
  assert.equal(result.state, 'landed', JSON.stringify(result));
  assert.equal(result.tested[0].baseline, 'target-on-candidate-dependencies');
  assert.deepEqual(result.tested[0].targetFailures, ['debt']);
  assert.equal(git(section, 'rev-parse', 'origin/lock'), git(t, '--git-dir', path.join(t, 'section.git'), 'rev-parse', 'main^2'));
});

test('a conflicting proposal is refused with its conflicted paths', () => {
  const { t, root, section } = forest();
  const base = git(section, 'rev-parse', 'origin/main');
  propose(section, 'left', 'notes', 'left\n');
  git(section, 'push', '--quiet', 'origin', 'left:main');
  propose(section, 'right', 'notes', 'right\n', base);
  const before = remoteMain(t, 'section');
  const result = landChangeSet({ root, identity, proposals: [parseProposal('services/section=right')] });
  assert.equal(result.reason, 'conflict');
  assert.deepEqual(result.conflicts, ['notes']);
  assert.equal(remoteMain(t, 'section'), before);
});

test('a forge pull-request ref is one more channel', () => {
  const { t, root, section } = forest();
  const head = propose(section, 'pr', 'notes', 'from a pull request\n');
  git(t, '--git-dir', path.join(t, 'section.git'), 'update-ref', 'refs/pull/1/head', head);
  const result = landChangeSet({ root, identity, proposals: [parseProposal('services/section=origin:refs/pull/1/head')] });
  assert.equal(result.state, 'landed', JSON.stringify(result));
  assert.ok(git(section, 'merge-base', '--is-ancestor', head, remoteMain(t, 'section')) === '');
});

// A section whose main already fails test `a`; tests `a` and `b` pass while their
// files read yes.
function redForest() {
  const f = forest();
  const { section } = f;
  git(section, 'switch', '--quiet', '-c', 'red', 'origin/main');
  write(section, 'package.json', JSON.stringify({ name: 'section', scripts: { test: 'node --test' } }));
  for (const name of ['a', 'b']) {
    write(section, `${name}.test.mjs`, `import test from 'node:test'; import fs from 'node:fs'; import assert from 'node:assert';\n` +
      `test('${name} holds', () => assert.equal(fs.readFileSync('${name}', 'utf8').trim(), 'yes'));\n`);
    write(section, name, name === 'a' ? 'no\n' : 'yes\n');
  }
  git(section, 'add', '.'); git(section, 'commit', '--quiet', '-m', 'main fails a');
  git(section, 'push', '--quiet', 'origin', 'red:main');
  return f;
}

test('names failing tests from node:test and TAP output', async () => {
  const { failingTests } = await import('../scripts/land.mjs');
  assert.deepEqual(failingTests('✔ fine (1ms)\n✖ a holds (2.5ms)\n✖ failing tests:\nnot ok 3 - b holds # time=1\n'), ['a holds', 'b holds']);
  assert.deepEqual(failingTests('Error: boom\n'), []);
});

test('a change to a section whose main is already red lands when it adds no failure', () => {
  const { t, root, section } = redForest();
  propose(section, 'unrelated', 'notes', 'two\n');
  const result = landChangeSet({ root, identity, proposals: [parseProposal('services/section=unrelated')] });
  assert.equal(result.state, 'landed', JSON.stringify(result));
  assert.deepEqual(result.tested[0].targetFailures, ['a holds']);
  assert.equal(result.tested[0].baseline, 'target', 'a target that can be tested is the baseline');
  assert.equal(result.tested[0].baselineReason, undefined);
  const budgeted = redForest();
  propose(budgeted.section, 'unrelated', 'notes', 'two\n');
  const spent = landChangeSet({ root: budgeted.root, identity, budget: calmBudget(400), proposals: [parseProposal('services/section=unrelated')] });
  assert.equal(spent.tested[0].budget?.[0]?.state, 'ran', 'a pass judged against a red target keeps its measured spend');
  assert.equal(remoteGitlink(t, 'services/section'), remoteMain(t, 'section'));
});

test('a change that adds a failure to a red main is refused, naming only the new failure', () => {
  const { t, root, section } = redForest();
  const before = remoteMain(t, 'section');
  propose(section, 'breaks-b', 'b', 'no\n');
  const result = landChangeSet({ root, identity, proposals: [parseProposal('services/section=breaks-b')] });
  assert.equal(result.reason, 'test');
  assert.deepEqual(result.introduced, ['b holds']);
  assert.equal(result.baseline, 'target');
  assert.equal(remoteMain(t, 'section'), before);
});

test('a green target judges a candidate that fails by the target\'s own run', () => {
  const { t, root, section } = redForest();
  git(section, 'switch', '--quiet', '-c', 'green', 'origin/main');
  write(section, 'a', 'yes\n');
  git(section, 'commit', '--quiet', '-am', 'main passes a'); git(section, 'push', '--quiet', 'origin', 'green:main');
  const before = remoteMain(t, 'section');
  propose(section, 'breaks-a', 'a', 'no\n');
  const result = landChangeSet({ root, identity, proposals: [parseProposal('services/section=breaks-a')] });
  assert.equal(result.reason, 'test');
  assert.deepEqual(result.introduced, ['a holds']);
  assert.equal(result.baseline, 'target');
  assert.equal(remoteMain(t, 'section'), before);
});

test('a contract runs within its budget and what it spent is recorded', () => {
  const { root, section } = forest();
  propose(section, 'budgeted', 'notes', 'two\n');
  const result = landChangeSet({ root, identity, budget: calmBudget(300), proposals: [parseProposal('services/section=budgeted')] });
  assert.equal(result.state, 'landed', JSON.stringify(result));
  const [spent] = result.tested[0].budget;
  assert.equal(spent.state, 'ran');
  assert.ok(spent.runtime && spent.cpu, JSON.stringify(spent));
});

test('a contract its budget kills holds the change: nothing is refused or pushed', () => {
  const { t, root, section } = forest();
  const before = [remoteMain(t, 'section'), remoteMain(t, 'root')];
  git(section, 'switch', '--quiet', '-c', 'hungry', 'origin/main');
  write(section, 'check.mjs', 'const a = []; for (let i = 0; i < 400; i++) a.push(Buffer.alloc(1 << 20, 1));\n');
  git(section, 'commit', '--quiet', '-am', 'hungry test'); git(section, 'push', '--quiet', 'origin', 'hungry');
  const result = landChangeSet({ root, identity, budget: calmBudget(150), proposals: [parseProposal('services/section=hungry')] });
  assert.equal(result.state, 'held', JSON.stringify(result));
  assert.equal(result.reason, 'over-budget');
  assert.deepEqual([remoteMain(t, 'section'), remoteMain(t, 'root')], before);
});

test('one baseline run serves every proposal judged against the same red target', () => {
  const { root, section } = redForest();
  const runs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-runs-')), 'runs');
  git(section, 'switch', '--quiet', '-c', 'counted', 'origin/main');
  write(section, 'count.test.mjs', `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(runs)}, process.cwd() + '\\n');\n`);
  git(section, 'add', '.'); git(section, 'commit', '--quiet', '-m', 'count runs'); git(section, 'push', '--quiet', 'origin', 'counted:main');
  propose(section, 'one', 'notes', 'first\n');
  propose(section, 'two', 'notes', 'second\n');
  const baselines = new Map();
  for (const branch of ['one', 'two'])
    assert.equal(landChangeSet({ root, identity, dryRun: true, baselines, proposals: [parseProposal(`services/section=${branch}`)] }).state, 'tested');
  const lines = fs.readFileSync(runs, 'utf8').trim().split('\n');
  assert.equal(lines.filter(l => /wt-base-/.test(l)).length, 1, lines.join('\n'));
  assert.equal(lines.filter(l => !/wt-base-/.test(l)).length, 2);
});
// A section whose main cannot be installed. package.json asks for the file: dependency
// `dep`, but the committed lockfile records none, so `npm ci` refuses: a lockfile that lags
// its package.json, as on 2026-10-30. Test `a holds` already fails on main, `b holds`
// passes, and `dep resolves` passes only where `dep` is installed.
const lockfile = withDep => JSON.stringify({ name: 'section', lockfileVersion: 3, requires: true, packages: {
  '': { name: 'section', ...(withDep && { dependencies: { dep: 'file:dep' } }) },
  ...(withDep && { dep: { version: '1.0.0' }, 'node_modules/dep': { resolved: 'dep', link: true } }) } }, null, 2) + '\n';
const holds = (name, file = name) => `import test from 'node:test'; import fs from 'node:fs'; import assert from 'node:assert';\n` +
  `test('${name} holds', () => assert.equal(fs.readFileSync('${file}', 'utf8').trim(), 'yes'));\n`;
function staleForest(scripts = { test: 'node --test' }) {
  return forest({
    'package.json': JSON.stringify({ name: 'section', scripts, dependencies: { dep: 'file:dep' } }),
    'package-lock.json': lockfile(false),
    'dep/package.json': JSON.stringify({ name: 'dep', version: '1.0.0', type: 'module', main: 'index.mjs' }),
    'dep/index.mjs': 'export default 1;\n',
    'a.test.mjs': holds('a'), a: 'no\n', 'b.test.mjs': holds('b'), b: 'yes\n',
    'dep.test.mjs': `import test from 'node:test'; test('dep resolves', async () => { await import('dep'); });\n`,
  });
}
function proposeFiles(section, branch, files, from = 'origin/main') {
  git(section, 'switch', '--quiet', '-c', branch, from);
  for (const [file, text] of Object.entries(files)) write(section, file, text);
  git(section, 'add', '-A'); git(section, 'commit', '--quiet', '-m', `change ${Object.keys(files).join(', ')}`);
  git(section, 'push', '--quiet', 'origin', branch);
  return git(section, 'rev-parse', 'HEAD');
}

test('a target the lander cannot install is judged by its own source on the candidate\'s dependencies, and the candidate that repairs it lands', () => {
  const { t, root, section } = staleForest();
  proposeFiles(section, 'repair-lock', { 'package-lock.json': lockfile(true) });
  const result = landChangeSet({ root, identity, proposals: [parseProposal('services/section=repair-lock')] });
  assert.equal(result.state, 'landed', JSON.stringify(result));
  const [tested] = result.tested;
  assert.equal(tested.baseline, 'target-on-candidate-dependencies');
  assert.match(tested.baselineReason.command, /^npm ci /, 'the reason names the step that refused the target');
  assert.match(tested.baselineReason.log, /in sync/);
  assert.deepEqual(tested.targetFailures, ['a holds'], 'the target ran over the candidate\'s dependencies: dep resolves, and a holds is the debt');
  assert.equal(remoteGitlink(t, 'services/section'), remoteMain(t, 'section'));
});

test('a candidate that adds a failure beyond the fallback baseline is refused, naming only that failure', () => {
  const { t, root, section } = staleForest();
  const before = [remoteMain(t, 'section'), remoteMain(t, 'root')];
  proposeFiles(section, 'repair-and-break', { 'package-lock.json': lockfile(true), b: 'no\n' });
  const result = landChangeSet({ root, identity, proposals: [parseProposal('services/section=repair-and-break')] });
  assert.equal(result.state, 'refused', JSON.stringify(result));
  assert.equal(result.reason, 'test');
  assert.deepEqual(result.introduced, ['b holds']);
  assert.equal(result.baseline, 'target-on-candidate-dependencies');
  assert.match(result.baselineReason.command, /^npm ci /);
  assert.deepEqual([remoteMain(t, 'section'), remoteMain(t, 'root')], before);
});

test('a target that cannot be tested even on the candidate\'s dependencies is untestable, not a source of introduced failures', () => {
  // main's test script names a runner that main does not have; the candidate repairs the lock and supplies it.
  const { t, root, section } = staleForest({ test: 'node runner.mjs' });
  const before = [remoteMain(t, 'section'), remoteMain(t, 'root')];
  proposeFiles(section, 'repair-everything', { 'package-lock.json': lockfile(true),
    'runner.mjs': `import test from 'node:test'; test('runner holds', () => { throw new Error('boom'); });\n` });
  const result = landChangeSet({ root, identity, proposals: [parseProposal('services/section=repair-everything')] });
  assert.equal(result.state, 'refused', JSON.stringify(result));
  assert.equal(result.reason, 'target-untestable');
  assert.equal(result.section, 'services/section');
  assert.equal(result.introduced, undefined, 'no baseline, so nothing is called introduced');
  assert.match(result.targetError.command, /^npm ci /);
  assert.match(result.targetError.log, /in sync/);
  assert.equal(result.fallbackError.command, 'npm test');
  assert.match(result.fallbackError.log, /runner\.mjs/);
  assert.deepEqual([remoteMain(t, 'section'), remoteMain(t, 'root')], before);
});

function calmBudget(memoryMb) {
  return { memoryMb, telemetry: () => ({ availableMb: 8000, memoryFullPct: 0, ioFullPct: 0 }),
    ledger: fs.mkdtempSync(path.join(os.tmpdir(), 'land-ledger-')) };
}

test('a target that moves while a change is tested is merged onto and tested again, not refused', () => {
  const { t, root, section } = forest();
  // Another writer lands on the section's main while the proposal's contract runs, once.
  const mover = path.join(t, 'mover');
  git(t, 'clone', '--quiet', path.join(t, 'section.git'), mover);
  const once = path.join(t, 'move-once');
  fs.writeFileSync(once, '');
  git(section, 'switch', '--quiet', '-c', 'racing', 'origin/main');
  write(section, 'check.mjs', `import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
if (fs.existsSync(${JSON.stringify(once)})) { fs.rmSync(${JSON.stringify(once)});
  fs.writeFileSync(${JSON.stringify(path.join(mover, 'other'))}, 'x\\n');
  for (const a of [['add', 'other'], ['-c', 'user.name=W', '-c', 'user.email=w@test', 'commit', '-qm', 'other writer'], ['push', '-q', 'origin', 'main']])
    execFileSync('git', a, { cwd: ${JSON.stringify(mover)} }); }
process.exit(fs.readFileSync('ok', 'utf8').trim() === 'yes' ? 0 : 1);\n`);
  git(section, 'commit', '--quiet', '-am', 'racing check'); git(section, 'push', '--quiet', 'origin', 'racing');
  const result = landChangeSet({ root, identity, proposals: [parseProposal('services/section=racing')] });
  assert.equal(result.state, 'landed', JSON.stringify(result));
  assert.equal(result.attempts, 2);
  assert.equal(git(section, 'show', `${remoteMain(t, 'section')}:other`), 'x', 'the other writer\'s landing is kept');
});

// LD-8 for Lake. A fake `lake` stands in for the toolchain: it logs each invocation and
// the .lake it found, appends to that .lake, and fails `build` while Bad.lean holds a
// Mathlib-only tactic. ELAN_HOME points the lander at it as elan's proxy.
function fakeLake(t) {
  const bin = path.join(t, 'elan', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  write(bin, 'lake', `#!/bin/sh
echo "lake $* | $(cat .lake/marker 2>/dev/null)" >> "${t}/lake.log"
echo ran >> .lake/marker 2>/dev/null
if [ "$1" = build ] && grep -q by_contra Bad.lean; then echo "error: Bad.lean: unknown tactic by_contra"; exit 1; fi
if [ "$1" = test ] && grep -q fail notes; then exit 1; fi
exit 0
`);
  fs.chmodSync(path.join(bin, 'lake'), 0o755);
  return path.join(t, 'elan');
}
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const lakeFiles = (extra = {}) => ({ 'lakefile.toml': 'name = "section"\n', 'Bad.lean': 'theorem t : True := trivial\n', ...extra });
const lakeLog = t => fs.existsSync(path.join(t, 'lake.log')) ? fs.readFileSync(path.join(t, 'lake.log'), 'utf8').trim().split('\n') : [];

test('a Lake package lands only after lake build, and the landing names the contract', () => {
  const { t, root, section } = forest(lakeFiles());
  const elan = fakeLake(t);
  propose(section, 'feature', 'Bad.lean', 'theorem u : True := trivial\n');
  const result = withEnv({ ELAN_HOME: elan }, () => landChangeSet({ root, identity, proposals: [parseProposal('services/section=feature')] }));
  assert.equal(result.state, 'landed', JSON.stringify(result));
  assert.deepEqual(result.tested.map(r => [r.section, r.contract, r.ok]), [['services/section', 'lake build', true]]);
  assert.deepEqual(lakeLog(t), ['lake build |'], 'no testDriver, so no lake test');
});

test('a Lake package whose build fails is refused and nothing is pushed', () => {
  const { t, root, section } = forest(lakeFiles());
  const elan = fakeLake(t);
  const before = [remoteMain(t, 'section'), remoteMain(t, 'root')];
  propose(section, 'broken', 'Bad.lean', 'example : True := by by_contra h; trivial\n');
  const result = withEnv({ ELAN_HOME: elan }, () => landChangeSet({ root, identity, proposals: [parseProposal('services/section=broken')] }));
  assert.equal(result.state, 'refused');
  assert.equal(result.reason, 'test');
  assert.equal(result.command, 'lake build');
  assert.match(result.log, /unknown tactic by_contra/);
  assert.deepEqual([remoteMain(t, 'section'), remoteMain(t, 'root')], before);
});

test('lake test runs after lake build only when the lakefile declares a testDriver', () => {
  const { t, root, section } = forest(lakeFiles({ 'lakefile.toml': 'name = "section"\ntestDriver = "Tests"\n' }));
  const elan = fakeLake(t);
  propose(section, 'feature', 'notes', 'two\n');
  let result = withEnv({ ELAN_HOME: elan }, () => landChangeSet({ root, identity, dryRun: true, proposals: [parseProposal('services/section=feature')] }));
  assert.equal(result.state, 'tested', JSON.stringify(result));
  assert.equal(result.tested[0].contract, 'lake build; lake test');
  assert.deepEqual(lakeLog(t).map(l => l.split(' |')[0]), ['lake build', 'lake test']);
  propose(section, 'red', 'notes', 'fail\n', 'origin/main');
  result = withEnv({ ELAN_HOME: elan }, () => landChangeSet({ root, identity, dryRun: true, proposals: [parseProposal('services/section=red')] }));
  assert.equal(result.state, 'refused');
  assert.equal(result.command, 'lake build; lake test');
});

test('testDriver is read from the top level of lakefile.toml and from lakefile.lean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-driver-'));
  const check = (name, text) => { for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f)); write(dir, name, text); return declaresTestDriver(dir); };
  assert.equal(check('lakefile.toml', 'name = "a"\ntestDriver = "T"\n[[lean_lib]]\nname = "A"\n'), true);
  assert.equal(check('lakefile.toml', 'name = "a"\n[[lean_lib]]\nname = "A"\ntestDriver = "T"\n'), false, 'a library key is not the package declaration');
  assert.equal(check('lakefile.toml', 'name = "a"\n# testDriver = "T"\n'), false);
  assert.equal(check('lakefile.lean', 'package a\n@[test_driver] lean_exe tests\n'), true);
  assert.equal(check('lakefile.lean', 'package a where\n  testDriver := `tests\n'), true);
  assert.equal(check('lakefile.lean', 'package a\n-- @[test_driver]\n'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the checkout\'s .lake is copied into the candidate, never shared with it', () => {
  const { t, root, section } = forest(lakeFiles());
  const elan = fakeLake(t);
  fs.mkdirSync(path.join(section, '.lake'));
  write(path.join(section, '.lake'), 'marker', 'cached\n');
  const inode = fs.statSync(path.join(section, '.lake/marker')).ino;
  propose(section, 'feature', 'notes', 'two\n');
  const result = withEnv({ ELAN_HOME: elan }, () => landChangeSet({ root, identity, proposals: [parseProposal('services/section=feature')] }));
  assert.equal(result.state, 'landed', JSON.stringify(result));
  assert.deepEqual(lakeLog(t), ['lake build | cached'], 'Lake found the checkout\'s build cache');
  assert.equal(fs.readFileSync(path.join(section, '.lake/marker'), 'utf8'), 'cached\n', 'the checkout\'s cache is untouched');
  assert.equal(fs.statSync(path.join(section, '.lake/marker')).ino, inode);
});

test('lake on PATH is used when elan has no proxy', () => {
  const { t, root, section } = forest(lakeFiles());
  const elan = fakeLake(t);
  const empty = path.join(t, 'no-elan');
  fs.mkdirSync(empty);
  propose(section, 'feature', 'notes', 'two\n');
  const result = withEnv({ ELAN_HOME: empty, PATH: `${path.join(elan, 'bin')}:${process.env.PATH}` },
    () => landChangeSet({ root, identity, proposals: [parseProposal('services/section=feature')] }));
  assert.equal(result.state, 'landed', JSON.stringify(result));
  assert.equal(result.tested[0].contract, 'lake build');
});

test('a section with neither a test script nor a lakefile lands with contract none', () => {
  const { root, section } = forest({ README: 'plain\n' });
  propose(section, 'feature', 'notes', 'two\n');
  const result = landChangeSet({ root, identity, proposals: [parseProposal('services/section=feature')] });
  assert.equal(result.state, 'landed', JSON.stringify(result));
  assert.deepEqual(result.tested.map(r => [r.contract, r.ok]), [['none', true]]);
});
