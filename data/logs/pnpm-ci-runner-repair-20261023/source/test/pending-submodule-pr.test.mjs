import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { receiveSubmodulePull } from '../scripts/submodule-pr.mjs';

const repo = '561-group/bare-cedar-fog', base = 'main', branch = 'ci/submodule-advance';
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const body = `Advanced:\n- supplier: aaaaaaaaa -> bbbbbbbbb\n\nLiteral $(touch injected), \`echo unsafe\`, $TOKEN\n\nObserved base: ${A}\nObserved head: ${B}\n`;
const proposal = { branch, baseSha: A, headSha: B, body };
const pr = () => ({ number: 796, state: 'open', html_url: `https://github.com/${repo}/pull/796`, body: 'stale',
  head: { ref: branch, sha: B, repo: { full_name: repo } }, base: { ref: base, sha: A, repo: { full_name: repo } } });

function fixture({ mode = 'existing', mutatePull } = {}) {
  const calls = [];
  let pull = mode.startsWith('missing') ? null : pr();
  if (mode.startsWith('identical')) pull.body = body;
  mutatePull?.(pull);
  let refReads = 0, writes = 0;
  const request = async (method, endpoint, value) => {
    calls.push({ method, endpoint, value });
    if (method === 'GET' && endpoint.includes('/git/ref/heads/')) {
      const name = decodeURIComponent(endpoint.split('/git/ref/heads/')[1]);
      refReads++;
      const stale = mode === 'stale-base' && name === base || mode === 'stale-head' && name === branch ||
        mode === 'concurrent-before' && refReads > 2 || mode === 'concurrent-after' && writes > 0 ||
        mode === 'identical-stale-final-ref' && refReads > 4;
      return { ref: `refs/heads/${name}`, object: { type: 'commit', sha: stale ? C : name === base ? A : B } };
    }
    if (method === 'GET' && endpoint.includes('/pulls?')) {
      if (mode === 'lookup-failure') throw new Error('provider unavailable');
      if (mode === 'malformed') return null;
      if (mode === 'ambiguous') return [pr(), pr()];
      return pull ? [structuredClone(pull)] : [];
    }
    if (method === 'GET' && endpoint.endsWith('/pulls/796')) {
      if (mode === 'readback-failure') throw new Error('readback unavailable');
      if (mode === 'identical-readback-failure') throw new Error('readback unavailable');
      if (mode === 'identical-changed-body') pull.body = 'concurrent reviewer metadata';
      if (mode === 'identical-closed') pull.state = 'closed';
      return structuredClone(pull);
    }
    if (method === 'PATCH' || method === 'POST') {
      writes++;
      if (!['write-failure', 'missing-write-failure'].includes(mode)) {
        pull ??= pr();
        pull.body = mode === 'wrong-body' ? 'different' : value.body;
      }
      if (['write-failure', 'missing-write-failure', 'lost-response', 'missing-lost-response'].includes(mode)) throw new Error('response lost');
      return structuredClone(pull);
    }
    throw new Error(`unexpected ${method} ${endpoint}`);
  };
  return { calls, request, writes: () => calls.filter(c => c.method !== 'GET') };
}

for (const [mode, expected, method] of [['existing', 'updated', 'PATCH'], ['missing', 'created', 'POST'],
  ['lost-response', 'reconciled', 'PATCH'], ['missing-lost-response', 'reconciled', 'POST']]) {
  test(`${mode}: exact body receives through REST and readback with one write`, async () => {
    const f = fixture({ mode });
    const r = await receiveSubmodulePull({ repo, base, proposal, request: f.request });
    assert.equal(r.status, expected);
    assert.equal(r.pullRequest, `https://github.com/${repo}/pull/796`);
    assert.equal(f.writes().length, 1);
    assert.equal(f.writes()[0].method, method);
    assert.equal(f.writes()[0].value.body, body);
    const lookup = f.calls.find(c => c.endpoint.includes('/pulls?')).endpoint;
    const search = new URL('https://api.github.com' + lookup).searchParams;
    assert.equal(search.get('head'), `561-group:${branch}`);
    assert.equal(search.get('base'), base); assert.equal(search.get('state'), 'open'); assert.equal(search.get('per_page'), '2');
    assert.ok(f.calls.slice(-2).every(c => c.method === 'GET' && c.endpoint.includes('/git/ref/heads/')));
  });
}

test('already received metadata is idempotent without any write', async () => {
  const f = fixture({ mode: 'identical' });
  const r = await receiveSubmodulePull({ repo, base, proposal, request: f.request });
  assert.equal(r.status, 'unchanged'); assert.equal(f.writes().length, 0);
  assert.ok(f.calls.some(c => c.endpoint.endsWith('/pulls/796')));
});

for (const mode of ['identical-changed-body', 'identical-closed', 'identical-readback-failure', 'identical-stale-final-ref']) {
  test(`${mode} is not reported received and never writes`, async () => {
    const f = fixture({ mode });
    await assert.rejects(receiveSubmodulePull({ repo, base, proposal, request: f.request }));
    assert.equal(f.writes().length, 0);
  });
}

for (const mode of ['lookup-failure', 'malformed', 'ambiguous', 'stale-base', 'stale-head', 'concurrent-before']) {
  test(`${mode} fails before any metadata write`, async () => {
    const f = fixture({ mode });
    await assert.rejects(receiveSubmodulePull({ repo, base, proposal, request: f.request }));
    assert.equal(f.writes().length, 0);
  });
}
for (const [name, mutatePull] of [
  ['invalid number', p => p.number = '796/evil'], ['foreign repository', p => p.head.repo.full_name = 'other/repo'],
  ['foreign base repository', p => p.base.repo.full_name = 'other/repo'], ['wrong branch', p => p.head.ref = 'manual'],
  ['wrong base', p => p.base.ref = 'other'], ['stale PR head', p => p.head.sha = C],
  ['stale PR base', p => p.base.sha = C], ['closed PR', p => p.state = 'closed'],
  ['wrong URL', p => p.html_url = 'https://example.com/796'],
]) test(`${name} cannot receive automated metadata`, async () => {
  const f = fixture({ mutatePull });
  await assert.rejects(receiveSubmodulePull({ repo, base, proposal, request: f.request }));
  assert.equal(f.writes().length, 0);
});
for (const mode of ['write-failure', 'missing-write-failure', 'wrong-body', 'readback-failure', 'concurrent-after']) {
  test(`${mode} retains unresolved outcome without retry or duplicate creation`, async () => {
    const f = fixture({ mode });
    await assert.rejects(receiveSubmodulePull({ repo, base, proposal, request: f.request }), /outcome unresolved/);
    assert.equal(f.writes().length, 1);
  });
}

test('live transport sends literal JSON on stdin, no projectCards or body shell substitution', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-pr-transport-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'gh'), `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.env.CALLS,JSON.stringify({args:process.argv.slice(2),body:fs.readFileSync(0,'utf8')}));console.log('{}');\n`, { mode: 0o755 });
  const module = new URL('../scripts/submodule-pr.mjs', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `import {githubRequest} from ${JSON.stringify(module)}; githubRequest('PATCH','/repos/${repo}/pulls/796',JSON.parse(process.argv[1]));`, JSON.stringify({ body })], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: root, CALLS: path.join(root, 'calls') },
  });
  assert.equal(run.status, 0, run.stderr);
  const received = JSON.parse(fs.readFileSync(path.join(root, 'calls')));
  assert.deepEqual(received.args, ['api', '--method', 'PATCH', `repos/${repo}/pulls/796`, '--input', '-']);
  assert.deepEqual(JSON.parse(received.body), { body });
  assert.equal(fs.existsSync(path.join(root, 'injected')), false);
});
