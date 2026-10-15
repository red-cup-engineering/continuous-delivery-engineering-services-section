// Hosted-runner minutes as a budgeted, perishable allowance (BCF notes: carriers-and-capacity,
// spending-perishable-generation-capacity). A spend is held, then settled spent, refused or void.
// Never overdraws: rule github-actions-use-held-runners-without-billing.
import { PRIVATE_ORG_ACTIONS_MONTHLY_MINUTES } from './plan-allowances.mjs';

const MS_DAY = 86_400_000;
export function newLedger({ plan, month, usedMinutes = 0 }) {
  if (!Object.hasOwn(PRIVATE_ORG_ACTIONS_MONTHLY_MINUTES, plan)) throw new TypeError('known GitHub organization plan required');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new TypeError('month as YYYY-MM required');
  if (!Number.isSafeInteger(usedMinutes) || usedMinutes < 0) throw new TypeError('nonnegative whole used minutes required');
  return { plan, month, allowance: PRIVATE_ORG_ACTIONS_MONTHLY_MINUTES[plan], usedMinutes, entries: [] };
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
  if (minutes > remainingMinutes(l)) return null;
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
