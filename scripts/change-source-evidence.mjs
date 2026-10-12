// This delivery-owned reader binds trusted preparation to worker and report.
// Its expectation must be retained outside every candidate-writable mount.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {machineName,isCommit} from './pinning-machines.mjs';

export const SOURCE_CONTRACT='guix.change-source-carriers.v2';
export const sha256=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}(?![\s\S])/u.test(value);
const equal=isDeepStrictEqual;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const refuse=message=>{throw new Error(message);};

export function validateSourceEvidence(receipt){
  if(!object(receipt)||receipt.kind!==SOURCE_CONTRACT||receipt.scope!=='complete-code-comparison-carriers'||receipt.runtimeAcceptance!==false)
    refuse('complete v2 source evidence required');
  const {snapshot,candidateSnapshot,baselineGraph,candidateGraph,sourcePlan,sourcePlanSha256}=receipt;
  for(const identity of [snapshot,candidateSnapshot]){
    if(!object(identity)||machineName(identity.repository)!==identity.repository||identity.repository.includes(':')
      ||!['commit','tree','definitionTree','machineBlob'].every(key=>isCommit(identity[key]))
      ||!['channelsBlob','lockBlob'].every(key=>identity[key]===null||isCommit(identity[key]))
      ||!(identity.definition==='.'||typeof identity.definition==='string'&&machineName(identity.repository+':'+identity.definition)))
      refuse('complete machine source identity required');
  }
  if(snapshot.repository!==candidateSnapshot.repository||snapshot.definition!==candidateSnapshot.definition)
    refuse('candidate machine root or definition differs');
  for(const [graph,identity] of [[baselineGraph,snapshot],[candidateGraph,candidateSnapshot]]){
    if(!object(graph)||graph.kind!=='guix.resolved-source-graph.v1'||!equal(graph.machine,identity)
      ||!['repositories','edges','entries','buildEntries','receivingPackages'].every(key=>Array.isArray(graph[key])))
      refuse('complete source graph identity required');
  }
  if(!object(sourcePlan)||sourcePlan.kind!=='guix.comparison-source-plan.v1'||sourcePlan.scope!=='comparison-only'
    ||sourcePlan.baseline!==sha256(baselineGraph)||sourcePlan.candidate!==sha256(candidateGraph)
    ||!Array.isArray(sourcePlan.requested)||!Array.isArray(sourcePlan.delta)||!digest(sourcePlanSha256)||sha256(sourcePlan)!==sourcePlanSha256)
    refuse('source graph plan or digest differs');
  const owners=new Set();
  for(const row of sourcePlan.delta){
    if(!object(row)||typeof row.repository!=='string'||owners.has(row.repository)
      ||!Object.hasOwn(row,'baseline')||!Object.hasOwn(row,'candidate')||(!row.baseline&&!row.candidate)
      ||![row.baseline,row.candidate].every(side=>side===null||object(side)&&isCommit(side.commit)&&isCommit(side.tree)))
      refuse('complete source graph delta required');
    owners.add(row.repository);
  }
  return receipt;
}

export function sourceExpectation(receipt,sourceSha256,{machine,machineCommit,repository,commit,controllerCommit}){
  validateSourceEvidence(receipt);
  if(!digest(sourceSha256)||!isCommit(controllerCommit)||!isCommit(commit)||!isCommit(machineCommit)
    ||machineName(repository)!==repository||repository.includes(':')||machineName(machine)!==machine)
    refuse('independent preparation identities required');
  const [root,definition='.']=machine.split(':');
  if(receipt.snapshot.repository!==root||receipt.snapshot.definition!==definition||receipt.snapshot.commit!==machineCommit)
    refuse('prepared machine differs from discovery');
  if(repository===root){
    if(receipt.candidateSnapshot.commit!==commit||receipt.sourcePlan.requested.length)refuse('machine PR requires its complete candidate root');
  }else if(receipt.candidateSnapshot.commit!==machineCommit||receipt.sourcePlan.requested.length!==1
    ||receipt.sourcePlan.requested[0].repository!==repository||receipt.sourcePlan.requested[0].commit!==commit)
    refuse('prepared source differs from the requested PR');
  return {kind:'guix.hosted-change-expectation.v2',sourceContract:SOURCE_CONTRACT,sourceSha256,controllerCommit,
    machine,machineCommit,requestedPR:{repository,commit},snapshot:receipt.snapshot,candidateSnapshot:receipt.candidateSnapshot,
    baselineGraph:receipt.baselineGraph,candidateGraph:receipt.candidateGraph,sourcePlan:receipt.sourcePlan,sourcePlanSha256:receipt.sourcePlanSha256};
}

export function validateExpectation(expected){
  if(expected?.kind!=='guix.hosted-change-expectation.v2'||expected.sourceContract!==SOURCE_CONTRACT)refuse('trusted preparation expectation missing');
  const receipt={...expected,kind:SOURCE_CONTRACT,scope:'complete-code-comparison-carriers',runtimeAcceptance:false};
  const derived=sourceExpectation(receipt,expected.sourceSha256,{...expected,...expected.requestedPR});
  if(!equal(derived,expected))refuse('malformed preparation expectation');
  return expected;
}

export function verdictSourceError(verdict,expected,status){
  try{validateExpectation(expected);}catch(error){return error.message;}
  const changes=expected.sourcePlan.delta.map(({repository,candidate})=>({repository,commit:candidate?.commit??null}));
  if(verdict?.kind!=='change-test'||verdict.snapshot!==expected.snapshot.commit
    ||!equal(verdict.changes,changes)||!equal(verdict.baselineGraph,expected.baselineGraph)||!equal(verdict.candidateGraph,expected.candidateGraph)
    ||!equal(verdict.sourcePlan,expected.sourcePlan)||verdict.sourcePlanSha256!==expected.sourcePlanSha256)
    return 'Change verdict differs from prepared complete source identities';
  if(!['no-regression','regression','incomplete','not-composed'].includes(verdict.verdict)
    ||![0,1].includes(status)||(verdict.verdict==='no-regression')!==(status===0))
    return 'Change verdict conflicts with recognized execution status';
  return null;
}

export function graphReceivingObligations(base,head){
  const selections=field=>({added:head[field].filter(name=>!base[field].includes(name)),removed:base[field].filter(name=>!head[field].includes(name))});
  const definitionChanged=['definition','machineBlob','channelsBlob','lockBlob'].some(key=>base.machine[key]!==head.machine[key]);
  const topology=graph=>graph.edges.map(({from,to,path,purpose,ref})=>({from,to,path,purpose,ref}));
  const topologyChanged=!equal(topology(base),topology(head));
  const before=base.repositories.map(row=>row.repository),after=head.repositories.map(row=>row.repository);
  return {entries:selections('entries'),buildEntries:selections('buildEntries'),...selections('receivingPackages'),definitionChanged,topologyChanged,
    addedOwners:after.filter(owner=>!before.includes(owner)),removedOwners:before.filter(owner=>!after.includes(owner)),
    unmeasured:(definitionChanged||topologyChanged)&&(!base.receivingPackages.length||!head.receivingPackages.length)};
}

export function receivingError(verdict,expectedSources){
  const receiving=verdict.receiving;
  if(verdict.verdict!=='no-regression')return null;
  if(!object(receiving)||!object(expectedSources?.baselineGraph)||!object(expectedSources?.candidateGraph))return 'No-regression verdict lacks complete receiving obligations';
  const expected=graphReceivingObligations(expectedSources.baselineGraph,expectedSources.candidateGraph);
  for(const [key,value] of Object.entries(expected))if(!equal(receiving[key],value))return 'Receiving obligations differ from prepared source graphs';
  if(!Array.isArray(receiving.baseline)||!Array.isArray(receiving.candidate)
    ||!Array.isArray(receiving.regressions)||!Array.isArray(receiving.removedTests)
    ||receiving.unread!==undefined||receiving.unmeasured!==false||receiving.regressions.length||receiving.removedTests.length
    ||receiving.removed.length||receiving.entries.removed.length||receiving.buildEntries.removed.length
    ||!Array.isArray(receiving.removedPackages)||receiving.removedPackages.some(row=>row.disposition!=='outside-baseline-machine-closure'))
    return 'No-regression verdict lacks complete receiving obligations';
  for(const [side,graph] of [['baseline',expectedSources.baselineGraph],['candidate',expectedSources.candidateGraph]]){
    if(!equal(receiving[side].map(row=>row?.name).sort(),[...graph.receivingPackages].sort()))return 'Declared receiving package evidence is incomplete';
    const path=value=>typeof value==='string'&&value.length<=4096&&!value.startsWith('/')&&!value.includes('\\')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
    for(const row of receiving[side]){
      const sources=graph.repositories.filter(source=>source.repository===row.repository);
      if(sources.length!==1||sources[0].commit!==row.commit||!digest(row.manifestSha256)||(row.path!=='.'&&!path(row.path))
        ||!Array.isArray(row.tests)||!row.tests.length||!Array.isArray(row.results)||row.results.length!==row.tests.length
        ||new Set(row.tests.map(test=>test?.path)).size!==row.tests.length||new Set(row.results.map(result=>result?.file)).size!==row.results.length
        ||row.tests.some(test=>!object(test)||!path(test.path)||!(isCommit(test.gitBlob)||digest(test.gitBlob))||!digest(test.sha256))
        ||row.results.some(result=>!object(result)||typeof result.passed!=='boolean'||!row.tests.some(test=>test.path===result.file)))
        return 'Malformed or unbound declared receiving test evidence';
    }
  }
  const results=rows=>new Map(rows.flatMap(row=>row.results.map(result=>[row.name+':'+result.file,result.passed])));
  const before=results(receiving.baseline),after=results(receiving.candidate);
  if([...before.keys()].some(key=>!after.has(key))||[...after].some(([key,passed])=>!passed&&before.get(key)!==false))
    return 'No-regression verdict conflicts with removed or failed receiving tests';
  return null;
}
