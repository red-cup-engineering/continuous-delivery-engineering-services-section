#!/usr/bin/env node
// node scripts/release-publish.mjs --pack <dir written by release-pack> --registry <url> [--tag candidate] [--promote production]
// Run on the host that holds the publisher credential: its unit or runner service loads registry-publish-token
// with LoadCredential=, so $CREDENTIALS_DIRECTORY has it. Nothing here moves the credential anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { publishPacked, readPublishToken, writeNpmrc } from '../src/release/publish-packed.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const [pack, registry] = ['pack', 'registry'].map(arg);
if (!pack || !registry) { console.error('pack and registry are required'); process.exit(2); }
const work = fs.mkdtempSync(path.join(process.env.RUNTIME_DIRECTORY ?? os.tmpdir(), 'release-publish-'));
fs.chmodSync(work, 0o700);
try {
  const npmrc = writeNpmrc(work, registry, readPublishToken());
  const plan = JSON.parse(fs.readFileSync(path.join(pack, 'plan.json'), 'utf8'));
  const run = async (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: work } });
  const result = await publishPacked({ plan, packDir: pack, registry, npmrc, tag: arg('tag') ?? 'candidate', promote: arg('promote') ?? 'production', run });
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
} finally { fs.rmSync(work, { recursive: true, force: true }); }
