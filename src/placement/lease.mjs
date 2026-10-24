// Single-executor lease per job with a monotonic fencing token (lease HLD, LLD-4 of the no-hub design).
// Pure functions over a JSON-serializable table. A result is accepted only with the newest token.
export const newTable = () => ({ counter: 0, jobs: {} });
const live = (j, now) => j && Date.parse(j.expiresAt) > Date.parse(now);
// A SHA-256 name is only content integrity, not proof of identity, authorization,
// independent result acceptance or source custody. It becomes useful after the
// original SHP receiver actually checks the bytes and their Work ownership.
const PACKET_NI = /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u;
function checkedPacketNi(packetNi) {
  if (packetNi !== undefined &&
      (typeof packetNi !== 'string' || !PACKET_NI.test(packetNi)))
    throw new TypeError('canonical packetNi expected when binding source Work');
}
const ownJob = (t, id) =>
  Object.hasOwn(t.jobs, id) ? t.jobs[id] : undefined;
const samePacket = (j, ni) =>
  (Object.hasOwn(j, 'packetNi') ? j.packetNi : undefined) === ni;
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

export function grant(t, { jobId, nodeId, now, ttlMs, packetNi }) {
  qualifiedJob(jobId,nodeId);
  checkedPacketNi(packetNi);
  const expiry=qualifiedExpiry(now,ttlMs);
  if(!Number.isSafeInteger(t.counter)||t.counter<0||t.counter===Number.MAX_SAFE_INTEGER)
    throw new TypeError('monotone lease counter is invalid or exhausted');
  const j = ownJob(t,jobId);
  if (j?.done) return { ok: false, reason: 'job-already-settled' };
  if (j && !samePacket(j,packetNi))
    return { ok: false, reason: 'changed-source-packet-under-original-job-id' };
  if (live(j, now) && !j.done) return { ok: false, reason: 'live-lease-held', holder: j.nodeId };
  const next={nodeId,token:t.counter+1,expiresAt:expiry,done:false};
  if(packetNi!==undefined) next.packetNi=packetNi;
  // Define an OWN property: job IDs such as "__proto__" must never alter
  // the prototype of an in-memory or JSON-round-tripped lease table.
  Object.defineProperty(t.jobs,jobId,{
    value:next,enumerable:true,configurable:true,writable:true,
  });
  t.counter += 1;
  return { ok: true, token: next.token, expiresAt: next.expiresAt };
}
export function renew(t, { jobId, nodeId, token, now, ttlMs, packetNi }) {
  qualifiedJob(jobId,nodeId);
  checkedPacketNi(packetNi);
  const expiry=qualifiedExpiry(now,ttlMs);
  const j = ownJob(t,jobId);
  if (!j || j.nodeId !== nodeId || j.token !== token || !live(j, now) || j.done) return { ok: false, reason: 'not-the-live-holder' };
  if (!samePacket(j,packetNi))
    return { ok: false, reason: 'packet-source-not-the-lease-bound-work' };
  j.expiresAt = expiry;
  return { ok: true, expiresAt: j.expiresAt };
}
// A pure build may be accepted from an expired holder whose token is still the newest (the bytes are
// content-addressed); an effect never may.
export function accept(t, { jobId, nodeId, token, now, effect = false, packetNi }) {
  checkedPacketNi(packetNi);
  const j = ownJob(t,jobId);
  if (!j || j.done) return { ok: false, reason: 'no-open-lease' };
  if (j.token !== token || j.nodeId !== nodeId) return { ok: false, reason: 'stale-fencing-token' };
  if (!samePacket(j,packetNi))
    return { ok: false, reason: 'packet-source-not-the-lease-bound-work' };
  if (effect && !live(j, now)) return { ok: false, reason: 'effect-after-expiry' };
  j.done = true;
  return { ok: true };
}
export const expired = (t, now) => Object.entries(t.jobs).filter(([, j]) => !j.done && !live(j, now)).map(([id]) => id);
