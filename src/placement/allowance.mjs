// Hosted-runner minutes as a budgeted, perishable allowance (BCF notes: carriers-and-capacity,
// spending-perishable-generation-capacity). A spend is held, then settled spent, refused or void.
// Never overdraws: rule github-actions-use-held-runners-without-billing.
import { PRIVATE_ORG_ACTIONS_MONTHLY_MINUTES } from './plan-allowances.mjs';

const MS_DAY = 86_400_000;
export function newLedger({ plan, month, usedMinutes, observedAt }) {
  if (typeof observedAt!=='string'||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(observedAt)||
      !Number.isFinite(Date.parse(observedAt)))
    throw new TypeError('actual observed hosted usage timestamp required');
  if (!Object.hasOwn(PRIVATE_ORG_ACTIONS_MONTHLY_MINUTES, plan)) throw new TypeError('known GitHub organization plan required');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new TypeError('month as YYYY-MM required');
  if (!Number.isSafeInteger(usedMinutes) || usedMinutes < 0) throw new TypeError('nonnegative whole used minutes required');
  return { plan, month, allowance: PRIVATE_ORG_ACTIONS_MONTHLY_MINUTES[plan], usedMinutes, observedAt, entries: [] };
}
export const heldMinutes = l => l.entries.filter(e => e.state === 'held').reduce((s, e) => s + e.minutes, 0);
export const remainingMinutes = l => Math.max(0, l.allowance - l.usedMinutes - heldMinutes(l));
export function daysLeft(l, now) {
  const [y, m] = l.month.split('-').map(Number);
  return Math.max(1, Math.ceil((Date.UTC(y, m, 1) - Date.parse(now)) / MS_DAY));
}
// The pace is what may be spent today without borrowing from later days.
export const paceMinutes = (l, now) => remainingMinutes(l) / daysLeft(l, now);
// Price of one hosted minute: low while the pace has room (the allowance lapses unspent), rising once a
// request exceeds the pace. Returns null when the hold would overdraw: that is refusal, not a price.
export function minutePrice(l, now, minutes) {
  const at=Date.parse(now), seen=Date.parse(l?.observedAt);
  if (!Number.isFinite(at)||!Number.isFinite(seen)||at<seen||
      at-seen>3_600_000||now.slice(0,7)!==l.month) return null;
  if (!Number.isSafeInteger(minutes)||minutes<=0||minutes > remainingMinutes(l)) return null;
  const pace = paceMinutes(l, now);
  return minutes <= pace ? 0.1 : 1 + (minutes - pace) / Math.max(pace, 1);
}
export function hold(l, { jobId, minutes }) {
  if (!Number.isSafeInteger(minutes) || minutes <= 0) throw new TypeError('positive whole minutes required');
  if (l.entries.some(e => e.jobId === jobId && e.state === 'held')) throw new Error('job-already-holds-minutes');
  if (minutes > remainingMinutes(l)) return { ok: false, reason: 'would-overdraw-the-free-allowance' };
  l.entries.push({ jobId, minutes, state: 'held' });
  return { ok: true };
}
export function settle(l, { jobId, state, billedMinutes = 0 }) {
  if (!['spent', 'refused', 'void'].includes(state)) throw new TypeError('spent, refused or void');
  const e = l.entries.find(x => x.jobId === jobId && x.state === 'held');
  if (!e) throw new Error('no-hold-to-settle');
  e.state = state;
  if (state === 'spent') { e.billedMinutes = billedMinutes; l.usedMinutes += billedMinutes; }
  return e;
}

/**
 * Provider-neutral free-capacity observation, not a new provider ledger or
 * account registry. An authenticated provider adapter supplies these original
 * per-account quantities and their expiry. The consumer must independently
 * qualify the native provider read; this function cannot authenticate it.
 * A Free service with unobservable credit balance is NOT executable here.
 */
export function newObservedBudget({
    provider,scope,remaining,observedAt,expiresAt,sourceRef,hardStop
  }) {
  if (typeof provider!=='string'||!provider.match(/^[a-z][a-z0-9-]{2,79}$/u)||
    typeof scope!=='string'||!scope.match(/^[a-zA-Z0-9_/:.-]{3,160}$/u)||
    typeof sourceRef!=='string'||sourceRef.length<8||sourceRef.length>1024||
    hardStop!==true)throw new TypeError('original free-only provider budget evidence required');
  const since=Date.parse(observedAt),until=Date.parse(expiresAt);
  if(!Number.isFinite(since)||!Number.isFinite(until)||until<=since||
    typeof observedAt!=='string'||typeof expiresAt!=='string'||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(observedAt)||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(expiresAt)||
    until-since>86_400_000)
    throw new TypeError('fresh bounded provider observation interval required');
  if(!remaining||Array.isArray(remaining)||typeof remaining!=='object'||
    !Object.keys(remaining).length||Object.keys(remaining).length>6)
    throw new TypeError('actual finite free-resource balances required');
  const quantities={};
  for(const [unit,value] of Object.entries(remaining)){
    if(!/^[a-z][a-z0-9A-Z]{0,31}$/u.test(unit)||
      typeof value!=='number'||!Number.isFinite(value)||value<0)
      throw new TypeError('free-resource balance must be a nonnegative finite quantity');
    quantities[unit]=value;
  }
  return {kind:'observed-free-budget',provider,scope,sourceRef,hardStop:true,
    observedAt,expiresAt,remaining:quantities,entries:[]};
}

export function budgetAvailable(b){
  const quantities={...b.remaining};
  for(const e of b.entries){
    if(e.state!=='held')continue;
    for(const [unit,amount] of Object.entries(e.units))
      quantities[unit]=Math.max(0,quantities[unit]-amount);
  }
  return quantities;
}

export function quoteBudget(b,{provider,scope,now,units}={}){
  if(!b)return {ok:false,reason:'provider-budget-unobserved'};
  if(b.kind!=='observed-free-budget'||b.provider!==provider||
    b.scope!==scope||b.hardStop!==true)
    return {ok:false,reason:'provider-budget-identity-or-no-billing-unqualified'};
  const at=Date.parse(now),since=Date.parse(b.observedAt),end=Date.parse(b.expiresAt);
  if(!Number.isFinite(at)||at<since||at>=end)
    return {ok:false,reason:'provider-budget-stale'};
  if(!units||Array.isArray(units)||typeof units!=='object'||!Object.keys(units).length)
    return {ok:false,reason:'provider-usage-unbounded'};
  const available=budgetAvailable(b);
  for(const [unit,value] of Object.entries(units)){
    if(!Object.hasOwn(available,unit)||typeof value!=='number'||
      !Number.isFinite(value)||value<0)
      return {ok:false,reason:'provider-usage-unit-unmeasured:'+unit};
    if(value>available[unit]+1e-9)
      return {ok:false,reason:'would-overdraw-the-observed-free-allowance:'+unit};
  }
  return {ok:true,units,sourceRef:b.sourceRef,expiresAt:b.expiresAt};
}

export function holdBudget(b,{jobId,provider,scope,now,units}={}){
  if(typeof jobId!=='string'||!jobId.length)throw new TypeError('job identity required');
  if(b?.entries?.some(e=>e.jobId===jobId))
    throw new Error('job-budget-hold-already-settled-or-held');
  const quote=quoteBudget(b,{provider,scope,now,units});
  if(!quote.ok)return quote;
  b.entries.push({jobId,units:{...units},state:'held'});
  return {ok:true,units:{...units}};
}

export function settleBudget(b,{jobId,state,actualUnits={}}={}){
  if(!['spent','void','refused'].includes(state))
    throw new TypeError('original provider budget settlement required');
  const held=b.entries.find(e=>e.jobId===jobId&&e.state==='held');
  if(!held)throw new Error('no-live-provider-budget-hold');
  if(state==='spent'){
    for(const [unit,amount] of Object.entries(actualUnits)){
      if(!Object.hasOwn(held.units,unit)||typeof amount!=='number'||
        !Number.isFinite(amount)||amount<0||amount>held.units[unit]+1e-9)
        throw new TypeError('billed usage exceeds held free units: '+unit);
    }
    for(const unit of Object.keys(held.units))
      if(!Object.hasOwn(actualUnits,unit))
        throw new TypeError('settlement missing observed usage unit: '+unit);
    for(const [unit,amount] of Object.entries(actualUnits))
      b.remaining[unit]-=amount;
  }
  held.state=state;
  if(state==='spent')held.actualUnits={...actualUnits};
  return held;
}
