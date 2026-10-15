#!/usr/bin/env node
// Closure mode: node scripts/release-pack.mjs --root <package name> --search <dir>[,<dir>...] --sha <commit> --out <dir>
//   One tarball per package of the root's closure, with exact sha-tagged internal versions, plus plan.json.
// Unit mode: node scripts/release-pack.mjs --only <name>[,<name>...] [--root <package name>] --search <dir> --sha <commit> --out <dir> --registry <url>
//   One tarball per named package of one checkout. A dependency that is not one of the named packages must
//   already be in the registry with the dist-tag `candidate`; its exact version is written into the tarball. A
//   dependency that resolves nowhere refuses the entire package before any tarball is written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { indexPackages, planClosure, planUnit, rewriteManifest } from '../src/release/closure.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const [root, search, sha, out, only, registry] = ['root', 'search', 'sha', 'out', 'only', 'registry'].map(arg);
if (process.argv.includes('--drop')) { console.error('release must preserve every declared dependency; --drop is retired'); process.exit(2); }
if ((!root && !only) || !search || !sha || !out) { console.error('root (or only), search, sha and out are required'); process.exit(2); }
if (only && !registry) { console.error('--only needs --registry to resolve dependencies outside the unit'); process.exit(2); }
const index = indexPackages(search.split(','));
const resolveCandidate = name => {
  try { return execFileSync('npm', ['view', name, 'dist-tags.candidate', '--registry', registry], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
};
let plan, missing, cycles, externalVersions = {}, unresolved = [];
if (only) {
  const unit = planUnit(only.split(',').filter(Boolean), index, sha);
  plan = unit.plan; missing = unit.absent; cycles = unit.cycles;
  const wanted = new Set(Object.values(unit.external).flat());
  for (const name of wanted) { const v = resolveCandidate(name); if (v) externalVersions[name] = v; else unresolved.push(name); }
  if (unresolved.length || missing.length) { console.error(JSON.stringify({ unresolved, notInTree: missing })); process.exit(1); }
  for (const step of plan) step.internal = { ...Object.fromEntries(unit.external[step.name].filter(d => d in externalVersions).map(d => [d, externalVersions[d]])), ...step.internal };
} else ({ plan, missing, cycles } = planClosure(root, index, sha, { failOnCycle: process.argv.includes('--fail-on-cycle') }));
if (missing.length || cycles.length) { console.error(JSON.stringify({notInTree:missing,cycles})); process.exit(1); }
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-pack-'));
const files = [];
for (const step of plan) {
  const copy = path.join(tmp, step.name.replace('/', '__'));
  fs.cpSync(step.dir, copy, { recursive: true, filter: s => !/(^|\/)(node_modules|\.git)(\/|$)/.test(s) });
  const rewritten = rewriteManifest(index.get(step.name).manifest, step.version, step.internal);
  fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify(rewritten, null, 2));
  const name = execFileSync('npm', ['pack', '--pack-destination', out, '--silent', '--ignore-scripts'], { cwd: copy, encoding: 'utf8' }).trim().split('\n').pop();
  files.push({ name: step.name, version: step.version, tarball: name });
}
fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify({ root, sha, files, notInTree: missing, cycles, externalVersions }, null, 2));
console.log(JSON.stringify({ packages: files.length, notInTree: missing, cycles: cycles.length, external: Object.keys(externalVersions).length }));
