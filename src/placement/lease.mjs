// Single-executor lease per job with a monotonic fencing token (lease HLD, LLD-4 of the no-hub design).
// Pure functions over a JSON-serializable table. A result is accepted only with the newest token.
export const newTable = () => ({ counter: 0, jobs: {} });
const live = (j, now) => j && Date.parse(j.expiresAt) > Date.parse(now);

export function grant(t, { jobId, nodeId, now, ttlMs }) {
  const j = t.jobs[jobId];
  if (live(j, now) && !j.done) return { ok: false, reason: 'live-lease-held', holder: j.nodeId };
  if (j?.done) return { ok: false, reason: 'job-already-settled' };
  t.counter += 1;
  t.jobs[jobId] = { nodeId, token: t.counter, expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(), done: false };
  return { ok: true, token: t.counter, expiresAt: t.jobs[jobId].expiresAt };
}
export function renew(t, { jobId, nodeId, token, now, ttlMs }) {
  const j = t.jobs[jobId];
  if (!j || j.nodeId !== nodeId || j.token !== token || !live(j, now) || j.done) return { ok: false, reason: 'not-the-live-holder' };
  j.expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
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
