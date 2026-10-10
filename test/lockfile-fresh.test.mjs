import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {freshness, lockMismatches, lockReading} from '../scripts/lockfile-fresh.mjs';

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

test('a mounted submodule is read at the commit the superproject records, so its stale importers are caught', (t) => {
  // The mounted section is its own repository; the superproject records one commit of it and has no checkout.
  const section = workspace(t, {
    'package.json': {name: '@h/mounted', private: true},
    'services/leaf/package.json': {name: '@h/leaf', dependencies: {'@h/b': 'workspace:*', left: '1.0.0'}},
  });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'section'], {cwd: section});
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: section, encoding: 'utf8'}).stdout.trim();
  const root = workspace(t, {
    'package.json': {name: 'root', private: true}, 'pnpm-workspace.yaml': yamlWorkspace,
    'lib/b/package.json': {name: '@h/b', version: '0.3.0'},
    '.gitmodules': `[submodule "mounted"]\n\tpath = lib/mounted\n\turl = ${section}\n`,
    'pnpm-lock.yaml': lock("  .: {}\n  lib/b: {}\n  lib/mounted: {}\n  lib/mounted/services/leaf:\n    dependencies:\n      '@h/b':\n        specifier: workspace:*\n        version: link:../../../b\n"),
  });
  spawnSync('git', ['update-index', '--add', '--cacheinfo', `160000,${commit},lib/mounted`], {cwd: root});
  const cache = join(root, '.cache');
  const reading = lockReading(root, {cache});
  assert.deepEqual(reading.unread, []);
  assert.deepEqual(reading.mismatches.map((m) => m.key), ['undeclared-in-lock:lib/mounted/services/leaf:dependencies:left']);
  // Without reading submodules (or where the mount cannot be reached) its importers are left unread, as before.
  const skipped = lockReading(root, {readSubmodules: false});
  assert.deepEqual(skipped, {mismatches: [], unread: ['lib/mounted']});
});

test('a mount whose remote cannot be reached is reported unread, not stale', (t) => {
  const root = workspace(t, {
    'package.json': {name: 'root', private: true}, 'pnpm-workspace.yaml': yamlWorkspace,
    'lib/b/package.json': {name: '@h/b', version: '0.3.0'},
    '.gitmodules': `[submodule "mounted"]\n\tpath = lib/mounted\n\turl = ${join(tmpdir(), 'no-such-lockfile-fresh-remote')}\n`,
    'pnpm-lock.yaml': lock("  .: {}\n  lib/b: {}\n  lib/mounted/services/leaf: {}\n"),
  });
  spawnSync('git', ['update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,lib/mounted'], {cwd: root});
  assert.deepEqual(lockReading(root, {cache: join(root, '.cache')}), {mismatches: [], unread: ['lib/mounted']});
});

test('a submodule nested in a mount is read at the commit the mount records', (t) => {
  const commitAll = (dir, message) => {
    spawnSync('git', ['add', '-A'], {cwd: dir});
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message], {cwd: dir});
    return spawnSync('git', ['rev-parse', 'HEAD'], {cwd: dir, encoding: 'utf8'}).stdout.trim();
  };
  const site = workspace(t, {'package.json': {name: '@h/site', dependencies: {left: '1.0.0'}}});
  const siteCommit = commitAll(site, 'site');
  const section = workspace(t, {'package.json': {name: '@h/mounted', private: true}, '.gitmodules': `[submodule "site"]\n\tpath = sites/site\n\turl = ${site}\n`});
  // The gitlink goes into the index after the files: `add -A` would drop it, its path being absent on disk.
  spawnSync('git', ['update-index', '--add', '--cacheinfo', `160000,${siteCommit},sites/site`], {cwd: section});
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'section'], {cwd: section});
  const sectionCommit = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: section, encoding: 'utf8'}).stdout.trim();
  const root = workspace(t, {
    'package.json': {name: 'root', private: true}, 'pnpm-workspace.yaml': yamlWorkspace,
    'lib/b/package.json': {name: '@h/b', version: '0.3.0'},
    '.gitmodules': `[submodule "mounted"]\n\tpath = lib/mounted\n\turl = ${section}\n`,
    'pnpm-lock.yaml': lock("  .: {}\n  lib/b: {}\n  lib/mounted: {}\n  lib/mounted/sites/site: {}\n"),
  });
  spawnSync('git', ['update-index', '--add', '--cacheinfo', `160000,${sectionCommit},lib/mounted`], {cwd: root});
  const reading = lockReading(root, {cache: join(root, '.cache')});
  assert.deepEqual(reading.unread, []);
  // The nested site is judged (its undeclared dependency is caught), not reported as a stale importer.
  assert.deepEqual(reading.mismatches.map((m) => m.key), ['undeclared-in-lock:lib/mounted/sites/site:dependencies:left']);
});

test('a dependency declared twice is recorded once, and an auto-installed peer is not stale', (t) => {
  const root = workspace(t, {
    'package.json': {name: 'root', private: true}, 'pnpm-workspace.yaml': yamlWorkspace + 'autoInstallPeers: true\n',
    'lib/b/package.json': {name: '@h/b', version: '0.3.0'},
    'lib/a/package.json': {name: '@h/a', dependencies: {twice: '1.0.0'}, devDependencies: {twice: '1.0.0'}, peerDependencies: {peer: '>=1'}},
    'pnpm-lock.yaml': lock("  .: {}\n  lib/b: {}\n  lib/a:\n    dependencies:\n      twice:\n        specifier: 1.0.0\n        version: 1.0.0\n      peer:\n        specifier: '>=1'\n        version: 1.2.0\n"),
  });
  assert.deepEqual(lockMismatches(root), []);
  const strict = workspace(t, {
    'package.json': {name: 'root', private: true}, 'pnpm-workspace.yaml': yamlWorkspace + 'autoInstallPeers: false\n',
    'lib/b/package.json': {name: '@h/b', version: '0.3.0'},
    'lib/a/package.json': {name: '@h/a', peerDependencies: {peer: '>=1'}},
    'pnpm-lock.yaml': lock("  .: {}\n  lib/b: {}\n  lib/a:\n    dependencies:\n      peer:\n        specifier: '>=1'\n        version: 1.2.0\n"),
  });
  assert.deepEqual(lockMismatches(strict).map((m) => m.key), ['stale-in-lock:lib/a:dependencies:peer']);
});

test('a negated subtree also leaves out the package at its own root, as pnpm reads it', (t) => {
  const root = workspace(t, {
    'package.json': {name: 'root', private: true},
    'pnpm-workspace.yaml': "packages:\n  - 'lib/**'\n  - '!**/legacy/**'\n  - '!lib/mount/**'\n  - '!lib/named'\n",
    'lib/a/package.json': {name: '@h/a', version: '1.0.0'},
    'lib/mount/package.json': {name: '@h/mount', version: '1.0.0'},
    'lib/mount/inner/package.json': {name: '@h/inner', version: '1.0.0'},
    'lib/named/package.json': {name: '@h/named', version: '1.0.0'},
    'lib/named/kept/package.json': {name: '@h/kept', version: '1.0.0'},
    'lib/legacy/package.json': {name: '@h/legacy', version: '1.0.0'},
    'pnpm-lock.yaml': lock("  .: {}\n  lib/a: {}\n  lib/named/kept: {}\n", ''),
  });
  assert.deepEqual(lockMismatches(root), []);
});
