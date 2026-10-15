import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newLedger, hold, settle, remainingMinutes, minutePrice, paceMinutes } from '../src/placement/allowance.mjs';
import { place } from '../src/placement/place.mjs';
import { newTable, grant, renew, accept, expired } from '../src/placement/lease.mjs';
import { compareBuilds, publishable } from '../src/placement/settle.mjs';

const NOW = '2026-10-15T04:50:00Z';
const read = f => JSON.parse(fs.readFileSync(new URL(`../data/placement/${f}`, import.meta.url), 'utf8'));
const job = () => read('jobs/kalshi-trading-closure-build.json');
const nodes = () => fs.readdirSync(new URL('../data/placement/nodes/', import.meta.url)).map(f => read(`nodes/${f}`));
const ledger = (used = 0) => newLedger({ plan: 'free', month: '2026-10', usedMinutes: used });

test('the Kalshi closure goes to the node that already holds it', () => {
  const r = place(job(), nodes(), { ledger: ledger(), now: NOW });
  assert.equal(r.chosen, 'cloud-session');
  assert.deepEqual(r.candidates[0].missing, []);
  assert.equal(r.needsLeaderWords, false);
});

test('unknown sizes are intervals, never zero: an unmeasured node is possible, not certain', () => {
  const r = place(job(), nodes(), { ledger: ledger(), now: NOW });
  const crg = r.candidates.find(c => c.nodeId === 'cold-red-gate');
  assert.equal(crg.certainty, 'possible');
  assert.equal(crg.price.max, Infinity);
  assert.ok(crg.price.min >= job().minutes);
});

test('hosted minutes are refused once the free allowance cannot cover the job, never overdrawn', () => {
  const r = place({ ...job(), minutes: 20 }, nodes(), { ledger: ledger(1990), now: NOW });
  const hosted = r.refused.find(x => x.nodeId === 'github-hosted-ubuntu-24.04');
  assert.ok(hosted.why.includes('would-overdraw-the-free-allowance'));
});

test('with only a hosted runner left and an exhausted allowance there is no placement', () => {
  const only = nodes().filter(n => n.id === 'github-hosted-ubuntu-24.04');
  const r = place(job(), only, { ledger: ledger(2000), now: NOW });
  assert.equal(r.chosen, null);
});

test('a hosted minute costs more once the request exceeds the daily pace', () => {
  const l = ledger();
  const pace = paceMinutes(l, NOW);
  assert.equal(minutePrice(l, NOW, Math.floor(pace)), 0.1);
  assert.ok(minutePrice(l, NOW, Math.ceil(pace) + 30) > 1);
  assert.equal(minutePrice(l, NOW, 2001), null);
});

test('a node too small for the job is refused with the field named', () => {
  const small = { ...job(), needs: { cores: 64, memoryGb: 1, freeDiskGb: 1 } };
  const r = place(small, nodes().filter(n => n.id === 'cloud-session'), { ledger: ledger(), now: NOW });
  assert.equal(r.chosen, null);
  assert.ok(r.refused[0].why.includes('too-small:cores'));
});

test('a job that must run on named nodes is not placed elsewhere, and an effect waits for the Leader', () => {
  const effect = { ...job(), effect: true, mustRunOn: ['laptop'], requires: { capabilities: ['bare-cedar-fog'] } };
  const r = place(effect, nodes(), { ledger: ledger(), now: NOW });
  assert.equal(r.chosen, 'laptop');
  assert.equal(r.needsLeaderWords, true);
});

test('a down node is never chosen', () => {
  const ns = nodes().map(n => n.id === 'cloud-session' ? { ...n, state: 'down' } : n);
  assert.notEqual(place(job(), ns, { ledger: ledger(), now: NOW }).chosen, 'cloud-session');
});

test('allowance: hold, settle spent, remaining shrinks; a second hold on the same job is refused', () => {
  const l = ledger();
  assert.equal(hold(l, { jobId: 'a', minutes: 30 }).ok, true);
  assert.equal(remainingMinutes(l), 1970);
  assert.throws(() => hold(l, { jobId: 'a', minutes: 5 }), /already-holds/);
  settle(l, { jobId: 'a', state: 'spent', billedMinutes: 12 });
  assert.equal(remainingMinutes(l), 1988);
  assert.equal(hold(l, { jobId: 'b', minutes: 5000 }).ok, false);
  hold(l, { jobId: 'c', minutes: 10 });
  settle(l, { jobId: 'c', state: 'void' });
  assert.equal(remainingMinutes(l), 1988);
});

test('lease: one live holder, fencing token rises, stale holder is refused', () => {
  const t = newTable();
  const a = grant(t, { jobId: 'j', nodeId: 'laptop', now: NOW, ttlMs: 60_000 });
  assert.equal(a.ok, true);
  assert.equal(grant(t, { jobId: 'j', nodeId: 'cloud-session', now: NOW, ttlMs: 60_000 }).reason, 'live-lease-held');
  const later = '2026-10-15T04:52:00Z';
  assert.deepEqual(expired(t, later), ['j']);
  const b = grant(t, { jobId: 'j', nodeId: 'cloud-session', now: later, ttlMs: 60_000 });
  assert.ok(b.token > a.token);
  assert.equal(accept(t, { jobId: 'j', nodeId: 'laptop', token: a.token, now: later }).reason, 'stale-fencing-token');
  assert.equal(renew(t, { jobId: 'j', nodeId: 'cloud-session', token: b.token, now: later, ttlMs: 60_000 }).ok, true);
  assert.equal(accept(t, { jobId: 'j', nodeId: 'cloud-session', token: b.token, now: later }).ok, true);
  assert.equal(grant(t, { jobId: 'j', nodeId: 'laptop', now: later, ttlMs: 1 }).reason, 'job-already-settled');
});

test('lease: an effect is not accepted after expiry, a pure build is', () => {
  const t = newTable();
  const a = grant(t, { jobId: 'e', nodeId: 'laptop', now: NOW, ttlMs: 1000 });
  const late = '2026-10-15T05:00:00Z';
  assert.equal(accept(t, { jobId: 'e', nodeId: 'laptop', token: a.token, now: late, effect: true }).reason, 'effect-after-expiry');
  assert.equal(accept(t, { jobId: 'e', nodeId: 'laptop', token: a.token, now: late }).ok, true);
});

test('two builders with identical store paths agree; a difference is top and queues a repair', () => {
  const out = { machine: '/gnu/store/aaa-machine', profile: '/gnu/store/bbb-profile' };
  const agree = compareBuilds([{ nodeId: 'laptop', outputs: out }, { nodeId: 'cold-red-gate', outputs: out }]);
  assert.equal(agree.state, 'agree');
  assert.equal(publishable(agree), true);
  const top = compareBuilds([{ nodeId: 'laptop', outputs: out }, { nodeId: 'cold-red-gate', outputs: { ...out, profile: '/gnu/store/ccc-profile' } }]);
  assert.equal(top.state, 'top');
  assert.deepEqual(top.differing, ['profile']);
  assert.equal(publishable(top), false);
  assert.equal(compareBuilds([{ nodeId: 'laptop', outputs: out }]).state, 'single');
});
