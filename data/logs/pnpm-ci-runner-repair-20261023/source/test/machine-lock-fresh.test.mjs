import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readLock, verdict} from '../scripts/machine-lock-fresh.mjs';

test('the ratchet fails a stale head only over a fresh base, and an unreadable head always', () => {
  assert.deepEqual(verdict({state: 'fresh'}, undefined), {fails: false, summary: 'fresh'});
  assert.equal(verdict({state: 'stale'}, undefined).fails, true);
  assert.equal(verdict({state: 'stale'}, {state: 'fresh'}).fails, true);
  assert.deepEqual(verdict({state: 'stale'}, {state: 'stale'}), {fails: false, summary: 'stale, as the base already was'});
  assert.equal(verdict({state: 'unreadable'}, {state: 'stale'}).fails, true);
  assert.deepEqual(verdict({state: 'unreadable'}, {state: 'unreadable'}), {fails: true, summary: 'unreadable'});
});

test('a snapshot without a committed lock or a controller owner is unreadable, and nothing is cloned', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'machine-lock-fresh-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  writeFileSync(join(root, 'sources.json'), JSON.stringify({repositories: [], owners: {}}));
  assert.match(readLock(root, join(root, 'work')).reason, /dependencies\.lock\.yaml/);
  writeFileSync(join(root, 'dependencies.lock.yaml'), "lockfileVersion: '9.0'\n");
  assert.match(readLock(root, join(root, 'work')).reason, /names no owner/);
});
