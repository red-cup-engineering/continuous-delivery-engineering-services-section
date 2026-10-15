// Publish the tarballs that release-pack wrote, in plan order, then move the dist-tag of the root package.
// The publisher token is read from the host's own credential directory (systemd LoadCredential), written
// only into a mode 0600 npmrc in a mode 0700 directory that the caller removes, and never put in an argument,
// the environment or a log line. A version that is already in the registry counts as published: the same
// commit gives the same version, so publishing twice is idempotent.
import fs from 'node:fs';
import path from 'node:path';
import { promoteArgs } from './publish.mjs';

export const PUBLISH_CREDENTIAL = 'registry-publish-token';
const present = r => /previously published|cannot publish over|EPUBLISHCONFLICT/i.test(`${r.stderr ?? ''}`);

export function readPublishToken(env = process.env) {
  const dir = env.CREDENTIALS_DIRECTORY;
  const file = dir && path.join(dir, PUBLISH_CREDENTIAL);
  if (!file || !fs.existsSync(file)) throw new Error(`credential-missing:${PUBLISH_CREDENTIAL}`);
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!token) throw new Error(`credential-empty:${PUBLISH_CREDENTIAL}`);
  return token;
}

export function writeNpmrc(dir, registry, token) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'npmrc');
  fs.writeFileSync(file, `//${new URL(registry).host}/:_authToken=${token}\n`, { mode: 0o600 });
  return file;
}

// plan: the plan.json of release-pack ({ root, files: [{ name, version, tarball }] }); the root is promoted.
export async function publishPacked({ plan, packDir, registry, npmrc, tag = 'candidate', promote = 'production', run }) {
  const published = [], present_ = [];
  for (const f of plan.files) {
    const args = ['publish', path.join(packDir, f.tarball), '--registry', registry, '--tag', tag, '--access', 'restricted', '--userconfig', npmrc];
    const r = await run('npm', args);
    if (r.status === 0) published.push(`${f.name}@${f.version}`);
    else if (present(r)) present_.push(`${f.name}@${f.version}`);
    else return { ok: false, failedAt: f.name, published, present: present_ };
  }
  const root = plan.files.find(f => f.name === plan.root);
  if (!root) return { ok: false, failedAt: 'root-not-in-plan', published, present: present_ };
  if (promote) {
    const r = await run('npm', [...promoteArgs(root.name, root.version, promote, registry), '--userconfig', npmrc]);
    if (r.status !== 0) return { ok: false, failedAt: `dist-tag:${promote}`, published, present: present_ };
  }
  return { ok: true, root: `${root.name}@${root.version}`, promoted: promote || null, published, present: present_ };
}
