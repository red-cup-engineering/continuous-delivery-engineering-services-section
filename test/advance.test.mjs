import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plan, renderBody, readEntries, run, githubSlug, BOT_EMAIL } from '../scripts/advance.mjs';

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cds-adv-'));
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);

const compareEndpoint = (pin = A, head = B) => `https://api.github.com/repos/o/s1/compare/${pin}...${head}`;
const compareMetadata = (overrides = {}) => ({
  url: compareEndpoint(), base_commit: { sha: A }, merge_base_commit: { sha: A },
  status: 'ahead', ahead_by: 80, behind_by: 0, total_commits: 80, commits: [{ sha: C }], ...overrides,
});

// Exercise the real child-process transport without a network or credential.
// An unpaged response includes the large patches that caused the live refusal.
function transport(t, paged, { unpaged = paged, exitCode = 0, pin = A, head = B, url = 'https://github.com/o/s1.git' } = {}) {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'response.json'), JSON.stringify({ paged, unpaged, exitCode }));
  fs.writeFileSync(path.join(dir, 'curl'), `#!${process.execPath}\n
const fs = require('node:fs'), path = require('node:path');
const dir = __dirname, args = process.argv.slice(2), input = fs.readFileSync(0, 'utf8');
fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ args, input }));
const response = JSON.parse(fs.readFileSync(path.join(dir, 'response.json')));
if (response.exitCode) process.exit(response.exitCode);
const body = args.at(-1).endsWith('?per_page=1&page=2') ? response.paged : response.unpaged;
process.stdout.write(typeof body === 'string' ? body : JSON.stringify(body));
`, { mode: 0o755 });
  const engine = new URL('../scripts/advance.mjs', import.meta.url).href;
  const script = `import {liveDeps} from ${JSON.stringify(engine)}; console.log(liveDeps('fixture-token').status(...JSON.parse(process.argv[1])));`;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([url, pin, head])], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, GIT_CONFIG_COUNT: '0' },
  }).trim();
  const requestFile = path.join(dir, 'request.json');
  const request = fs.existsSync(requestFile) ? JSON.parse(fs.readFileSync(requestFile)) : null;
  if (request) {
    assert.deepEqual(request.args, ['-fsS', '--config', '-', '-H', 'Accept: application/vnd.github+json', `${compareEndpoint(pin, head)}?per_page=1&page=2`]);
    assert.equal(request.input, 'header = "Authorization: Bearer fixture-token"\n');
  }
  return { result, request };
}

test('live ancestry reads bounded aggregate metadata instead of overflowing on comparison patches', t => {
  const paged = compareMetadata();
  const unpaged = { ...paged, files: [{ filename: 'large.txt', patch: 'x'.repeat(2 * 1024 * 1024) }] };
  assert.equal(transport(t, paged, { unpaged }).result, 'ahead');
});

for (const [name, pin, head, value] of [
  ['single descendant with empty second page', A, B, compareMetadata({ ahead_by: 1, total_commits: 1, commits: [] })],
  ['identical with empty second page', A, A, compareMetadata({ url: compareEndpoint(A, A), status: 'identical', ahead_by: 0, total_commits: 0, commits: [] })],
  ['behind with empty second page', A, B, compareMetadata({ status: 'behind', merge_base_commit: { sha: B }, ahead_by: 0, behind_by: 80, total_commits: 0, commits: [] })],
  ['diverged', A, B, compareMetadata({ status: 'diverged', merge_base_commit: { sha: C }, behind_by: 3 })],
]) test(`live ancestry preserves aggregate ${name}`, t => {
  assert.equal(transport(t, value, { pin, head }).result, value.status);
});

for (const [name, changes] of [
  ['foreign repository', { url: compareEndpoint().replace('/o/s1/', '/other/s1/') }],
  ['different head', { url: compareEndpoint(A, C) }],
  ['foreign base', { base_commit: { sha: C } }],
  ['unproven ancestor', { merge_base_commit: { sha: C } }],
  ['missing ancestor', { merge_base_commit: null }],
  ['non-string ancestor', { merge_base_commit: { sha: [A] } }],
  ['contradictory counts', { behind_by: 1 }],
  ['fractional count', { ahead_by: 1.5, total_commits: 1.5 }],
  ['missing totals', { total_commits: null }],
  ['page-local totals', { total_commits: 1 }],
  ['unexpected status', { status: 'unavailable' }],
  ['unexpected file page', { files: [] }],
  ['unbounded commit page', { commits: [{ sha: B }, { sha: C }] }],
]) test(`live ancestry refuses ${name}`, t => {
  assert.equal(transport(t, compareMetadata(changes)).result, 'unknown');
});

test('live ancestry refuses malformed, failed and oversized metadata without a fallback request', t => {
  assert.equal(transport(t, '{').result, 'unknown');
  assert.equal(transport(t, compareMetadata(), { exitCode: 22 }).result, 'unknown');
  assert.equal(transport(t, compareMetadata({ extra: 'x'.repeat(2 * 1024 * 1024) })).result, 'unknown');
});

test('live ancestry requires exact input SHAs before requesting comparison', t => {
  for (const value of ['main', 'a'.repeat(39), `${A}?page=1`, '', [A], null]) for (const field of ['pin', 'head']) {
    const { result, request } = transport(t, compareMetadata(), { [field]: value });
    assert.equal(result, 'unknown'); assert.equal(request, null);
  }
});

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
function conflictingParent({ ours = B, theirs = C, ours2 = A, theirs2 = A, edit, editReview, initialEdit } = {}) {
  const result = parent(), { origin, work } = result;
  if (initialEdit) {
    initialEdit(work); sh(work, 'add', '.gitmodules'); sh(work, 'commit', '-q', '-m', 'original supplier definitions'); sh(work, 'push', '-q', 'origin', 'main');
  }
  run(work, { branch: 'ci/submodule-advance', head: u => u.endsWith('s1') ? ours : ours2, status: () => 'ahead' });
  fs.writeFileSync(path.join(work, 'reviewer.txt'), 'retain reviewer source\n');
  editReview?.(work);
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

test('an unrelated clean supplier addition does not block unchanged conflicting supplier ancestry', () => {
  const fixture = conflictingParent({ edit(work) {
    fs.appendFileSync(path.join(work, '.gitmodules'), '[submodule "group-computer-engineering"]\n\tpath = group-computer-engineering\n\turl = https://github.com/561-group/computer-engineering-services-section.git\n');
    sh(work, 'add', '.gitmodules');
    sh(work, 'update-index', '--add', '--cacheinfo', `160000,${A},group-computer-engineering`);
  } });
  const { origin, work, review, base } = fixture;
  const result = run(work, { branch: 'ci/submodule-advance', head: u => u.endsWith('s1') ? C : A, status: chainStatus });
  assert.equal(result.result, 'advanced');
  assert.equal(pin(origin, 'ci/submodule-advance', 's1'), C);
  assert.equal(pin(origin, 'ci/submodule-advance', 'group-computer-engineering'), A);
  assert.equal(sh(origin, 'show', 'ci/submodule-advance:.gitmodules'), sh(origin, 'show', `${base}:.gitmodules`));
  const joined = sh(origin, 'rev-parse', 'ci/submodule-advance');
  assert.deepEqual(sh(origin, 'show', '-s', '--format=%P', joined).split(' '), [review, base]);
  for (const source of [review, base]) sh(origin, 'merge-base', '--is-ancestor', source, joined);
  sh(work, 'checkout', '-q', 'main');
  assert.equal(run(work, { branch: 'ci/submodule-advance', head: u => u.endsWith('s1') ? C : A, status: chainStatus }).result, 'nothing to advance');
  assert.equal(sh(origin, 'rev-parse', 'ci/submodule-advance'), joined);
});

for (const [name, edit] of [
  ['branch', work => sh(work, 'config', '-f', '.gitmodules', 'submodule.s1.branch', 'other')],
  ['ref metadata', work => sh(work, 'config', '-f', '.gitmodules', 'submodule.s1.ref', 'refs/heads/other')],
  ['path', work => sh(work, 'config', '-f', '.gitmodules', 'submodule.s1.path', 'relocated')],
  ['section rename', work => sh(work, 'config', '-f', '.gitmodules', '--rename-section', 'submodule.s1', 'submodule.renamed')],
  ['definition removal', work => sh(work, 'config', '-f', '.gitmodules', '--remove-section', 'submodule.s1')],
  ['duplicate URL', work => sh(work, 'config', '-f', '.gitmodules', '--add', 'submodule.s1.url', 'https://github.com/o/s1')],
  ['duplicate path', work => sh(work, 'config', '-f', '.gitmodules', '--add', 'submodule.s1.path', 's1')],
  ['alias path', work => {
    sh(work, 'config', '-f', '.gitmodules', 'submodule.alias.path', 's1');
    sh(work, 'config', '-f', '.gitmodules', 'submodule.alias.url', 'https://github.com/o/s1');
  }],
]) {
  test(`conflicting supplier ${name} change remains refused before ancestry lookup or publication`, () => {
    const fixture = conflictingParent({ edit(work) { edit(work); sh(work, 'add', '.gitmodules'); } });
    let observations = 0;
    assert.throws(() => run(fixture.work, { branch: 'ci/submodule-advance', head: () => C,
      status: () => { observations++; return 'ahead'; } }), /supplier definitions changed|ambiguous supplier path|ambiguous conflicting supplier/);
    assert.equal(observations, 0);
    assertNotPublished(fixture);
  });
}

for (const field of ['url', 'branch', 'ref', 'ignore']) {
  test(`unchanged duplicate ${field} values remain ambiguous across all four conflicting snapshots`, () => {
    const fixture = conflictingParent({ initialEdit(work) {
      const value = field === 'url' ? 'https://github.com/o/s1' : field === 'ignore' ? 'none' : 'main';
      sh(work, 'config', '-f', '.gitmodules', `submodule.s1.${field}`, value);
      sh(work, 'config', '-f', '.gitmodules', '--add', `submodule.s1.${field}`, value);
    } });
    let observations = 0;
    assert.throws(() => run(fixture.work, { branch: 'ci/submodule-advance', head: () => C,
      status: () => { observations++; return 'ahead'; } }), /ambiguous conflicting supplier values/);
    assert.equal(observations, 0); assertNotPublished(fixture);
  });
}

test('normal supplier reads and conflict qualification both ignore external include directives', () => {
  const { work } = parent();
  const external = path.join(work, 'external-config');
  fs.writeFileSync(external, '[submodule "s1"]\nurl = https://github.com/another/s1\nbranch = other\n');
  fs.appendFileSync(path.join(work, '.gitmodules'), `[include]\npath = ${external}\n`);
  // Git's explicitly selected file defaults to includes disabled. Pin that
  // behavior in both consumers rather than letting ambient configuration win.
  assert.equal(sh(work, 'config', '-f', '.gitmodules', 'submodule.s1.url'), sh(work, 'config', '--no-includes', '-f', '.gitmodules', 'submodule.s1.url'));
  const entries = readEntries(work, { head: () => A, status: () => 'identical' });
  assert.deepEqual(entries.map(e => e.path), ['s1', 's2']);
  assert.equal(entries.find(e => e.path === 's1').url, 'https://github.com/o/s1');
  assert.equal(entries.find(e => e.path === 's1').branch, '');
  const fixture = conflictingParent({ initialEdit(work) {
    fs.writeFileSync(path.join(work, 'external-config'), '[submodule "s1"]\nurl = https://github.com/another/s1\n');
    fs.appendFileSync(path.join(work, '.gitmodules'), '[include]\npath = external-config\n');
  } });
  const observed = [];
  const result = run(fixture.work, { branch: 'ci/submodule-advance', head: u => u.endsWith('s1') ? C : A,
    status: (url, pin, head) => { observed.push(url); return chainStatus(url, pin, head); } });
  assert.equal(result.result, 'advanced'); assert.deepEqual(result.unread, []);
  assert.equal(pin(fixture.origin, 'ci/submodule-advance', 's1'), C);
  assert.ok(observed.length > 0 && observed.every(url => url === 'https://github.com/o/s1'));
});

test('an actual conflicting supplier definition stays a text conflict', () => {
  const fixture = conflictingParent({
    editReview(work) { sh(work, 'config', '-f', '.gitmodules', 'submodule.s1.url', 'https://github.com/reviewer/s1'); sh(work, 'add', '.gitmodules'); },
    edit(work) { sh(work, 'config', '-f', '.gitmodules', 'submodule.s1.url', 'https://github.com/base/s1'); sh(work, 'add', '.gitmodules'); },
  });
  assert.throws(() => run(fixture.work, { branch: 'ci/submodule-advance', head: () => C, status: chainStatus }), /non-gitlink base merge conflict: .gitmodules/);
  assertNotPublished(fixture);
});

test('supplier definition file mode changes cannot be excused by matching values', () => {
  const fixture = conflictingParent({ edit(work) { fs.chmodSync(path.join(work, '.gitmodules'), 0o755); sh(work, 'add', '.gitmodules'); } });
  assert.throws(() => run(fixture.work, { branch: 'ci/submodule-advance', head: () => C, status: chainStatus }), /supplier definitions changed file mode/);
  assertNotPublished(fixture);
});

test('supplier definition symlink replacement remains refused', () => {
  const fixture = conflictingParent({ edit(work) {
    fs.unlinkSync(path.join(work, '.gitmodules')); fs.symlinkSync('not-a-supplier-definition', path.join(work, '.gitmodules'));
    sh(work, 'add', '.gitmodules');
  } });
  assert.throws(() => run(fixture.work, { branch: 'ci/submodule-advance', head: () => C, status: chainStatus }), /supplier definitions.*file kind|non-gitlink base merge conflict/);
  assert.equal(sh(fixture.origin, 'rev-parse', 'ci/submodule-advance'), fixture.review);
  assert.equal(sh(fixture.work, 'rev-parse', 'HEAD'), fixture.base);
  assert.equal(sh(fixture.work, 'status', '--porcelain', '--ignore-submodules=all'), '');
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
