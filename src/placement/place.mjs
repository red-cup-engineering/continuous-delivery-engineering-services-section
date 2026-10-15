// Place a job on the node that can run it at the lowest price. Unknown quantities are intervals
// (min 0, max unbounded), never zero. Price is minutes of wall time plus scarcity.
import { minutePrice, quoteBudget } from './allowance.mjs';

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

export function assess(job, node, { ledger = null, budgets = {}, now }) {
  const why = [];
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
    if (!ledger) why.push('no-observed-hosted-allowance');
    else { const p = minutePrice(ledger, now, job.minutes); if (p === null) why.push('hosted-allowance-exhausted-or-stale'); else scarcity = p; }
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
        const remaining=budgets[node.cost.scope].remaining;
        scarcity=0.1+Math.max(...Object.entries(units).map(([unit,value])=>
          value/Math.max(remaining[unit],1e-9)));
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
