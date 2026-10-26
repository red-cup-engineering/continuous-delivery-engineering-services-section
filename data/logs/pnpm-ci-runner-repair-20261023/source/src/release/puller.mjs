// Pull-based release: watch a dist-tag on an npm registry, verify, install into a versioned directory,
// switch a symlink atomically, restart, check health, and move back on failure. CI holds nothing into
// the machine that runs this. Standards: npm registry protocol (packument, dist-tags, dist.integrity),
// W3C SRI, HTTP conditional requests (RFC 9110), systemd credentials (the token arrives by file).
import { createHash } from 'node:crypto';

export const sri = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

// deps: { fetch, readState, writeState, install(version, bytes), activate(version), restart(), health() }
export async function pullOnce({ registry, name, tag, token, deps }) {
  const state = await deps.readState();
  const url = `${registry.replace(/\/$/, '')}/${name.replace('/', '%2f')}`;
  const headers = { accept: 'application/vnd.npm.install-v1+json, application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (state.etag) headers['if-none-match'] = state.etag;
  const res = await deps.fetch(url, { headers });
  if (res.status === 304) return { result: 'unchanged' };
  if (res.status >= 500 || res.status === 429) return { result: 'registry-unavailable', status: res.status, keeps: state.active ?? null };
  if (res.status !== 200) return { result: 'refused', status: res.status };
  const packument = await res.json();
  const version = packument['dist-tags']?.[tag];
  const etag = res.headers.get('etag') ?? null;
  if (!version) return { result: 'tag-not-set', tag };
  if (version === state.active) { await deps.writeState({ ...state, etag }); return { result: 'unchanged', version }; }
  const dist = packument.versions?.[version]?.dist;
  if (!dist?.tarball || !dist?.integrity) return { result: 'refused', reason: 'packument-lacks-dist' };
  const tgz = await deps.fetch(dist.tarball, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (tgz.status !== 200) return { result: 'registry-unavailable', status: tgz.status, keeps: state.active ?? null };
  const bytes = Buffer.from(await tgz.arrayBuffer());
  if (sri(bytes) !== dist.integrity) return { result: 'refused', reason: 'integrity-mismatch', expected: dist.integrity };
  await deps.install(version, bytes);
  const previous = state.active ?? null;
  await deps.activate(version);
  let ok = false;
  try { await deps.restart(); ok = await deps.health(); } catch { ok = false; }
  if (!ok) {
    if (previous) { await deps.activate(previous); try { await deps.restart(); } catch { /* kept for the record */ } }
    await deps.writeState({ ...state, etag: null, failed: version });
    return { result: 'rolled-back', failed: version, to: previous };
  }
  await deps.writeState({ etag, active: version, previous, failed: null });
  return { result: 'activated', version, previous };
}
