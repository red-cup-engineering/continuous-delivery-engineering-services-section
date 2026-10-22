// Trusted SWARM associate admission to original Continuous Delivery placement.
// Pure read-only projection: does NOT authenticate, dispatch, mint credits or
// register a GitHub runner. Only original server-side authorities may attest.

const isRef = v => typeof v === 'string' && v.length >= 8 && v.length <= 256 && !/[\s\0]/u.test(v);
const isId = v => typeof v === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(v);
const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const date = v => typeof v === 'string' ? Date.parse(v) : NaN;
const active = (v, now) => Number.isFinite(date(v)) && date(v) > now;
const recent = (v, now, limit) => Number.isFinite(date(v)) && date(v) <= now && now - date(v) <= limit;
const refuse = reason => Object.freeze({ kind: 'swarm-ci-node-proposal.v1', admitted: false, reason });

/** Convert independently verified member + machine evidence into a prospective
 * original placement node. readAdmission MUST be supplied by a trusted original
 * service, never by an HTTP caller, OIDC ID token or the volunteer device. It
 * authenticates login, membership, consent, device credential, sandbox witness,
 * capacity observation and economic reserve in their original systems.
 * Dispatch is NOT granted here; these proofs require renewal at execution.
 */
export function projectAssociateCiNode({ admissionRef, now, readAdmission } = {}) {
  const time = date(now);
  if (!Number.isFinite(time)) return refuse('invalid-observation-time');
  if (!isRef(admissionRef) || typeof readAdmission !== 'function') return refuse('trusted-admission-reader-required');
  let a;
  try { a = readAdmission({ admissionRef, now }); }
  catch { return refuse('admission-unavailable'); }
  if (a?.kind !== 'swarm.associate-ci-admission.v1' || a.ref !== admissionRef || !isRef(a.witnessRef))
    return refuse('admission-not-source-verified');

  const actor = a.member?.actorId, id = a.device?.id;
  if (typeof actor !== 'string' || !/^https:\/\/swarm\.561\.group\/actors\/[a-z0-9-]+$/u.test(actor)
    || !isId(id) || a.device?.actorId !== actor || a.session?.actorId !== actor
    || a.consent?.actorId !== actor || a.consent?.deviceId !== id
    || a.sandbox?.deviceId !== id || a.observation?.deviceId !== id)
    return refuse('actor-device-custody-mismatch');
  if (a.session?.state !== 'authenticated' || a.session?.provider !== 'google'
    || !active(a.session.expiresAt, time)) return refuse('no-current-login');
  if (a.member?.state !== 'approved' || !active(a.member.expiresAt, time))
    return refuse('no-current-associate-enrollment');
  if (a.device?.mode !== 'native-desktop' || a.device?.state !== 'connected')
    return refuse('desktop-agent-not-connected');
  if (a.consent?.state !== 'active' || !active(a.consent.expiresAt, time)
    || !Array.isArray(a.consent.workClasses) || !a.consent.workClasses.includes('public-ci'))
    return refuse('public-ci-not-consented');
  if (a.sandbox?.kind !== 'ephemeral-vm' || a.sandbox?.hostMounts !== false
    || a.sandbox?.secretMounts !== false || a.sandbox?.network !== 'restricted'
    || !isRef(a.sandbox.policyRef) || !recent(a.sandbox.verifiedAt, time, 86_400_000))
    return refuse('ephemeral-isolation-not-verified');
  if (a.observation?.state !== 'up' || !isRef(a.observation.witnessRef)
    || !recent(a.observation.observedAt, time, 120_000))
    return refuse('capacity-not-independently-fresh');
  if (a.creditHold?.state !== 'held' || a.creditHold?.workClass !== 'public-ci'
    || !isRef(a.creditHold.ref) || !active(a.creditHold.expiresAt, time))
    return refuse('original-credit-liability-not-held');

  const limits = a.consent.limits, measured = a.observation;
  if (!limits || !['cores','memoryGb','freeDiskGb','maxMinutes'].every(k => positive(limits[k]))
    || !['cores','memoryGb','freeDiskGb','bandwidthMbps'].every(k => positive(measured[k]))
    || limits.maxMinutes > 60) return refuse('bounded-resource-limits-required');

  const node = Object.freeze({
    id: 'associate-ci-' + id, state: 'up', observedAt: measured.observedAt,
    cores: Math.min(measured.cores, limits.cores),
    memoryGb: Math.min(measured.memoryGb, limits.memoryGb),
    freeDiskGb: Math.min(measured.freeDiskGb, limits.freeDiskGb),
    bandwidthMbps: measured.bandwidthMbps, closureCache: [],
    capabilities: ['node', 'git', 'swarm-ci-public'], publicOnly: true,
    cost: { kind: 'held' },
    associateCi: Object.freeze({ admissionRef, witnessRef: a.witnessRef,
      actorId: actor, deviceId: id, workClass: 'public-ci',
      maxMinutes: limits.maxMinutes, creditHoldRef: a.creditHold.ref }),
  });
  return Object.freeze({ kind: 'swarm-ci-node-proposal.v1', admitted: true, node,
    status: 'placement-candidate-only', dispatchAuthorized: false });
}

const sha40 = v => typeof v === 'string' && /^[a-f0-9]{40}$/u.test(v);

/** Even an admitted device cannot execute an arbitrary job. This second,
 * independent original-work gate requires public, pure, explicitly qualified,
 * immutable CI inputs and an exact server-side source/Work grant. Grant readers
 * MUST verify the actual forge repository, trusted event, ref, rights and
 * private-source prohibition, not believe a job object's public claim.
 */
export function assessAssociateCiJob({ job, node, now, authorizeAssociateJob } = {}) {
  const a = node?.associateCi, deny = reason => Object.freeze({ok: false, reason});
  if (!a || a.workClass !== 'public-ci' || !isRef(a.admissionRef)
    || !isRef(a.witnessRef) || !isRef(a.creditHoldRef)
    || !isId(a.deviceId) || !positive(a.maxMinutes)
    || node.publicOnly !== true || node.cost?.kind !== 'held')
    return deny('not-a-qualified-associate-ci-node');
  if (job?.visibility !== 'public' || job.effect !== false
    || !job.requires?.capabilities?.includes('swarm-ci-public'))
    return deny('workload-not-public-pure-ci');
  if (!Number.isSafeInteger(job.minutes) || job.minutes < 1
    || !Number.isSafeInteger(job.maxMinutes) || job.maxMinutes < job.minutes
    || job.maxMinutes > a.maxMinutes)
    return deny('runtime-exceeds-consent');
  if (!sha40(job.source?.commitSha) || job.source?.visibility !== 'public'
    || job.source?.trigger !== 'trusted-push'
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(job.source?.repository ?? ''))
    return deny('immutable-public-source-required');
  const time = date(now);
  if (!Number.isFinite(time) || typeof authorizeAssociateJob !== 'function')
    return deny('trusted-work-grant-required');
  let g;
  try { g = authorizeAssociateJob({job, node, now}); }
  catch { return deny('trusted-work-grant-unavailable'); }
  if (g?.kind !== 'swarm.ci-job-grant.v1' || g.allowed !== true || !isRef(g.ref)
    || g.jobId !== job.id || g.nodeId !== node.id
    || g.admissionRef !== a.admissionRef || g.sourceSha !== job.source.commitSha
    || !active(g.expiresAt, time))
    return deny('exact-ci-work-not-authorized');
  return Object.freeze({ok:true, kind:'swarm.ci-placement-eligibility.v1',
    grantRef:g.ref, sourceSha:g.sourceSha, dispatchAuthorized:false});
}
