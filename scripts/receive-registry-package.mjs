import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Receive the exact packed artifact, rather than treating an occupied version
// number as evidence that the caller's source was published.
const mode = process.argv[2];
if (!['before', 'after'].includes(mode)) throw new Error('expected before or after publication');
const { PACKAGE: name, VERSION: version, PACKAGE_ARCHIVE: archive, REGISTRY: address, REGISTRY_AUTH: credential, REGISTRY_AUTH_KIND: kind } = process.env;
if (!name || !version || !archive || !credential || !['Bearer', 'Basic'].includes(kind)) throw new Error('exact package, version, archive and registry authority required');
const registry = new URL(address);
if (registry.protocol !== 'https:' || registry.username || registry.password) throw new Error('registry requires credential-free HTTPS addressing');
const bytes = readFileSync(archive);
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const shasum = createHash('sha1').update(bytes).digest('hex');
const response = await fetch(new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, registry.href.replace(/\/?$/, '/')), {
  headers: { accept: 'application/json', authorization: `${kind} ${credential}` },
  redirect: 'error', signal: AbortSignal.timeout(30_000),
});
if (response.status === 404 && mode === 'before') {
  console.log(JSON.stringify({ state: 'absent', name, version, integrity }));
} else {
  if (!response.ok) throw new Error(`registry receiving refused: HTTP ${response.status}`);
  const published = await response.json();
  if (published.name !== name || published.version !== version) throw new Error('registry returned another package or version');
  const digests = new Set((published.dist?.integrity ?? '').split(/\s+/));
  if (!(digests.has(integrity) || (!published.dist?.integrity && published.dist?.shasum === shasum))) throw new Error('published version differs from the packed source; preserve it and qualify a new declared version');
  console.log(JSON.stringify({ state: 'received', name, version, integrity, source: process.env.GITHUB_SHA }));
}
