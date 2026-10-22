import test from 'node:test';
import assert from 'node:assert/strict';
import { projectAssociateCiNode, assessAssociateCiJob } from '../src/placement/associate-ci.mjs';
import { assess, place, planFleet } from '../src/placement/place.mjs';

const NOW = '2026-10-21T22:00:00Z';
const REF = 'swarm-admission-witness-1', SHA = 'a'.repeat(40);
const INSTANCE = {id:'metroplat:world-one',origin:'https://world-one.561.group/',oauthAudience:'https://world-one.561.group/mcp',oauthIssuer:'https://accounts.google.com'};
const ACTOR = 'https://world-one.561.group/actors/associate-1';

const admission = () => ({
  kind: 'metroplat.instance-compute-admission.v1', ref: REF, witnessRef: 'independent-source-witness-1',
  instance:{...INSTANCE},
  member: {actorId: ACTOR,instanceId:INSTANCE.id,state:'approved', expiresAt:'2026-11-21T00:00:00Z'},
  session: {actorId: ACTOR,instanceId:INSTANCE.id,method:'oauth',issuer:INSTANCE.oauthIssuer,audience:INSTANCE.oauthAudience,state:'authenticated', expiresAt:'2026-10-21T23:00:00Z'},
  device: {actorId: ACTOR,instanceId:INSTANCE.id,id:'device-1', mode:'native-desktop', state:'connected'},
  consent: {actorId:ACTOR,instanceId:INSTANCE.id,deviceId:'device-1', state:'active', workClasses:['public-ci'],
    expiresAt:'2026-10-22T00:00:00Z',
    limits: {cores:2, memoryGb:3, freeDiskGb:5, maxMinutes:10}},
  sandbox: {deviceId:'device-1',instanceId:INSTANCE.id,kind:'ephemeral-vm', hostMounts:false,
    secretMounts:false, network:'restricted', policyRef:'sandbox-policy-witness',
    verifiedAt:'2026-10-21T21:59:00Z'},
  observation: {deviceId:'device-1',instanceId:INSTANCE.id,state:'up', witnessRef:'independent-capacity-witness',
    observedAt:'2026-10-21T21:59:50Z',
    cores:8, memoryGb:24, freeDiskGb:50, bandwidthMbps:30},
  marketOfferCurrent:true,marketOfferRef:'sha256:'+'c'.repeat(64),
  marketOffer:{
    kind:'organizing.compute-contribution-offer.v1',event:'offered',
    instance:INSTANCE.id,by:ACTOR,deviceId:'device-1',
    offerId:'offer-device-1',workClass:'public-ci',
    expiresAt:'2026-10-22T00:00:00Z',
    limits:{coresMilli:2000,memoryMiB:3072,diskMiB:5120,maxMinutes:10},
    ask:{currency:'CRED',unitRef:'work:accepted-ci-unit',microsPerAcceptedUnit:'250000'}
  }
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
const acceptedTrade = ({job,node})=>({
  kind:'organizing.compute-contribution-contract.v1',
  status:'agreed-not-executed',executionAuthorized:false,
  leaseAuthorized:false,earningPosted:false,paymentAuthorized:false,
  instanceId:node.associateCi.instanceId,actorId:node.associateCi.actorId,
  deviceId:node.associateCi.deviceId,workRef:job.id,
  quoteId:'sha256:'+'b'.repeat(64),offerRef:node.associateCi.offerRef,
  buyerAcceptanceRef:'buyer-acceptance-witness',
  supplierAcceptanceRef:'supplier-acceptance-witness',
  budgetHoldRef:'original-budget-held-ref',unitRef:'work:accepted-ci-unit',
  currency:'CRED',priceMicrosPerAcceptedUnit:'250000',
  maximumAcceptedUnits:2,maximumTotalMicros:'500000',expiresAt:'2026-10-21T22:08:00Z'
});
const workGrant = ({job,node}) => ({kind:'swarm.ci-job-grant.v1',
  allowed:true, ref:'trusted-original-work-grant-1',jobId:job.id,
  nodeId:node.id,admissionRef:node.associateCi.admissionRef,
  sourceSha:job.source.commitSha, expiresAt:'2026-10-21T22:10:00Z',
  trade:acceptedTrade({job,node})});

test('no trusted admission reader or source witness means no volunteer node',()=>{
  assert.equal(projectAssociateCiNode({now:NOW}).admitted,false);
  assert.equal(projectAssociateCiNode({admissionRef:REF,now:NOW,readAdmission:()=>({})}).reason,
    'admission-not-source-verified');
  assert.equal(projectAssociateCiNode({admissionRef:REF,now:NOW,readAdmission:()=>{throw Error('offline')}}).reason,
    'admission-unavailable');
});

test('approved OAuth Actor for a specific MetroPlat world can advertise bounded desktop compute',()=>{
  const out=projection();
  assert.equal(out.admitted,true);
  assert.equal(out.dispatchAuthorized,false);
  assert.match(out.node.id,/^associate-ci-[a-f0-9]{32}$/);
  assert.equal(out.node.associateCi.instanceId,INSTANCE.id);
  assert.equal(out.node.associateCi.oauthAudience,INSTANCE.oauthAudience);
  assert.equal(out.node.cores,2);
  assert.equal(out.node.memoryGb,3);
  assert.equal(out.node.freeDiskGb,5);
  assert.equal(out.node.cost.kind,'associate-quoted');
  assert.equal(out.node.associateCi.commercialState,'unsold-no-budget-hold');
  assert.equal(out.node.associateCi.offerRef,'sha256:'+'c'.repeat(64));
  assert.equal(Object.hasOwn(out.node.associateCi,'creditHoldRef'),false);
  assert.equal(out.node.publicOnly,true);
  assert.deepEqual(out.node.capabilities,['node','git','swarm-ci-public']);
});

test('revoked login, membership, consent and device are individually refused',()=>{
  for (const [change, expected] of [
    [a=>a.session.expiresAt='2026-10-21T21:00:00Z','no-current-oauth-session'],
    [a=>a.member.state='revoked','no-current-associate-enrollment'],
    [a=>a.consent.state='paused','public-ci-not-consented'],
    [a=>a.consent.workClasses=['public-wasm'],'public-ci-not-consented'],
    [a=>a.device.state='disconnected','desktop-agent-not-connected'],
    [a=>a.device.mode='browser-tab','desktop-agent-not-connected'],
    [a=>a.consent.actorId='https://world-one.561.group/actors/other','instance-actor-device-custody-mismatch'],
    [a=>a.member.instanceId='metroplat:neighbor','instance-actor-device-custody-mismatch'],
    [a=>a.session.audience='https://neighbor.561.group/mcp','no-current-oauth-session'],
    [a=>a.session.issuer='https://malicious.example','no-current-oauth-session'],
  ]) assert.equal(projection(change).reason,expected);
});

test('unverified isolation, stale independent measurements and excessive resources refuse',()=>{
  for (const [change, expected] of [
    [a=>a.sandbox.hostMounts=true,'ephemeral-isolation-not-verified'],
    [a=>a.sandbox.network='open','ephemeral-isolation-not-verified'],
    [a=>a.observation.observedAt='2026-10-21T21:50:00Z','capacity-not-independently-fresh'],
    [a=>a.sandbox.instanceId='metroplat:neighbor','instance-actor-device-custody-mismatch'],
    [a=>{a.marketOfferCurrent=false;},'current-priced-original-market-offer-unverified'],
    [a=>{a.marketOffer.event='withdrawn';},'current-priced-original-market-offer-unverified'],
    [a=>{a.marketOffer.by='unrelated:other';},'current-priced-original-market-offer-unverified'],
    [a=>{a.marketOffer.instance='metroplat:neighbor';},'current-priced-original-market-offer-unverified'],
    [a=>{a.marketOffer.ask.microsPerAcceptedUnit='0';},'current-priced-original-market-offer-unverified'],
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
  assert.equal(granted.trade.budgetHoldRef,'original-budget-held-ref');
  assert.equal(granted.trade.maximumTotalMicros,'500000');
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

test('an unsold capacity advert remains valid but unaccepted pricing cannot authorize any CI job',()=>{
  const node=projection().node,j=job();
  const noPrice=assessAssociateCiJob({job:j,node,now:NOW,
    authorizeAssociateJob:args=>({...workGrant(args),trade:undefined})});
  assert.equal(noPrice.reason,'bilateral-priced-work-and-reserved-budget-required');
  for(const change of [
    t=>{t.instanceId='metroplat:neighbor';},
    t=>{t.actorId='oidc:unrelated';},
    t=>{t.quoteId='not-a-sha256-digest';},
    t=>{t.budgetHoldRef='';},
    t=>{t.status='revoked';},
    t=>{t.offerRef='sha256:'+'d'.repeat(64);},
    t=>{t.currency='USD';},
    t=>{t.unitRef='work:other-units';},
    t=>{t.priceMicrosPerAcceptedUnit='200000';},
    t=>{t.leaseAuthorized=true;},
    t=>{t.earningPosted=true;},
    t=>{t.buyerAcceptanceRef=t.supplierAcceptanceRef;},
    t=>{t.maximumTotalMicros='500001';},
    t=>{t.priceMicrosPerAcceptedUnit='0';},
    t=>{t.expiresAt='2026-10-21T21:00:00Z';},
  ]){
    const grant=args=>{
      const g=workGrant(args);
      change(g.trade);
      return g;
    };
    const verdict=place(j,[node],{now:NOW,authorizeAssociateJob:grant});
    assert.equal(verdict.chosen,null);
    assert.ok(verdict.refused[0].why.includes('swarm-ci:bilateral-priced-work-and-reserved-budget-required'));
  }
  assert.equal(place(j,[node],{now:NOW,authorizeAssociateJob:workGrant}).chosen,node.id);
});

test('same device name enrolled in different OAuth worlds receives a different scoped node identity',()=>{
  const first=projection();
  const second=admission();
  const target={id:'metroplat:world-two',origin:'https://world-two.561.group/',
    oauthAudience:'https://world-two.561.group/mcp',oauthIssuer:'https://accounts.google.com'};
  second.instance=target;
  const otherActor='https://world-two.561.group/actors/associate-1';
  for(const key of ['member','session','device','consent','sandbox','observation'])
    second[key].instanceId=target.id;
  for(const key of ['member','session','device','consent'])second[key].actorId=otherActor;
  second.session.audience=target.oauthAudience;
  second.marketOffer.instance=target.id;
  second.marketOffer.by=otherActor;
  second.marketOfferRef='sha256:'+'e'.repeat(64);
  const other=projectAssociateCiNode({admissionRef:REF,now:NOW,readAdmission:()=>second});
  assert.equal(first.admitted,true);
  assert.equal(other.admitted,true);
  assert.notEqual(first.node.id,other.node.id);
  assert.equal(other.node.associateCi.instanceId,target.id);
});


test('a paid associate is never a generic zero-cost provider before Work accepts one reserved trade',()=>{
  const node=projection().node;
  assert.equal(node.cost.kind,'associate-quoted');
  assert.equal(node.associateCi.commercialState,'unsold-no-budget-hold');
  const j=job();
  const before=assess(j,node,{now:NOW});
  assert.equal(before.feasible,false);
  assert.ok(before.why.some(reason=>reason.startsWith('swarm-ci:')));
  const approved=assess(j,node,{now:NOW,authorizeAssociateJob:workGrant});
  assert.equal(approved.feasible,true);
  assert.equal(approved.budgetHold.kind,'associate-quote');
  assert.equal(approved.budgetHold.maximumTotalMicros,'500000');
  assert.equal(approved.budgetHold.currency,'CRED');
  assert.equal(approved.budgetHold.budgetHoldRef,'original-budget-held-ref');
  assert.equal(approved.budgetHold.scope,INSTANCE.id);
  assert.equal(place(j,[node],{now:NOW}).chosen,null);
  const plan=planFleet([j],[node],{now:NOW,authorizeAssociateJob:workGrant});
  assert.equal(plan.placements[0].budgetHold.kind,'associate-quote');
  assert.equal(plan.providerBudgetHeld,false);
  assert.equal(plan.executed,0);
});

test('fleet will not spend one original buyer hold twice across distinct CI Work',()=>{
  const node=projection().node;
  const jobs=[job({id:'first-ci-job'}),job({id:'second-ci-job'})];
  const plan=planFleet(jobs,[node],{now:NOW,authorizeAssociateJob:workGrant});
  assert.equal(plan.proposed,1);
  assert.equal(plan.unplaced,1);
  assert.equal(plan.placements[0].jobId,'first-ci-job');
  assert.equal(plan.pending[0].reason,'original-associate-budget-hold-already-proposed');
  assert.equal(plan.providerBudgetHeld,false);
  assert.equal(plan.leaseReceived,false);
  // Independent original reserve receipts, even in the same instance,
  // give the other workload a separate lawful budget in a proposal.
  const two=planFleet(jobs,[node],{now:NOW,authorizeAssociateJob:args=>{
    const g=workGrant(args);
    g.trade.budgetHoldRef='budget-reservation-'+args.job.id;
    return g;
  }});
  assert.equal(two.proposed,2);
  assert.equal(two.unplaced,0);
});


test('original participant limits beat claimed capacity, and never round MiB upward',()=>{
  const a=admission();
  a.marketOffer.limits.coresMilli=1250;
  a.marketOffer.limits.memoryMiB=1536;
  a.marketOffer.limits.diskMiB=2560;
  a.marketOffer.limits.maxMinutes=5;
  const result=projectAssociateCiNode({admissionRef:REF,now:NOW,readAdmission:()=>a});
  assert.equal(result.admitted,true);
  assert.equal(result.node.cores,1.25);
  assert.equal(result.node.memoryGb,1.5);
  assert.equal(result.node.freeDiskGb,2.5);
  assert.equal(result.node.associateCi.maxMinutes,5);
  assert.equal(place(job({maxMinutes:7}),[result.node],
    {now:NOW,authorizeAssociateJob:workGrant}).chosen,null);
});
