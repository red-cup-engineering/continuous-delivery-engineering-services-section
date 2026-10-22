// Trusted per-MetroPlat-instance associate admission to original CI placement.
import { createHash } from 'node:crypto';
// Pure read-only projection: does NOT authenticate, dispatch, mint credits or
// register a GitHub runner. Only original server-side authorities may attest.

const isRef = v => typeof v === 'string' && v.length >= 8 && v.length <= 256 && !/[\s\0]/u.test(v);
const isId = v => typeof v === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(v);
const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const date = v => typeof v === 'string' ? Date.parse(v) : NaN;
const active = (v, now) => Number.isFinite(date(v)) && date(v) > now;
const recent = (v, now, limit) => Number.isFinite(date(v)) && date(v) <= now && now - date(v) <= limit;
const HTTPS = value => {
  try { const u = new URL(value);return u.protocol==='https:' && !u.username &&
    !u.password && !u.hash && Boolean(u.hostname); }catch{return false;}
};
const positiveMicro = value => typeof value==='string' &&
  /^[1-9][0-9]{0,14}$/u.test(value);
const QUOTE = /^sha256:[a-f0-9]{64}$/u;
const refuse = reason => Object.freeze({kind:'swarm-ci-node-proposal.v2',admitted:false,reason});

/** Convert independently verified member + machine evidence into a prospective
 * original placement node. readAdmission MUST be supplied by a trusted original
 * service, never by an HTTP caller, OIDC ID token or the volunteer device. It
 * authenticates login, membership, consent, device credential, sandbox witness,
 * capacity observation in their original systems; buyer reserve is read per Work.
 * Dispatch is NOT granted here; these proofs require renewal at execution.
 */
export function projectAssociateCiNode({ admissionRef, now, readAdmission } = {}) {
  const time = date(now);
  if (!Number.isFinite(time)) return refuse('invalid-observation-time');
  if (!isRef(admissionRef) || typeof readAdmission !== 'function') return refuse('trusted-admission-reader-required');
  let a;
  try { a = readAdmission({ admissionRef, now }); }
  catch { return refuse('admission-unavailable'); }
  if (a?.kind !== 'metroplat.instance-compute-admission.v1' ||
    a.ref !== admissionRef || !isRef(a.witnessRef))
    return refuse('admission-not-source-verified');
  // Original host/issuer are authenticated by the upstream reader; a login on
  // one MetroPlat instance never delegates compute rights to a neighbor.
  const actor=a.member?.actorId, id=a.device?.id, instance=a.instance?.id;
  const origin=a.instance?.origin, audience=a.instance?.oauthAudience;
  if (!isRef(instance) || !HTTPS(origin) || new URL(origin).href !== new URL(origin).origin+'/' ||
      !HTTPS(a.instance.oauthIssuer) || !isRef(audience) ||
      !audience.startsWith(origin) || !isRef(actor) || !isId(id) ||
      a.member?.instanceId!==instance || a.session?.instanceId!==instance ||
      a.device?.instanceId!==instance || a.consent?.instanceId!==instance ||
      a.sandbox?.instanceId!==instance || a.observation?.instanceId!==instance ||
      a.device?.actorId !== actor || a.session?.actorId !== actor ||
      a.consent?.actorId !== actor || a.consent?.deviceId !== id ||
      a.sandbox?.deviceId !== id || a.observation?.deviceId !== id)
    return refuse('instance-actor-device-custody-mismatch');
  if (a.session?.state!=='authenticated' || a.session?.method!=='oauth' ||
    a.session?.issuer!==a.instance.oauthIssuer || a.session?.audience!==audience ||
    !active(a.session.expiresAt,time)) return refuse('no-current-oauth-session');
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
    || !isId(a.observation.physicalPoolId) ||
    !isRef(a.observation.poolWitnessRef) ||
    !recent(a.observation.observedAt, time, 120_000))
    return refuse('capacity-not-independently-fresh');
  // One authenticated original market reading relates an actor's current
  // unwithdrawn offer and its stable receipt to this very device. Neither
  // the worker's own report nor a historical offer row can revive consent.
  const offer=a.marketOffer;
  const offered=offer?.limits;
  if(offer?.kind!=='organizing.compute-contribution-offer.v1' ||
    offer.event!=='offered' || a.marketOfferCurrent!==true ||
    !QUOTE.test(a.marketOfferRef ?? '') ||
    offer.instance!==instance || offer.by!==actor ||
    offer.deviceId!==id || offer.workClass!=='public-ci' ||
    !active(offer.expiresAt,time) ||
    !Number.isSafeInteger(offered?.coresMilli) || offered.coresMilli<1 ||
    !Number.isSafeInteger(offered?.memoryMiB) || offered.memoryMiB<1 ||
    !Number.isSafeInteger(offered?.diskMiB) || offered.diskMiB<1 ||
    !Number.isSafeInteger(offered?.maxMinutes) ||
    offered.maxMinutes<1 || offered.maxMinutes>60 ||
    !/^[A-Z]{3,5}$/u.test(offer.ask?.currency ?? '') ||
    !isRef(offer.ask?.unitRef) || !positiveMicro(offer.ask?.microsPerAcceptedUnit))
    return refuse('current-priced-original-market-offer-unverified');
  // At offer/admission time capacity is not yet sold and no buyer liability
  // exists. A held bilateral quote and buyer reservation are mandatory at
  // the individual Work gate, not a prerequisite to listing one's capacity.
  const limits = a.consent.limits, measured = a.observation;
  if (!limits || !['cores','memoryGb','freeDiskGb','maxMinutes'].every(k => positive(limits[k]))
    || !['cores','memoryGb','freeDiskGb','bandwidthMbps'].every(k => positive(measured[k]))
    || limits.maxMinutes > 60) return refuse('bounded-resource-limits-required');

  const node = Object.freeze({
    id:'associate-ci-'+createHash('sha256')
      .update(JSON.stringify([instance,actor,id])).digest('hex').slice(0,32),
    state: 'up', observedAt: measured.observedAt,
    // A real device has one original physical carrier even if multiple
    // worlds/OAuth memberships advertise it. The scheduler's independent
    // physical-pool observer must measure that carrier, or placement refuses.
    sharedCapacityPool:measured.physicalPoolId,
    // AOE offers milli-cores and MiB; the existing placement resource
    // coordinates use cores and GiB for memory/disk. Never round upward.
    cores: Math.min(measured.cores, limits.cores, offered.coresMilli / 1000),
    memoryGb: Math.min(measured.memoryGb, limits.memoryGb, offered.memoryMiB / 1024),
    freeDiskGb: Math.min(measured.freeDiskGb, limits.freeDiskGb, offered.diskMiB / 1024),
    bandwidthMbps: measured.bandwidthMbps, closureCache: [],
    capabilities: ['node', 'git', 'swarm-ci-public'], publicOnly: true,
    cost: { kind: 'associate-quoted' },
    associateCi: Object.freeze({admissionRef,witnessRef:a.witnessRef,
      instanceId:instance,instanceOrigin:origin,oauthAudience:audience,
      actorId:actor,deviceId:id,physicalPoolWitnessRef:measured.poolWitnessRef,
      workClass:'public-ci',
      offerRef:a.marketOfferRef,offerId:offer.offerId,
      offerCurrency:offer.ask.currency,unitRef:offer.ask.unitRef,
      minimumPriceMicros:offer.ask.microsPerAcceptedUnit,
      maxMinutes:Math.min(limits.maxMinutes,offered.maxMinutes),
      commercialState:'unsold-no-budget-hold'}),
  });
  return Object.freeze({kind:'swarm-ci-node-proposal.v2',admitted:true,node,
    status:'placement-candidate-only',dispatchAuthorized:false});
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
    || !isRef(a.witnessRef) || !isRef(a.instanceId) ||
    !HTTPS(a.instanceOrigin) || !isRef(a.oauthAudience) ||
    !isRef(a.actorId) || !isId(a.deviceId) || !positive(a.maxMinutes) ||
    !QUOTE.test(a.offerRef ?? '') || !isId(a.offerId) ||
    !/^[A-Z]{3,5}$/u.test(a.offerCurrency ?? '') ||
    !isRef(a.unitRef) || !positiveMicro(a.minimumPriceMicros)
    || node.publicOnly !== true || node.cost?.kind !== 'associate-quoted')
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
  // Both market parties must accept the same source-priced bounded quote.
  // This must be read from the original Work/Organizing/ledger owners, not
  // inferred from the worker's online time or OAuth authentication.
  const t=g.trade;
  if(t?.kind!=='organizing.compute-contribution-contract.v1' ||
    t.status!=='agreed-not-executed' ||
    t.executionAuthorized!==false || t.leaseAuthorized!==false ||
    t.earningPosted!==false || t.paymentAuthorized!==false ||
    t.instanceId!==a.instanceId || t.actorId!==a.actorId ||
    t.deviceId!==a.deviceId || t.workRef!==job.id ||
    !QUOTE.test(t.quoteId ?? '') || t.offerRef!==a.offerRef ||
    t.currency!==a.offerCurrency || t.unitRef!==a.unitRef ||
    !positiveMicro(t.priceMicrosPerAcceptedUnit) ||
    BigInt(t.priceMicrosPerAcceptedUnit)<BigInt(a.minimumPriceMicros) ||
    !isRef(t.buyerAcceptanceRef) || !isRef(t.supplierAcceptanceRef) ||
    t.buyerAcceptanceRef===t.supplierAcceptanceRef ||
    !isRef(t.budgetHoldRef) || !isRef(t.unitRef) ||
    !/^[A-Z]{3,5}$/u.test(t.currency ?? '') ||
    !positiveMicro(t.priceMicrosPerAcceptedUnit) ||
    !Number.isSafeInteger(t.maximumAcceptedUnits) ||
    t.maximumAcceptedUnits<1 || t.maximumAcceptedUnits>1_000_000 ||
    typeof t.maximumTotalMicros!=='string' || !/^[1-9][0-9]{0,18}$/u.test(t.maximumTotalMicros) ||
    BigInt(t.maximumTotalMicros)!==BigInt(t.priceMicrosPerAcceptedUnit)*BigInt(t.maximumAcceptedUnits) ||
    !active(t.expiresAt,time))
    return deny('bilateral-priced-work-and-reserved-budget-required');
  return Object.freeze({ok:true,kind:'swarm.ci-placement-eligibility.v2',
    grantRef:g.ref,sourceSha:g.sourceSha,trade:Object.freeze({
      quoteId:t.quoteId,offerRef:t.offerRef,budgetHoldRef:t.budgetHoldRef,
      currency:t.currency,unitRef:t.unitRef,
      priceMicrosPerAcceptedUnit:t.priceMicrosPerAcceptedUnit,
      maximumAcceptedUnits:t.maximumAcceptedUnits,
      maximumTotalMicros:t.maximumTotalMicros,
      expiresAt:t.expiresAt
    }),dispatchAuthorized:false});
}
