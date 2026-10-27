import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newLedger, hold, settle, remainingMinutes, minutePrice, paceMinutes,
  newObservedBudget, quoteBudget, holdBudget, settleBudget, budgetAvailable }
  from '../src/placement/allowance.mjs';
import { place, assess, planFleet, preflightSessionExecution } from '../src/placement/place.mjs';
import { newTable, grant, renew, accept, expired } from '../src/placement/lease.mjs';
import { compareBuilds, publishable } from '../src/placement/settle.mjs';

const NOW = '2026-10-15T04:50:00Z';
const read = f => JSON.parse(fs.readFileSync(new URL(`../data/placement/${f}`, import.meta.url), 'utf8'));
const job = () => read('jobs/kalshi-trading-closure-build.json');
const nodes = () => fs.readdirSync(new URL('../data/placement/nodes/', import.meta.url)).map(f => read(`nodes/${f}`));
const ledger = (used = 0) => newLedger({ plan: 'free', month: '2026-10',
  usedMinutes: used, observedAt: NOW });

// Synthetic evidence tests the receiving interface, not installed authority.
function sessionFixture(mode='local-qualification') {
  const source={repository:'fixture/original-owner',repositoryId:42,commit:'a'.repeat(40)};
  const sessionId='fixture-session', workspacePath='/workspace/one-job',scope='fixture:host-custody';
  const job={id:'bounded-source-test',effect:false,visibility:'public',minutes:1,maxMinutes:5,
    closure:[],needs:{cores:1,memoryGb:0.1,freeDiskGb:0.01,freeInodes:100},
    requires:{capabilities:['node']},sessionExecution:{mode,scope,sessionId,source,workspacePath}};
  const node={id:'fixture-node',state:'up',observedAt:NOW,cores:4,memoryGb:4,freeDiskGb:2,
    freeInodes:1000,bandwidthMbps:100,startupMinutes:0,queuedMinutes:0,capabilities:['node'],closureCache:[],cost:{kind:'held'},
    sessionExecution:{scope,sessionId,source:{...source},workspacePath,checkoutHead:source.commit,checkoutClean:true,
      observationRef:'fixture:observed-session',observedAt:NOW,expiresAt:'2026-10-15T05:00:00Z',
      lifecycle:'foreground-single-job',maxJobs:1,activeJobs:0,completedJobs:0}};
  const readSessionAdmission=subject=>({kind:'session-execution-admission.v1',state:'received',subject,
    issuer:'fixture:host-owner',evidenceRef:'fixture:original-receipt',verifierRevision:'b'.repeat(40),
    reviewRef:'fixture:exact-source-review',lifecycleRef:'fixture:bounded-lifetime',
    isolationRef:'fixture:independent-boundary',credentialPolicy:'no-job-secrets',
    isolation:mode==='github-jit'?'clean-one-job':'reviewed-local-source',
    observedAt:NOW,expiresAt:'2026-10-15T05:00:00Z',
    ...(mode==='github-jit'?{runner:{id:7,repositoryId:42,ephemeral:true,
      scope:'trusted-exact-head',evidenceRef:'fixture:provider-runner'}}:{})});
  return {job,node,ctx:{now:NOW,readSessionAdmission}};
}

test('session preflight preserves ordinary placement and cannot turn a local result into registration',()=>{
  assert.equal(preflightSessionExecution(job(),nodes()[0],{now:NOW}),null);
  const f=sessionFixture(), before=structuredClone([f.job,f.node]);
  const result=place(f.job,[f.node],f.ctx);
  assert.equal(result.chosen,f.node.id);
  assert.equal(result.candidates[0].sessionExecution.mode,'local-qualification');
  assert.equal(result.candidates[0].sessionExecution.executed,false);
  assert.equal(result.candidates[0].sessionExecution.leaseRequired,true);
  assert.equal(result.candidates[0].sessionExecution.runner,undefined);
  assert.deepEqual([f.job,f.node],before);
});

test('session capacity includes inodes and exact workspace, head, freshness and finite lifetime',()=>{
  const changes=[
    [f=>{f.node.freeInodes=0;},'too-small:freeInodes'],
    [f=>{delete f.node.freeInodes;},'session-inode-capacity-unmeasured'],
    [f=>{f.job.needs.freeInodes=0;},'session-inode-capacity-unmeasured'],
    [f=>{f.node.memoryGb=null;},'session-resource-unmeasured:memoryGb'],
    [f=>{f.node.memoryGb=0;},'too-small:memoryGb'],
    [f=>{f.node.cores=0;},'too-small:cores'],
    [f=>{f.node.freeDiskGb=0;},'too-small:freeDiskGb'],
    [f=>{f.node.sessionExecution.checkoutHead='c'.repeat(40);},'session-source-head-or-workspace-differs'],
    [f=>{f.node.sessionExecution.source.repositoryId=43;},'session-source-head-or-workspace-differs'],
    [f=>{f.node.sessionExecution.checkoutClean=false;},'session-source-head-or-workspace-differs'],
    [f=>{f.node.sessionExecution.workspacePath='/workspace/other';},'session-source-head-or-workspace-differs'],
    [f=>{f.node.sessionExecution.sessionId='different-session';},'session-source-head-or-workspace-differs'],
    [f=>{f.node.sessionExecution.scope='different-custody';},'session-source-head-or-workspace-differs'],
    [f=>{f.node.sessionExecution.observationRef='';},'session-observation-stale-or-absent'],
    [f=>{f.node.sessionExecution.observedAt='2026-10-15T03:00:00Z';},'session-observation-stale-or-absent'],
    [f=>{delete f.node.sessionExecution.expiresAt;},'session-lifetime-does-not-cover-job'],
    [f=>{f.node.sessionExecution.expiresAt='2026-10-15T04:54:59Z';},'session-lifetime-does-not-cover-job'],
    [f=>{f.job.maxMinutes=Infinity;},'session-maximum-runtime-required'],
    [f=>{f.node.queuedMinutes=5;},'session-maximum-does-not-cover-placement-time'],
    [f=>{f.node.startupMinutes=5;},'session-maximum-does-not-cover-placement-time'],
    [f=>{delete f.node.queuedMinutes;},'session-placement-time-unmeasured'],
    [f=>{f.job.closure=[{id:'uncached',sizeMb:1000}];f.node.bandwidthMbps=1;},'session-maximum-does-not-cover-placement-time'],
    [f=>{f.node.state='intermittent';},'session-placement-time-unmeasured'],
    [f=>{f.job.effect='publish';},'session-external-effect-free-job-required'],
    [f=>{delete f.job.effect;},'session-external-effect-free-job-required'],
    [f=>{f.node.sessionExecution.activeJobs=1;},'session-single-job-lifecycle-unreceived'],
    [f=>{f.node.sessionExecution.completedJobs=1;},'session-single-job-lifecycle-unreceived'],
    [f=>{f.node.sessionExecution.lifecycle='persistent-service';},'session-single-job-lifecycle-unreceived'],
    [f=>{delete f.job.sessionExecution;},'session-job-identity-required'],
    [f=>{delete f.node.sessionExecution;},'session-observation-stale-or-absent'],
  ];
  for(const [change,reason] of changes){
    const f=sessionFixture();change(f);let reads=0;
    const r=place(f.job,[f.node],{...f.ctx,readSessionAdmission:()=>{reads++;throw Error('unexpected');}});
    assert.equal(r.chosen,null,reason);assert.ok(r.refused[0].why.includes(reason),reason);
    assert.equal(reads,0,reason);
  }
});

test('session admission must be independently read and revision, subject, issuer and expiry bound',()=>{
  const f=sessionFixture();
  assert.deepEqual(place(f.job,[f.node],{now:NOW}).refused[0].why,['session-admission-unreceived']);
  for(const reading of [true,{},null,Promise.resolve(true)]){
    assert.equal(place(f.job,[f.node],{now:NOW,readSessionAdmission:()=>reading}).chosen,null);
  }
  const alterations=[r=>{r.issuer='';},r=>{r.verifierRevision='main';},r=>{r.reviewRef='';},
    r=>{r.isolationRef='';},r=>{r.lifecycleRef='';},r=>{r.credentialPolicy='inherited-secrets';},
    r=>{r.expiresAt='2026-10-15T04:54:59Z';},r=>{r.subject.source.commit='c'.repeat(40);},
    r=>{r.subject.nodeId='other';},r=>{r.subject.jobId='other';},r=>{r.subject.observationRef='fixture:other';},
    r=>{r.subject.jobDigest='c'.repeat(64);},
    r=>{r.observedAt='2026-10-15T03:00:00Z';},r=>{r.isolation='bwrap-installed';}];
  for(const alter of alterations){
    const read=subject=>{const r=f.ctx.readSessionAdmission(subject);alter(r);return r;};
    assert.equal(place(f.job,[f.node],{now:NOW,readSessionAdmission:read}).chosen,null);
  }
  const failed=place(f.job,[f.node],{now:NOW,readSessionAdmission:()=>{throw Error('offline');}});
  assert.deepEqual(failed.refused[0].why,['session-admission-read-failed']);
});

test('JIT preflight requires original registration receiving and clean one-job isolation',()=>{
  const f=sessionFixture('github-jit');
  assert.equal(place(f.job,[f.node],f.ctx).chosen,f.node.id);
  for(const alter of [r=>{delete r.runner;},r=>{r.runner.repositoryId=99;},
    r=>{r.runner.ephemeral=false;},r=>{r.runner.scope='all-branches';},
    r=>{r.runner.evidenceRef='';},r=>{r.isolation='reviewed-local-source';}]){
    const read=subject=>{const r=f.ctx.readSessionAdmission(subject);alter(r);return r;};
    assert.equal(place(f.job,[f.node],{now:NOW,readSessionAdmission:read}).chosen,null);
  }
});

test('fleet session preflight reserves inodes and one job without mutating original custody',()=>{
  const f=sessionFixture(),before=structuredClone(f.node);
  const result=planFleet([f.job,{...f.job,id:'second-job'}],[f.node],f.ctx);
  assert.equal(result.proposed,1);assert.equal(result.executed,0);
  assert.equal(result.placements[0].resourceHold.freeInodes,100);
  assert.equal(result.residualResources[0].freeInodes,900);
  assert.ok(result.pending[0].refused[0].why.includes('session-single-job-lifecycle-unreceived'));
  assert.deepEqual(f.node,before);
  // A label cannot bypass the session preflight by dropping the job request.
  assert.equal(place({...f.job,sessionExecution:undefined},[f.node],f.ctx).chosen,null);
  const aliases=planFleet([f.job,{...f.job,id:'second-job'}],[f.node,{...structuredClone(f.node),id:'alias-node'}],f.ctx);
  assert.equal(aliases.proposed,1);
  assert.ok(aliases.pending[0].refused.every(r=>r.why.includes('session-single-job-lifecycle-unreceived')));
  const invalidAlias=structuredClone(f.node);invalidAlias.id='invalid-alias';invalidAlias.sessionExecution.activeJobs=-1;
  assert.equal(planFleet([f.job,{...f.job,id:'second-job'}],[f.node,invalidAlias],f.ctx).proposed,1);
  const other=structuredClone(f.node);other.id='other-custody-node';other.sessionExecution.scope='fixture:other-host';
  const otherJob=structuredClone(f.job);otherJob.id='other-custody-job';otherJob.sessionExecution.scope='fixture:other-host';
  assert.equal(planFleet([f.job,otherJob],[f.node,other],f.ctx).proposed,2);
});

test('session receiving binds changed commands, closure and needs under the same original job ID',()=>{
  const f=sessionFixture();let prior;
  place(f.job,[f.node],{...f.ctx,readSessionAdmission:subject=>{prior=f.ctx.readSessionAdmission(subject);return prior;}});
  for(const job of [{...f.job,command:['node','other-test.mjs']},
    {...f.job,needs:{...f.job.needs,freeInodes:101}},
    {...f.job,closure:[{id:'changed-input',sizeMb:0}]}]){
    const result=place(job,[f.node],{now:NOW,readSessionAdmission:()=>prior});
    assert.equal(result.chosen,null);
    assert.ok(result.refused[0].why.includes('session-admission-identity-or-evidence-unreceived'));
  }
  const changedNode=structuredClone(f.node);changedNode.freeInodes++;
  assert.equal(place(f.job,[changedNode],{now:NOW,readSessionAdmission:()=>prior}).chosen,null);
});

test('session transfer bounds cannot be reduced by negative, inverted or unmeasured intervals',()=>{
  for(const sizeMb of [-750,{min:-1,max:1},{min:10,max:1},{min:0,max:Infinity},undefined]){
    const f=sessionFixture();f.job.closure=[{id:'uncached',sizeMb}];
    if(sizeMb===undefined) delete f.job.closure[0].sizeMb;
    let reads=0;const result=place(f.job,[f.node],{...f.ctx,readSessionAdmission:()=>{reads++;}});
    assert.equal(result.chosen,null);assert.equal(reads,0);
  }
  for(const bandwidthMbps of [-1,0,{min:-1,max:100},{min:100,max:1},undefined]){
    const f=sessionFixture();f.job.closure=[{id:'uncached',sizeMb:1}];f.node.bandwidthMbps=bandwidthMbps;
    if(bandwidthMbps===undefined) delete f.node.bandwidthMbps;
    assert.equal(place(f.job,[f.node],f.ctx).chosen,null);
  }
  const f=sessionFixture();f.node.startupMinutes=10;f.node.bandwidthMbps=1;
  f.job.closure=[{id:'positive',sizeMb:100},{id:'negative',sizeMb:-750}];
  assert.equal(place(f.job,[f.node],f.ctx).chosen,null);
  f.node.startupMinutes=0;f.job.closure=[{id:'bounded',sizeMb:{min:0,max:1}}];
  assert.equal(place(f.job,[f.node],f.ctx).chosen,f.node.id);
});

test('the Kalshi closure goes to the node that already holds it', () => {
  const r = place(job(), nodes(), { ledger: ledger(), now: NOW });
  assert.equal(r.chosen, 'cloud-session');
  assert.deepEqual(r.candidates[0].missing, []);
  assert.equal(r.needsLeaderWords, false);
});

test('unknown sizes are intervals, never zero: an unmeasured node is possible, not certain', () => {
  const r = place(job(), nodes(), { ledger: ledger(), now: NOW });
  // A down host must not be selected merely for unknown resources.
  assert.ok(r.refused.some(c=>c.nodeId==='cold-red-gate'&&
    c.why.includes('node-not-observed-up')));
  // Hypothetical new provider observation: sizes still remain intervals.
  const crg = assess(job(),{...nodes().find(n=>n.id==='cold-red-gate'),
    state:'up',observedAt:NOW},{ledger:ledger(),now:NOW});
  assert.equal(crg.certainty, 'possible');
  assert.equal(crg.price.max, Infinity);
  assert.ok(crg.price.min >= job().minutes);
});

test('hosted minutes are refused once the free allowance cannot cover the job, never overdrawn', () => {
  const r = place({ ...job(), minutes: 20, maxMinutes: 20 }, nodes(), { ledger: ledger(1990), now: NOW });
  const hosted = r.refused.find(x => x.nodeId === 'github-hosted-ubuntu-24.04');
  assert.ok(hosted.why.includes('hosted-allowance-exhausted-or-stale'));
});

test('with only a hosted runner left and an exhausted allowance there is no placement', () => {
  const only = nodes().filter(n => n.id === 'github-hosted-ubuntu-24.04');
  const r = place(job(), only, { ledger: ledger(2000), now: NOW });
  assert.equal(r.chosen, null);
});

test('a hosted minute costs more once the request exceeds the daily pace', () => {
  const l = ledger();
  const pace = paceMinutes(l, NOW);
  assert.equal(minutePrice(l, NOW, Math.floor(pace)), 0.1);
  assert.ok(minutePrice(l, NOW, Math.ceil(pace) + 30) > 1);
  assert.equal(minutePrice(l, NOW, 2001), null);
});

test('a node too small for the job is refused with the field named', () => {
  const small = { ...job(), needs: { cores: 64, memoryGb: 1, freeDiskGb: 1 } };
  const r = place(small, nodes().filter(n => n.id === 'cloud-session'), { ledger: ledger(), now: NOW });
  assert.equal(r.chosen, null);
  assert.ok(r.refused[0].why.includes('too-small:cores'));
});

test('a job that must run on named nodes is not placed elsewhere, and an effect waits for the Leader', () => {
  const effect = { ...job(), effect: true, mustRunOn: ['laptop'], requires: { capabilities: ['bare-cedar-fog'] } };
  // The real laptop has no current receiver observation; only this synthetic
  // heartbeat would permit its capacity to be considered.
  const observed=nodes().map(n=>n.id==='laptop'?{...n,observedAt:NOW}:n);
  assert.equal(place(effect,nodes(),{ledger:ledger(),now:NOW}).chosen,null);
  const r = place(effect, observed, { ledger: ledger(), now: NOW });
  assert.equal(r.chosen, 'laptop');
  assert.equal(r.needsLeaderWords, true);
});

test('a down node is never chosen', () => {
  const ns = nodes().map(n => n.id === 'cloud-session' ? { ...n, state: 'down' } : n);
  assert.notEqual(place(job(), ns, { ledger: ledger(), now: NOW }).chosen, 'cloud-session');
});

test('allowance: hold, settle spent, remaining shrinks; a second hold on the same job is refused', () => {
  const l = ledger();
  assert.equal(hold(l, { jobId: 'a', minutes: 30 }).ok, true);
  assert.equal(remainingMinutes(l), 1970);
  assert.throws(() => hold(l, { jobId: 'a', minutes: 5 }), /already-holds/);
  settle(l, { jobId: 'a', state: 'spent', billedMinutes: 12 });
  assert.equal(remainingMinutes(l), 1988);
  assert.equal(hold(l, { jobId: 'b', minutes: 5000 }).ok, false);
  hold(l, { jobId: 'c', minutes: 10 });
  settle(l, { jobId: 'c', state: 'void' });
  assert.equal(remainingMinutes(l), 1988);
});

test('lease: one live holder, fencing token rises, stale holder is refused', () => {
  const t = newTable();
  const a = grant(t, { jobId: 'j', nodeId: 'laptop', now: NOW, ttlMs: 60_000 });
  assert.equal(a.ok, true);
  assert.equal(grant(t, { jobId: 'j', nodeId: 'cloud-session', now: NOW, ttlMs: 60_000 }).reason, 'live-lease-held');
  const later = '2026-10-15T04:52:00Z';
  assert.deepEqual(expired(t, later), ['j']);
  const b = grant(t, { jobId: 'j', nodeId: 'cloud-session', now: later, ttlMs: 60_000 });
  assert.ok(b.token > a.token);
  assert.equal(accept(t, { jobId: 'j', nodeId: 'laptop', token: a.token, now: later }).reason, 'stale-fencing-token');
  assert.equal(renew(t, { jobId: 'j', nodeId: 'cloud-session', token: b.token, now: later, ttlMs: 60_000 }).ok, true);
  assert.equal(accept(t, { jobId: 'j', nodeId: 'cloud-session', token: b.token, now: later }).ok, true);
  assert.equal(grant(t, { jobId: 'j', nodeId: 'laptop', now: later, ttlMs: 1 }).reason, 'job-already-settled');
});

test('invalid lease identities or unbounded time cannot mutate fencing custody', () => {
  const t=newTable();
  const before=structuredClone(t);
  for(const data of [
    {jobId:'',nodeId:'node',now:NOW,ttlMs:1000},
    {jobId:'job',nodeId:'',now:NOW,ttlMs:1000},
    {jobId:'job',nodeId:'node',now:'invalid',ttlMs:1000},
    {jobId:'job',nodeId:'node',now:NOW,ttlMs:0},
    {jobId:'job',nodeId:'node',now:NOW,ttlMs:-1},
    {jobId:'job',nodeId:'node',now:NOW,ttlMs:Infinity},
    {jobId:'job',nodeId:'node',now:NOW,ttlMs:1.5},
    {jobId:'job',nodeId:'node',now:NOW,ttlMs:Number.MAX_SAFE_INTEGER},
  ]) {
    assert.throws(()=>grant(t,data),/identities|lease requires|expiry exceeds/);
    assert.deepEqual(t,before);
  }
  const accepted=grant(t,{jobId:'job',nodeId:'node',now:NOW,ttlMs:1000});
  assert.equal(accepted.ok,true);
  const liveBefore=structuredClone(t);
  assert.throws(()=>renew(t,{jobId:'job',nodeId:'node',token:accepted.token,now:NOW,ttlMs:0}),/positive whole TTL/);
  assert.deepEqual(t,liveBefore);
  assert.equal(renew(t,{jobId:'job',nodeId:'node',token:accepted.token,now:NOW,ttlMs:2000}).ok,true);
});

test('lease: an effect is not accepted after expiry, a pure build is', () => {
  const t = newTable();
  const a = grant(t, { jobId: 'e', nodeId: 'laptop', now: NOW, ttlMs: 1000 });
  const late = '2026-10-15T05:00:00Z';
  assert.equal(accept(t, { jobId: 'e', nodeId: 'laptop', token: a.token, now: late, effect: true }).reason, 'effect-after-expiry');
  assert.equal(accept(t, { jobId: 'e', nodeId: 'laptop', token: a.token, now: late }).ok, true);
});

test('two builders with identical store paths agree; a difference is top and queues a repair', () => {
  const out = { machine: '/gnu/store/aaa-machine', profile: '/gnu/store/bbb-profile' };
  const agree = compareBuilds([{ nodeId: 'laptop', outputs: out }, { nodeId: 'cold-red-gate', outputs: out }]);
  assert.equal(agree.state, 'agree');
  assert.equal(publishable(agree), true);
  const top = compareBuilds([{ nodeId: 'laptop', outputs: out }, { nodeId: 'cold-red-gate', outputs: { ...out, profile: '/gnu/store/ccc-profile' } }]);
  assert.equal(top.state, 'top');
  assert.deepEqual(top.differing, ['profile']);
  assert.equal(publishable(top), false);
  assert.equal(compareBuilds([{ nodeId: 'laptop', outputs: out }]).state, 'single');
});

test('absence of usage or freshness never becomes free private GitHub minutes',()=>{
  assert.throws(()=>newLedger({plan:'free',month:'2026-10'}),/observed/);
  const privateRunner=nodes().find(n=>n.id==='github-hosted-ubuntu-24.04');
  assert.equal(privateRunner.state,'down');
  const r=place(job(),[{...privateRunner,state:'up',observedAt:NOW}],
    {now:NOW});
  assert.equal(r.chosen,null);
  assert.ok(r.refused[0].why.includes('no-observed-hosted-allowance'));
  const stale=newLedger({plan:'free',month:'2026-10',usedMinutes:0,
    observedAt:'2026-10-15T01:00:00.000Z'});
  assert.equal(place(job(),[{...privateRunner,state:'up',observedAt:NOW}],
    {ledger:stale,now:NOW}).chosen,null);
});

test('stale cloud capacity is refused; source snapshots never authorize a job',()=>{
  const cloud=nodes().find(n=>n.id==='cloud-session');
  assert.ok(cloud.observedAt);
  assert.equal(place(job(),[cloud],{ledger:ledger(),now:NOW}).chosen,'cloud-session');
  const later='2026-10-15T06:30:00Z';
  const stale=place(job(),[cloud],{ledger:ledger(),now:later});
  assert.equal(stale.chosen,null);
  assert.ok(stale.refused[0].why.includes('node-availability-observation-stale-or-absent'));
  assert.equal(place(job(),[{...cloud,state:'unverified',observedAt:later}],
    {now:later}).chosen,null);
});

test('observed Free CircleCI credits select original source without spending GitHub minutes',()=>{
  const now='2026-10-15T04:50:00.000Z';
  const scope='red-cup-engineering/private';
  const sourceRef='provider://circleci/free-observation';
  const creditLedger=newObservedBudget({provider:'circleci-free-private',scope,
    sourceRef,hardStop:true,observedAt:now,
    expiresAt:'2026-10-15T05:50:00.000Z',remaining:{credits:250}});
  const circle={id:'circleci-free-private',state:'up',observedAt:now,
    cores:1,memoryGb:2,freeDiskGb:4,bandwidthMbps:100,
    capabilities:['node','git'],closureCache:[],
    cost:{kind:'metered-free',provider:'circleci-free-private',scope,
      hardStop:true,maxJobMinutes:60,unitsPerMinute:{credits:5}}};
  const sourceJob={...job(),visibility:'private',minutes:10,maxMinutes:30,
    sourceEgress:{permitted:true,provider:'circleci-free-private',scope,
      authorityRef:'office:engineering/free-ci-github-app'},
    needs:{cores:1,memoryGb:2,freeDiskGb:1},closure:[]};
  const noGrant=place({...sourceJob,sourceEgress:null},[circle],{now});
  assert.equal(noGrant.chosen,null);
  assert.ok(noGrant.refused[0].why.includes('private-source-egress-not-granted'));
  const missing=place(sourceJob,[circle],{now});
  assert.equal(missing.chosen,null);
  assert.ok(missing.refused[0].why.includes('provider-budget-unobserved'));
  const context={now,budgets:{[scope]:creditLedger}};
  const eligible=place(sourceJob,[circle],context);
  assert.equal(eligible.chosen,circle.id);
  assert.deepEqual(eligible.candidates[0].budgetHold.units,{credits:150});
  assert.equal(holdBudget(creditLedger,{jobId:sourceJob.id,provider:circle.cost.provider,
    scope,now,units:{credits:150}}).ok,true);
  assert.equal(budgetAvailable(creditLedger).credits,100);
  const other=place({...sourceJob,id:'other'},[circle],context);
  assert.equal(other.chosen,null);
  assert.ok(other.refused[0].why.some(x=>x.includes('would-overdraw')));
  settleBudget(creditLedger,{jobId:sourceJob.id,state:'spent',actualUnits:{credits:70}});
  assert.equal(budgetAvailable(creditLedger).credits,180);
  assert.equal(place({...sourceJob,id:'other'},[circle],context).chosen,circle.id);
  assert.equal(place(sourceJob,[{...circle,publicOnly:true}],context).chosen,null);
  assert.equal(place(sourceJob,[{...circle,observedAt:'2026-10-15T00:00:00.000Z'}],
    context).chosen,null);
  assert.equal(place(sourceJob,[{...circle,cost:{...circle.cost,hardStop:false}}],
    context).chosen,null);
  assert.equal(place({...sourceJob,maxMinutes:120},[circle],context).chosen,null);
});

test('Oracle Always Free multi-unit quotes cannot overspend either OCPU or GB-hour',()=>{
  const now='2026-10-15T04:50:00.000Z';
  const scope='oci/home-free/a1';
  const remaining={ocpuHours:2,gbHours:12};
  const b=newObservedBudget({provider:'oci-always-free-a1',scope,hardStop:true,
    sourceRef:'provider://oci/native-quota-observation',
    observedAt:now,expiresAt:'2026-10-15T05:50:00.000Z',remaining});
  const worker={id:'oci-a1-existing-vm',state:'up',observedAt:now,
    cores:2,memoryGb:12,freeDiskGb:10,bandwidthMbps:100,
    capabilities:['node','git','guix'],closureCache:[],
    cost:{kind:'metered-free',provider:'oci-always-free-a1',
      scope,hardStop:true,maxJobMinutes:1440,
      unitsPerMinute:{ocpuHours:2/60,gbHours:12/60}}};
  const short={...job(),minutes:30,maxMinutes:30,closure:[],
    sourceEgress:{permitted:true,provider:'oci-always-free-a1',scope,
      authorityRef:'office:engineering/oracle-test-observation'},
    needs:{cores:1,memoryGb:2,freeDiskGb:1}};
  assert.equal(place(short,[worker],{now,budgets:{[scope]:b}}).chosen,worker.id);
  const tooLong={...short,maxMinutes:120};
  const result=place(tooLong,[worker],{now,budgets:{[scope]:b}});
  assert.equal(result.chosen,null);
  assert.ok(result.refused[0].why.some(x=>x.includes('ocpuHours')));
  const memoryBound=newObservedBudget({provider:'oci-always-free-a1',scope,
    sourceRef:'provider://oci/separate-memory-cap',hardStop:true,
    observedAt:now,expiresAt:'2026-10-15T05:50:00.000Z',
    remaining:{ocpuHours:8,gbHours:12}});
  const memory=place(tooLong,[worker],{now,budgets:{[scope]:memoryBound}});
  assert.equal(memory.chosen,null);
  assert.ok(memory.refused[0].why.some(x=>x.includes('gbHours')));
  assert.throws(()=>newObservedBudget({provider:'oci-always-free-a1',scope,
    sourceRef:'provider://oci/not-hard-stop',hardStop:false,
    observedAt:now,expiresAt:'2026-10-15T05:50:00.000Z',remaining}),/free-only/);
});

test('shared compute budget refuses zero holds and negative multi-unit settlement',()=>{
  const now='2026-10-15T04:50:00.000Z';
  const b=newObservedBudget({provider:'oci-always-free-a1',scope:'oci/one-free',
    hardStop:true,sourceRef:'provider://oci/independent-budget',
    observedAt:now,expiresAt:'2026-10-15T05:50:00.000Z',
    remaining:{ocpuHours:2,gbHours:12}});
  const claim={provider:b.provider,scope:b.scope,now,units:{ocpuHours:0,gbHours:0}};
  assert.equal(quoteBudget(b,claim).reason,'provider-usage-has-no-positive-reservation');
  assert.equal(holdBudget(b,{jobId:'zero',...claim}).ok,false);
  assert.deepEqual(b.entries,[]);
  const hold=holdBudget(b,{jobId:'real',...claim,units:{ocpuHours:1.5,gbHours:6}});
  assert.equal(hold.ok,true);
  // A later provider readback changed availability while the hold was active.
  b.remaining.gbHours=5;
  const before=structuredClone(b);
  assert.throws(()=>settleBudget(b,{jobId:'real',state:'spent',
    actualUnits:{ocpuHours:1.0,gbHours:6}}),/exceeds observed remaining/);
  assert.deepEqual(b,before,'refusal cannot debit only the first unit or settle the hold');
  b.remaining.gbHours=12;
  const received=settleBudget(b,{jobId:'real',state:'spent',
    actualUnits:{ocpuHours:1,gbHours:5}});
  assert.equal(received.state,'spent');
  assert.deepEqual(b.remaining,{ocpuHours:1,gbHours:7});
});

test('budget receipt expires and provider may not silently switch denomination',()=>{
  const b=newObservedBudget({provider:'circleci-free-private',scope:'org/a',
    sourceRef:'provider://circleci/another-one',hardStop:true,
    observedAt:'2026-10-15T04:50:00.000Z',
    expiresAt:'2026-10-15T05:00:00.000Z',remaining:{credits:200}});
  const query={provider:'circleci-free-private',scope:'org/a',
    now:'2026-10-15T04:55:00.000Z',units:{credits:75}};
  assert.equal(quoteBudget(b,query).ok,true);
  assert.equal(quoteBudget(b,{...query,now:'2026-10-15T05:00:00.000Z'}).ok,false);
  assert.equal(quoteBudget(b,{...query,units:{dollars:1}}).ok,false);
  assert.equal(quoteBudget(b,{...query,provider:'google-cloud'}).ok,false);
  holdBudget(b,{jobId:'one',...query});
  assert.throws(()=>holdBudget(b,{jobId:'one',...query}),/already/);
  assert.throws(()=>settleBudget(b,{jobId:'one',state:'spent',
    actualUnits:{credits:80}}),/exceeds/);
  settleBudget(b,{jobId:'one',state:'void'});
  assert.equal(budgetAvailable(b).credits,200);
});

test('hosted remaining minutes cannot be carried across a monthly reset without reobservation',()=>{
  const l=newLedger({plan:'free',month:'2026-10',usedMinutes:0,
    observedAt:'2026-10-31T23:45:00Z'});
  assert.equal(minutePrice(l,'2026-10-31T23:55:00Z',10)!==null,true);
  assert.equal(minutePrice(l,'2026-11-01T00:15:00Z',10),null);
});

test('fenced build comparison never publishes a lone or duplicate builder',()=>{
  const outputs={machine:'/gnu/store/aaa-machine',profile:'/gnu/store/bbb-profile'};
  assert.equal(publishable(compareBuilds([{nodeId:'a',outputs}])),false);
  assert.equal(compareBuilds([{nodeId:'a',outputs},{nodeId:'a',outputs}]).state,'unqualified');
  assert.equal(publishable(compareBuilds([{nodeId:'a',outputs},{nodeId:'a',outputs}])),false);
  assert.equal(publishable(compareBuilds([{nodeId:'a',outputs},{nodeId:'b',outputs}])),true);
  assert.equal(compareBuilds([{nodeId:'a',outputs:{}},{nodeId:'b',outputs}]).state,'unqualified');
  assert.equal(compareBuilds([{nodeId:'a',outputs:{x:'/tmp/not-a-store-path'}}]).state,'unqualified');
});

test('hosted minutes are held at maximum duration and provider overrun cannot settle',()=>{
  const now=NOW,host=nodes().find(n=>n.id==='github-hosted-ubuntu-24.04');
  const up={...host,state:'up',observedAt:now};
  const limited={...job(),minutes:5,maxMinutes:30};
  const available=ledger(1975);
  let result=place(limited,[up],{ledger:available,now});
  assert.equal(result.chosen,null);
  assert.ok(result.refused[0].why.includes('hosted-allowance-exhausted-or-stale'));
  result=place({...limited,maxMinutes:20},[up],{ledger:available,now});
  assert.equal(result.chosen,up.id);
  assert.equal(result.candidates[0].budgetHold.minutes,20);
  assert.equal(place({...limited,maxMinutes:undefined},[up],
    {ledger:available,now}).chosen,null);
  const l=ledger(0);
  assert.equal(hold(l,{jobId:'bounded',minutes:20}).ok,true);
  assert.throws(()=>settle(l,{jobId:'bounded',state:'spent'}),/observed-hosted-minutes/);
  assert.throws(()=>settle(l,{jobId:'bounded',state:'spent',billedMinutes:-1}),/observed-hosted-minutes/);
  assert.throws(()=>settle(l,{jobId:'bounded',state:'spent',billedMinutes:21}),/observed-hosted-minutes/);
  assert.equal(l.entries[0].state,'held');
  settle(l,{jobId:'bounded',state:'spent',billedMinutes:7});
  assert.equal(l.usedMinutes,7);
  assert.throws(()=>hold(l,{jobId:'bounded',minutes:2}),/already-holds-or-settled/);
  assert.throws(()=>hold(l,{jobId:' ',minutes:2}),/original job identity/);
});


test('fleet planning actually distributes concurrent work across held and free providers',()=>{
  const now='2026-10-15T04:50:00.000Z',scopeA='circleci/free/org',
    scopeB='oci/home/a1';
  const quotaA=newObservedBudget({provider:'circleci-free-private',scope:scopeA,
    hardStop:true,sourceRef:'provider://circleci/native-credit-balance',
    observedAt:now,expiresAt:'2026-10-15T05:50:00.000Z',
    remaining:{credits:120}});
  const quotaB=newObservedBudget({provider:'oci-always-free-a1',scope:scopeB,
    hardStop:true,sourceRef:'provider://oci/native-a1-usage',
    observedAt:now,expiresAt:'2026-10-15T05:50:00.000Z',
    remaining:{ocpuHours:2,gbHours:12}});
  const originalNodes=[
    {id:'owned-host',state:'up',observedAt:now,cores:1,memoryGb:2,freeDiskGb:3,
      capabilities:['node'],bandwidthMbps:100,closureCache:[],
      cost:{kind:'held'}},
    {id:'circleci',state:'up',observedAt:now,cores:1,memoryGb:2,freeDiskGb:3,
      capabilities:['node'],bandwidthMbps:100,closureCache:[],
      cost:{kind:'metered-free',provider:'circleci-free-private',scope:scopeA,
        maxJobMinutes:30,hardStop:true,unitsPerMinute:{credits:5}}},
    {id:'oci',state:'up',observedAt:now,cores:2,memoryGb:12,freeDiskGb:10,
      capabilities:['node'],bandwidthMbps:100,closureCache:[],
      cost:{kind:'metered-free',provider:'oci-always-free-a1',scope:scopeB,
        maxJobMinutes:60,hardStop:true,
        unitsPerMinute:{ocpuHours:2/60,gbHours:12/60}}}
  ];
  const originalBudgets={[scopeA]:quotaA,[scopeB]:quotaB};
  const task=(id,cores,memoryGb,provider,scope)=>({
    id,minutes:5,maxMinutes:20,visibility:'private',effect:false,
    closure:[],needs:{cores,memoryGb,freeDiskGb:1},
    requires:{capabilities:['node']},
    sourceEgress:provider?{permitted:true,provider,scope,
      authorityRef:'office:source-owner/external-compute-grant'}:undefined
  });
  const jobs=[
    task('first',1,2),
    task('second',1,2,'circleci-free-private',scopeA),
    task('third',2,8,'oci-always-free-a1',scopeB),
    task('fourth',1,2,'circleci-free-private',scopeA)
  ];
  const beforeNodes=structuredClone(originalNodes),
    beforeBudgets=structuredClone(originalBudgets);
  const result=planFleet(jobs,originalNodes,{now,budgets:originalBudgets});
  assert.deepEqual(result.placements.map(p=>[p.jobId,p.nodeId]),
    [['first','owned-host'],['second','circleci'],['third','oci']]);
  assert.equal(result.unplaced,1);
  assert.equal(result.pending[0].jobId,'fourth');
  assert.equal(result.proposed,3);
  assert.equal(result.executed,0);
  assert.equal(result.providerBudgetHeld,false);
  assert.equal(result.leaseReceived,false);
  assert.equal(result.placements[1].budgetHold.units.credits,100);
  assert.equal(result.placements[2].budgetHold.units.ocpuHours>0,true);
  assert.deepEqual(originalNodes,beforeNodes);
  assert.deepEqual(originalBudgets,beforeBudgets);
  // Deterministic outcomes for the same observed inputs.
  assert.deepEqual(planFleet(jobs,originalNodes,{now,budgets:originalBudgets}),result);
});

test('fleet does not dispatch effects, unknown nodes, missing quota or duplicate jobs',()=>{
  const now='2026-10-15T04:50:00.000Z';
  const n={id:'original-host',state:'up',observedAt:now,
    cores:2,memoryGb:4,freeDiskGb:8,bandwidthMbps:100,
    capabilities:['node'],closureCache:[],cost:{kind:'held'}};
  const j={id:'x',minutes:1,maxMinutes:5,closure:[],
    needs:{cores:1,memoryGb:2,freeDiskGb:1},effect:false};
  assert.throws(()=>planFleet([j,{...j}],[n],{now}),/unique original job/);
  const batch=planFleet([{...j,effect:true}, {...j,id:'unknown',maxMinutes:undefined}],
    [n],{now});
  assert.equal(batch.placements.length,0);
  assert.deepEqual(batch.pending.map(x=>x.reason),
    ['effect-authority-not-received','original-job-closure-or-maximum-runtime-unmeasured']);
  const unmeasured=planFleet([j],[{...n,cores:null}],{now});
  assert.equal(unmeasured.placements.length,0);
  assert.equal(unmeasured.probes.length,1);
  assert.equal(planFleet([j],[{...n,observedAt:'2026-10-14T00:00:00.000Z'}],
    {now}).proposed,0);
});




test('provider placement prices net-available free credits after original reservations',()=>{
  const now='2026-10-15T04:50:00.000Z';
  const provider='circleci-free-public';
  const mkBudget=(scope,credits)=>newObservedBudget({provider,scope,
    hardStop:true,sourceRef:'provider://circleci/account-credit-readback',
    observedAt:now,expiresAt:'2026-10-15T05:50:00.000Z',
    remaining:{credits}});
  const a=mkBudget('org/cloud-a',100),b=mkBudget('org/cloud-b',50);
  assert.equal(holdBudget(a,{jobId:'previous-office-job',provider,
    scope:a.scope,now,units:{credits:85}}).ok,true);
  assert.equal(budgetAvailable(a).credits,15);
  assert.equal(budgetAvailable(b).credits,50);
  const node=(id,scope)=>({id,state:'up',observedAt:now,
    cores:1,memoryGb:2,freeDiskGb:4,bandwidthMbps:100,
    capabilities:['node','git'],closureCache:[],
    cost:{kind:'metered-free',provider,scope,hardStop:true,
      maxJobMinutes:30,unitsPerMinute:{credits:1}}});
  const nodes=[node('nearly-held','org/cloud-a'),node('available','org/cloud-b')];
  const job={id:'current-public-source',visibility:'public',effect:false,
    minutes:5,maxMinutes:10,closure:[],
    needs:{cores:1,memoryGb:1,freeDiskGb:1},
    requires:{capabilities:['node']}};
  const budgets={[a.scope]:a,[b.scope]:b};
  const original=structuredClone(budgets);
  const selection=place(job,nodes,{now,budgets});
  assert.equal(selection.chosen,'available');
  assert.equal(selection.candidates[0].nodeId,'available');
  assert.ok(selection.candidates[0].scarcityPerMinute <
    selection.candidates[1].scarcityPerMinute);
  const fleet=planFleet([job,{...job,id:'second-public-source'}],nodes,{now,budgets});
  assert.deepEqual(fleet.placements.map(p=>p.nodeId),['available','nearly-held']);
  assert.equal(fleet.executed,0);
  assert.equal(fleet.providerBudgetHeld,false);
  assert.deepEqual(budgets,original);
  // An unobserved balance is not a cheaper alternative.
  assert.equal(place(job,nodes,{now,budgets:{[a.scope]:a}}).chosen,'nearly-held');
});

test('typed effectful office jobs never acquire pure fleet placements on owned or cloud capacity',()=>{
  const now='2026-10-15T04:50:00.000Z';
  const held={id:'owned',state:'up',observedAt:now,cores:8,memoryGb:16,
    freeDiskGb:20,bandwidthMbps:100,capabilities:['node','guix'],
    closureCache:[],cost:{kind:'held'}};
  const scope='oci/home/actual-authority-required';
  const cloud={...held,id:'oci-a1',cost:{kind:'metered-free',
    provider:'oci-always-free-a1',scope,hardStop:true,
    maxJobMinutes:30,unitsPerMinute:{ocpuHours:1/60,gbHours:2/60}}};
  const budget=newObservedBudget({provider:cloud.cost.provider,scope,
    sourceRef:'provider://oci/fixture-not-installed',
    hardStop:true,observedAt:now,expiresAt:'2026-10-15T05:50:00.000Z',
    remaining:{ocpuHours:1,gbHours:3}});
  const original={id:'office-work',effect:false,visibility:'private',
    minutes:3,maxMinutes:12,closure:[],
    needs:{cores:1,memoryGb:2,freeDiskGb:1},
    requires:{capabilities:['node']},
    sourceEgress:{permitted:true,provider:cloud.cost.provider,scope,
      authorityRef:'office:engineering/fixture-cloud-egress'}};
  const effects=[true,'deploy-cloud-run',{kind:'provider-write',operation:'deploy'},
    ['ledger','settle'],1,'false'];
  const jobs=effects.map((effect,i)=>({...original,id:'effect-'+i,effect}));
  for(const node of [held,cloud]){
    const options={now,budgets:{[scope]:budget}};
    const before=structuredClone(budget);
    const result=planFleet(jobs,[node],options);
    assert.equal(result.proposed,0);
    assert.equal(result.executed,0);
    assert.equal(result.pending.length,effects.length);
    assert.deepEqual(result.pending.map(x=>x.reason),
      effects.map(()=> 'effect-authority-not-received'));
    assert.equal(result.placements.length,0);
    assert.equal(result.probes.length,0);
    assert.deepEqual(budget,before);
    for(const job of jobs){
      assert.equal(place(job,[node],options).needsLeaderWords,true);
    }
    const pure=planFleet([original],[node],options);
    assert.equal(pure.proposed,1);
    assert.equal(pure.placements[0].state,'proposed-not-executed');
    assert.equal(place(original,[node],options).needsLeaderWords,false);
  }
});

test('the existing placement CLI reads a complete original office shift without provider effects',async()=>{
  const {spawnSync}=await import('node:child_process');
  const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
  const {join}=await import('node:path');
  const {tmpdir}=await import('node:os');
  const root=mkdtempSync(join(tmpdir(),'placement-real-entry-'));
  try{
    const dir=join(root,'nodes');mkdirSync(dir);
    const n={id:'held-verified',state:'up',observedAt:NOW,cores:2,
      memoryGb:4,freeDiskGb:8,bandwidthMbps:100,
      closureCache:[],capabilities:['node'],cost:{kind:'held'}};
    writeFileSync(join(dir,'observed-node.json'),JSON.stringify(n));
    const job={id:'one',effect:false,minutes:5,maxMinutes:10,
      closure:[],needs:{cores:1,memoryGb:2,freeDiskGb:1},
      requires:{capabilities:['node']}};
    const jobs=join(root,'jobs.json'),single=join(root,'job.json');
    writeFileSync(jobs,JSON.stringify([job,{...job,id:'two'},{...job,id:'three'}]));
    writeFileSync(single,JSON.stringify(job));
    const script=new URL('../scripts/place-job.mjs',import.meta.url).pathname;
    const run=(...args)=>spawnSync(process.execPath,[script,...args],{
      encoding:'utf8',timeout:10000});
    const batch=run('--jobs',jobs,'--nodes',dir,'--now',NOW);
    assert.equal(batch.status,0,batch.stderr);
    const result=JSON.parse(batch.stdout);
    assert.equal(result.kind,'original-fleet-placement-proposal');
    assert.deepEqual(result.placements.map(x=>x.jobId),['one','two']);
    assert.equal(result.pending[0].jobId,'three');
    assert.equal(result.executed,0);
    assert.equal(result.providerBudgetHeld,false);
    const original=run('--job',single,'--nodes',dir,'--now',NOW);
    assert.equal(original.status,0,original.stderr);
    assert.equal(JSON.parse(original.stdout).chosen,'held-verified');
    for(const flags of [
      ['--jobs',jobs,'--job',single,'--nodes',dir],
      ['--jobs',jobs,'--nodes',dir,'--unknown','x'],
      ['--jobs',jobs,'--nodes',dir,'--used','0']
    ])assert.notEqual(run(...flags).status,0);
  }finally{rmSync(root,{recursive:true,force:true});}
});


test('no fractional credit reservation can be offered when real observed Free balance is exactly zero',()=>{
  const at='2026-10-23T22:01:00.000Z';
  const provider='circleci-free-private',scope='red-cup/free-verified-ci';
  const b=newObservedBudget({provider,scope,hardStop:true,
    sourceRef:'provider://circleci/observed-zero-native-budget',
    observedAt:'2026-10-23T22:00:00.000Z',expiresAt:'2026-10-23T23:00:00.000Z',
    remaining:{credits:0}});
  const claim={provider,scope,now:at,units:{credits:0.0000000005}};
  assert.deepEqual(quoteBudget(b,claim),{ok:false,
    reason:'would-overdraw-the-observed-free-allowance:credits'});
  assert.deepEqual(holdBudget(b,{jobId:'first',...claim}),{ok:false,
    reason:'would-overdraw-the-observed-free-allowance:credits'});
  assert.deepEqual(b.entries,[],'a source-only quote cannot create a phantom provider hold');
  assert.equal(budgetAvailable(b).credits,0);
  assert.deepEqual(quoteBudget(b,{...claim,units:{credits:0}}),{ok:false,
    reason:'provider-usage-has-no-positive-reservation'});
});

test('decimal fractions conserve exactly across multiple independent held jobs',()=>{
  const at='2026-10-23T22:01:00.000Z';
  const b=newObservedBudget({provider:'oci-always-free-a1',scope:'oci/free-decimal',
    hardStop:true,sourceRef:'provider://oci/exact-decimal-source',
    observedAt:'2026-10-23T22:00:00.000Z',expiresAt:'2026-10-23T23:00:00.000Z',
    remaining:{ocpuHours:0.3,gbHours:0.6}});
  const grant=(jobId,units)=>holdBudget(b,{jobId,provider:b.provider,scope:b.scope,now:at,units});
  assert.equal(grant('quarter',{ocpuHours:0.1,gbHours:0.2}).ok,true);
  assert.equal(grant('remainder',{ocpuHours:0.2,gbHours:0.4}).ok,true);
  assert.deepEqual(budgetAvailable(b),{ocpuHours:0,gbHours:0});
  assert.equal(grant('extra',{ocpuHours:1e-12}).ok,false);
  assert.equal(b.entries.length,2);
  const charged=settleBudget(b,{jobId:'quarter',state:'spent',
    actualUnits:{ocpuHours:0.1,gbHours:0.2}});
  assert.equal(charged.state,'spent');
  assert.deepEqual(b.remaining,{ocpuHours:0.2,gbHours:0.4},
    'source decimal 0.3-0.1 and 0.6-0.2 remain exact observed balance, not binary drift');
  assert.deepEqual(budgetAvailable(b),{ocpuHours:0,gbHours:0});
  settleBudget(b,{jobId:'remainder',state:'spent',
    actualUnits:{ocpuHours:0.2,gbHours:0.4}});
  assert.deepEqual(b.remaining,{ocpuHours:0,gbHours:0});
});

test('source balance shrink below held work is a refusal, never silently clamped to available zero',()=>{
  const at='2026-10-23T22:01:00.000Z';
  const b=newObservedBudget({provider:'circleci-free-private',scope:'red-cup/free-ci',
    hardStop:true,sourceRef:'provider://circleci/native-changed-quota',
    observedAt:'2026-10-23T22:00:00.000Z',expiresAt:'2026-10-23T23:00:00.000Z',
    remaining:{credits:1,minutes:100}});
  const call=units=>({provider:b.provider,scope:b.scope,now:at,units});
  assert.equal(holdBudget(b,{jobId:'first',...call({credits:0.8})}).ok,true);
  b.remaining.credits=0.7; // provider's independently observed remaining fell
  const prior=structuredClone(b);
  assert.deepEqual(quoteBudget(b,call({minutes:1})),{ok:false,
    reason:'provider-held-budget-exceeds-observed-balance:credits'},
    'one denomination in conflict blocks all new Work, not just the same unit');
  assert.deepEqual(holdBudget(b,{jobId:'second',...call({minutes:1})}),{ok:false,
    reason:'provider-held-budget-exceeds-observed-balance:credits'});
  assert.throws(()=>budgetAvailable(b),/provider-held-budget-exceeds-observed-balance/);
  assert.deepEqual(b,prior,'a capacity shortfall cannot create a second job hold');
});

test('provider remaining and live-hold nonfinite source data fail closed without a guessed zero',()=>{
  const at='2026-10-23T22:01:00.000Z';
  const b=newObservedBudget({provider:'oci-always-free-a1',scope:'oci/source-clock',
    hardStop:true,sourceRef:'provider://oci/valid-original-observation',
    observedAt:'2026-10-23T22:00:00.000Z',expiresAt:'2026-10-23T23:00:00.000Z',
    remaining:{credits:3}});
  const c={provider:b.provider,scope:b.scope,now:at,units:{credits:1}};
  assert.equal(holdBudget(b,{jobId:'genuine',...c}).ok,true);
  b.remaining.credits=NaN;
  assert.equal(quoteBudget(b,c).reason,'provider-budget-observation-malformed');
  assert.throws(()=>budgetAvailable(b),/provider-budget-observation-malformed/);
  b.remaining.credits=3;
  b.entries[0].units.credits=Infinity;
  assert.equal(quoteBudget(b,c).reason,'provider-budget-observation-malformed');
  assert.throws(()=>budgetAvailable(b),/provider-budget-observation-malformed/);
  b.entries[0].units={unobservedUnit:1};
  assert.equal(quoteBudget(b,c).reason,'provider-held-budget-unit-unobserved:unobservedUnit');
});

test('provider settlement may not exceed even a fractional original free hold and stays atomic',()=>{
  const b=newObservedBudget({provider:'circleci-free-private',scope:'red-cup/cashless-ci',
    hardStop:true,sourceRef:'provider://circleci/verified-observation',
    observedAt:'2026-10-23T22:00:00.000Z',expiresAt:'2026-10-23T23:00:00.000Z',
    remaining:{credits:10,gbHours:20}});
  const now='2026-10-23T22:01:00.000Z';
  assert.equal(holdBudget(b,{jobId:'one',provider:b.provider,scope:b.scope,now,
    units:{credits:0.1,gbHours:0.2}}).ok,true);
  const original=structuredClone(b);
  assert.throws(()=>settleBudget(b,{jobId:'one',state:'spent',
    actualUnits:{credits:0.1000000005,gbHours:0.2}}),/billed usage exceeds held free units/);
  assert.deepEqual(b,original,'failed independent free-budget settlement is strictly no-effect');
  assert.throws(()=>settleBudget(b,{jobId:'one',state:'spent',
    actualUnits:{credits:0.1,gbHours:0.2000000005}}),/billed usage exceeds held free units/);
  assert.deepEqual(b,original);
  settleBudget(b,{jobId:'one',state:'spent',actualUnits:{credits:0.1,gbHours:0.2}});
  assert.deepEqual(b.remaining,{credits:9.9,gbHours:19.8});
});
