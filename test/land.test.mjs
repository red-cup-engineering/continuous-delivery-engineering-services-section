import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { landChangeSet, parseProposal } from '../scripts/land.mjs';

const author = { GIT_AUTHOR_NAME: 'Agent', GIT_AUTHOR_EMAIL: 'agent@test.561.group', GIT_COMMITTER_NAME: 'Agent', GIT_COMMITTER_EMAIL: 'agent@test.561.group' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'init.defaultBranch=main', ...a],
  { cwd, encoding: 'utf8', env: { ...process.env, ...author }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);
const identity = { GIT_AUTHOR_NAME: 'Lander', GIT_AUTHOR_EMAIL: 'lander@test.561.group', GIT_COMMITTER_NAME: 'Lander', GIT_COMMITTER_EMAIL: 'lander@test.561.group' };

// A colony root mounting one section at services/section, each behind a bare remote.
// The section's test contract passes while its `ok` file reads yes.
function forest() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'land-test-'));
  for (const name of ['section', 'root']) git(t, 'init', '--quiet', '--bare', `${name}.git`);
  const seed = path.join(t, 'seed');
  git(t, 'clone', '--quiet', path.join(t, 'section.git'), seed);
  write(seed, 'package.json', JSON.stringify({ name: 'section', scripts: { test: 'node check.mjs' } }));
  write(seed, 'check.mjs', "import fs from 'node:fs'; process.exit(fs.readFileSync('ok', 'utf8').trim() === 'yes' ? 0 : 1);\n");
  write(seed, 'ok', 'yes\n');
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
