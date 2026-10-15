// Compute the internal closure of a service from package manifests and rewrite workspace:* ranges to the
// exact sha-tagged versions that will be published, so a registry install resolves without a workspace.
import fs from 'node:fs';
import path from 'node:path';
import { planPublish } from './publish.mjs';

const SKIP = new Set(['node_modules', '.git', 'legacy']);
export function indexPackages(roots) {
  const index = new Map();
  const walk = (dir, depth) => {
    if (depth > 20) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.name === 'package.json' && e.isFile())) {
      try { const m = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); if (m.name && !index.has(m.name)) index.set(m.name, { dir, manifest: m }); } catch { /* unreadable manifest */ }
    }
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name)) walk(path.join(dir, e.name), depth + 1);
  };
  roots.forEach(r => walk(r, 0));
  return index;
}
const declared = m => ({ ...m.dependencies, ...m.optionalDependencies });
const internalDeps = (m, index) => Object.keys(declared(m)).filter(n => index.has(n));
const workspaceDeps = m => Object.entries(declared(m)).filter(([, r]) => /^(workspace|link|file):/.test(r)).map(([n]) => n);
export function closureOf(rootName, index) {
  const seen = new Map(), missing = new Set(); const stack = [rootName];
  while (stack.length) {
    const n = stack.pop(); if (seen.has(n)) continue;
    const p = index.get(n); if (!p) { missing.add(n); continue; }
    seen.set(n, p);
    stack.push(...internalDeps(p.manifest, index));
    for (const w of workspaceDeps(p.manifest)) if (!index.has(w)) missing.add(w);
  }
  return { packages: [...seen.entries()].map(([name, p]) => ({ name, dir: p.dir, base: /^\d+\.\d+\.\d+$/.test(p.manifest.version) ? p.manifest.version : '0.0.0', dependsOn: internalDeps(p.manifest, index) })), missing: [...missing] };
}
// A workspace range with no package in the searched tree cannot be installed from a registry. It is
// dropped from the packed manifest and reported (`dropped`), never left as workspace:*.
export function rewriteManifest(manifest, version, internal) {
  const out = { ...manifest, version }, dropped = [];
  for (const k of ['dependencies', 'optionalDependencies']) if (out[k]) {
    out[k] = Object.fromEntries(Object.entries(out[k]).flatMap(([n, r]) => {
      if (n in internal) return [[n, internal[n]]];
      if (/^(workspace|link|file):/.test(r)) { dropped.push(n); return []; }
      return [[n, r]];
    }));
  }
  Object.defineProperty(out, 'dropped', { value: dropped, enumerable: false });
  delete out.devDependencies; delete out.scripts?.prepare;
  return out;
}
export const planClosure = (rootName, index, sha, options) => { const c = closureOf(rootName, index); const plan = planPublish(c.packages, sha, options); return { plan, missing: c.missing, cycles: plan.cycles }; };
