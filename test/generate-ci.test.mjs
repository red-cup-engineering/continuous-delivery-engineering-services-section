import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect, generate, renderCi, renderSync, REUSABLE, REF } from '../generator/generate-ci.mjs';

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
  assert.match(y, /lean-proofs:\n    uses: .*\/lean\.yml@[a-f0-9]{40}\n    with:\n      working-directory: proofs/);
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
  for (const w of ['node-package', 'lean', 'content']) assert.ok(y.includes(`${REUSABLE}/${w}.yml@${REF}`), w);
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
  assert.match(y, /superrepo-advance\.yml@[a-f0-9]{40}/);
  assert.match(y, /notify-parent\.yml@[a-f0-9]{40}/);
  assert.match(y, /parent: o\/parent/);
  assert.equal(renderSync({ submodules: false }), null);
});

test('current machine-neutral generator does not assign a package to implicit machines',()=>{
  assert.equal(generate(fixture({'package.json':'{}'})).files['.github/workflows/change-test.yml'],undefined);
});
