#!/usr/bin/env node
// node scripts/serve-pack.mjs --dir <release-pack output> [--port N] [--tag production]
// A read-only npm-protocol registry over a pack directory (packuments, dist-tags, tarballs). It lets a
// closure be installed from exact versions before anything is published, and is a fixture registry.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const dir = arg('dir'), tag = arg('tag') ?? 'production';
const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
const docs = new Map();
for (const f of plan.files) {
  const bytes = fs.readFileSync(path.join(dir, f.tarball));
  const manifest = JSON.parse(execFileSync('tar', ['-xzOf', path.join(dir, f.tarball), 'package/package.json']).toString());
  docs.set(f.name, { f, bytes, manifest, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, shasum: createHash('sha1').update(bytes).digest('hex') });
}
const uplink = arg('uplink') ?? 'https://registry.npmjs.org';   // public names pass through, as the real registry does
const srv = http.createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/-/ping') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  if (u.startsWith('/-/tgz/')) { const d = [...docs.values()].find(x => x.f.tarball === u.slice(7)); if (!d) { res.writeHead(404); return res.end(); } res.writeHead(200); return res.end(d.bytes); }
  const d = docs.get(u.slice(1));
  if (!d) {
    if (!/^@red-cup-engineering\//.test(u.slice(1)) && uplink !== 'none') {
      try { const r = await fetch(`${uplink}/${encodeURIComponent(u.slice(1)).replace('%40', '@')}`, { headers: { accept: req.headers.accept ?? 'application/json' } }); res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' }); return res.end(Buffer.from(await r.arrayBuffer())); } catch { /* fall through to 404 */ }
    }
    res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not found"}');
  }
  const base = `http://127.0.0.1:${srv.address().port}`;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ name: d.f.name, 'dist-tags': { [tag]: d.f.version, latest: d.f.version }, versions: { [d.f.version]: { ...d.manifest, dist: { tarball: `${base}/-/tgz/${d.f.tarball}`, integrity: d.integrity, shasum: d.shasum } } } }));
});
srv.listen(Number(arg('port') ?? 0), '127.0.0.1', () => console.log(`http://127.0.0.1:${srv.address().port}`));
