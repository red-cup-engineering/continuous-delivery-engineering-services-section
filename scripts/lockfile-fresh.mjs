#!/usr/bin/env node
// Is a pnpm workspace's committed lock fresh? Every workspace package must have an importer in pnpm-lock.yaml
// whose recorded specifiers are exactly the dependencies its package.json declares, and every workspace:*
// dependency must name a package the workspace holds. Each mismatch is a stable key, so a reading is a ledger:
// `--base DIR` reads the base checkout too, and only mismatches the head adds fail (a ratchet, for a main that
// is not clean yet). pnpm's own frozen install stops at the first stale importer; this lists them all.
//
//   node scripts/lockfile-fresh.mjs HEAD_DIR [--base BASE_DIR]
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {join, posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';

const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/** The workspace's package directories: tracked package.json files matching pnpm-workspace.yaml's `packages` globs. */
export function workspacePackages(root) {
  const workspace = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) ?? {};
  const include = [], exclude = [];
  for (const pattern of workspace.packages ?? []) (pattern.startsWith('!') ? exclude : include).push(pattern.slice(pattern.startsWith('!') ? 1 : 0));
  const listed = spawnSync('git', ['ls-files', '-z', '--', 'package.json', '*/package.json'], {cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
  if (listed.status !== 0) throw new Error(`cannot list tracked manifests in ${root}: ${listed.stderr}`);
  const dirs = new Set(['.']);
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    const dir = posix.dirname(file);
    if (dir === '.' || /(?:^|\/)node_modules(?:\/|$)/u.test(dir)) continue;
    if (include.some((pattern) => posix.matchesGlob(dir, pattern)) && !exclude.some((pattern) => posix.matchesGlob(dir, pattern))) dirs.add(dir);
  }
  return [...dirs].sort();
}

/** The repository's mounted submodules, by path: a lock importer under one is judged only where it is checked out. */
export function submodulePaths(root) {
  const listed = spawnSync('git', ['ls-files', '--stage', '-z'], {cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
  if (listed.status !== 0) throw new Error(`cannot list the index of ${root}: ${listed.stderr}`);
  return listed.stdout.split('\0').filter((entry) => entry.startsWith('160000 ')).map((entry) => entry.split('\t')[1]);
}

/** Mismatches between the declared dependencies and the committed lock, each with a stable key. */
export function lockMismatches(root) {
  const lock = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')) ?? {};
  const importers = lock.importers ?? {}, dirs = workspacePackages(root), names = new Map(), found = [];
  // An override replaces the specifier pnpm records; the overrides themselves must match the lock's.
  const overrides = (parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) ?? {}).overrides ?? {};
  for (const name of new Set([...Object.keys(overrides), ...Object.keys(lock.overrides ?? {})]))
    if (String(overrides[name]) !== String((lock.overrides ?? {})[name])) found.push({key: `override:${name}`, declared: overrides[name], locked: (lock.overrides ?? {})[name]});
  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    if (manifest.name) names.set(manifest.name, dir);
  }
  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')), importer = importers[dir];
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
  // An importer inside a mounted submodule has its package.json in the submodule, which a checkout without
  // submodules does not hold: it is not stale, only unread here.
  const mounts = submodulePaths(root);
  const mounted = (dir) => mounts.some((mount) => dir === mount || dir.startsWith(`${mount}/`));
  for (const dir of Object.keys(importers)) if (!dirs.includes(dir) && !mounted(dir)) found.push({key: `stale-importer:${dir}`});
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

export function freshness(head, base) {
  const now = lockMismatches(head);
  if (!base) return {mismatches: now, added: now, removed: []};
  const before = existsSync(join(base, 'pnpm-lock.yaml')) ? lockMismatches(base) : [];
  const was = new Set(before.map((m) => m.key)), is = new Set(now.map((m) => m.key));
  return {mismatches: now, added: now.filter((m) => !was.has(m.key)), removed: before.filter((m) => !is.has(m.key)).map((m) => m.key)};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf('--base');
  const base = at >= 0 ? args[at + 1] : undefined, head = args.find((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));
  if (!head) { process.stderr.write('usage: lockfile-fresh.mjs HEAD_DIR [--base BASE_DIR]\n'); process.exit(2); }
  const result = freshness(head, base);
  process.stdout.write(JSON.stringify({kind: 'lockfile-freshness', mismatches: result.mismatches.length, added: result.added, removed: result.removed}, null, 2) + '\n');
  if (result.added.length) process.exitCode = 1;
}
