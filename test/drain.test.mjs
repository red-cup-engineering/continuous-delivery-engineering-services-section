import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { drain, planDrain, refusalComment, repositorySlug } from '../scripts/drain.mjs';

const author = { GIT_AUTHOR_NAME: 'Agent', GIT_AUTHOR_EMAIL: 'agent@test.561.group', GIT_COMMITTER_NAME: 'Agent', GIT_COMMITTER_EMAIL: 'agent@test.561.group' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...a],
  { cwd, encoding: 'utf8', env: { ...process.env, ...author }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const identity = { GIT_AUTHOR_NAME: 'Lander', GIT_AUTHOR_EMAIL: 'lander@test.561.group', GIT_COMMITTER_NAME: 'Lander', GIT_COMMITTER_EMAIL: 'lander@test.561.group' };

test('reads GitHub slugs from https and ssh remotes', () => {
  assert.equal(repositorySlug('https://github.com/Red-Cup-Engineering/lagoon.git'), 'red-cup-engineering/lagoon');
  assert.equal(repositorySlug('git@github.com:561-group/bare-cedar-fog.git'), '561-group/bare-cedar-fog');
  assert.equal(repositorySlug('/tmp/x.git'), null);
});

test('plans oldest first, drafts included, HOLD titles left alone', () => {
  const p = (number, createdAt, title, draft = true) => ({ slug: 'o/r', number, createdAt, title, draft });
  const { queue, skipped } = planDrain([p(3, '2026-10-03', 'later'), p(1, '2026-10-01', 'HOLD: reconcile'), p(2, '2026-10-02', 'earlier', false)]);
  assert.deepEqual(queue.map(x => x.number), [2, 3]);
  assert.deepEqual(skipped.map(x => [x.number, x.skipped]), [[1, 'hold']]);
});

test('a refusal comment names the conflicted files or the new failures', () => {
  assert.match(refusalComment({ reason: 'conflict', target: 'main', conflicts: ['a.mjs'] }), /conflicts with `main` in:\n- `a.mjs`/);
  const text = refusalComment({ reason: 'test', target: 'main', command: 'npm test', introduced: ['b holds'], log: 'x' });
  assert.match(text, /- b holds/);
});

test('drains pull-request refs: lands the passing one, comments on the failing one, skips HOLD', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-test-'));
  const origin = path.join(t, 'r.git');
  git(t, 'init', '--quiet', '--bare', origin);
  const repo = path.join(t, 'r');
  git(t, 'clone', '--quiet', origin, repo);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'r', scripts: { test: 'node check.mjs' } }));
  fs.writeFileSync(path.join(repo, 'check.mjs'), "import fs from 'node:fs'; process.exit(fs.readFileSync('ok', 'utf8').trim() === 'yes' ? 0 : 1);\n");
  fs.writeFileSync(path.join(repo, 'ok'), 'yes\n');
  git(repo, 'add', '.'); git(repo, 'commit', '--quiet', '-m', 'seed'); git(repo, 'push', '--quiet', 'origin', 'main');
  const pull = (number, file, text) => {
    git(repo, 'switch', '--quiet', '-c', `pr${number}`, 'main');
    fs.writeFileSync(path.join(repo, file), text);
    git(repo, 'add', file); git(repo, 'commit', '--quiet', '-m', `pr ${number}`);
    git(repo, 'push', '--quiet', 'origin', `pr${number}:refs/pull/${number}/head`);
    return { slug: 'o/r', number, title: `change ${number}`, draft: true, base: 'main', createdAt: `2026-10-0${number}`,
      head: git(repo, 'rev-parse', 'HEAD'), sameRepository: true };
  };
  const pulls = [pull(1, 'notes', 'one\n'), pull(2, 'ok', 'no\n'), { ...pull(3, 'other', 'x\n'), title: 'HOLD: not yet' }];
  const comments = [];
  const { results } = drain({ root: repo, pulls, identity, locate: () => repo,
    comment: (p, body, mark) => { comments.push({ number: p.number, body, mark }); return true; } });
  assert.deepEqual(results.map(r => [r.number, r.state]), [[3, 'skipped'], [1, 'landed'], [2, 'refused']]);
  assert.ok(git(repo, 'merge-base', '--is-ancestor', pulls[0].head, git(repo, 'ls-remote', origin, 'refs/heads/main').split(/\s/)[0]) === '');
  assert.deepEqual(comments.map(c => c.number), [2]);
  assert.match(comments[0].body, /`npm test` fails/);
  assert.match(comments[0].mark, new RegExp(`<!-- lander ${pulls[1].head} [0-9a-f]{40} -->`));
});

// A repository whose main and pull request #1 (branch feature) both rewrote `notes`.
function conflicted() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-test-'));
  const origin = path.join(t, 'r.git');
  git(t, 'init', '--quiet', '--bare', origin);
  const repo = path.join(t, 'r');
  git(t, 'clone', '--quiet', origin, repo);
  fs.writeFileSync(path.join(repo, 'notes'), 'seed\n');
  fs.writeFileSync(path.join(repo, 'other'), 'untouched\n');
  git(repo, 'add', '.'); git(repo, 'commit', '--quiet', '-m', 'seed'); git(repo, 'push', '--quiet', 'origin', 'main');
  git(repo, 'switch', '--quiet', '-c', 'feature');
  fs.writeFileSync(path.join(repo, 'notes'), 'feature\n');
  git(repo, 'commit', '--quiet', '-am', 'feature'); git(repo, 'push', '--quiet', 'origin', 'feature');
  git(repo, 'push', '--quiet', 'origin', 'feature:refs/pull/1/head');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '--quiet', 'main');
  fs.writeFileSync(path.join(repo, 'notes'), 'main\n');
  git(repo, 'commit', '--quiet', '-am', 'main moved'); git(repo, 'push', '--quiet', 'origin', 'main');
  const pull = { slug: 'o/r', number: 1, title: 'feature', draft: true, base: 'main', head, headRef: 'feature',
    createdAt: '2026-10-01', sameRepository: true };
  return { origin, repo, pull, remote: ref => git(repo, 'ls-remote', origin, ref).split(/\s/)[0] };
}
const resolver = { GIT_AUTHOR_NAME: 'Claude (resolver)', GIT_AUTHOR_EMAIL: 'claude+resolver@test.561.group', GIT_COMMITTER_NAME: 'Claude (resolver)', GIT_COMMITTER_EMAIL: 'claude+resolver@test.561.group' };

test('a conflicted pull request is resolved on its own branch and then landed', async () => {
  const { resolveConflict } = await import('../scripts/resolve.mjs');
  const { repo, pull, remote } = conflicted();
  const briefs = [];
  const agent = (dir, brief) => { briefs.push(brief); fs.writeFileSync(path.join(dir, 'notes'), 'main\nfeature\n'); return { ok: true, output: '' }; };
  const { results } = drain({ root: repo, pulls: [pull], identity, locate: () => repo, comment: () => assert.fail('no comment owed'),
    resolve: args => resolveConflict({ ...args, identity: resolver, agent }) });
  assert.equal(results[0].state, 'landed', JSON.stringify(results[0]));
  assert.deepEqual(results[0].resolution, { state: 'resolved', reason: undefined, conflicts: ['notes'], files: undefined });
  assert.match(briefs[0], /- notes/);
  const feature = remote('refs/heads/feature');
  assert.equal(git(repo, 'log', '-1', '--format=%ae', feature), 'claude+resolver@test.561.group');
  assert.equal(git(repo, 'show', `${remote('refs/heads/main')}:notes`), 'main\nfeature');
});

test('a resolution that leaves markers or touches another file is not pushed', async () => {
  const { resolveConflict } = await import('../scripts/resolve.mjs');
  for (const [agent, reason] of [
    [() => ({ ok: true, output: '' }), 'markers-left'],
    [dir => { fs.writeFileSync(path.join(dir, 'notes'), 'both\n'); fs.writeFileSync(path.join(dir, 'other'), 'changed\n'); return { ok: true, output: '' }; }, 'outside-conflict'],
  ]) {
    const { repo, pull, remote } = conflicted();
    const comments = [];
    const { results } = drain({ root: repo, pulls: [pull], identity, locate: () => repo, comment: (p, body) => { comments.push(body); return true; },
      resolve: args => resolveConflict({ ...args, identity: resolver, agent }) });
    assert.equal(results[0].state, 'refused');
    assert.equal(results[0].resolution.reason, reason);
    assert.equal(remote('refs/heads/feature'), pull.head, 'the pull request branch is untouched');
    assert.equal(comments.length, 1);
  }
});

test('whitespace the base branch already carries does not block a resolution', async () => {
  const { resolveConflict } = await import('../scripts/resolve.mjs');
  const { repo, pull } = conflicted();
  fs.writeFileSync(path.join(repo, 'README.md'), 'trailing   \n');
  git(repo, 'add', 'README.md'); git(repo, 'commit', '--quiet', '-m', 'main carries trailing whitespace'); git(repo, 'push', '--quiet', 'origin', 'main');
  const agent = dir => { fs.writeFileSync(path.join(dir, 'notes'), 'main\nfeature\n'); return { ok: true, output: '' }; };
  assert.equal(resolveConflict({ repo, pull, target: 'main', identity: resolver, agent }).state, 'resolved');
});
