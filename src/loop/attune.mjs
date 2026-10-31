// Attune (Analyze) for a host section's PACE-S loop: read the readings against the
// section's own baseline and name each obstruction once, with who owns it and what
// may be done about it. An obstruction is a reading that something is held, failed,
// stale or contradictory; it is computed afresh from every Pause and never stored.
//
// { kind, subject, owner, since?, evidence, actions } where `actions` are the
// admissible responses Care chooses among, most specific first.

export const BASELINE = { memoryFullAvg300Pct: 10, diskMarginBytes: 0 };

export function attune(readings, { baseline = BASELINE, owners = {} } = {}) {
  const out = [];
  const gen = readings.find(r => r.probe === 'generations');
  const units = gen?.byUnit ?? {};
  const distinct = [...new Set(Object.values(units).flatMap(u => u.generations))];
  const stale = new Set(Object.entries(units).filter(([, u]) => u.generations.length > 1).map(([unit]) => unit));
  const delivery = owners.delivery ?? 'host delivery (LAGOON deliver-host)';

  if (distinct.length > 1) out.push({ kind: 'mixed-generations', subject: 'host', owner: delivery,
    evidence: { generations: distinct, byUnit: units }, actions: ['deliver-host'] });
  for (const unit of stale) out.push({ kind: 'unit-loads-two-generations', subject: unit, owner: delivery,
    evidence: units[unit], actions: ['deliver-host'] });

  for (const r of readings) {
    if (r.probe === 'unit-failed') out.push({ kind: 'unit-failed', subject: r.subject,
      owner: units[r.subject] ? delivery : owners.units ?? 'host units',
      evidence: { generations: units[r.subject]?.generations ?? [] }, actions: units[r.subject] && distinct.length > 1 ? ['deliver-host'] : ['read-journal', 'escalate-owner'] });
    if (r.probe === 'unit-held') out.push({ kind: 'unit-held-while-active', subject: r.subject, since: r.since,
      owner: owners[r.subject] ?? owners.units ?? 'host units', evidence: { reason: r.reason }, actions: ['escalate-owner'] });
    if (r.probe === 'state-path-stray') out.push({ kind: 'state-path-stray', subject: r.subject, owner: delivery,
      evidence: { path: r.path, deadAt: r.deadAt }, actions: ['deliver-host'] });
    if (r.probe === 'memory' && r.fullAvg300 > baseline.memoryFullAvg300Pct) out.push({ kind: 'memory-stalled', subject: 'host',
      owner: owners.memory ?? 'host memory budget (within-budget)', evidence: r, actions: ['admit-within-budget-only', 'contain-unbounded-units'] });
    if (r.probe === 'disk' && r.availableBytes < r.floorBytes + baseline.diskMarginBytes) out.push({ kind: 'disk-below-floor', subject: 'host',
      owner: owners.disk ?? 'host storage (LAGOON retention)', evidence: r, actions: ['retire-generations', 'collect-garbage', 'trim'] });
  }
  return out;
}
