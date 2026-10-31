#!/usr/bin/env node
// A host section's PACE-S loop, Pause and Attune: read the host and print each
// obstruction once, with its owner and admissible actions. Read-only.
//
//   node scripts/section-loop.mjs --colony DIR [--wsl-host-script FILE --wsl-host-parameters FILE]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { attune } from '../src/loop/attune.mjs';
import { liveHost, pause } from '../src/loop/pause.mjs';

const { values } = parseArgs({ options: { colony: { type: 'string' }, 'wsl-host-script': { type: 'string' }, 'wsl-host-parameters': { type: 'string' },
  readings: { type: 'boolean', default: false } } });
if (!values.colony) { console.error('usage: section-loop.mjs --colony DIR [--wsl-host-script FILE --wsl-host-parameters FILE] [--readings]'); process.exit(64); }

// The physical capacity port of a WSL host and the floor its own record declares.
const capacity = values['wsl-host-script'] && values['wsl-host-parameters'] ? () => {
  const reading = JSON.parse(execFileSync(process.execPath, [values['wsl-host-script'], 'capacity', `--parameters=${values['wsl-host-parameters']}`],
    { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] }));
  const policy = JSON.parse(fs.readFileSync(values['wsl-host-parameters'], 'utf8')).windows?.backingStorage?.policy ?? {};
  const total = Number(reading.volumes?.[0]?.totalBytes ?? 0);
  return { availableBytes: Number(reading.volumes?.[0]?.availableBytes ?? 0),
    floorBytes: Math.max(Number(policy.minFreeBytes ?? 0), total * (policy.minFreePercent ?? 0) / 100) + Number(policy.growthBytes ?? 0) };
} : undefined;

const readings = pause(liveHost, { colony: values.colony, capacity });
const obstructions = attune(readings);
if (values.readings) for (const r of readings) console.log(JSON.stringify(r));
for (const o of obstructions) console.log(JSON.stringify(o));
console.error(JSON.stringify({ obstructions: obstructions.length, kinds: [...new Set(obstructions.map(o => o.kind))] }));
process.exit(obstructions.length ? 2 : 0);
