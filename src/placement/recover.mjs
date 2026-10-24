// Bounded capacity recovery for source-declared independent Work units.
// The original planFleet remains the only placer and resource/budget quote owner.
// One initial cheap Voronoi-style cost placement is retained; an alternative
// scarcity-first order is accepted only if EVERY originally admitted Work item
// remains admitted and more source-owned Work fits the same observed resources.
// Never publishes a lease, bids, changes provider holds or authorizes an effect.
import { assess, planFleet } from "./place.mjs";

function finiteOriginalWork(job) {
  return job && !Boolean(job.effect) && Array.isArray(job.closure) &&
    Number.isFinite(job.minutes) && job.minutes > 0 &&
    Number.isFinite(job.maxMinutes) && job.maxMinutes >= job.minutes &&
    job.needs && ["cores", "memoryGb", "freeDiskGb"].every(k =>
      Number.isFinite(job.needs[k]) && job.needs[k] >= 0) && job.needs.cores > 0;
}

function availableTerritory(job, nodes, context) {
  if (!finiteOriginalWork(job)) return { slots: Infinity, assessments: 0 };
  // Count actual finite, certain, presently eligible node regions. This uses
  // the original place/assess authority, not an independently invented bid.
  let slots = 0;
  for (const node of nodes) {
    const result = assess(job, node, context);
    if (result.feasible && result.certainty === "certain" &&
        Number.isFinite(result.price.max) && Number.isFinite(result.price.min)) {
      // A resource footprint can occupy one node more than once when that node
      // has spare cores/memory/disk. Rank by eligible regions, not nominal cores;
      // the original fleet planner holds the real resources in every plan.
      slots++;
    }
  }
  return { slots, assessments: nodes.length };
}

const originalOrder = (sourceJobs, rows) => {
  const order = new Map(sourceJobs.map((j, i) => [j.id, i]));
  return rows.slice().sort((a, b) =>
    (order.get(a.jobId) ?? Infinity) - (order.get(b.jobId) ?? Infinity));
};

/**
 * Improve the total number of independently source-declared work units that
 * can be placed *now*, without sacrificing any Work already provisionally placed
 * in the caller's priority order. Input order still determines which Work
 * is never allowed to be displaced; the only alternate ordering treats rare
 * qualified node regions first and lets flexible jobs use remaining capacity.
 */
export function recoverFleetCapacity(jobs, nodes, context) {
  const baseline = planFleet(jobs, nodes, context);
  const unchanged = (reason, assessments = 0) => ({
    ...baseline, capacityRecovery: {
      policy: "preserve-original-admissions",
      attempted: false, improved: false, reason,
      originalProposed: baseline.proposed, recoveredProposed: baseline.proposed,
      newlyPlaced: [], relocated: [],
      effort: { planningPasses: 1, territoryAssessments: assessments },
    },
  });
  // With no initial admitted jobs, ordering cannot create free resources.
  // Denied effects, unmeasured original jobs and probing requests cannot
  // become executable by changing scheduling order. Avoid an extra O(jobs*nodes)
  // calculation in these common conditions on small low-resource machines.
  if (!baseline.unplaced) return unchanged("all-original-work-provisionally-placed");
  if (!baseline.proposed) return unchanged("no-original-admissions");
  if (!baseline.pending.some(p => p.reason === "no-finite-certain-original-placement"))
    return unchanged("no-capacity-related-pending-work");
  // A large source-declared queue may already cost substantial baseline planning.
  // Do not add O(jobs × nodes) eligibility probes when the optional recovery
  // search exceeds its deterministic CPU-work budget. Preserve every original
  // provisional placement and expose the refusal instead of guessing capacity.
  const territoryBudget = 4_096;
  const territoryVolume = jobs.length * nodes.length;
  if (territoryVolume > territoryBudget)
    return unchanged("territory-assessment-budget-exceeded");
  const scarcity = jobs.map((job, index) => ({
    job, index, ...availableTerritory(job, nodes, context),
  }));
  const assessments = scarcity.reduce((sum, row) => sum + row.assessments, 0);
  const cardinality = slots => slots === 0 ? Infinity : slots;
  const byTerritory = (a, b) =>
    cardinality(a.slots) - cardinality(b.slots) || a.index - b.index;
  const formerlyPlaced = new Map(baseline.placements.map(p => [p.jobId, p.nodeId]));
  let best = baseline, bestOrder = jobs;
  let planningPasses = 1, targetedReorders = 0, acceptedAlternatives = 0;
  const triedOrders = new Set([JSON.stringify(jobs.map(job => job.id))]);
  const propose = order => {
    const key = JSON.stringify(order.map(job => job.id));
    if (triedOrders.has(key)) return false;
    triedOrders.add(key);
    planningPasses++;
    // Retain original planFleet as the ONLY authority for provisional resource
    // and provider-budget holds, egress, eligibility and effect refusals.
    const candidate = planFleet(order, nodes, context);
    if (candidate.proposed <= best.proposed) return false;
    const received = new Set(candidate.placements.map(p => p.jobId));
    // A previous improvement may have admitted additional Work. Do not lose
    // that Work in a subsequent candidate merely to gain more total slots.
    if (!best.placements.every(p => received.has(p.jobId))) return false;
    best = candidate;
    bestOrder = order;
    acceptedAlternatives++;
    return true;
  };

  // Original cache, transfer, scarcity and queue prices determine each
  // possible placement; eligible-region count is only a reordering heuristic.
  const sorted = scarcity.slice().sort(byTerritory).map(row => row.job);
  if (!sorted.every((job, index) => job.id === jobs[index].id))
    propose(sorted);

  // A single alternative often misses dissimilar resource footprints with
  // the same eligible-region cardinality. Try bounded augmenting reorders,
  // putting an actually waiting unit first, then delegating all constraints
  // and budget changes to original planFleet again.
  const volume = jobs.length * nodes.length;
  const maximumTargetTrials = nodes.length > 1
    ? Math.min(8, Math.floor(territoryBudget / Math.max(1, volume))) : 0;
  for (let i = 0; i < maximumTargetTrials && best.proposed < jobs.length; i++) {
    const waiting = new Set(best.pending
      .filter(p => p.reason === "no-finite-certain-original-placement")
      .map(p => p.jobId));
    const focus = scarcity.filter(row =>
      row.slots > 0 && Number.isFinite(row.slots) && waiting.has(row.job.id))
      .sort(byTerritory);
    let attempted = false;
    for (const row of focus) {
      const order = [row.job, ...bestOrder.filter(job => job.id !== row.job.id)];
      const key = JSON.stringify(order.map(job => job.id));
      if (triedOrders.has(key)) continue;
      targetedReorders++;
      propose(order);
      attempted = true;
      break;
    }
    if (!attempted) break;
  }

  const improved = best.proposed > baseline.proposed;
  const chosen = improved ? {
    ...best,
    placements: originalOrder(jobs, best.placements),
    pending: originalOrder(jobs, best.pending),
    probes: originalOrder(jobs, best.probes),
  } : baseline;
  const selected = new Map(chosen.placements.map(p => [p.jobId, p.nodeId]));
  return {
    ...chosen,
    capacityRecovery: {
      policy: "preserve-original-admissions",
      attempted: planningPasses > 1, improved,
      ...(planningPasses === 1 ? { reason: "no-useful-order-change" } : {}),
      originalProposed: baseline.proposed, recoveredProposed: chosen.proposed,
      effort: { planningPasses, territoryAssessments: assessments,
        targetedReorders, acceptedAlternatives },
      newlyPlaced: improved ? jobs.map(job => job.id)
        .filter(id => !formerlyPlaced.has(id) && selected.has(id)) : [],
      relocated: improved ? [...formerlyPlaced].filter(([id, nodeId]) =>
        selected.get(id) !== nodeId).map(([id, from]) => ({
        jobId: id, from, to: selected.get(id),
      })) : [],
    },
  };
}
