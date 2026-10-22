// One physical capacity can serve several logically distinct CI/release runners.
// Admit capacity only from the original trusted host reader. The node advertises
// an ID, never an independently spendable copy of host cores/RAM/disk.
// Pure proposal only: durable reservations still belong to the original executor.

const ID=/^[a-z0-9][a-z0-9-]{0,79}$/u;
const dims=['cores','memoryGb','freeDiskGb'];
const REF=v=>typeof v==='string'&&v.length>=8&&v.length<=1024&&!/[\s\0]/u.test(v);
const validSize=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;

export function observeSharedCapacity(nodes,{now,readSharedCapacity}={}){
  const pools=new Map(),refused=new Map(),members=new Map();
  for(const node of nodes){
    if(node.sharedCapacityPool===undefined)continue;
    const id=node.sharedCapacityPool;
    if(typeof id!=='string'||!ID.test(id)){
      refused.set(id,'invalid-shared-capacity-pool-identity');continue;
    }
    if(!members.has(id))members.set(id,[]);
    members.get(id).push(node.id);
  }
  const observed=Date.parse(now);
  for(const [id,ids] of members){
    if(typeof readSharedCapacity!=='function'){
      refused.set(id,'trusted-shared-capacity-reader-required');continue;
    }
    let record;
    try{record=readSharedCapacity({poolId:id,now});}
    catch{refused.set(id,'shared-capacity-source-unavailable');continue;}
    if(record?.kind!=='observed-physical-compute-pool.v1'||record.id!==id||
      record.state!=='up'||!REF(record.witnessRef)||
      !Array.isArray(record.nodeIds)||!ids.every(n=>record.nodeIds.includes(n))||
      record.nodeIds.some(n=>typeof n!=='string'||!n)){
      refused.set(id,'shared-capacity-custody-unverified');continue;
    }
    const when=Date.parse(record.observedAt);
    if(!Number.isFinite(observed)||!Number.isFinite(when)||when>observed||
      observed-when>120_000){
      refused.set(id,'shared-capacity-observation-stale');continue;
    }
    if(!dims.every(k=>validSize(record[k]))){
      refused.set(id,'shared-capacity-dimensions-unmeasured');continue;
    }
    pools.set(id,Object.freeze(Object.fromEntries([
      ['id',id],['observedAt',record.observedAt],
      ['witnessRef',record.witnessRef],...dims.map(k=>[k,record[k]])
    ])));
  }
  return {pools,refused};
}

/** Count a job against its own node AND its shared physical capacity. */
export function sharedPoolFit(node,reading){
  const id=node?.sharedCapacityPool;
  if(id===undefined)return {reason:null,capacity:null};
  if(typeof id!=='string'||!ID.test(id))
    return {reason:'invalid-shared-capacity-pool-identity',capacity:null};
  const reason=reading?.refused?.get(id);
  if(reason)return {reason,capacity:null};
  const capacity=reading?.pools?.get(id);
  return capacity?{reason:null,capacity}:{reason:'shared-capacity-source-unavailable',capacity:null};
}
