import test from 'node:test';
import assert from 'node:assert/strict';
import {observeSharedCapacity} from '../src/placement/shared-capacity.mjs';
import {assess,place,planFleet} from '../src/placement/place.mjs';

const NOW='2026-10-21T23:10:00Z';
const makeNode=(id,pool,extra={})=>({
  id,state:'up',observedAt:NOW,
  sharedCapacityPool:pool,publicOnly:true,
  cores:4,memoryGb:16,freeDiskGb:40,bandwidthMbps:100,
  capabilities:['node'],closureCache:[],
  cost:{kind:'held'},...extra
});
const workload=(id,needs={cores:1,memoryGb:2,freeDiskGb:3})=>({
  id,effect:false,visibility:'public',minutes:5,maxMinutes:10,
  closure:[],needs,requires:{capabilities:['node']}
});
const shared=(poolId,now)=>({
  kind:'observed-physical-compute-pool.v1',id:poolId,
  state:'up',witnessRef:'original-host-capacity-observation-20261021',
  nodeIds:poolId==='other-host'?['third']:['ci-a','ci-b'],
  observedAt:NOW,cores:2,memoryGb:4,freeDiskGb:6
});
const readSharedCapacity=({poolId,now})=>shared(poolId,now);

test('shared real capacity is admitted once, only from the original trusted host observer',()=>{
  const nodes=[makeNode('ci-a','one-host'),makeNode('ci-b','one-host')];
  assert.equal(observeSharedCapacity(nodes,{now:NOW}).refused.get('one-host'),
    'trusted-shared-capacity-reader-required');
  let n=0;
  const r=observeSharedCapacity(nodes,{now:NOW,readSharedCapacity:(arg)=>{n++;return readSharedCapacity(arg);}});
  assert.equal(n,1);
  assert.deepEqual([r.pools.get('one-host').cores,r.pools.get('one-host').memoryGb,
    r.pools.get('one-host').freeDiskGb],[2,4,6]);
  assert.equal(r.pools.get('one-host').witnessRef,'original-host-capacity-observation-20261021');
});

test('two CI runner aliases cannot claim four cores on a physical two-core host',()=>{
  const nodes=[makeNode('ci-a','one-host'),makeNode('ci-b','one-host')];
  const jobs=[workload('a'),workload('b'),workload('c')];
  const plan=planFleet(jobs,nodes,{now:NOW,readSharedCapacity});
  assert.equal(plan.kind,'original-fleet-placement-proposal');
  assert.equal(plan.proposed,2);
  assert.equal(plan.unplaced,1);
  assert.equal(plan.executed,0);
  assert.equal(plan.leaseReceived,false);
  assert.equal(plan.providerBudgetHeld,false);
  assert.deepEqual(plan.placements.map(p=>p.resourceHold.cores),[1,1]);
  assert.deepEqual(plan.residualSharedCapacity.map(p=>[p.id,p.cores,p.memoryGb,p.freeDiskGb]),
    [['one-host',0,0,0]]);
  // Source observations and user-provided original data are never mutated.
  assert.equal(nodes[0].cores,4);
  assert.equal(nodes[1].memoryGb,16);
});

test('shared RAM and disk, not only CPU, restrict original placement',()=>{
  const nodes=[makeNode('ci-a','one-host'),makeNode('ci-b','one-host')];
  const jobs=[workload('first',{cores:1,memoryGb:3,freeDiskGb:5}),
    workload('second',{cores:1,memoryGb:2,freeDiskGb:2})];
  const plan=planFleet(jobs,nodes,{now:NOW,readSharedCapacity});
  assert.equal(plan.proposed,1);
  assert.equal(plan.unplaced,1);
  assert.equal(plan.residualSharedCapacity[0].cores,1);
  assert.equal(plan.residualSharedCapacity[0].memoryGb,1);
  assert.equal(plan.residualSharedCapacity[0].freeDiskGb,1);
});

test('a second independently witnessed physical host adds genuine fleet capacity',()=>{
  const nodes=[makeNode('ci-a','one-host'),makeNode('ci-b','one-host'),makeNode('third','other-host')];
  const result=planFleet([workload('one'),workload('two'),workload('three')],
    nodes,{now:NOW,readSharedCapacity});
  assert.equal(result.proposed,3);
  assert.equal(result.unplaced,0);
  assert.deepEqual(result.residualSharedCapacity.map(p=>[p.id,p.cores]),
    [['one-host',0],['other-host',1]]);
});

test('unknown, stale and conflicting physical custody refuse placement',()=>{
  const node=makeNode('ci-a','one-host'),j=workload('j');
  assert.equal(place(j,[node],{now:NOW}).chosen,null);
  assert.ok(place(j,[node],{now:NOW}).refused[0].why.includes('trusted-shared-capacity-reader-required'));
  for(const [change,reason] of [
    [p=>{p.observedAt='2026-10-21T23:00:00Z';},'shared-capacity-observation-stale'],
    [p=>{p.nodeIds=['ci-b'];},'shared-capacity-custody-unverified'],
    [p=>{p.id='different-host';},'shared-capacity-custody-unverified'],
    [p=>{p.witnessRef='x';},'shared-capacity-custody-unverified'],
    [p=>{p.memoryGb=Infinity;},'shared-capacity-dimensions-unmeasured'],
    [p=>{p.state='unverified';},'shared-capacity-custody-unverified']
  ]){
    const read=({poolId,now})=>{const p=shared(poolId,now);change(p);return p;};
    const verdict=place(j,[node],{now:NOW,readSharedCapacity:read});
    assert.equal(verdict.chosen,null);
    assert.ok(verdict.refused[0].why.includes(reason));
  }
});

test('single original job is evaluated against physical host even when the alias reports more',()=>{
  const node=makeNode('ci-a','one-host');
  const over=assess(workload('over',{cores:3,memoryGb:1,freeDiskGb:1}),node,
    {now:NOW,readSharedCapacity});
  assert.equal(over.feasible,false);
  assert.ok(over.why.includes('too-small:cores'));
  const fitting=place(workload('small'),[node],{now:NOW,readSharedCapacity});
  assert.equal(fitting.chosen,'ci-a');
});

test('a denied pool never blocks a different independently admitted physical pool',()=>{
  const nodes=[makeNode('ci-a','one-host'),makeNode('third','other-host')];
  const plan=planFleet([workload('a'),workload('b')],nodes,
    {now:NOW,readSharedCapacity:({poolId,now})=>{
      if(poolId==='one-host')throw Error('unavailable');
      return shared(poolId,now);
    }});
  assert.equal(plan.proposed,2);
  assert.ok(plan.placements.every(p=>p.nodeId==='third'));
});
