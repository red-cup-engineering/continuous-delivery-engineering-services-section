#!/usr/bin/env node
// Is a pnpm workspace's committed lock fresh? Every workspace package must have an importer in pnpm-lock.yaml
// whose recorded specifiers are exactly the dependencies its package.json declares, and every workspace:*
// dependency must name a package the workspace holds. Each mismatch is a stable key, so a reading is a ledger:
// `--base DIR` reads the base checkout too, and only mismatches the head adds fail (a ratchet, for a main that
// is not clean yet). pnpm's own frozen install stops at the first stale importer; this lists them all.
// A mounted submodule's manifests are read at the commit the superproject records (its checkout, or a blobless
// fetch of its .gitmodules URL); a mount that cannot be reached is reported unread, not judged.
//
//   node scripts/lockfile-fresh.mjs HEAD_DIR [--base BASE_DIR] [--no-submodules]
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, posix, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';

const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

const git = (cwd, args) => spawnSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
const isManifest = (file) => (file === 'package.json' || file.endsWith('/package.json')) && !/(?:^|\/)node_modules\//u.test(file);

function workspaceGlobs(root) {
  const workspace = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) ?? {};
  const include = [], exclude = [];
  for (const pattern of workspace.packages ?? []) (pattern.startsWith('!') ? exclude : include).push(pattern.slice(pattern.startsWith('!') ? 1 : 0));
  // pnpm finds workspace packages by globbing `<pattern>/package.json`, where `**` also matches no directory at all:
  // `dir/**` takes in (or, negated, leaves out) the package at `dir` itself. Read each pattern the same way.
  const matches = (dir, pattern) => posix.matchesGlob(`${dir}/package.json`, `${pattern}/package.json`);
  return (dir) => dir === '.' || (include.some((pattern) => matches(dir, pattern)) && !exclude.some((pattern) => matches(dir, pattern)));
}

/** The workspace's package directories: tracked package.json files matching pnpm-workspace.yaml's `packages` globs. */
export function workspacePackages(root) {
  const listed = git(root, ['ls-files', '-z', '--', 'package.json', '*/package.json']);
  if (listed.status !== 0) throw new Error(`cannot list tracked manifests in ${root}: ${listed.stderr}`);
  const inWorkspace = workspaceGlobs(root), dirs = new Set(['.']);
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    const dir = posix.dirname(file);
    if (dir !== '.' && isManifest(file) && inWorkspace(dir)) dirs.add(dir);
  }
  return [...dirs].sort();
}

/** The repository's mounted submodules: each gitlink's path and the commit the superproject records for it. */
export function submodules(root) {
  const listed = git(root, ['ls-files', '--stage', '-z']);
  if (listed.status !== 0) throw new Error(`cannot list the index of ${root}: ${listed.stderr}`);
  return listed.stdout.split('\0').filter((entry) => entry.startsWith('160000 ')).map((entry) => {
    const [meta, path] = entry.split('\t');
    return {path, commit: meta.split(' ')[1]};
  });
}
export const submodulePaths = (root) => submodules(root).map((mount) => mount.path);

/** A submodule URL as git resolves it: relative to the URL of the repository whose .gitmodules names it. */
function resolveUrl(url, parent) {
  if (!(url.startsWith('../') || url.startsWith('./'))) return url;
  if (!parent) return null;
  return /^[a-z]+:\/\//u.test(parent) ? new URL(url, parent.endsWith('/') ? parent : `${parent}/`).href : resolve(parent, url);
}

/** The URL a .gitmodules (from a file, or from a blob `COMMIT:.gitmodules`) names for a mount path. */
function moduleUrl(cwd, source, path) {
  const read = (args) => git(cwd, ['config', ...source, ...args]);
  const names = read(['--get-regexp', '^submodule\\..*\\.path$']).stdout.split('\n').filter(Boolean);
  const entry = names.map((line) => line.split(' ')).find(([, value]) => value === path);
  return entry ? read(['--get', entry[0].replace(/\.path$/u, '.url')]).stdout.trim() || null : null;
}

/** A local repository holding `commit` of `url`: a blobless fetch into the cache, keyed by URL. Null when the
 *  remote cannot be reached. */
function fetchedRepository(url, commit, cache) {
  const directory = join(cache, createHash('sha256').update(url).digest('hex').slice(0, 16));
  if (!existsSync(join(directory, '.git'))) {
    mkdirSync(directory, {recursive: true});
    if (git(directory, ['init', '-q']).status !== 0 || git(directory, ['remote', 'add', 'origin', url]).status !== 0) return null;
  }
  if (git(directory, ['cat-file', '-e', `${commit}^{commit}`]).status === 0) return directory;
  const fetched = git(directory, ['-c', 'protocol.file.allow=always', 'fetch', '-q', '--depth=1', '--filter=blob:none', 'origin', commit]);
  return fetched.status === 0 ? directory : null;
}

/** Every workspace manifest by directory, including those inside mounted submodules (and submodules nested in
 *  them) read at the commits their superprojects record, and the mounts that could not be read. */
export function workspaceManifests(root, {readSubmodules = true, cache = join(tmpdir(), 'lockfile-fresh-submodules')} = {}) {
  const manifests = new Map(), unread = [], inWorkspace = workspaceGlobs(root);
  for (const dir of workspacePackages(root)) manifests.set(dir, JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')));
  const origin = git(root, ['remote', 'get-url', 'origin']).stdout.trim() || null;
  // A mount: its path in the workspace, the commit recorded for it, and where it can be read.
  const readMount = (path, commit, repository, url) => {
    const entries = git(repository, ['ls-tree', '-r', '-z', commit]);
    if (entries.status !== 0) { unread.push(path); return; }
    for (const entry of entries.stdout.split('\0').filter(Boolean)) {
      const [meta, file] = entry.split('\t'), [mode, , hash] = meta.split(' ');
      if (mode === '160000') {
        const nested = posix.join(path, file);
        const nestedUrl = resolveUrl(moduleUrl(repository, ['--blob', `${commit}:.gitmodules`], file) ?? '', url);
        let nestedRepository = null;
        try { nestedRepository = nestedUrl && fetchedRepository(nestedUrl, hash, cache); } catch { nestedRepository = null; }
        if (nestedRepository) readMount(nested, hash, nestedRepository, nestedUrl); else unread.push(nested);
        continue;
      }
      if (!isManifest(file)) continue;
      const dir = posix.join(path, posix.dirname(file));
      if (!inWorkspace(dir)) continue;
      const shown = git(repository, ['show', `${commit}:${file}`]);
      if (shown.status !== 0) { unread.push(path); return; }
      manifests.set(dir, JSON.parse(shown.stdout));
    }
  };
  for (const mount of submodules(root)) {
    if (!readSubmodules) { unread.push(mount.path); continue; }
    const checkout = join(root, mount.path);
    let repository = null, url = null;
    try {
      url = existsSync(join(root, '.gitmodules')) ? resolveUrl(moduleUrl(root, ['-f', '.gitmodules'], mount.path) ?? '', origin) : null;
      if (existsSync(join(checkout, '.git')) && git(checkout, ['cat-file', '-e', `${mount.commit}^{commit}`]).status === 0) repository = checkout;
      else if (url) repository = fetchedRepository(url, mount.commit, cache);
    } catch { repository = null; }
    if (repository) readMount(mount.path, mount.commit, repository, url); else unread.push(mount.path);
  }
  return {manifests, unread};
}

/** Mismatches between the declared dependencies and the committed lock, each with a stable key. */
export function lockMismatches(root, options = {}) {
  return lockReading(root, options).mismatches;
}

/** The lock's mismatches, and the mounted submodules whose importers could not be read (left out, not judged). */
export function lockReading(root, options = {}) {
  const lock = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')) ?? {};
  const {manifests, unread} = workspaceManifests(root, options);
  const importers = lock.importers ?? {}, dirs = [...manifests.keys()].sort(), names = new Map(), found = [];
  // An override replaces the specifier pnpm records; the overrides themselves must match the lock's.
  const workspace = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) ?? {}, overrides = workspace.overrides ?? {};
  // pnpm installs declared peers itself unless autoInstallPeers is off (its default is on).
  const autoInstallPeers = workspace.autoInstallPeers !== false;
  for (const name of new Set([...Object.keys(overrides), ...Object.keys(lock.overrides ?? {})]))
    if (String(overrides[name]) !== String((lock.overrides ?? {})[name])) found.push({key: `override:${name}`, declared: overrides[name], locked: (lock.overrides ?? {})[name]});
  for (const dir of dirs) {
    const manifest = manifests.get(dir);
    if (manifest.name) names.set(manifest.name, dir);
  }
  for (const dir of dirs) {
    const manifest = manifests.get(dir), importer = importers[dir];
    if (!importer) { found.push({key: `missing-importer:${dir}`}); continue; }
    for (const field of FIELDS) {
      const declared = manifest[field] ?? {}, locked = importer[field] ?? {};
      for (const [name, specifier] of Object.entries(declared)) {
        // A name declared in dependencies and again in devDependencies or optionalDependencies is recorded
        // once, under dependencies.
        if (field !== 'dependencies' && name in (manifest.dependencies ?? {})) continue;
        if (String(specifier).startsWith('workspace:') && !names.has(name)) found.push({key: `unprovided-workspace-dependency:${dir}:${name}`});
        if (!(name in locked)) found.push({key: `undeclared-in-lock:${dir}:${field}:${name}`});
        else if (String(locked[name].specifier) !== String(overrides[name] ?? specifier)) found.push({key: `specifier:${dir}:${field}:${name}`, declared: specifier, locked: locked[name].specifier});
      }
      // An auto-installed peer is recorded among the importer's dependencies without being declared there.
      const peer = (name) => autoInstallPeers && field === 'dependencies' && name in (manifest.peerDependencies ?? {});
      for (const name of Object.keys(locked)) if (!(name in declared) && !peer(name)) found.push({key: `stale-in-lock:${dir}:${field}:${name}`});
    }
  }
  // A submodule that could not be read (no checkout of its commit, no reachable remote) leaves its importers
  // unread: not stale, and reported as unread rather than judged.
  const mounted = (dir) => unread.some((mount) => dir === mount || dir.startsWith(`${mount}/`));
  for (const dir of Object.keys(importers)) if (!dirs.includes(dir) && !mounted(dir)) found.push({key: `stale-importer:${dir}`});
  return {mismatches: found.sort((a, b) => a.key.localeCompare(b.key)), unread: unread.sort()};
}

export function freshness(head, base, options = {}) {
  const now = lockReading(head, options);
  if (!base) return {mismatches: now.mismatches, added: now.mismatches, removed: [], unread: now.unread};
  const before = existsSync(join(base, 'pnpm-lock.yaml')) ? lockReading(base, options).mismatches : [];
  const was = new Set(before.map((m) => m.key)), is = new Set(now.mismatches.map((m) => m.key));
  return {mismatches: now.mismatches, added: now.mismatches.filter((m) => !was.has(m.key)), removed: before.filter((m) => !is.has(m.key)).map((m) => m.key), unread: now.unread};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf('--base');
  const base = at >= 0 ? args[at + 1] : undefined, head = args.find((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));
  if (!head) { process.stderr.write('usage: lockfile-fresh.mjs HEAD_DIR [--base BASE_DIR] [--no-submodules]\n'); process.exit(2); }
  const result = freshness(head, base, {readSubmodules: !args.includes('--no-submodules')});
  process.stdout.write(JSON.stringify({kind: 'lockfile-freshness', mismatches: result.mismatches.length, added: result.added, removed: result.removed, unreadSubmodules: result.unread}, null, 2) + '\n');
  if (result.added.length) process.exitCode = 1;
}
