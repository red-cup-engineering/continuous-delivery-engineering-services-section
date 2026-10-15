#!/usr/bin/env node
// node scripts/place-job.mjs --job <job.json> --nodes <dir> [--plan free|team|enterpriseCloud] [--used <minutes>] [--now <iso>]
import fs from 'node:fs';
import path from 'node:path';
import { newLedger } from '../src/placement/allowance.mjs';
import { place } from '../src/placement/place.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const job = JSON.parse(fs.readFileSync(arg('job'), 'utf8'));
const dir = arg('nodes');
const nodes = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const now = arg('now', new Date().toISOString());
const ledger = newLedger({ plan: arg('plan', 'free'), month: now.slice(0, 7), usedMinutes: Number(arg('used', 0)) });
console.log(JSON.stringify(place(job, nodes, { ledger, now }), (_k, v) => v === Infinity ? 'unbounded' : v, 2));
