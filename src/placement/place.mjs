// Place a job on the node that can run it at the lowest price. Unknown quantities are intervals
// (min 0, max unbounded), never zero. Price is minutes of wall time plus scarcity.
import { minutePrice } from './allowance.mjs';

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

export function assess(job, node, { ledger = null, now }) {
  const why = [];
  if (job.mustRunOn && !job.mustRunOn.includes(node.id)) why.push('job-names-other-nodes');
  if (node.state === 'down') why.push('node-is-down');
  for (const c of job.requires?.capabilities ?? []) if (!(node.capabilities ?? []).includes(c)) why.push(`lacks-capability:${c}`);
  const n = job.needs ?? {};
  const f = { cores: fit(node.cores, n.cores ?? 0), memoryGb: fit(node.memoryGb, n.memoryGb ?? 0), freeDiskGb: fit(node.freeDiskGb, n.freeDiskGb ?? 0) };
  for (const [k, v] of Object.entries(f)) if (v === 'no') why.push(`too-small:${k}`);
  let scarcity = 0;
  if (node.cost?.kind === 'hosted-minutes') {
    if (!ledger) why.push('no-allowance-ledger');
    else { const p = minutePrice(ledger, now, job.minutes); if (p === null) why.push('would-overdraw-the-free-allowance'); else scarcity = p; }
  }
  if (why.length) return { nodeId: node.id, feasible: false, why };
  const fetch = fetchMinutes(job, node);
  let price = add(fetch.minutes, mul(iv(job.minutes), 1 + scarcity));
  price = add(price, iv(node.queuedMinutes ?? 0));
  if (node.state === 'intermittent') price = add(price, iv(node.expectedAwayMinutes));
  return { nodeId: node.id, feasible: true, certainty: worst(...Object.values(f)), price, missing: fetch.missing, scarcityPerMinute: scarcity };
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
