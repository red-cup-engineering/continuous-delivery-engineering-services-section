import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { admission, parseSize, readTelemetry, reservations, withinBudget } from '../scripts/within-budget.mjs';

const calm = { availableMb: 8000, memoryFullPct: 0, ioFullPct: 0 };
const ledger = () => fs.mkdtempSync(path.join(os.tmpdir(), 'within-budget-test-'));

test('parses sizes in megabytes', () => {
  assert.equal(parseSize('1500M'), 1500);
  assert.equal(parseSize('2G'), 2048);
  assert.equal(parseSize('512KiB'), 0.5);
  assert.equal(parseSize('300.0M'), 300);
});

test('reads available memory and full stall pressure', () => {
  const files = {
    '/proc/meminfo': 'MemTotal: 12248988 kB\nMemAvailable:    5472716 kB\n',
    '/proc/pressure/memory': 'some avg10=13.25 avg60=26.37 avg300=48.80 total=1\nfull avg10=12.54 avg60=23.06 avg300=39.45 total=1\n',
    '/proc/pressure/io': 'some avg10=1.00 avg60=0 avg300=0 total=1\nfull avg10=0.50 avg60=0 avg300=0 total=1\n',
  };
  assert.deepEqual(readTelemetry(f => files[f]), { availableMb: 5344, memoryFullPct: 12.54, ioFullPct: 0.5 });
});

test('admits only within margin, after what is already reserved', () => {
  assert.equal(admission(calm, 0, 2048), null);
  assert.match(admission({ ...calm, memoryFullPct: 12 }, 0, 100), /memory stalled 12%/);
  assert.equal(admission({ ...calm, ioFullPct: 40 }, 0, 100), null, 'I/O stall is recorded, not a gate');
  assert.match(admission(calm, 6000, 2048), /976 MB free beyond the 1024 MB reserve and 6000 MB reserved, job needs 2048 MB/);
});

test('a reservation counts only while its process lives', () => {
  const dir = ledger();
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ memoryMb: 700 }));
  fs.writeFileSync(path.join(dir, '999999999.json'), JSON.stringify({ memoryMb: 5000 }));
  assert.equal(reservations(dir), 700);
  assert.ok(!fs.existsSync(path.join(dir, '999999999.json')));
});

test('holds a job that does not fit and reports why it was not admitted', () => {
  const r = withinBudget({ command: 'true', memoryMb: 100, ledger: ledger(), waitMs: 50, pollMs: 10,
    telemetry: () => ({ ...calm, memoryFullPct: 30 }) });
  assert.equal(r.budget.state, 'not-admitted');
  assert.match(r.budget.held, /memory stalled/);
});

test('runs a job contained, measures it, and kills only it when it exceeds its budget', () => {
  const ok = withinBudget({ command: 'node', args: ['-e', 'console.log(process.cwd())'], cwd: os.tmpdir(), memoryMb: 200,
    ledger: ledger(), telemetry: () => calm });
  assert.equal(ok.status, 0, ok.output);
  assert.equal(ok.output.trim(), os.tmpdir());
  assert.equal(ok.budget.state, 'ran');
  assert.ok(ok.budget.runtime && ok.budget.cpu);
  const over = withinBudget({ command: 'node', args: ['-e', 'const a=[];for(let i=0;i<400;i++)a.push(Buffer.alloc(1<<20,1))'],
    memoryMb: 150, ledger: ledger(), telemetry: () => calm });
  assert.notEqual(over.status, 0);
  assert.equal(over.budget.state, 'over-budget');
  assert.ok(over.budget.peakMb >= 140, JSON.stringify(over.budget));
});
