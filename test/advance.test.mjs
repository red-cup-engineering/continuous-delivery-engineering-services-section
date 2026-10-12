import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plan, renderBody, run, githubSlug, BOT_EMAIL } from '../scripts/advance.mjs';

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cds-adv-'));
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);

test('plan advances only where the remote head differs and descends from the pin', () => {
  const p = plan([
    { path: 'x', pin: A, head: A, status: 'identical' },
    { path: 'y', pin: A, head: B, status: 'ahead' },
    { path: 'z', pin: A, head: B, status: 'diverged' },
    { path: 'w', pin: B, head: A, status: 'behind' },
    { path: 'u', pin: A, head: '', status: 'unknown' },
  ]);
  assert.deepEqual(p.advance.map(e => e.path), ['y']);
  assert.deepEqual(p.diverged.map(e => e.path), ['z', 'w', 'u']);
  assert.deepEqual(p.current.map(e => e.path), ['x']);
});

test('body lists diverged pins instead of advancing them', () => {
  const b = renderBody(plan([
    { path: 'y', pin: A, head: B, status: 'ahead' },
    { path: 'z', pin: A, head: C, status: 'diverged' },
  ]), 'Triggered by a push to main of o/s.');
  assert.match(b, /^Triggered by/);
  assert.match(b, /Advanced:\n- y: aaaaaaaaa -> bbbbbbbbb/);
  assert.match(b, /Diverged, not advanced[^\n]*\n- z: pin aaaaaaaaa, remote ccccccccc \(diverged\)/);
});

test('githubSlug', () => {
  assert.equal(githubSlug('https://github.com/o/r.git'), 'o/r');
  assert.equal(githubSlug('git@github.com:o/r.git'), null);
});

// A parent repository with a bare origin and two gitlinks (no real submodule remotes needed).
function parent() {
  const origin = tmp(), work = tmp();
  sh(origin, 'init', '-q', '--bare', '-b', 'main');
  sh(work, 'init', '-q', '-b', 'main');
  sh(work, 'config', 'user.name', 'owner'); sh(work, 'config', 'user.email', 'owner@example.com');
  fs.writeFileSync(path.join(work, '.gitmodules'),
    '[submodule "s1"]\n\tpath = s1\n\turl = https://github.com/o/s1\n[submodule "s2"]\n\tpath = s2\n\turl = https://github.com/o/s2\n');
  sh(work, 'add', '.gitmodules');
  sh(work, 'update-index', '--add', '--cacheinfo', `160000,${A},s1`);
  sh(work, 'update-index', '--add', '--cacheinfo', `160000,${A},s2`);
  sh(work, 'commit', '-q', '-m', 'init');
  sh(work, 'remote', 'add', 'origin', origin);
  sh(work, 'push', '-q', 'origin', 'main');
  return { origin, work };
}
const deps = { head: (url) => url.endsWith('s1') ? B : C, status: (url) => url.endsWith('s1') ? 'ahead' : 'diverged' };
const pin = (cwd, ref, p) => sh(cwd, 'ls-tree', ref, p).split(/\s+/)[2];

test('run pushes one branch advancing s1 and leaving diverged s2 pinned; writes body inside .git', () => {
  const { origin, work } = parent();
  const r = run(work, { branch: 'ci/submodule-advance', ...deps });
  assert.equal(r.result, 'advanced');
  assert.equal(pin(origin, 'ci/submodule-advance', 's1'), B);
  assert.equal(pin(origin, 'ci/submodule-advance', 's2'), A);
  assert.equal(r.bodyFile, path.join(work, '.git', 'advance-body.md'));
  assert.match(fs.readFileSync(r.bodyFile, 'utf8'), /s2: pin aaaaaaaaa, remote ccccccccc/);
});

test('run with nothing to advance pushes nothing', () => {
  const { origin, work } = parent();
  const r = run(work, { branch: 'ci/submodule-advance', head: () => A, status: () => 'identical' });
  assert.equal(r.result, 'nothing to advance');
  assert.throws(() => sh(origin, 'rev-parse', 'ci/submodule-advance'));
});

test('a branch carrying a reviewer commit is extended, never force-pushed', () => {
  const { origin, work } = parent();
  run(work, { branch: 'ci/submodule-advance', ...deps });
  // a reviewer adds a commit to the PR branch
  const rev = tmp();
  sh(rev, 'clone', '-q', '-b', 'ci/submodule-advance', origin, '.');
  sh(rev, 'config', 'user.name', 'reviewer'); sh(rev, 'config', 'user.email', 'rev@example.com');
  fs.writeFileSync(path.join(rev, 'fix.txt'), 'reviewer');
  sh(rev, 'add', 'fix.txt'); sh(rev, 'commit', '-q', '-m', 'reviewer fix'); sh(rev, 'push', '-q', 'origin', 'ci/submodule-advance');
  const reviewerSha = sh(rev, 'rev-parse', 'HEAD');
  // the remote moves again; main is checked out afresh, as in a new run
  sh(work, 'checkout', '-q', 'main');
  const r = run(work, { branch: 'ci/submodule-advance', head: (u) => u.endsWith('s1') ? C : C, status: (u) => u.endsWith('s1') ? 'ahead' : 'diverged' });
  assert.equal(r.foreign, true);
  assert.equal(pin(origin, 'ci/submodule-advance', 's1'), C);
  assert.equal(sh(origin, 'cat-file', '-t', reviewerSha), 'commit');
  assert.equal(sh(origin, 'merge-base', '--is-ancestor', reviewerSha, 'ci/submodule-advance') ?? '', '');
});

test('a branch carrying only bot commits retains its prior history', () => {
  const { origin, work } = parent();
  run(work, { branch: 'ci/submodule-advance', ...deps });
  assert.equal(sh(origin, 'log', '-1', '--format=%ae', 'ci/submodule-advance'), BOT_EMAIL);
  sh(work, 'checkout', '-q', 'main');
  const r = run(work, { branch: 'ci/submodule-advance', head: (u) => u.endsWith('s1') ? C : A, status: (u) => u.endsWith('s1') ? 'ahead' : 'identical' });
  assert.equal(r.foreign, false);
  assert.equal(pin(origin, 'ci/submodule-advance', 's1'), C);
  assert.equal(sh(origin, 'rev-list', '--count', 'main..ci/submodule-advance'), '2');
});

test('workflows hold no /tmp writes and no force-push flag', () => {
  for (const f of fs.readdirSync('.github/workflows')) {
    const t = fs.readFileSync(path.join('.github/workflows', f), 'utf8');
    assert.ok(!/\/tmp\//.test(t) || f === 'content.yml', `${f} writes /tmp`);
    assert.ok(!/push (-f|--force)\b/.test(t), `${f} force-pushes`);
  }
});
