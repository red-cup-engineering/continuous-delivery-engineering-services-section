// Place a job on the node that can run it at the lowest price. Unknown quantities are intervals
// (min 0, max unbounded), never zero. Price is minutes of wall time plus scarcity.
import { minutePrice, quoteBudget, budgetAvailable, hold, holdBudget } from './allowance.mjs';
import { createHash } from 'node:crypto';

const iv = q => q == null ? { min: 0, max: Infinity } : typeof q === 'number' ? { min: q, max: q } : { min: q.min ?? 0, max: q.max ?? Infinity };
const add = (a, b) => ({ min: a.min + b.min, max: a.max + b.max });
const mul = (a, k) => ({ min: a.min * k, max: a.max * k });
const fit = (have, need) => { const h = iv(have); return h.min >= need ? 'certain' : h.max >= need ? 'possible' : 'no'; };
const worst = (...xs) => xs.includes('no') ? 'no' : xs.includes('possible') ? 'possible' : 'certain';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reference = value => typeof value === 'string' && value.trim().length >= 8 && value.length <= 2048;
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const sourceIdentity = value => record(value) && Object.keys(value).length === 3 && Number.isSafeInteger(value.repositoryId) && value.repositoryId > 0
  && typeof value.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) && oid(value.commit);
const sameSource = (a,b) => sourceIdentity(a) && sourceIdentity(b) && a.repositoryId === b.repositoryId
  && a.repository === b.repository && a.commit === b.commit;
const workspace = value => typeof value === 'string' && value.startsWith('/') && !value.includes('\0')
  && !value.split('/').some(part => part === '.' || part === '..');
const measuredInterval = value => typeof value === 'number' ? Number.isFinite(value) && value >= 0
  : record(value) && Number.isFinite(value.min) && Number.isFinite(value.max) && value.min >= 0 && value.max >= value.min;
function jobDigest(value) {
  const active=new Set();
  const canonical=value=>{
    if(value===null || typeof value==='boolean' || typeof value==='string') return JSON.stringify(value);
    if(typeof value==='number' && Number.isFinite(value)) return JSON.stringify(value);
    if(!record(value) && !Array.isArray(value)) throw new TypeError('JSON job required');
    if(active.has(value) || (Object.getPrototypeOf(value)!==Object.prototype && !Array.isArray(value)))
      throw new TypeError('plain acyclic JSON job required');
    if(Array.isArray(value) && Object.keys(value).length!==value.length)
      throw new TypeError('dense JSON job arrays required');
    active.add(value);
    const result=Array.isArray(value)?'['+value.map(canonical).join(',')+']'
      :'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
    active.delete(value);return result;
  };
  const bytes=canonical(value);
  if(Buffer.byteLength(bytes)>1024*1024) throw new TypeError('bounded JSON job required');
  return createHash('sha256').update(bytes).digest('hex');
}

/** Opt-in receiving preflight, not a runner provisioner or an authority reader.
 * The owning host supplies a synchronous, read-only admission reader which has
 * independently authenticated the issuer and current source-bound evidence.
 * JSON, a label, a local tool, or a true callback result cannot supply it.
 * effect:false excludes consequential external effects, not ordinary test I/O.
 */
export function preflightSessionExecution(job,node,{now,readSessionAdmission}={}) {
  if(job.sessionExecution === undefined && node.sessionExecution === undefined) return null;
  const why=[], wanted=job.sessionExecution, observed=node.sessionExecution, at=Date.parse(now);
  if(!record(wanted) || !['local-qualification','github-jit'].includes(wanted.mode)
      || !reference(wanted.scope) || !reference(wanted.sessionId) || !sourceIdentity(wanted.source) || !workspace(wanted.workspacePath))
    why.push('session-job-identity-required');
  if(typeof job.id !== 'string' || !job.id.trim() || typeof node.id !== 'string' || !node.id.trim())
    why.push('session-job-or-node-identity-required');
  if(job.effect !== false) why.push('session-external-effect-free-job-required');
  if(!Number.isFinite(job.minutes) || job.minutes <= 0 || !Number.isFinite(job.maxMinutes)
      || job.maxMinutes < job.minutes || job.maxMinutes <= 0)
    why.push('session-maximum-runtime-required');
  const until=at+job.maxMinutes*60_000;
  if(!record(observed) || !reference(observed.scope) || !reference(observed.observationRef) || !reference(observed.sessionId)
      || !Number.isFinite(Date.parse(observed.observedAt)) || !Number.isFinite(at)
      || at < Date.parse(observed.observedAt) || at-Date.parse(observed.observedAt) > 3_600_000)
    why.push('session-observation-stale-or-absent');
  if(wanted?.scope !== observed?.scope || wanted?.sessionId !== observed?.sessionId || wanted?.workspacePath !== observed?.workspacePath
      || !sameSource(wanted?.source,observed?.source) || observed?.checkoutHead !== wanted?.source?.commit
      || observed?.checkoutClean !== true)
    why.push('session-source-head-or-workspace-differs');
  if(!Number.isFinite(until) || !Number.isFinite(Date.parse(observed?.expiresAt))
      || Date.parse(observed.expiresAt) < until)
    why.push('session-lifetime-does-not-cover-job');
  if(observed?.lifecycle !== 'foreground-single-job' || observed?.maxJobs !== 1
      || observed?.activeJobs !== 0 || observed?.completedJobs !== 0)
    why.push('session-single-job-lifecycle-unreceived');
  if(!Number.isSafeInteger(job.needs?.freeInodes) || job.needs.freeInodes <= 0
      || !Number.isSafeInteger(node.freeInodes) || node.freeInodes < 0)
    why.push('session-inode-capacity-unmeasured');
  else if(node.freeInodes < job.needs.freeInodes) why.push('too-small:freeInodes');
  for(const key of ['cores','memoryGb','freeDiskGb'])
    if(!Number.isFinite(job.needs?.[key]) || job.needs[key] < 0 || !Number.isFinite(node[key]) || node[key] < 0
        || (key === 'cores' && job.needs[key] <= 0)) why.push('session-resource-unmeasured:'+key);
    else if(node[key] < job.needs[key]) why.push('too-small:'+key);
  // The occupied session includes source transfer and any queue/away time,
  // not merely the optimistic test duration. Unknown quantities are not zero.
  let digest,observationDigest;
  try {
    digest=jobDigest(job);
    observationDigest=jobDigest(node);
    if(!Array.isArray(job.closure) || !Number.isFinite(node.startupMinutes) || node.startupMinutes<0
        || !Number.isFinite(node.queuedMinutes) || node.queuedMinutes<0
        || (node.state==='intermittent' && (!Number.isFinite(node.expectedAwayMinutes) || node.expectedAwayMinutes<0)))
      why.push('session-placement-time-unmeasured');
    else {
      const cached=Array.isArray(node.closureCache)?new Set(node.closureCache):null;
      const membersValid=cached && node.closureCache.every(id=>typeof id==='string' && id.trim())
        && job.closure.every(member=>record(member) && typeof member.id==='string' && member.id.trim()
          && (cached.has(member.id) || measuredInterval(member.sizeMb??job.defaultMemberSizeMb)));
      const missing=membersValid?job.closure.filter(member=>!cached.has(member.id)):[];
      const needsTransfer=missing.some(member=>iv(member.sizeMb??job.defaultMemberSizeMb).max>0);
      const bandwidthValid=!needsTransfer || (measuredInterval(node.bandwidthMbps) && iv(node.bandwidthMbps).min>0);
      const transfer=membersValid && bandwidthValid?fetchMinutes(job,node).minutes.max:NaN;
      if(!Number.isFinite(transfer) || transfer<0) why.push('session-transfer-time-unmeasured');
      const occupied=transfer+job.minutes+node.startupMinutes+node.queuedMinutes
        +(node.state==='intermittent'?node.expectedAwayMinutes:0);
      if(!Number.isFinite(occupied) || occupied>job.maxMinutes)
        why.push('session-maximum-does-not-cover-placement-time');
    }
  } catch { why.push('session-original-job-unqualified'); }
  // Do not consult authority on a source/capacity/lifecycle mismatch.
  if(why.length) return {ok:false,why};
  if(typeof readSessionAdmission !== 'function') return {ok:false,why:['session-admission-unreceived']};
  const subject={jobId:job.id,nodeId:node.id,scope:wanted.scope,sessionId:wanted.sessionId,mode:wanted.mode,
    source:{...wanted.source},workspacePath:wanted.workspacePath,maxMinutes:job.maxMinutes,
    observationRef:observed.observationRef,jobDigest:digest,observationDigest};
  let admission;
  try { admission=readSessionAdmission(structuredClone(subject)); }
  catch { return {ok:false,why:['session-admission-read-failed']}; }
  const sameSubject=record(admission?.subject) && Object.keys(subject).length === Object.keys(admission.subject).length
    && ['jobId','nodeId','scope','sessionId','mode','workspacePath','maxMinutes','observationRef','jobDigest','observationDigest'].every(key=>admission.subject[key]===subject[key])
    && sameSource(admission.subject.source,subject.source);
  if(!record(admission) || admission.kind !== 'session-execution-admission.v1' || admission.state !== 'received'
      || !sameSubject || !reference(admission.issuer) || !reference(admission.evidenceRef)
      || !oid(admission.verifierRevision) || !reference(admission.reviewRef) || !reference(admission.lifecycleRef)
      || !reference(admission.isolationRef) || admission.credentialPolicy !== 'no-job-secrets'
      || !Number.isFinite(Date.parse(admission.observedAt)) || Date.parse(admission.observedAt) > at
      || at-Date.parse(admission.observedAt) > 3_600_000
      || !Number.isFinite(Date.parse(admission.expiresAt)) || Date.parse(admission.expiresAt) < until)
    return {ok:false,why:['session-admission-identity-or-evidence-unreceived']};
  const isolation=wanted.mode==='github-jit'?'clean-one-job':'reviewed-local-source';
  if(admission.isolation !== isolation) return {ok:false,why:['session-isolation-unreceived']};
  if(wanted.mode==='github-jit' && (!record(admission.runner) || !Number.isSafeInteger(admission.runner.id)
      || admission.runner.id <= 0 || admission.runner.repositoryId !== wanted.source.repositoryId
      || admission.runner.ephemeral !== true || admission.runner.scope !== 'trusted-exact-head'
      || !reference(admission.runner.evidenceRef)))
    return {ok:false,why:['session-runner-registration-unreceived']};
  return {ok:true,mode:wanted.mode,scope:wanted.scope,sessionId:wanted.sessionId,source:{...wanted.source},
    evidenceRef:admission.evidenceRef,expiresAt:new Date(Math.min(Date.parse(observed.expiresAt),Date.parse(admission.expiresAt))).toISOString(),
    executed:false,leaseRequired:true};
}

export function fetchMinutes(job, node) {
  const cached = new Set(node.closureCache ?? []);
  const missing = job.closure.filter(m => !cached.has(m.id));
  const mb = missing.reduce((s, m) => add(s, iv(m.sizeMb ?? job.defaultMemberSizeMb)), { min: 0, max: 0 });
  const bw = iv(node.bandwidthMbps);               // megabits per second; seconds = megabytes * 8 / Mbps
  const div = (m, r) => m === 0 ? 0 : r === 0 ? Infinity : (m * 8) / r / 60;
  return { missing: missing.map(m => m.id), minutes: { min: div(mb.min, bw.max), max: div(mb.max, bw.min) } };
}

export function assess(job, node, { ledger = null, budgets = {}, now, readSessionAdmission }) {
  const why = [];
  const session=preflightSessionExecution(job,node,{now,readSessionAdmission});
  if(session && !session.ok) why.push(...session.why);
  if (job.mustRunOn && !job.mustRunOn.includes(node.id)) why.push('job-names-other-nodes');
  if (!['up','intermittent'].includes(node.state)) why.push('node-not-observed-up');
  const nowMs=Date.parse(now),nodeAt=Date.parse(node.observedAt);
  if(!Number.isFinite(nowMs)||!Number.isFinite(nodeAt)||
    nowMs<nodeAt||nowMs-nodeAt>3_600_000)
    why.push('node-availability-observation-stale-or-absent');
  const visibility=job.visibility??'private'; // no implicit public classification
  if (visibility!=='public'&&node.publicOnly===true)
    why.push('private-source-on-public-only-provider');
  if (visibility!=='public'&&node.cost?.kind==='metered-free'){
    const e=job.sourceEgress;
    if(e?.permitted!==true||e.provider!==node.cost.provider||
      e.scope!==node.cost.scope||
      typeof e.authorityRef!=='string'||e.authorityRef.length<8)
      why.push('private-source-egress-not-granted');
  }
  for (const c of job.requires?.capabilities ?? []) if (!(node.capabilities ?? []).includes(c)) why.push(`lacks-capability:${c}`);
  const n = job.needs ?? {};
  const f = { cores: fit(node.cores, n.cores ?? 0), memoryGb: fit(node.memoryGb, n.memoryGb ?? 0), freeDiskGb: fit(node.freeDiskGb, n.freeDiskGb ?? 0) };
  for (const [k, v] of Object.entries(f)) if (v === 'no') why.push(`too-small:${k}`);
  let scarcity = 0, budgetHold = null;
  if (node.cost?.kind === 'hosted-minutes') {
    // Minute-based external executions must hold their worst-case runtime.
    // Quoting the optimistic estimate can exhaust free minutes mid-job.
    const maximum=job.maxMinutes;
    if(!Number.isSafeInteger(job.minutes)||job.minutes<=0||
       !Number.isSafeInteger(maximum)||maximum<job.minutes||
       (node.cost.maxJobMinutes!==undefined&&maximum>node.cost.maxJobMinutes))
      why.push('bounded-max-hosted-minutes-required');
    if (!ledger) why.push('no-observed-hosted-allowance');
    else if(Number.isSafeInteger(maximum)&&maximum>0){
      const price=minutePrice(ledger,now,maximum);
      if(price===null)why.push('hosted-allowance-exhausted-or-stale');
      else {
        scarcity=price;
        budgetHold={kind:'hosted-minutes',minutes:maximum,
          plan:ledger.plan,month:ledger.month,observedAt:ledger.observedAt};
      }
    }
  } else if(node.cost?.kind==='metered-free'){
    if(node.cost.hardStop!==true) why.push('provider-may-charge-above-free-tier');
    if(!Number.isFinite(job.maxMinutes)||job.maxMinutes<=0||
      job.maxMinutes<job.minutes||
      !Number.isFinite(node.cost.maxJobMinutes)||node.cost.maxJobMinutes<=0||
      job.maxMinutes>node.cost.maxJobMinutes)
      why.push('bounded-max-job-minutes-required');
    const rates=node.cost.unitsPerMinute,units={};
    if(!rates||Array.isArray(rates)||typeof rates!=='object'||!Object.keys(rates).length)
      why.push('metered-provider-resource-rates-unavailable');
    else for(const [unit,rate] of Object.entries(rates)){
      if(!/^[a-z][a-z0-9A-Z]{0,31}$/u.test(unit)||typeof rate!=='number'||
        !Number.isFinite(rate)||rate<=0)why.push('invalid-provider-resource-rate:'+unit);
      else if(Number.isFinite(job.maxMinutes))units[unit]=Math.ceil(job.maxMinutes*rate*1e6)/1e6;
    }
    if(!why.length){
      const quote=quoteBudget(budgets[node.cost.scope],{
        provider:node.cost.provider,scope:node.cost.scope,now,units
      });
      if(!quote.ok)why.push(quote.reason);
      else {
        budgetHold={provider:node.cost.provider,scope:node.cost.scope,
          units,sourceRef:quote.sourceRef,expiresAt:quote.expiresAt};
        // Rank against the same outstanding holds already applied by quoteBudget.
        // Nominal provider.remaining exaggerates capacity reserved by other jobs.
        const available=budgetAvailable(budgets[node.cost.scope]);
        scarcity=0.1+Math.max(...Object.entries(units).map(([unit,value])=>
          value/Math.max(available[unit],1e-9)));
      }
    }
  } else if(node.cost?.kind!=='held')
    why.push('unsupported-or-unpriced-provider');
  if (why.length) return { nodeId: node.id, feasible: false, why:[...new Set(why)] };
  const fetch = fetchMinutes(job, node);
  let price = add(fetch.minutes, mul(iv(job.minutes), 1 + scarcity));
  price = add(price, iv(node.queuedMinutes ?? 0));
  if (node.state === 'intermittent') price = add(price, iv(node.expectedAwayMinutes));
  return { nodeId: node.id, feasible: true, certainty: worst(...Object.values(f)), price, missing: fetch.missing, scarcityPerMinute: scarcity, budgetHold,
    ...(session?{sessionExecution:session}:{}) };
}

const rank = a => [a.certainty === 'certain' ? 0 : 1, Number.isFinite(a.price.max) ? 0 : 1, a.price.max, a.price.min];
const cmp = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

export function place(job, nodes, ctx) {
  const assessed = nodes.map(n => assess(job, n, ctx));
  const candidates = assessed.filter(a => a.feasible).sort(cmp);
  const chosen = candidates[0] ?? null;
  return {
    job: job.id, chosen: chosen?.nodeId ?? null,
    needsProbe: chosen ? chosen.certainty !== 'certain' : false,   // an advertised field was unknown: measure before relying on it
    needsLeaderWords: Boolean(job.effect),
    candidates, refused: assessed.filter(a => !a.feasible),
  };
}


/** Plan a whole office shift against the *same observed pool*.
 * This is a deterministic, side-effect-free proposal: all budget holds and
 * resource reservations are made only in temporary copies, never charged
 * externally or persisted as a distributed lease. The receiver must acquire
 * a single-writer original budget hold and fencing token before execution.
 * Job ordering is the caller's independently governed priority ordering.
 */
export function planFleet(jobs,nodes,{ledger=null,budgets={},now,readSessionAdmission}={}){
  if(!Array.isArray(jobs)||!Array.isArray(nodes)||!jobs.length||
    !Number.isFinite(Date.parse(now))||jobs.length>1000||nodes.length>256)
    throw new TypeError('bounded original jobs, nodes and observation time required');
  const ids=new Set();
  for(const job of jobs){
    if(typeof job?.id!=='string'||!job.id.trim()||ids.has(job.id))
      throw new TypeError('unique original job identities required');
    ids.add(job.id);
  }
  const locations=new Set();
  for(const node of nodes){
    if(typeof node?.id!=='string'||!node.id.trim()||locations.has(node.id))
      throw new TypeError('unique original node identities required');
    locations.add(node.id);
  }
  const provisionalNodes=structuredClone(nodes);
  const provisionalLedger=ledger===null?null:structuredClone(ledger);
  const provisionalBudgets=structuredClone(budgets);
  const placements=[],pending=[],probes=[];
  for(const job of jobs){
    // An effectful office operation requires a separate authenticated
    // authority/lease receiver. A pure placement plan cannot manufacture one.
    if(Boolean(job.effect)){
      pending.push({jobId:job.id,reason:'effect-authority-not-received'});
      continue;
    }
    if(!Array.isArray(job.closure)||!Number.isFinite(job.minutes)||
      job.minutes<=0||!Number.isFinite(job.maxMinutes)||
      job.maxMinutes<job.minutes||job.maxMinutes<=0){
      pending.push({jobId:job.id,reason:'original-job-closure-or-maximum-runtime-unmeasured'});
      continue;
    }
    const dimensions=['cores','memoryGb','freeDiskGb',...(job.sessionExecution===undefined?[]:['freeInodes'])];
    if(dimensions.some(k=>!Number.isFinite(job.needs?.[k])||job.needs[k]<0)||
      job.needs.cores<=0){
      pending.push({jobId:job.id,reason:'explicit-compute-footprint-required'});
      continue;
    }
    const view=place(job,provisionalNodes,
      {now,ledger:provisionalLedger,budgets:provisionalBudgets,readSessionAdmission});
    // Only candidates with finite worst-case runtime and *certain* measured
    // resources can acquire provisional capacity. Possible measurements
    // request probes; a chosen node name alone is never dispatch authority.
    const candidate=view.candidates.find(c=>c.certainty==='certain'&&
      Number.isFinite(c.price.max)&&provisionalNodes.some(n=>{
        if(n.id!==c.nodeId)return false;
        return dimensions.every(k=>typeof n[k]==='number'&&
          Number.isFinite(n[k])&&n[k]>=job.needs[k]);
      }));
    if(!candidate){
      if(view.candidates.some(c=>c.certainty!=='certain'||!Number.isFinite(c.price.max)))
        probes.push({jobId:job.id,reason:'measure-original-node-resources-or-transfer-time',
          nodeIds:view.candidates.map(c=>c.nodeId)});
      pending.push({jobId:job.id,reason:'no-finite-certain-original-placement',
        refused:view.refused.map(x=>({nodeId:x.nodeId,why:x.why}))});
      continue;
    }
    const node=provisionalNodes.find(n=>n.id===candidate.nodeId);
    // Account for *all* concurrent jobs in one provisional free allowance.
    // Never expose the temporary hold as an authorization to execute work.
    if(node.cost?.kind==='hosted-minutes'){
      if(!candidate.budgetHold||!provisionalLedger){
        pending.push({jobId:job.id,reason:'missing-original-hosted-hold'});
        continue;
      }
      const held=hold(provisionalLedger,{jobId:job.id,
        minutes:candidate.budgetHold.minutes});
      if(!held.ok){
        pending.push({jobId:job.id,reason:held.reason});
        continue;
      }
    }else if(node.cost?.kind==='metered-free'){
      if(!candidate.budgetHold||!provisionalBudgets[node.cost.scope]){
        pending.push({jobId:job.id,reason:'missing-original-provider-budget'});
        continue;
      }
      const held=holdBudget(provisionalBudgets[node.cost.scope],{
        jobId:job.id,provider:node.cost.provider,scope:node.cost.scope,
        now,units:candidate.budgetHold.units});
      if(!held.ok){
        pending.push({jobId:job.id,reason:held.reason});
        continue;
      }
    }
    const resourceHold=Object.fromEntries(dimensions.map(k=>[k,job.needs[k]]));
    for(const key of dimensions)node[key]-=resourceHold[key];
    if(candidate.sessionExecution) for(const alias of provisionalNodes)
      if(alias.sessionExecution?.scope===node.sessionExecution.scope && alias.sessionExecution?.sessionId===node.sessionExecution.sessionId)
        alias.sessionExecution.activeJobs = 1;
    placements.push({jobId:job.id,nodeId:node.id,resourceHold,
      budgetHold:candidate.budgetHold,price:candidate.price,
      state:'proposed-not-executed',leaseRequired:true,
      ...(candidate.sessionExecution?{sessionExecution:candidate.sessionExecution}:{})});
  }
  return {kind:'original-fleet-placement-proposal',at:now,placements,pending,probes,
    proposed:placements.length,unplaced:pending.length,
    executed:0,providerBudgetHeld:false,leaseReceived:false,
    // Remaining are temporary hypothetical amounts, not provider readback.
    residualResources:provisionalNodes.map(n=>({nodeId:n.id,
      cores:n.cores,memoryGb:n.memoryGb,freeDiskGb:n.freeDiskGb,
      ...(n.sessionExecution===undefined?{}:{freeInodes:n.freeInodes})}))};
}
