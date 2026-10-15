// Two builders that produce the same store paths agree; a difference is top (contested) and queues
// a repair (BCF: binary-caches-as-substrate-federation). One builder is unsettled by comparison.
export function compareBuilds(results) {
  if (results.length === 0) return { state: 'none' };
  const names = [...new Set(results.flatMap(r => Object.keys(r.outputs)))].sort();
  const differing = names.filter(n => new Set(results.map(r => r.outputs[n] ?? null)).size > 1);
  if (differing.length) return { state: 'top', differing, repair: differing.map(name => ({ name, claims: Object.fromEntries(results.map(r => [r.nodeId, r.outputs[name] ?? null])) })) };
  const outputs = Object.fromEntries(names.map(n => [n, results[0].outputs[n]]));
  return results.length === 1 ? { state: 'single', outputs } : { state: 'agree', outputs, builders: results.map(r => r.nodeId) };
}
// What is published to the registry is the settled outputs, never a contested one.
export const publishable = s => s.state === 'agree' || s.state === 'single';
