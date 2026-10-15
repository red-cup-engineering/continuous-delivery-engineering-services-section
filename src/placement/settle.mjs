// Compare native content-addressed build outputs across independent,
 // provider-qualified builders. This pure comparison never authenticates
 // Git commits, source grants or provider readbacks: receiving must do that.
export function compareBuilds(results) {
  if(!Array.isArray(results))return {state:'unqualified',reason:'non-array-build-evidence'};
  if(results.length===0)return {state:'none'};
  if(results.some(r=>!r||typeof r.nodeId!=='string'||!r.nodeId.trim()||
    !r.outputs||Array.isArray(r.outputs)||typeof r.outputs!=='object'||
    !Object.keys(r.outputs).length||
    Object.entries(r.outputs).some(([name,path])=>
      !name||typeof path!=='string'||!path.startsWith('/gnu/store/')||
      path.length<20)))
    return {state:'unqualified',reason:'invalid-original-build-output-evidence'};
  const builders=results.map(r=>r.nodeId);
  if(new Set(builders).size!==builders.length)
    return {state:'unqualified',reason:'builder-identity-not-independent'};
  const names=[...new Set(results.flatMap(r=>Object.keys(r.outputs)))].sort();
  const differing=names.filter(n=>new Set(results.map(r=>r.outputs[n]??null)).size>1);
  if(differing.length)return {state:'top',differing,
    repair:differing.map(name=>({name,claims:Object.fromEntries(
      results.map(r=>[r.nodeId,r.outputs[name]??null]))}))};
  const outputs=Object.fromEntries(names.map(n=>[n,results[0].outputs[n]]));
  if(results.length===1)
    return {state:'single',outputs,builders,reason:'independent-builder-receiving-required'};
  return {state:'agree',outputs,builders};
}
// A single successful build is usable as a provisional local artifact but
// cannot be promoted as an independently verified cross-node build.
export const publishable = s=>s?.state==='agree'&&
  Array.isArray(s.builders)&&s.builders.length>=2&&
  new Set(s.builders).size===s.builders.length;
