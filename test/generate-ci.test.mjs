import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect, generate, renderCi, renderSync, REUSABLE } from '../generator/generate-ci.mjs';
import { openPullRequest } from '../generator/open-pr.mjs';

// Fixture repositories are built from a map of path -> content.
function fixture(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-fx-'));
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true });
    fs.writeFileSync(path.join(d, p), c);
  }
  return d;
}

test('empty repository selects nothing and writes no caller', () => {
  const r = generate(fixture({ 'a.txt': 'x' }));
  assert.deepEqual(r.selection, { node: false, lean: [], content: false });
  assert.deepEqual(r.files, {});
});

test('package.json selects node-package, also when nested; node_modules is ignored', () => {
  assert.equal(detect(fixture({ 'pkg/package.json': '{}' })).node, true);
  assert.equal(detect(fixture({ 'node_modules/x/package.json': '{}' })).node, false);
});

test('lakefile selects lean with its working directory', () => {
  assert.deepEqual(detect(fixture({ 'lakefile.lean': '' })).lean, ['.']);
  const y = renderCi(detect(fixture({ 'proofs/lakefile.toml': '' })));
  assert.match(y, /lean-proofs:\n    uses: .*\/lean\.yml@main\n    with:\n      working-directory: proofs/);
});

test('relative $schema selects content; remote $schema does not', () => {
  assert.equal(detect(fixture({ 'a.json': '{"$schema":"./s.json"}' })).content, true);
  assert.equal(detect(fixture({ 'a.json': '{"$schema":"https://json-schema.org/x"}' })).content, false);
  assert.equal(detect(fixture({ 'a.json': 'not json' })).content, false);
});

test('relative markdown links select content; urls, anchors and fenced code do not', () => {
  assert.equal(detect(fixture({ 'a.md': 'see [b](b.md)' })).content, true);
  assert.equal(detect(fixture({ 'a.md': '[x](https://e.com) [y](#top)' })).content, false);
  assert.equal(detect(fixture({ 'a.md': '```\n[b](b.md)\n```' })).content, false);
});

test('all three selected: short caller naming each reusable workflow', () => {
  const r = generate(fixture({ 'package.json': '{}', 'lakefile.lean': '', 'README.md': '[d](d.md)' }));
  const y = r.files['.github/workflows/ci.yml'];
  for (const w of ['node-package', 'lean', 'content']) assert.ok(y.includes(`${REUSABLE}/${w}.yml@main`), w);
  assert.ok(y.split('\n').length < 20);
  assert.match(y, /on: \[push, pull_request\]/);
});

test('handwritten workflows are reported against the covering reusable workflow', () => {
  const r = generate(fixture({
    'package.json': '{}',
    '.github/workflows/test.yml': 'steps:\n - run: npm ci\n',
    '.github/workflows/proof.yml': 'steps:\n - uses: leanprover/lean-action@v1\n',
    '.github/workflows/odd.yml': 'steps:\n - run: echo hi\n',
  }));
  const by = Object.fromEntries(r.handwritten.map(h => [h.file, h.coveredBy]));
  assert.deepEqual(by, { 'test.yml': 'node-package.yml', 'proof.yml': 'lean.yml', 'odd.yml': null });
});

test('repository with submodules gets a sync caller; a parent adds the upward notify', () => {
  const r = generate(fixture({ '.gitmodules': '' }), { parent: 'o/parent' });
  const y = r.files['.github/workflows/sync.yml'];
  assert.match(y, /superrepo-advance\.yml@main/);
  assert.match(y, /notify-parent\.yml@main/);
  assert.match(y, /parent: o\/parent/);
  assert.equal(renderSync({ submodules: false }), null);
});

test('pull request by git-data API extends an existing branch without force', async () => {
  const calls = [];
  const request = async (method, p, body) => {
    calls.push([method, p, body]);
    if (p === '/repos/o/r') return { default_branch: 'main' };
    if (p.endsWith('/git/ref/heads/ci/caller-generator')) return { object: { sha: 'b1' } };
    if (p.includes('/git/commits/')) return { tree: { sha: 't0' } };
    if (p.endsWith('/git/trees')) return { sha: 't1' };
    if (p.endsWith('/git/commits')) return { sha: 'c1' };
    if (p.includes('/pulls?')) return [];
    if (p.endsWith('/pulls')) return { html_url: 'https://github.com/o/r/pull/1' };
    return {};
  };
  const url = await openPullRequest({ repo: 'o/r', files: { '.github/workflows/ci.yml': 'x' }, request });
  assert.equal(url, 'https://github.com/o/r/pull/1');
  const patch = calls.find(c => c[0] === 'PATCH');
  assert.equal(patch[2].force, false);
  assert.deepEqual(calls.find(c => c[1].endsWith('/git/commits') && c[0] === 'POST')[2].parents, ['b1']);
  assert.ok(!calls.some(c => c[1].endsWith('/git/refs') && c[0] === 'POST'));
});
