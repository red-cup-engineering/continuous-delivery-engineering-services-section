import test from 'node:test';
import assert from 'node:assert/strict';
import { projectAssociateCiNode, assessAssociateCiJob } from '../src/placement/associate-ci.mjs';
import { assess, place, planFleet } from '../src/placement/place.mjs';

const NOW = '2026-10-21T22:00:00Z';
const REF = 'swarm-admission-witness-1', SHA = 'a'.repeat(40);
const ACTOR = 'https://swarm.561.group/actors/associate-1';

const admission = () => ({
  kind: 'swarm.associate-ci-admission.v1', ref: REF, witnessRef: 'independent-source-witness-1',
  member: {actorId: ACTOR, state:'approved', expiresAt:'2026-11-21T00:00:00Z'},
  session: {actorId: ACTOR, provider:'google', state:'authenticated', expiresAt:'2026-10-21T23:00:00Z'},
  device: {actorId: ACTOR, id:'device-1', mode:'native-desktop', state:'connected'},
  consent: {actorId:ACTOR, deviceId:'device-1', state:'active', workClasses:['public-ci'],
    expiresAt:'2026-10-22T00:00:00Z',
    limits: {cores:2, memoryGb:3, freeDiskGb:5, maxMinutes:10}},
  sandbox: {deviceId:'device-1', kind:'ephemeral-vm', hostMounts:false,
    secretMounts:false, network:'restricted', policyRef:'sandbox-policy-witness',
    verifiedAt:'2026-10-21T21:59:00Z'},
  observation: {deviceId:'device-1', state:'up', witnessRef:'independent-capacity-witness',
    observedAt:'2026-10-21T21:59:50Z',
    cores:8, memoryGb:24, freeDiskGb:50, bandwidthMbps:30},
  creditHold: {state:'held', workClass:'public-ci',
    ref:'original-credit-hold-ref', expiresAt:'2026-10-21T23:00:00Z'},
});

const projection = (change = null) => {
  const evidence=admission();
  if (change) change(evidence);
  return projectAssociateCiNode({admissionRef:REF, now:NOW, readAdmission:()=>evidence});
};
const job = (change = {}) => ({
  id:'source-check-1', effect:false, visibility:'public',
  minutes:3, maxMinutes:7, closure:[],
  requires:{capabilities:['node','swarm-ci-public']},
  needs:{cores:1,memoryGb:1,freeDiskGb:1},
  source:{repository:'red-cup-engineering/continuous-delivery-services-section',
    visibility:'public',trigger:'trusted-push',commitSha:SHA},
  ...change,
});
const workGrant = ({job,node}) => ({kind:'swarm.ci-job-grant.v1',
  allowed:true, ref:'trusted-original-work-grant-1',jobId:job.id,
  nodeId:node.id,admissionRef:node.associateCi.admissionRef,
  sourceSha:job.source.commitSha, expiresAt:'2026-10-21T22:10:00Z'});

test('no trusted admission reader or source witness means no volunteer node',()=>{
  assert.equal(projectAssociateCiNode({now:NOW}).admitted,false);
  assert.equal(projectAssociateCiNode({admissionRef:REF,now:NOW,readAdmission:()=>({})}).reason,
    'admission-not-source-verified');
  assert.equal(projectAssociateCiNode({admissionRef:REF,now:NOW,readAdmission:()=>{throw Error('offline')}}).reason,
    'admission-unavailable');
});

test('approved Google Actor, consented desktop and isolation only advertise bounded candidate',()=>{
  const out=projection();
  assert.equal(out.admitted,true);
  assert.equal(out.dispatchAuthorized,false);
  assert.equal(out.node.id,'associate-ci-device-1');
  assert.equal(out.node.cores,2);
  assert.equal(out.node.memoryGb,3);
  assert.equal(out.node.freeDiskGb,5);
  assert.equal(out.node.cost.kind,'held');
  assert.equal(out.node.publicOnly,true);
  assert.deepEqual(out.node.capabilities,['node','git','swarm-ci-public']);
});

test('revoked login, membership, consent and device are individually refused',()=>{
  for (const [change, expected] of [
    [a=>a.session.expiresAt='2026-10-21T21:00:00Z','no-current-login'],
    [a=>a.member.state='revoked','no-current-associate-enrollment'],
    [a=>a.consent.state='paused','public-ci-not-consented'],
    [a=>a.consent.workClasses=['public-wasm'],'public-ci-not-consented'],
    [a=>a.device.state='disconnected','desktop-agent-not-connected'],
    [a=>a.device.mode='browser-tab','desktop-agent-not-connected'],
    [a=>a.consent.actorId='https://swarm.561.group/actors/other','actor-device-custody-mismatch'],
  ]) assert.equal(projection(change).reason,expected);
});

test('unverified sandbox, stale measurements, missing credit hold, large caps refuse',()=>{
  for (const [change, expected] of [
    [a=>a.sandbox.hostMounts=true,'ephemeral-isolation-not-verified'],
    [a=>a.sandbox.network='open','ephemeral-isolation-not-verified'],
    [a=>a.observation.observedAt='2026-10-21T21:50:00Z','capacity-not-independently-fresh'],
    [a=>a.creditHold.state='unverified','original-credit-liability-not-held'],
    [a=>a.consent.limits.maxMinutes=61,'bounded-resource-limits-required'],
    [a=>a.observation.cores=0,'bounded-resource-limits-required'],
  ]) assert.equal(projection(change).reason,expected);
});

test('qualified public immutable pure work needs an exact independent original grant',()=>{
  const node=projection().node,j=job();
  assert.equal(assessAssociateCiJob({job:j,node,now:NOW}).reason,'trusted-work-grant-required');
  assert.equal(assess(j,node,{now:NOW}).why.includes('swarm-ci:trusted-work-grant-required'),true);
  const granted=assessAssociateCiJob({job:j,node,now:NOW,authorizeAssociateJob:workGrant});
  assert.equal(granted.ok,true);
  assert.equal(granted.dispatchAuthorized,false);
  assert.equal(assess(j,node,{now:NOW,authorizeAssociateJob:workGrant}).feasible,true);
  const r=place(j,[node],{now:NOW,authorizeAssociateJob:workGrant});
  assert.equal(r.chosen,node.id);
  assert.equal(r.needsLeaderWords,false);
  const planned=planFleet([j],[node],{now:NOW,authorizeAssociateJob:workGrant});
  assert.equal(planned.proposed,1);
  assert.equal(planned.executed,0);
  assert.equal(planned.leaseReceived,false);
  assert.equal(planFleet([j],[node],{now:NOW}).proposed,0);
});

test('private, effectful, pull request, unpinned, over-limit or untagged job is refused',()=>{
  const node=projection().node;
  for (const j of [
    job({visibility:'private'}),job({effect:true}),
    job({source:{...job().source,visibility:'private'}}),
    job({source:{...job().source,trigger:'pull_request'}}),
    job({source:{...job().source,commitSha:'main'}}),
    job({requires:{capabilities:['node']}}),
    job({maxMinutes:11}),
  ]) {
    const r=place(j,[node],{now:NOW,authorizeAssociateJob:workGrant});
    assert.equal(r.chosen,null,JSON.stringify(j));
    assert.ok(r.refused[0].why.some(x=>x.startsWith('swarm-ci:')),JSON.stringify(j));
  }
});

test('a fabricated associate node marker cannot silently become generic held compute',()=>{
  const r=place(job(),[{id:'associate-ci-device-evil',state:'up',observedAt:NOW,
    publicOnly:true,capabilities:['swarm-ci-public','node'],cores:4,
    memoryGb:8,freeDiskGb:100,bandwidthMbps:100,cost:{kind:'held'},closureCache:[]}],
    {now:NOW,authorizeAssociateJob:workGrant});
  assert.equal(r.chosen,null);
  assert.equal(r.refused[0].why.includes('swarm-ci:not-a-qualified-associate-ci-node'),true);
});
