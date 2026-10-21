import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {reconcileRetiredIntakeFleet,RETIRED_BRANCH_INTAKE_PATH} from '../generator/open-pr.mjs';

const ORG='red-cup-engineering';
const OLD = "name: Agent work\non:\n  push:\n    branches: ['**']\n  pull_request_target:\n    types: [opened, reopened, synchronize, closed]\npermissions:\n  contents: read\n  issues: write\n  pull-requests: write\nconcurrency:\n  group: agent-work-\${{ github.event.pull_request.head.ref || github.ref_name }}\n  cancel-in-progress: false\njobs:\n  receive:\n    if: github.event_name != 'push' || (github.ref_name != github.event.repository.default_branch && !github.event.deleted)\n    uses: red-cup-engineering/continuous-delivery-services-section/.github/workflows/agent-work.yml@9941b91847d4c5e7947fb044faeb4e77476dc17d\n";
const oid = text=>{const bytes=Buffer.from(text);return createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex');};
assert.equal(oid(OLD),'ee077700dcdde1e71be3da2f8982c2ceae15b21e');
const file=(text=OLD)=>({type:'file',path:RETIRED_BRANCH_INTAKE_PATH,encoding:'base64',sha:oid(text),content:Buffer.from(text).toString('base64')});
function fixture({count=2,foreign=false,blockedRead=-1,deniedWrite=-1,staleRef=-1,archived=-1}={}) {
  const owners=Array.from({length:count},(_,i)=>({id:i+111,name:'repo-'+i,
    full_name:ORG+'/repo-'+i,owner:{login:ORG},default_branch:'main',
    archived:i===archived,disabled:false,fork:false}));
  const source=new Map(owners.map((o,i)=>[o.full_name,file(i===1&&foreign?'name: custom workflow\n':OLD)]));
  const writes=[],queries=[],preflights=new Map();
  const request=async(method,path,body)=>{
    queries.push([method,path]);
    if(method==='GET'&&path.startsWith('/orgs/'+ORG+'/repos?')) {
      const page=Number(new URLSearchParams(path.split('?')[1]).get('page'));
      return owners.slice((page-1)*100,page*100);
    }
    const match=/^\/repos\/([^/]+\/[^/]+)\/(.*)$/u.exec(path);
    if(!match)throw Error('unexpected remote operation');
    const [,repository,resource]=match;
    const index=Number(repository.split('repo-')[1]);
    if(method==='GET'&&resource.startsWith('contents/')) {
      if(index===blockedRead)throw Error('permission denied');
      return source.get(repository)??null;
    }
    if(method==='GET'&&resource.startsWith('git/ref/heads/')) {
      const calls=preflights.get(repository)??0;preflights.set(repository,calls+1);
      return {ref:'refs/heads/main',object:{sha:index===staleRef&&calls>0?'b'.repeat(40):'a'.repeat(40)}};
    }
    if(method==='DELETE'&&resource===('contents/'+RETIRED_BRANCH_INTAKE_PATH)) {
      writes.push({repository,body});
      if(index===deniedWrite)throw Error('write refused');
      if(source.get(repository)?.sha!==body.sha)throw Error('content changed');
      source.delete(repository);
      return {content:null,commit:{sha:'e'.repeat(40)}};
    }
    throw Error('unknown GitHub source request');
  };
  return {request,writes,queries,source};
}

test('read-only inventory qualifies real Git blob, not repository name or a substring',async()=>{
  const f=fixture({count:3,foreign:true});
  const result=await reconcileRetiredIntakeFleet({organizations:[ORG]},{request:f.request});
  assert.deepEqual({mode:result.mode,repos:result.repositories,eligible:result.eligible,unrecognized:result.unrecognized},
    {mode:'plan',repos:3,eligible:2,unrecognized:1});
  assert.equal(f.writes.length,0);
  assert.ok(f.source.has(ORG+'/repo-0'));
});

test('one fleet invocation changes all verified owners and independently checks absence',async()=>{
  const f=fixture({count:3,foreign:true});
  const result=await reconcileRetiredIntakeFleet({organizations:[ORG],apply:true},{request:f.request});
  assert.deepEqual({removed:result.removed,unrecognized:result.unrecognized,refused:result.refused},
    {removed:2,unrecognized:1,refused:0});
  assert.equal(f.writes.length,2);
  for(const operation of f.writes) {
    assert.equal(operation.body.sha,oid(OLD));
    assert.equal(operation.body.branch,'main');
    assert.equal(f.source.has(operation.repository),false);
  }
  assert.equal(f.source.has(ORG+'/repo-1'),true);
  assert.equal(Object.values(result).some(value=>typeof value==='string'&&value.includes('repo-')),false);
});

test('individual refusal is not retried and cannot be claimed successful',async()=>{
  const f=fixture({count:3,deniedWrite:1});
  const result=await reconcileRetiredIntakeFleet({organizations:[ORG],apply:true},{request:f.request});
  assert.equal(result.removed,2);
  assert.equal(result.refused,1);
  assert.equal(f.writes.filter(x=>x.repository===ORG+'/repo-1').length,1);
  assert.equal(f.source.has(ORG+'/repo-1'),true);
});

test('unread inventory refuses all writes before any mutation',async()=>{
  const f=fixture({count:3,blockedRead:1});
  await assert.rejects(reconcileRetiredIntakeFleet({organizations:[ORG],apply:true},{request:f.request}),/preflight incomplete/);
  assert.equal(f.writes.length,0);
});

test('stale default branch and archived source refuse effects',async()=>{
  const f=fixture({count:3,staleRef:1,archived:2});
  const result=await reconcileRetiredIntakeFleet({organizations:[ORG],apply:true},{request:f.request});
  assert.equal(result.repositories,2);
  assert.equal(result.eligible,2);
  assert.equal(result.removed,1);
  assert.equal(result.refused,1);
  assert.equal(f.writes.length,1);
});

test('pagination is complete, not just the first page of a large organization',async()=>{
  const f=fixture({count:101});
  const result=await reconcileRetiredIntakeFleet({organizations:[ORG]},{request:f.request});
  assert.equal(result.repositories,101);
  assert.equal(result.eligible,101);
  assert.ok(f.queries.some(([,path])=>path.includes('page=2')));
  assert.equal(f.writes.length,0);
});

test('bounded organization, immutable source and effect budget prevent blind fleet writes',async()=>{
  const f=fixture();
  for(const organizations of [[],['unrelated-owner'],[ORG,ORG],null])
    await assert.rejects(reconcileRetiredIntakeFleet({organizations},{request:f.request}));
  await assert.rejects(reconcileRetiredIntakeFleet({organizations:[ORG],apply:true,maxChanges:1},{request:f.request}),/authorized batch bound/);
  assert.equal(f.writes.length,0);
});

test('a census past 500 repositories stays complete up to the 1000-repository bound',async()=>{
  const f=fixture({count:868});
  // Most repositories never carried the intake; only the first 300 do.
  const request=async(method,path,body)=>method==='GET'&&/\/repo-([3-9][0-9]{2})\/contents\//u.test(path)?null:f.request(method,path,body);
  const result=await reconcileRetiredIntakeFleet({organizations:[ORG]},{request});
  assert.deepEqual({repositories:result.repositories,eligible:result.eligible,absent:result.absent},{repositories:868,eligible:300,absent:568});
  assert.ok(f.queries.some(([,path])=>path.includes('page=9')));
  await assert.rejects(reconcileRetiredIntakeFleet({organizations:[ORG]},{request:fixture({count:1001}).request}),/1000-repository bound/);
  assert.equal(f.writes.length,0);
});

test('all five house organizations are admitted together, and no others',async()=>{
  const f=fixture({count:1});
  const all=['561-group','red-cup-engineering','lenticule-science','coesite-operations','causeway-services'];
  const request=async(method,path,body)=>/^GET \/orgs\/(?!red-cup-engineering\/)[^/]+\/repos\?/u.test(method+' '+path)?[]:f.request(method,path,body);
  const result=await reconcileRetiredIntakeFleet({organizations:all},{request});
  assert.equal(result.repositories,1);
  await assert.rejects(reconcileRetiredIntakeFleet({organizations:[...all,'emsenn']},{request}));
});
