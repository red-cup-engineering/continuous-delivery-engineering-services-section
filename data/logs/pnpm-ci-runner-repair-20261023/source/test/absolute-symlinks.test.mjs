import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {absoluteSymlinks} from '../scripts/absolute-symlinks.mjs';

test('a committed link with an absolute target fails unless an exclusion covers it; relative links pass', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'absolute-symlinks-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'lib/records'), {recursive: true});
  mkdirSync(join(root, 'lib/legacy/old'), {recursive: true});
  writeFileSync(join(root, 'lib/target.txt'), 'x');
  symlinkSync('/home/user/elsewhere/section', join(root, 'lib/records/copied'));
  symlinkSync('/home/emsenn/info/old', join(root, 'lib/legacy/old/kept'));
  symlinkSync('../target.txt', join(root, 'lib/records/relative'));
  spawnSync('git', ['init', '-q'], {cwd: root});
  spawnSync('git', ['add', '.'], {cwd: root});
  assert.deepEqual(absoluteSymlinks(root), {
    found: [{path: 'lib/records/copied', target: '/home/user/elsewhere/section'}],
    excluded: [{path: 'lib/legacy/old/kept', target: '/home/emsenn/info/old'}],
  });
  assert.equal(absoluteSymlinks(root, {exclude: ['lib/records/**', '**/legacy/**']}).found.length, 0);
});
