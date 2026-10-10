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
  return (dir) => dir === '.' || (include.some((pattern) => posix.matchesGlob(dir, pattern)) && !exclude.some((pattern) => posix.matchesGlob(dir, pattern)));
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

/** Where a submodule's commit can be read: its checkout when it holds the commit, else a blobless fetch of the
 *  URL .gitmodules names (relative URLs resolve against the superproject's origin). Null when neither reaches it. */
function submoduleRepository(root, mount, cache) {
  const checkout = join(root, mount.path);
  if (existsSync(join(checkout, '.git')) && git(checkout, ['cat-file', '-e', `${mount.commit}^{commit}`]).status === 0) return checkout;
  if (!existsSync(join(root, '.gitmodules'))) return null;
  const names = git(root, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']).stdout.split('\n').filter(Boolean);
  const entry = names.map((line) => line.split(' ')).find(([, path]) => path === mount.path);
  if (!entry) return null;
  let url = git(root, ['config', '-f', '.gitmodules', '--get', entry[0].replace(/\.path$/u, '.url')]).stdout.trim();
  if (url.startsWith('../') || url.startsWith('./')) {
    const origin = git(root, ['remote', 'get-url', 'origin']).stdout.trim();
    if (!origin) return null;
    url = /^[a-z]+:\/\//u.test(origin) ? new URL(url, origin.endsWith('/') ? origin : `${origin}/`).href : resolve(origin, url);
  }
  const directory = join(cache, createHash('sha256').update(url).digest('hex').slice(0, 16));
  if (!existsSync(join(directory, '.git'))) {
    mkdirSync(directory, {recursive: true});
    if (git(directory, ['init', '-q']).status !== 0 || git(directory, ['remote', 'add', 'origin', url]).status !== 0) return null;
  }
  if (git(directory, ['cat-file', '-e', `${mount.commit}^{commit}`]).status === 0) return directory;
  const fetched = git(directory, ['-c', 'protocol.file.allow=always', 'fetch', '-q', '--depth=1', '--filter=blob:none', 'origin', mount.commit]);
  return fetched.status === 0 ? directory : null;
}

/** Every workspace manifest by directory, including those inside mounted submodules read at their recorded
 *  commits, and the mounts that could not be read. */
export function workspaceManifests(root, {readSubmodules = true, cache = join(tmpdir(), 'lockfile-fresh-submodules')} = {}) {
  const manifests = new Map(), unread = [], inWorkspace = workspaceGlobs(root);
  for (const dir of workspacePackages(root)) manifests.set(dir, JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')));
  for (const mount of submodules(root)) {
    let repository = null;
    try { if (readSubmodules) repository = submoduleRepository(root, mount, cache); } catch { repository = null; }
    if (!repository) { unread.push(mount.path); continue; }
    const files = git(repository, ['ls-tree', '-r', '-z', '--name-only', mount.commit]);
    if (files.status !== 0) { unread.push(mount.path); continue; }
    for (const file of files.stdout.split('\0').filter(isManifest)) {
      const dir = posix.join(mount.path, posix.dirname(file));
      if (!inWorkspace(dir)) continue;
      const shown = git(repository, ['show', `${mount.commit}:${file}`]);
      if (shown.status !== 0) { unread.push(mount.path); break; }
      manifests.set(dir, JSON.parse(shown.stdout));
    }
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
  const overrides = (parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) ?? {}).overrides ?? {};
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
        if (String(specifier).startsWith('workspace:') && !names.has(name)) found.push({key: `unprovided-workspace-dependency:${dir}:${name}`});
        if (!(name in locked)) found.push({key: `undeclared-in-lock:${dir}:${field}:${name}`});
        else if (String(locked[name].specifier) !== String(overrides[name] ?? specifier)) found.push({key: `specifier:${dir}:${field}:${name}`, declared: specifier, locked: locked[name].specifier});
      }
      for (const name of Object.keys(locked)) if (!(name in declared)) found.push({key: `stale-in-lock:${dir}:${field}:${name}`});
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
