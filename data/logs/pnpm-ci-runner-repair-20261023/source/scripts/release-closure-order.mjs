#!/usr/bin/env node
// node scripts/release-closure-order.mjs --root <package name> --repos <dir>[,<dir>...]
// Prints, as JSON, the closure of a root package grouped by the repository (one of the given checkouts)
// that holds each package, with the repository order that puts every dependency repository first.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { indexPackages, closureOf } from '../src/release/closure.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const [root, repos] = ['root', 'repos'].map(arg);
if (!root || !repos) { console.error('root and repos are required'); process.exit(2); }
const dirs = repos.split(',').map(d => path.resolve(d));
const repoOf = file => dirs.find(d => file === d || file.startsWith(d + path.sep));
const index = indexPackages(dirs);
const { packages, missing } = closureOf(root, index);
const remote = d => execFileSync('git', ['-C', d, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim().replace(/^https:\/\/[^@]*@/, 'https://').replace(/\.git$/, '');
const byRepo = new Map(), edges = new Map();
for (const p of packages) {
  const r = repoOf(p.dir); if (!byRepo.has(r)) byRepo.set(r, []); byRepo.get(r).push(p); edges.set(r, edges.get(r) ?? new Set());
}
const repoOfName = n => repoOf(index.get(n).dir);
for (const p of packages) for (const d of p.dependsOn) if (repoOfName(d) !== repoOf(p.dir)) edges.get(repoOf(p.dir)).add(repoOfName(d));
const order = [], seen = new Set(), stack = new Set(), cycles = [];
const visit = r => { if (seen.has(r)) return; if (stack.has(r)) { cycles.push(r); return; } stack.add(r); for (const d of edges.get(r)) visit(d); stack.delete(r); seen.add(r); order.push(r); };
[...byRepo.keys()].forEach(visit);
console.log(JSON.stringify({ root, packages: packages.length, missing, repositoryCycles: cycles.map(remote), repositories: order.map(r => ({ repository: remote(r), packages: byRepo.get(r).map(p => ({ name: p.name, dir: path.relative(r, p.dir) || '.', dependsOn: p.dependsOn })), dependsOnRepositories: [...edges.get(r)].map(remote) })) }, null, 2));
