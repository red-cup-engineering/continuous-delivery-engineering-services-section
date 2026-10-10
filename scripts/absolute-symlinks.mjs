#!/usr/bin/env node
// Does the repository commit a symbolic link with an absolute target? Such a link resolves only on the
// machine that wrote it: elsewhere it dangles, and where the path exists a workspace tool follows it into the
// live tree (pnpm listed a second copy of a whole section that way, emsenn/bare-cedar-fog#594). Links are read
// from the index, so a sparse or blobless checkout is enough. Paths under an excluded glob (default
// `**/legacy/**`, preserved history nothing reads) are reported but do not fail.
//
//   node scripts/absolute-symlinks.mjs REPOSITORY_DIR [--exclude GLOB ...]
import {spawnSync} from 'node:child_process';
import {posix} from 'node:path';
import {fileURLToPath} from 'node:url';

const git = (cwd, args) => {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout;
};
const absolute = (target) => target.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(target) || target.startsWith('\\\\');

/** Every committed link with an absolute target, split into those that fail and those an exclusion covers. */
export function absoluteSymlinks(root, {exclude = ['**/legacy/**']} = {}) {
  const links = git(root, ['ls-files', '--stage', '-z']).split('\0').filter((entry) => entry.startsWith('120000 '))
    .map((entry) => { const [meta, path] = entry.split('\t'); return {path, blob: meta.split(' ')[1]}; });
  const found = [], excluded = [];
  for (const {path, blob} of links) {
    const target = git(root, ['cat-file', 'blob', blob]);
    if (!absolute(target)) continue;
    (exclude.some((glob) => posix.matchesGlob(path, glob)) ? excluded : found).push({path, target});
  }
  return {found, excluded};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), exclude = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--exclude') exclude.push(args[++i]);
  const root = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--exclude');
  if (!root) { process.stderr.write('usage: absolute-symlinks.mjs REPOSITORY_DIR [--exclude GLOB ...]\n'); process.exit(2); }
  const result = absoluteSymlinks(root, exclude.length ? {exclude} : {});
  process.stdout.write(JSON.stringify({kind: 'absolute-symlinks', ...result}, null, 2) + '\n');
  if (result.found.length) process.exitCode = 1;
}
