// Place a job on the node that can run it at the lowest price. Unknown quantities are intervals
// (min 0, max unbounded), never zero. Price is minutes of wall time plus scarcity.
import { minutePrice, quoteBudget, budgetAvailable, hold, holdBudget } from './allowance.mjs';
import { assessAssociateCiJob } from './associate-ci.mjs';

const iv = q => q == null ? { min: 0, max: Infinity } : typeof q === 'number' ? { min: q, max: q } : { min: q.min ?? 0, max: q.max ?? Infinity };
const add = (a, b) => ({ min: a.min + b.min, max: a.max + b.max });
const mul = (a, k) => ({ min: a.min * k, max: a.max * k });
const fit = (have, need) => { const h = iv(have); return h.min >= need ? 'certain' : h.max >= need ? 'possible' : 'no'; };
const worst = (...xs) => xs.includes('no') ? 'no' : xs.includes('possible') ? 'possible' : 'certain';

export function fetchMinutes(job, node) {
  const cached = new Set(node.closureCache ?? []);
  const missing = job.closure.filter(m => !cached.has(m.id));
  const mb = missing.reduce((s, m) => add(s, iv(m.sizeMb ?? job.defaultMemberSizeMb)), { min: 0, max: 0 });
  const bw = iv(node.bandwidthMbps);               // megabits per second; seconds = megabytes * 8 / Mbps
  const div = (m, r) => m === 0 ? 0 : r === 0 ? Infinity : (m * 8) / r / 60;
  return { missing: missing.map(m => m.id), minutes: { min: div(mb.min, bw.max), max: div(mb.max, bw.min) } };
}

export function assess(job, node, { ledger = null, budgets = {}, now, authorizeAssociateJob = null }) {
  const why = [];
  // Untrusted associate devices must pass both original admission and exact Work gates.
  // This remains a planning verdict; a real dispatcher must revalidate on dispatch.
  if (typeof node?.id === 'string' && (node.id.startsWith('associate-ci-') || node.associateCi !== undefined)) {
    const gate = assessAssociateCiJob({ job, node, now, authorizeAssociateJob });
    if (!gate.ok) why.push('swarm-ci:' + gate.reason);
  }
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
  if (why.length) return { nodeId: node.id, feasible: false, why };
  const fetch = fetchMinutes(job, node);
  let price = add(fetch.minutes, mul(iv(job.minutes), 1 + scarcity));
  price = add(price, iv(node.queuedMinutes ?? 0));
  if (node.state === 'intermittent') price = add(price, iv(node.expectedAwayMinutes));
  return { nodeId: node.id, feasible: true, certainty: worst(...Object.values(f)), price, missing: fetch.missing, scarcityPerMinute: scarcity, budgetHold };
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
export function planFleet(jobs,nodes,{ledger=null,budgets={},now,authorizeAssociateJob=null}={}){
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
    const dimensions=['cores','memoryGb','freeDiskGb'];
    if(dimensions.some(k=>!Number.isFinite(job.needs?.[k])||job.needs[k]<0)||
      job.needs.cores<=0){
      pending.push({jobId:job.id,reason:'explicit-compute-footprint-required'});
      continue;
    }
    const view=place(job,provisionalNodes,
      {now,ledger:provisionalLedger,budgets:provisionalBudgets,authorizeAssociateJob});
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
    placements.push({jobId:job.id,nodeId:node.id,resourceHold,
      budgetHold:candidate.budgetHold,price:candidate.price,
      state:'proposed-not-executed',leaseRequired:true});
  }
  return {kind:'original-fleet-placement-proposal',at:now,placements,pending,probes,
    proposed:placements.length,unplaced:pending.length,
    executed:0,providerBudgetHeld:false,leaseReceived:false,
    // Remaining are temporary hypothetical amounts, not provider readback.
    residualResources:provisionalNodes.map(n=>({nodeId:n.id,
      cores:n.cores,memoryGb:n.memoryGb,freeDiskGb:n.freeDiskGb}))};
}
