#!/usr/bin/env node
// node scripts/release-pack.mjs --root <package name> --search <dir>[,<dir>...] --sha <commit> --out <dir>
// Writes one tarball per package of the closure, with exact sha-tagged internal versions, plus plan.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { indexPackages, planClosure, rewriteManifest } from '../src/release/closure.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const [root, search, sha, out] = ['root', 'search', 'sha', 'out'].map(arg);
if (!root || !search || !sha || !out) { console.error('root, search, sha and out are required'); process.exit(2); }
const index = indexPackages(search.split(','));
const { plan, missing, cycles } = planClosure(root, index, sha, { failOnCycle: process.argv.includes('--fail-on-cycle') });
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-pack-'));
const files = [], dropped = {};
for (const step of plan) {
  const copy = path.join(tmp, step.name.replace('/', '__'));
  fs.cpSync(step.dir, copy, { recursive: true, filter: s => !/(^|\/)(node_modules|\.git)(\/|$)/.test(s) });
  const rewritten = rewriteManifest(index.get(step.name).manifest, step.version, step.internal);
  if (rewritten.dropped.length) dropped[step.name] = rewritten.dropped;
  fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify(rewritten, null, 2));
  const name = execFileSync('npm', ['pack', '--pack-destination', out, '--silent', '--ignore-scripts'], { cwd: copy, encoding: 'utf8' }).trim().split('\n').pop();
  files.push({ name: step.name, version: step.version, tarball: name });
}
fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify({ root, sha, files, notInTree: missing, dropped, cycles }, null, 2));
console.log(JSON.stringify({ packages: files.length, notInTree: missing, cycles: cycles.length }));
