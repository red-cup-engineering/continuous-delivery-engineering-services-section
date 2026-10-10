import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {freshness, lockMismatches} from '../scripts/lockfile-fresh.mjs';

function workspace(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'lockfile-fresh-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), {recursive: true}); writeFileSync(join(root, path), typeof text === 'string' ? text : JSON.stringify(text)); }
  spawnSync('git', ['init', '-q'], {cwd: root}); spawnSync('git', ['add', '.'], {cwd: root});
  return root;
}
const yamlWorkspace = "packages:\n  - 'lib/**'\n  - '!**/legacy/**'\noverrides:\n  '@h/b': 'workspace:*'\n";
const lock = (importers, overrides = "  '@h/b': workspace:*\n") => `lockfileVersion: '9.0'\noverrides:\n${overrides}importers:\n${importers}`;

test('a fresh lock has no mismatches, with overrides applied to the recorded specifier', (t) => {
  const root = workspace(t, {
    'package.json': {name: 'root', private: true}, 'pnpm-workspace.yaml': yamlWorkspace,
    'lib/a/package.json': {name: '@h/a', version: '1.0.0', dependencies: {'@h/b': '0.3.0', left: '^1.0.0'}},
    'lib/b/package.json': {name: '@h/b', version: '0.3.0'},
    'lib/legacy/old/package.json': {name: '@h/old', version: '1.0.0'},
    'pnpm-lock.yaml': lock("  .: {}\n  lib/a:\n    dependencies:\n      '@h/b':\n        specifier: workspace:*\n        version: link:../b\n      left:\n        specifier: ^1.0.0\n        version: 1.0.0\n  lib/b: {}\n"),
  });
  assert.deepEqual(lockMismatches(root), []);
});

test('every kind of staleness is named, and the ratchet fails only what the head adds', (t) => {
  const files = {
    'package.json': {name: 'root', private: true}, 'pnpm-workspace.yaml': yamlWorkspace,
    'lib/a/package.json': {name: '@h/a', version: '1.0.0', dependencies: {left: '^2.0.0', added: '1.0.0', '@h/missing': 'workspace:*'}},
    'lib/b/package.json': {name: '@h/b', version: '0.3.0'},
    'lib/new/package.json': {name: '@h/new', version: '1.0.0'},
    'pnpm-lock.yaml': lock("  .: {}\n  lib/a:\n    dependencies:\n      left:\n        specifier: ^1.0.0\n        version: 1.0.0\n      gone:\n        specifier: 1.0.0\n        version: 1.0.0\n  lib/b: {}\n  lib/removed: {}\n"),
  };
  const head = workspace(t, files);
  assert.deepEqual(lockMismatches(head).map((m) => m.key), [
    'missing-importer:lib/new', 'specifier:lib/a:dependencies:left', 'stale-importer:lib/removed', 'stale-in-lock:lib/a:dependencies:gone',
    'undeclared-in-lock:lib/a:dependencies:@h/missing', 'undeclared-in-lock:lib/a:dependencies:added', 'unprovided-workspace-dependency:lib/a:@h/missing',
  ]);
  const base = workspace(t, {...files, 'lib/a/package.json': {name: '@h/a', version: '1.0.0', dependencies: {left: '^2.0.0', added: '1.0.0', '@h/missing': 'workspace:*', gone: '1.0.0'}}});
  const result = freshness(head, base);
  assert.deepEqual(result.added.map((m) => m.key), ['stale-in-lock:lib/a:dependencies:gone']);
  const clean = workspace(t, {...files, 'pnpm-lock.yaml': lock("  .: {}\n", "  '@h/b': '1.0.0'\n")});
  assert.ok(lockMismatches(clean).some((m) => m.key === 'override:@h/b'));
});

test('an importer inside a mounted submodule is not stale where the submodule is not checked out', (t) => {
  const root = workspace(t, {
    'package.json': {name: 'root', private: true}, 'pnpm-workspace.yaml': yamlWorkspace,
    'lib/b/package.json': {name: '@h/b', version: '0.3.0'},
    'pnpm-lock.yaml': lock("  .: {}\n  lib/b: {}\n  lib/mounted: {}\n  lib/mounted/services/leaf: {}\n  lib/gone: {}\n"),
  });
  // A gitlink, as a checkout without submodules holds a mounted section: the index names it, its files are absent.
  spawnSync('git', ['update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,lib/mounted'], {cwd: root});
  assert.deepEqual(lockMismatches(root).map((m) => m.key), ['stale-importer:lib/gone']);
});
