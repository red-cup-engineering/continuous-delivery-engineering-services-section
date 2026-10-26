#!/usr/bin/env node
// node scripts/release-pull.mjs --registry <url> --name <pkg> --tag production --root <dir> --unit <systemd unit>
// <root>/releases/<version>/ holds each install; <root>/current is the symlink; <root>/state.json holds the etag.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pullOnce } from '../src/release/puller.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const [registry, name, tag, root, unit] = ['registry', 'name', 'tag', 'root', 'unit'].map(arg);
if (!registry || !name || !tag || !root) { console.error('registry, name, tag and root are required'); process.exit(2); }
const credDir = process.env.CREDENTIALS_DIRECTORY;
const token = credDir && fs.existsSync(path.join(credDir, 'registry-read-token')) ? fs.readFileSync(path.join(credDir, 'registry-read-token'), 'utf8').trim() : undefined;
const statePath = path.join(root, 'state.json');
fs.mkdirSync(path.join(root, 'releases'), { recursive: true });
const deps = {
  fetch: (u, o) => fetch(u, o),
  readState: async () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; } },
  writeState: async s => { fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(s)); fs.renameSync(`${statePath}.tmp`, statePath); },
  install: async (version, bytes) => {
    const dir = path.join(root, 'releases', version);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-xz', '--strip-components=1', '-C', dir], { input: bytes });
    const args = ['install', '--omit=dev', '--ignore-scripts', '--registry', registry];
    let rc;
    if (token && process.env.RUNTIME_DIRECTORY) {   // tmpfs, mode 0600, removed with the unit's runtime directory
      rc = path.join(process.env.RUNTIME_DIRECTORY, 'npmrc');
      fs.writeFileSync(rc, `//${new URL(registry).host}/:_authToken=${token}\n`, { mode: 0o600 });
      args.push('--userconfig', rc);
    }
    execFileSync('npm', args, { cwd: dir });
  },
  activate: async version => {
    const link = path.join(root, 'current'), tmp = `${link}.next`;
    try { fs.unlinkSync(tmp); } catch { /* none */ }
    fs.symlinkSync(path.join(root, 'releases', version), tmp);
    fs.renameSync(tmp, link);
  },
  restart: async () => { if (unit) execFileSync('systemctl', ['restart', unit]); },
  health: async () => { if (!unit) return true; try { execFileSync('systemctl', ['is-active', '--quiet', unit]); return true; } catch { return false; } },
};
console.log(JSON.stringify(await pullOnce({ registry, name, tag, token, deps })));
