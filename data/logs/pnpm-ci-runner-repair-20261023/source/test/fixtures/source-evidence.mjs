// Deliberate boundary fixtures. Genuine supplier export/restore is exercised
// separately by hosted-change-source-integration.test.mjs.
import {sourceExpectation,sha256,graphReceivingObligations} from '../../scripts/change-source-evidence.mjs';
export const controllerCommit='d'.repeat(40);
export function evidence({machine='o/machine',machineCommit='a'.repeat(40),repository='o/change',commit='c'.repeat(40)}={}){
  const [root,definition='.']=machine.split(':'),tree='b'.repeat(40);
  const identity={repository:root,commit:machineCommit,tree,definition,definitionTree:tree,machineBlob:tree,channelsBlob:tree,lockBlob:tree};
  const source={repository,commit:'b'.repeat(40),tree,paths:['source']};
  const graph={kind:'guix.resolved-source-graph.v1',machine:identity,entries:[],buildEntries:[],receivingPackages:[],repositories:[{repository:root,commit:machineCommit,tree,paths:['.']},source],edges:[]};
  const next={...source,commit};
  const candidateGraph={...graph,repositories:[graph.repositories[0],next]};
  const sourcePlan={kind:'guix.comparison-source-plan.v1',scope:'comparison-only',baseline:sha256(graph),candidate:sha256(candidateGraph),requested:[{repository,commit,tree}],delta:[{repository,baseline:{commit:source.commit,tree,paths:source.paths},candidate:{commit,tree,paths:next.paths}}]};
  const receipt={kind:'guix.change-source-carriers.v2',scope:'complete-code-comparison-carriers',runtimeAcceptance:false,snapshot:identity,candidateSnapshot:identity,baselineGraph:graph,candidateGraph,sourcePlan,sourcePlanSha256:sha256(sourcePlan)};
  const expected=sourceExpectation(receipt,'e'.repeat(64),{machine,machineCommit,repository,commit,controllerCommit});
  const receiving={...graphReceivingObligations(graph,candidateGraph),baseline:[],candidate:[],regressions:[],removedTests:[],unmeasured:false,removed:[],entries:{removed:[],added:[]},buildEntries:{removed:[],added:[]},removedPackages:[]};
  const verdict={kind:'change-test',snapshot:machineCommit,changes:[{repository,commit}],sourcePlan,sourcePlanSha256:receipt.sourcePlanSha256,baselineGraph:graph,candidateGraph,
    verdict:'no-regression',regressions:0,lock:'frozen',packages:[],designRules:{added:[],removed:[]},receiving};
  return {receipt,expected,verdict};
}
