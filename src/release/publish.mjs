// Publish a package set at a sha-tagged version and move a dist-tag. npm publish is run through an
// injected runner so a test needs no registry. Provenance (Sigstore via OIDC) is requested only where the
// CI provider supplies an identity token; the publisher token comes from the environment of the caller
// (an OIDC-minted token, never a stored secret) and is never written to a file or logged here.
import { shaVersion } from './version.mjs';

// packages: [{ name, dir, base, dependsOn: [names] }] -> publish order with exact internal versions.
export function planPublish(packages, sha) {
  const byName = new Map(packages.map(p => [p.name, p]));
  const order = [], seen = new Set(), stack = new Set();
  const visit = n => {
    if (seen.has(n)) return;
    if (stack.has(n)) throw new Error(`dependency-cycle:${n}`);
    stack.add(n);
    for (const d of byName.get(n).dependsOn ?? []) if (byName.has(d)) visit(d);
    stack.delete(n); seen.add(n); order.push(n);
  };
  packages.forEach(p => visit(p.name));
  const versions = Object.fromEntries(packages.map(p => [p.name, shaVersion(p.base, sha)]));
  return order.map(n => ({ name: n, dir: byName.get(n).dir, version: versions[n], internal: Object.fromEntries((byName.get(n).dependsOn ?? []).filter(d => byName.has(d)).map(d => [d, versions[d]])) }));
}

export async function publishAll({ plan, registry, tag = 'candidate', provenance = false, run }) {
  const done = [];
  for (const step of plan) {
    const args = ['publish', step.dir, '--registry', registry, '--tag', tag, '--access', 'restricted'];
    if (provenance) args.push('--provenance');
    const r = await run('npm', args, { version: step.version, internal: step.internal });
    if (r.status !== 0) return { ok: false, failedAt: step.name, published: done };
    done.push(`${step.name}@${step.version}`);
  }
  return { ok: true, published: done };
}
// Promotion is moving a dist-tag, not publishing again.
export const promoteArgs = (name, version, tag, registry) => ['dist-tag', 'add', `${name}@${version}`, tag, '--registry', registry];
