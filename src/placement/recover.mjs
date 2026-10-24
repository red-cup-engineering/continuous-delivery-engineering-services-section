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
  const scarcity = jobs.map((job, index) => ({
    job, index, ...availableTerritory(job, nodes, context),
  }));
  const assessments = scarcity.reduce((sum, row) => sum + row.assessments, 0);
  const alternative = scarcity.slice()
    .sort((a, b) => a.slots - b.slots || a.index - b.index)
    .map(row => row.job);
  if (alternative.every((job, index) => job.id === jobs[index].id))
    return unchanged("no-useful-order-change", assessments);
  const candidate = planFleet(alternative, nodes, context);
  const formerlyPlaced = new Map(baseline.placements.map(p => [p.jobId, p.nodeId]));
  const nowPlaced = new Map(candidate.placements.map(p => [p.jobId, p.nodeId]));
  const originalAdmissionsPreserved = [...formerlyPlaced.keys()]
    .every(id => nowPlaced.has(id));
  const improved = originalAdmissionsPreserved &&
    candidate.proposed > baseline.proposed;
  const chosen = improved ? {
    ...candidate,
    placements: originalOrder(jobs, candidate.placements),
    pending: originalOrder(jobs, candidate.pending),
    probes: originalOrder(jobs, candidate.probes),
  } : baseline;
  return {
    ...chosen,
    capacityRecovery: {
      policy: "preserve-original-admissions",
      attempted: true, improved,
      originalProposed: baseline.proposed, recoveredProposed: chosen.proposed,
      effort: { planningPasses: 2, territoryAssessments: assessments },
      newlyPlaced: [...nowPlaced.keys()].filter(id => improved && !formerlyPlaced.has(id)),
      relocated: improved ? [...formerlyPlaced].filter(([id, nodeId]) =>
        nowPlaced.get(id) !== nodeId).map(([id, from]) => ({
        jobId: id, from, to: nowPlaced.get(id),
      })) : [],
    },
  };
}
