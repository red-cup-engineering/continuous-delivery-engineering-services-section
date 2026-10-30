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
