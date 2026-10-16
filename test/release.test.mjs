import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pullOnce, sri } from '../src/release/puller.mjs';
import { shaVersion } from '../src/release/version.mjs';
import { planPublish, publishAll, promoteArgs } from '../src/release/publish.mjs';

function tarball(version) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
  fs.mkdirSync(path.join(d, 'package'));
  fs.writeFileSync(path.join(d, 'package', 'package.json'), JSON.stringify({ name: '@x/svc', version }));
  return execFileSync('tar', ['-cz', '-C', d, 'package']);
}
// A registry that speaks the part of the npm protocol the puller uses.
function registry({ tag = 'production', versions = {}, down = false, badIntegrity = false } = {}) {
  const srv = http.createServer((req, res) => {
    if (down) { res.writeHead(502, { 'retry-after': '120' }); return res.end(); }
    if (req.url.startsWith('/tgz/')) { const v = req.url.slice(5); res.writeHead(200); return res.end(versions[v]); }
    const body = JSON.stringify({ name: '@x/svc', 'dist-tags': { [tag]: srv.live }, versions: Object.fromEntries(Object.entries(versions).map(([v, b]) => [v, { dist: { tarball: `${srv.base}/tgz/${v}`, integrity: badIntegrity ? 'sha512-AAAA' : sri(b) } }])) });
    const etag = `"${createHash('sha1').update(body).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { etag, 'content-type': 'application/json' }); res.end(body);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => { srv.base = `http://127.0.0.1:${srv.address().port}`; r(srv); }));
}
function machine({ healthy = () => true } = {}) {
  let state = {}; const log = [];
  return { log, get state() { return state; }, deps: {
    fetch: (u, o) => fetch(u, o), readState: async () => state, writeState: async s => { state = s; },
    install: async v => log.push(`install ${v}`), activate: async v => log.push(`activate ${v}`),
    restart: async () => log.push('restart'), health: async () => healthy(log),
  } };
}
const V1 = shaVersion('1.0.0', 'a'.repeat(12)), V2 = shaVersion('1.0.0', 'b'.repeat(12));

test('a version is a semver prerelease tagged with the commit', () => {
  assert.equal(shaVersion('1.4.0', '0123456789abcdef'), '1.4.0-sha.0123456789ab');
  assert.throws(() => shaVersion('v1', 'abc1234'));
});

test('pull: activates the tagged version, then is a no-op on a 304', async () => {
  const srv = await registry({ versions: { [V1]: tarball(V1) } }); srv.live = V1;
  const m = machine();
  const a = await pullOnce({ registry: srv.base, name: '@x/svc', tag: 'production', deps: m.deps });
  assert.equal(a.result, 'activated');
  assert.deepEqual(m.log, [`install ${V1}`, `activate ${V1}`, 'restart']);
  const b = await pullOnce({ registry: srv.base, name: '@x/svc', tag: 'production', deps: m.deps });
  assert.equal(b.result, 'unchanged');
  srv.close();
});

test('pull: promoting a new version activates it; moving the tag back is the rollback', async () => {
  const srv = await registry({ versions: { [V1]: tarball(V1), [V2]: tarball(V2) } }); srv.live = V1;
  const m = machine(); const go = () => pullOnce({ registry: srv.base, name: '@x/svc', tag: 'production', deps: m.deps });
  await go(); srv.live = V2; assert.equal((await go()).version, V2);
  assert.equal(m.state.previous, V1);
  srv.live = V1; const back = await go();
  assert.equal(back.result, 'activated'); assert.equal(m.state.active, V1);
  srv.close();
});

test('pull: a tarball whose digest differs from the packument is refused and nothing is installed', async () => {
  const srv = await registry({ versions: { [V1]: tarball(V1) }, badIntegrity: true }); srv.live = V1;
  const m = machine();
  const r = await pullOnce({ registry: srv.base, name: '@x/svc', tag: 'production', deps: m.deps });
  assert.equal(r.reason, 'integrity-mismatch'); assert.deepEqual(m.log, []);
  srv.close();
});

test('pull: when the registry answers 502 the active version is kept', async () => {
  const srv = await registry({ down: true });
  const m = machine(); m.deps.readState = async () => ({ active: V1 });
  const r = await pullOnce({ registry: srv.base, name: '@x/svc', tag: 'production', deps: m.deps });
  assert.deepEqual([r.result, r.keeps], ['registry-unavailable', V1]);
  srv.close();
});

test('pull: a failed health check returns to the previous version', async () => {
  const srv = await registry({ versions: { [V1]: tarball(V1), [V2]: tarball(V2) } }); srv.live = V1;
  let bad = false; const m = machine({ healthy: () => !bad });
  const go = () => pullOnce({ registry: srv.base, name: '@x/svc', tag: 'production', deps: m.deps });
  await go(); bad = true; srv.live = V2;
  const r = await go();
  assert.deepEqual([r.result, r.failed, r.to], ['rolled-back', V2, V1]);
  assert.equal(m.log.filter(x => x.startsWith('activate')).at(-1), `activate ${V1}`);
  srv.close();
});

test('publish: dependencies first, exact internal versions, a cycle is refused, promotion is a tag move', async () => {
  const pk = [{ name: 'a', dir: 'a', base: '1.0.0', dependsOn: ['b'] }, { name: 'b', dir: 'b', base: '2.0.0', dependsOn: [] }];
  const plan = planPublish(pk, 'c'.repeat(40));
  assert.deepEqual(plan.map(p => p.name), ['b', 'a']);
  assert.equal(plan[1].internal.b, plan[0].version);
  assert.throws(() => planPublish([{ name: 'a', dir: 'a', base: '1.0.0', dependsOn: ['a'] }], 'c'.repeat(40)), /cycle/);
  const cyc = planPublish([{ name: 'a', dir: 'a', base: '1.0.0', dependsOn: ['b'] }, { name: 'b', dir: 'b', base: '1.0.0', dependsOn: ['a'] }], 'c'.repeat(40), { failOnCycle: false });
  assert.equal(cyc.length, 2); assert.deepEqual(cyc.cycles[0], ['a', 'b', 'a']);
  const calls = []; const r = await publishAll({ plan, registry: 'https://registry.561.group', run: async (c, a) => (calls.push(a), { status: 0 }) });
  assert.equal(r.ok, true); assert.ok(calls[0].includes('--tag') && calls[0].includes('candidate'));
  const stop = await publishAll({ plan, registry: 'r', run: async () => ({ status: 1 }) });
  assert.deepEqual([stop.ok, stop.failedAt], [false, 'b']);
  assert.deepEqual(promoteArgs('a', plan[1].version, 'production', 'r').slice(0, 2), ['dist-tag', 'add']);
});

import { indexPackages, closureOf, rewriteManifest, planClosure, planUnit } from '../src/release/closure.mjs';
test('closure: follows internal dependencies, rewrites workspace ranges to exact versions, ignores external ones', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const mk = (n, m) => { fs.mkdirSync(path.join(d, n)); fs.writeFileSync(path.join(d, n, 'package.json'), JSON.stringify({ version: '1.2.3', ...m })); };
  mk('svc', { name: '@x/svc', dependencies: { '@x/lib': 'workspace:*', yaml: '2.8.3' } });
  mk('lib', { name: '@x/lib', dependencies: { '@x/deep': 'workspace:*' }, devDependencies: { t: '1' } });
  mk('deep', { name: '@x/deep' });
  mk('other', { name: '@x/other' });
  mk('lost', { name: '@x/lost', dependencies: { '@x/absent': 'workspace:*' } });
  const index = indexPackages([d]);
  const c = closureOf('@x/svc', index);
  assert.deepEqual(c.packages.map(p => p.name).sort(), ['@x/deep', '@x/lib', '@x/svc']);
  assert.deepEqual(closureOf('@x/lost', index).missing, ['@x/absent']);
  const { plan } = planClosure('@x/svc', index, 'd'.repeat(40));
  assert.deepEqual(plan.map(p => p.name), ['@x/deep', '@x/lib', '@x/svc']);
  const svc = plan.at(-1);
  const m = rewriteManifest(index.get('@x/svc').manifest, svc.version, svc.internal);
  assert.equal(m.dependencies['@x/lib'], plan[1].version);
  assert.equal(m.dependencies.yaml, '2.8.3');
  const lib = plan.find(p => p.name === '@x/lib');
  const rewrittenLib = rewriteManifest(index.get('@x/lib').manifest, lib.version, lib.internal);
  assert.equal(rewrittenLib.devDependencies, undefined);
  assert.equal(rewrittenLib.dependencies['@x/deep'], plan[0].version);
  assert.equal(index.get('@x/lib').manifest.dependencies['@x/deep'], 'workspace:*');
  assert.throws(() => rewriteManifest(index.get('@x/lib').manifest, lib.version, {}), /unresolved-local-dependency:@x\/lib:@x\/deep/);
  assert.throws(()=>rewriteManifest(index.get('@x/lost').manifest,'v',{}),/unresolved-local-dependency:@x\/lost:@x\/absent/);
  assert.equal(index.get('@x/lost').manifest.dependencies['@x/absent'],'workspace:*');
  const original={name:'@x/test',scripts:{prepare:'node create.js',start:'node run.js'},optionalDependencies:{'@x/remote':'file:../remote'}};
  assert.throws(()=>rewriteManifest(original,'1.0.0',{}),/unresolved-local-dependency:@x\/test:@x\/remote/);
  assert.equal(original.scripts.prepare,'node create.js');
  const safe=rewriteManifest({...original,optionalDependencies:{'@x/remote':'1.2.3'}},'1.0.0',{});
  assert.equal(safe.optionalDependencies['@x/remote'],'1.2.3');
  assert.equal(safe.scripts.prepare,undefined);
  assert.equal(safe.scripts.start,'node run.js');
  assert.equal(original.scripts.prepare,'node create.js');
});

test('unit: names one checkout\'s packages, shares one version among them, and sends every other internal dependency to the registry', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-'));
  const mk = (n, m) => { fs.mkdirSync(path.join(d, n)); fs.writeFileSync(path.join(d, n, 'package.json'), JSON.stringify({ version: '1.2.3', ...m })); };
  mk('a', { name: '@x/a', dependencies: { '@x/b': 'workspace:*', '@x/earlier': 'workspace:*', '@x/nowhere': 'workspace:*', yaml: '2.8.3' } });
  mk('b', { name: '@x/b', dependencies: { '@x/a': 'workspace:*' } });
  mk('earlier', { name: '@x/earlier' });
  const index = indexPackages([d]);
  const u = planUnit(['@x/a', '@x/b'], index, 'e'.repeat(40));
  assert.deepEqual(u.absent, []);
  assert.deepEqual(u.external['@x/a'].sort(), ['@x/earlier', '@x/nowhere']);
  assert.equal(u.cycles.length, 1);
  assert.equal(new Set(u.plan.map(p => p.version)).size, 1);
  assert.deepEqual(planUnit(['@x/ghost'], index, 'e'.repeat(40)).absent, ['@x/ghost']);
});

import { publishPacked, readPublishToken, writeNpmrc } from '../src/release/publish-packed.mjs';
test('publish-packed: token from the credential directory only, dependencies first, present versions are idempotent, root is promoted', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-'));
  assert.throws(() => readPublishToken({}), /credential-missing/);
  assert.throws(() => readPublishToken({ CREDENTIALS_DIRECTORY: d }), /credential-missing/);
  fs.writeFileSync(path.join(d, 'registry-publish-token'), 'secret-token\n');
  const token = readPublishToken({ CREDENTIALS_DIRECTORY: d });
  assert.equal(token, 'secret-token');
  const rc = writeNpmrc(path.join(d, 'w'), 'https://registry.561.group/', token);
  assert.equal(fs.statSync(rc).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(rc, 'utf8'), '//registry.561.group/:_authToken=secret-token\n');
  const plan = { root: 'a', files: [{ name: 'b', version: '1.0.0-sha.abc1234', tarball: 'b.tgz' }, { name: 'a', version: '1.0.0-sha.abc1234', tarball: 'a.tgz' }] };
  const calls = [];
  const ok = await publishPacked({ plan, packDir: '/p', registry: 'https://r/', npmrc: rc, run: async (c, a) => (calls.push(a), { status: 0 }) });
  assert.deepEqual([ok.ok, ok.promoted, ok.root], [true, 'production', 'a@1.0.0-sha.abc1234']);
  assert.equal(calls[0][1], '/p/b.tgz'); assert.deepEqual(calls[2].slice(0, 2), ['dist-tag', 'add']);
  assert.ok(calls.every(a => !a.join(' ').includes('secret-token')));
  const again = await publishPacked({ plan, packDir: '/p', registry: 'r', npmrc: rc, run: async (c, a) => (a[0] === 'publish' ? { status: 1, stderr: 'You cannot publish over the previously published versions' } : { status: 0 }) });
  assert.deepEqual([again.ok, again.published.length, again.present.length], [true, 0, 2]);
  const bad = await publishPacked({ plan, packDir: '/p', registry: 'r', npmrc: rc, run: async () => ({ status: 1, stderr: 'E401' }) });
  assert.deepEqual([bad.ok, bad.failedAt], [false, 'b']);
});
