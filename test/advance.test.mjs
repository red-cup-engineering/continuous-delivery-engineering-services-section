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
  assert.deepEqual(p.diverged.map(e => e.path), ['z', 'w']);
  assert.deepEqual(p.unread.map(e => e.path), ['u']);
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

// Two parent histories advance the same unmaterialized gitlink. This is the
// ordinary later-run failure: Git lacks supplier objects, while the supplier's
// compare operation can prove the chain without checking out its worktree.
function conflictingParent({ ours = B, theirs = C, ours2 = A, theirs2 = A, edit } = {}) {
  const result = parent(), { origin, work } = result;
  run(work, { branch: 'ci/submodule-advance', head: u => u.endsWith('s1') ? ours : ours2, status: () => 'ahead' });
  fs.writeFileSync(path.join(work, 'reviewer.txt'), 'retain reviewer source\n');
  sh(work, 'config', 'user.email', 'reviewer@example.com');
  sh(work, 'add', 'reviewer.txt'); sh(work, 'commit', '-q', '-m', 'reviewer source');
  sh(work, 'push', '-q', 'origin', 'ci/submodule-advance');
  result.review = sh(work, 'rev-parse', 'HEAD');
  sh(work, 'checkout', '-q', 'main');
  sh(work, 'update-index', '--cacheinfo', `160000,${theirs},s1`);
  sh(work, 'update-index', '--cacheinfo', `160000,${theirs2},s2`);
  fs.writeFileSync(path.join(work, 'base.txt'), 'retain default source\n');
  sh(work, 'add', 'base.txt');
  edit?.(work);
  sh(work, 'commit', '-q', '-m', 'default source advances independently');
  sh(work, 'push', '-q', 'origin', 'main');
  result.base = sh(work, 'rev-parse', 'HEAD');
  return result;
}

const chainStatus = (_url, pin, head) => {
  const order = [A, B, C, 'd'.repeat(40)];
  return pin === head ? 'identical' : order.indexOf(pin) < order.indexOf(head) ? 'ahead' : 'behind';
};
const assertNotPublished = ({ origin, work, review }) => {
  assert.equal(sh(origin, 'rev-parse', 'ci/submodule-advance'), review);
  assert.equal(sh(work, 'rev-parse', 'HEAD'), review);
  assert.equal(sh(work, 'ls-files', '--unmerged'), '');
  assert.equal(sh(work, 'status', '--porcelain', '--ignore-submodules=all'), '');
};

for (const [name, ours, theirs] of [['default ahead', B, C], ['review ahead', C, B]]) {
  test(`later run joins comparable gitlink conflict (${name}), retains both histories, and is idempotent`, () => {
    const { origin, work, review, base } = conflictingParent({ ours, theirs });
    const options = { branch: 'ci/submodule-advance', head: u => u.endsWith('s1') ? C : A, status: chainStatus };
    const r = run(work, options);
    assert.equal(r.result, 'advanced'); assert.equal(r.pushed, true); assert.equal(r.foreign, true);
    assert.equal(pin(origin, 'ci/submodule-advance', 's1'), C);
    const joined = sh(origin, 'rev-parse', 'ci/submodule-advance');
    assert.deepEqual(sh(origin, 'show', '-s', '--format=%P', joined).split(' '), [review, base]);
    for (const source of [review, base]) sh(origin, 'merge-base', '--is-ancestor', source, joined);
    assert.equal(sh(origin, 'show', `${joined}:reviewer.txt`), 'retain reviewer source');
    assert.equal(sh(origin, 'show', `${joined}:base.txt`), 'retain default source');
    sh(work, 'checkout', '-q', 'main');
    assert.equal(run(work, options).result, 'nothing to advance');
    assert.equal(sh(origin, 'rev-parse', 'ci/submodule-advance'), joined);
  });
}

test('after receiving a comparable conflict, fresh observation can advance farther', () => {
  const { origin, work, review, base } = conflictingParent();
  const D = 'd'.repeat(40);
  const r = run(work, { branch: 'ci/submodule-advance', head: u => u.endsWith('s1') ? D : A, status: chainStatus });
  assert.equal(r.pushed, true);
  assert.equal(pin(origin, 'ci/submodule-advance', 's1'), D);
  for (const source of [review, base]) sh(origin, 'merge-base', '--is-ancestor', source, 'ci/submodule-advance');
  assert.match(r.body, /s1: ccccccccc -> ddddddddd/);
});

for (const relation of ['diverged', 'unknown', 'identical', undefined]) {
  test(`conflicting supplier heads with ${relation} comparison stay unpublished and abort cleanly`, () => {
    const fixture = conflictingParent();
    assert.throws(() => run(fixture.work, { branch: 'ci/submodule-advance', head: () => C,
      status: (url, pin, head) => pin === A ? 'ahead' : relation }), /unresolved base gitlink ancestry/);
    assertNotPublished(fixture);
  });
}

test('a backwards side relative to the common gitlink is not healed by choosing the other side', () => {
  const fixture = conflictingParent();
  assert.throws(() => run(fixture.work, { branch: 'ci/submodule-advance', head: () => C,
    status: (url, pin, head) => pin === A && head === B ? 'behind' : chainStatus(url, pin, head) }), /unproven base gitlink ancestry/);
  assertNotPublished(fixture);
});

test('changed supplier definitions refuse automatic conflict resolution', () => {
  const fixture = conflictingParent({ edit(work) {
    sh(work, 'config', '-f', '.gitmodules', 'submodule.s1.url', 'https://github.com/another/s1');
    sh(work, 'add', '.gitmodules');
  } });
  assert.throws(() => run(fixture.work, { branch: 'ci/submodule-advance', head: () => C, status: chainStatus }), /supplier definitions changed/);
  assertNotPublished(fixture);
});

test('a text conflict alongside the comparable gitlink remains a refusal', () => {
  const fixture = conflictingParent({ edit(work) {
    fs.writeFileSync(path.join(work, 'reviewer.txt'), 'conflicting default source\n');
    sh(work, 'add', 'reviewer.txt');
  } });
  assert.throws(() => run(fixture.work, { branch: 'ci/submodule-advance', head: () => C, status: chainStatus }), /non-gitlink base merge conflict/);
  assertNotPublished(fixture);
});

test('a deleted conflicting gitlink is not restored by ancestry selection', () => {
  const fixture = conflictingParent({ edit(work) { sh(work, 'update-index', '--force-remove', 's1'); } });
  assert.throws(() => run(fixture.work, { branch: 'ci/submodule-advance', head: () => C, status: chainStatus }), /non-gitlink base merge conflict/);
  assertNotPublished(fixture);
});

test('unknown original ancestry and thrown supplier reads abort without publication', () => {
  for (const status of [() => 'unknown', () => { throw new Error('supplier unavailable'); }]) {
    const fixture = conflictingParent();
    assert.throws(() => run(fixture.work, { branch: 'ci/submodule-advance', head: () => C, status }), /unproven base gitlink ancestry|supplier unavailable/);
    assertNotPublished(fixture);
  }
});

test('all conflicting suppliers must qualify before any resolution is retained', () => {
  const fixture = conflictingParent({ ours2: B, theirs2: C });
  assert.throws(() => run(fixture.work, { branch: 'ci/submodule-advance', head: () => C,
    status: (url, pin, head) => url.endsWith('s2') && pin === B ? 'diverged' : chainStatus(url, pin, head) }), /unresolved base gitlink ancestry: s2/);
  assertNotPublished(fixture);
});

test('a concurrent sync branch contribution rejects publication without losing that contribution', () => {
  const { origin, work, review } = conflictingParent();
  let concurrent;
  const status = (url, pin, head) => {
    if (!concurrent) {
      const tree = sh(origin, 'rev-parse', `${review}^{tree}`);
      concurrent = execFileSync('git', ['-c', 'user.name=reviewer', '-c', 'user.email=reviewer@example.com',
        'commit-tree', tree, '-p', review, '-m', 'concurrent reviewer contribution'], { cwd: origin, encoding: 'utf8' }).trim();
      sh(origin, 'update-ref', 'refs/heads/ci/submodule-advance', concurrent, review);
    }
    return chainStatus(url, pin, head);
  };
  assert.throws(() => run(work, { branch: 'ci/submodule-advance', head: u => u.endsWith('s1') ? C : A, status }), /git push/);
  assert.equal(sh(origin, 'rev-parse', 'ci/submodule-advance'), concurrent);
  sh(origin, 'merge-base', '--is-ancestor', review, concurrent);
});

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
