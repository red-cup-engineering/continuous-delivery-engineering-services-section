// Single-executor lease per job with a monotonic fencing token (lease HLD, LLD-4 of the no-hub design).
// Pure functions over a JSON-serializable table. A result is accepted only with the newest token.
export const newTable = () => ({ counter: 0, jobs: {} });
const live = (j, now) => j && Date.parse(j.expiresAt) > Date.parse(now);
function qualifiedExpiry(now,ttlMs) {
  const observed=typeof now==='string'?Date.parse(now):NaN;
  if(!Number.isFinite(observed)||!Number.isSafeInteger(ttlMs)||ttlMs<=0)
    throw new TypeError('lease requires a valid observation and positive whole TTL');
  const until=observed+ttlMs;
  if(!Number.isSafeInteger(until)||!Number.isFinite(until)||
     !Number.isFinite(new Date(until).getTime()))
    throw new TypeError('lease expiry exceeds representable time');
  return new Date(until).toISOString();
}
function qualifiedJob(jobId,nodeId) {
  if(typeof jobId!=='string'||!jobId.trim()||
     typeof nodeId!=='string'||!nodeId.trim())
    throw new TypeError('original job and executor identities required');
}

export function grant(t, { jobId, nodeId, now, ttlMs }) {
  qualifiedJob(jobId,nodeId);
  const expiry=qualifiedExpiry(now,ttlMs);
  if(!Number.isSafeInteger(t.counter)||t.counter<0||t.counter===Number.MAX_SAFE_INTEGER)
    throw new TypeError('monotone lease counter is invalid or exhausted');
  const j = t.jobs[jobId];
  if (live(j, now) && !j.done) return { ok: false, reason: 'live-lease-held', holder: j.nodeId };
  if (j?.done) return { ok: false, reason: 'job-already-settled' };
  t.counter += 1;
  t.jobs[jobId] = { nodeId, token: t.counter, expiresAt: expiry, done: false };
  return { ok: true, token: t.counter, expiresAt: t.jobs[jobId].expiresAt };
}
export function renew(t, { jobId, nodeId, token, now, ttlMs }) {
  qualifiedJob(jobId,nodeId);
  const expiry=qualifiedExpiry(now,ttlMs);
  const j = t.jobs[jobId];
  if (!j || j.nodeId !== nodeId || j.token !== token || !live(j, now) || j.done) return { ok: false, reason: 'not-the-live-holder' };
  j.expiresAt = expiry;
  return { ok: true, expiresAt: j.expiresAt };
}
// A pure build may be accepted from an expired holder whose token is still the newest (the bytes are
// content-addressed); an effect never may.
export function accept(t, { jobId, nodeId, token, now, effect = false }) {
  const j = t.jobs[jobId];
  if (!j || j.done) return { ok: false, reason: 'no-open-lease' };
  if (j.token !== token || j.nodeId !== nodeId) return { ok: false, reason: 'stale-fencing-token' };
  if (effect && !live(j, now)) return { ok: false, reason: 'effect-after-expiry' };
  j.done = true;
  return { ok: true };
}
export const expired = (t, now) => Object.entries(t.jobs).filter(([, j]) => !j.done && !live(j, now)).map(([id]) => id);
