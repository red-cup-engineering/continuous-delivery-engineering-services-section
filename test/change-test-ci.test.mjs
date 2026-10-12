import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { machineEntry, machinesPinning } from '../scripts/pinning-machines.mjs';
import { MARKER, overallVerdict, readResults, renderComment, upsertComment } from '../scripts/change-test-comment.mjs';

import {evidence} from './fixtures/source-evidence.mjs';

const sources = (...repositories) => ({ repositories: repositories.map((repository) => ({ repository, commit: 'a'.repeat(40) })) });

test('a foreign marker cannot make the workflow overwrite another author\'s comment',async()=>{
  for(const user of [undefined,{login:'contributor'},{login:'github-actions'},{login:'another-bot[bot]'}]){
    const writes=[];
    const request=async(method,url,body)=>{
      if(method==='GET')return [{id:7,user,body:MARKER+'\nforeign content'}];
      writes.push([method,url,body]);return {html_url:'https://example.invalid/report'};
    };
    await upsertComment({repo:'o/r',pr:1,body:MARKER+'\nreport',request});
    assert.deepEqual(writes.map(([method,url])=>[method,url]),[['POST','/repos/o/r/issues/1/comments']]);
  }
});

test('a change is tested against every machine that pins its repository, and only those', () => {
  const readings = {
    'emsenn/cold-red-gate': sources('red-cup-engineering/computer-data-services-section', 'red-cup-engineering/feltos'),
    'emsenn/bare-cedar-fog': sources('red-cup-engineering/feltos'),
  };
  assert.deepEqual(machinesPinning('red-cup-engineering/feltos', readings), ['emsenn/cold-red-gate', 'emsenn/bare-cedar-fog']);
  assert.deepEqual(machinesPinning('Red-Cup-Engineering/Computer-Data-Services-Section', readings), ['emsenn/cold-red-gate']);
  assert.deepEqual(machinesPinning('red-cup-engineering/unpinned', readings), []);
  // Unreadable machines make discovery unknown, rather than silently shrinking its coverage.
  assert.throws(() => machinesPinning('red-cup-engineering/feltos', { 'm/broken': null }), /unread/);
});

const leg = (machine, verdict) => ({ machine, machineCommit: 'b'.repeat(40), commit: 'c'.repeat(40), verdict, logTail: 'tail' });

test('the one comment reports every machine, its worst verdict first, and the design rules added and removed', () => {
  const regression = { verdict: 'regression', regressions: 1, lock: 'frozen',
    packages: [{ name: '@x/a', tests: 3, passed: 2, regressions: ['test/a.test.mjs'], preexisting: [] }],
    designRules: { added: [{ key: 'drc-3:@x/a:src/s.mjs:node:sqlite' }], removed: ['drc-2:@x/b'] } };
  const clean = { verdict: 'no-regression', regressions: 0, lock: 'frozen', packages: [], designRules: { added: [], removed: [] } };
  assert.equal(overallVerdict([leg('m/one', clean), leg('m/two', regression)]), 'regression');
  assert.equal(overallVerdict([leg('m/one', clean), leg('m/two', null)]), 'not-run');
  assert.equal(overallVerdict([leg('m/one', clean)]), 'no-regression');
  const body = renderComment([leg('m/one', clean), leg('m/two', regression)]);
  assert.ok(body.startsWith(MARKER), 'the comment is found again by its marker');
  assert.match(body, /## Change test: `regression`/);
  assert.match(body, /### m\/one @ `bbbbbbbbb`: `no-regression`/);
  assert.match(body, /\| `@x\/a` \| 2\/3 passed \| `test\/a\.test\.mjs` \| 0 \|/);
  assert.match(body, /Design rules \*\*added\*\* \(1\): `drc-3:@x\/a:src\/s\.mjs:node:sqlite`/);
  assert.match(body, /Design rules removed \(1\): `drc-2:@x\/b`/);
  // A leg with no verdict shows its log instead of passing silently.
  assert.match(renderComment([leg('m/one', null)]), /produced no verdict[\s\S]*tail/);
  assert.match(renderComment([], { none: 'o/r', expected: [], discovery: 'success' }), /No candidate machine pins `o\/r`/);
});

test('the results directory is read leg by leg; a leg with an empty verdict reads as none', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'change-test-results-'));
  try {
    const expected = ['one', 'two'].map((name) => machineEntry(`m/${name}`, 'b'.repeat(40)));
    const commit = 'c'.repeat(40);
    const preparationByMachine=Object.fromEntries(expected.map(entry=>[entry.machine,evidence({...entry,repository:'o/r',commit}).expected]));
    for (const [name, verdict] of [['one', JSON.stringify(evidence({...expected[0],repository:'o/r',commit}).verdict)], ['two', '']]) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, 'meta.json'), JSON.stringify({ ...expected.find((entry) => entry.machine === `m/${name}`), commit, status: 0 }));
      fs.writeFileSync(path.join(root, name, 'verdict.json'), verdict);
      fs.writeFileSync(path.join(root, name, 'log-tail.txt'), `log of ${name}`);
    }
    const results = readResults(root, { expected, commit, repository: 'o/r', discovery: 'success', controllerCommit:'d'.repeat(40), preparationByMachine });
    assert.deepEqual(results.map((r) => [r.machine, r.verdict?.verdict ?? null, r.logTail]), [['m/one', 'no-regression', 'log of one'], ['m/two', null, 'log of two']]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the comment is updated in place when it exists and created once when it does not', async () => {
  const calls = [];
  const requestWith = (pages) => async (method, url, body) => {
    calls.push([method, url, body?.body]);
    if (method === 'GET') return pages[Number(new URL(url, 'https://x').searchParams.get('page')) - 1] ?? [];
    return { html_url: `${method} ${url}` };
  };
  const others = Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'someone else' }));
  // The marked comment on the second page is found and patched; nothing new is posted.
  assert.equal(await upsertComment({ repo: 'o/r', pr: 7, body: `${MARKER}\nnew`, request: requestWith([others, [{ id: 555, user: {login:'github-actions[bot]'}, body: `${MARKER}\nold` }]]) }),
    'PATCH /repos/o/r/issues/comments/555');
  assert.ok(!calls.some(([method]) => method === 'POST'));
  calls.length = 0;
  assert.equal(await upsertComment({ repo: 'o/r', pr: 7, body: `${MARKER}\nnew`, request: requestWith([[{ id: 1, body: 'unrelated' }]]) }),
    'POST /repos/o/r/issues/7/comments');
  assert.deepEqual(calls.filter(([method]) => method !== 'GET'), [['POST', '/repos/o/r/issues/7/comments', `${MARKER}\nnew`]]);
});
