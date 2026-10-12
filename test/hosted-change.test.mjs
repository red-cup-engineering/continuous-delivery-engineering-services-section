import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runtimeBinding,containerCommand,runHosted,checkControllerConfig,admitSourceController} from '../scripts/hosted-change.mjs';
const commit='a'.repeat(40),digest='b'.repeat(64);
function fixture(t){const root=mkdtempSync(join(tmpdir(),'hosted-boundary-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const paths=Object.fromEntries(['controller','carriers','output','helper'].map(name=>[name,join(root,name)]));for(const path of Object.values(paths))mkdirSync(path);return {root,...paths};}
const binding=()=>({kind:'guix.hosted-runtime.v1',controllerCommit:commit,sourceContract:'guix.change-source-carriers.v1',image:'ghcr.io/red-cup-engineering/fixture@sha256:'+digest,qualificationSha256:digest,uid:1001,gid:1001});
function record(helper,value){mkdirSync(join(helper,'runtime-bindings'),{recursive:true});writeFileSync(join(helper,'runtime-bindings',commit+'.json'),JSON.stringify(value));}
test('missing runtime admission refuses before any process or container execution',t=>{const paths=fixture(t);assert.throws(()=>runHosted({...paths,commit,digest,execute:()=>assert.fail('unadmitted execution')}),/runtime not admitted/);});
test('runtime admission rejects mutable, foreign, unqualified, root or mismatched images',t=>{const {helper}=fixture(t);for(const change of [{image:'ghcr.io/red-cup-engineering/fixture:main'},{image:'ghcr.io/outsider/fixture@sha256:'+digest},{qualificationSha256:''},{uid:0},{gid:0},{controllerCommit:'c'.repeat(40)},{sourceContract:'manifest-only'}]){record(helper,{...binding(),...change});assert.throws(()=>runtimeBinding(helper,commit),/admission/);}record(helper,binding());assert.deepEqual(runtimeBinding(helper,commit),binding());});
test('hosted command has bounded non-root isolation with only three read-only inputs and fresh output',t=>{const paths=fixture(t),args=containerCommand({...paths,commit,digest,binding:binding()});for(const value of ['--network=none','--read-only','--pull=never','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=256','--memory=4g','--memory-swap=4g','--cpus=2','1001:1001'])assert.ok(args.includes(value),value);assert.equal(args.filter(value=>value.startsWith('type=bind')).length,4);assert.equal(args.filter(value=>value.startsWith('type=bind')&&value.endsWith(',readonly')).length,3);assert.doesNotMatch(args.join(' '),/docker.sock|--privileged|--env-file|HOUSE_READ_TOKEN|GITHUB_TOKEN/);assert.equal(args.at(-1),digest);});
test('overlapping mount custody and unretained identities refuse',t=>{const paths=fixture(t);assert.throws(()=>containerCommand({...paths,helper:paths.controller,commit,digest,binding:binding()}),/separate custody/);assert.throws(()=>containerCommand({...paths,commit:'main',digest,binding:binding()}),/identities/);assert.throws(()=>containerCommand({...paths,commit,digest:'',binding:binding()}),/identities/);});

test('read-only controller mounts cannot carry local authentication helpers or rewritten origins',()=>{
  checkControllerConfig('core.bare\nfalse\0remote.origin.url\nhttps://github.com/red-cup-engineering/guix-machine-release-service.git\0');
  for(const text of ['http.extraheader\nAuthorization: secret\0','credential.helper\nstore\0','remote.origin.url\nhttps://token@github.com/o/r\0','include.path\n/tmp/private\0','core.hooksPath\n/tmp/hooks\0'])assert.throws(()=>checkControllerConfig(text),/unadmitted local Git/);
});

test('worker does not forward host credentials and checks returned comparison identities',async t=>{
  const {controller,carriers,output}=fixture(t);
  mkdirSync(join(controller,'scripts'));
  writeFileSync(join(controller,'scripts/materialize-sources.mjs'),`
    export function verifyChangeSources(){return {snapshot:{commit:'${commit}'}};}
    export function prepareExportedComparison(){return {snapshot:'/fixture/machine',changes:[{repository:'fixture/change',commit:'${commit}',directory:'/fixture/change'}]};}
  `);
  const {worker}=await import('../scripts/hosted-change.mjs');
  const old=process.env.HOUSE_READ_TOKEN;process.env.HOUSE_READ_TOKEN='fixture secret';t.after(()=>{if(old===undefined)delete process.env.HOUSE_READ_TOKEN;else process.env.HOUSE_READ_TOKEN=old;});
  const good={kind:'change-test',snapshot:commit,changes:[{repository:'fixture/change',commit}],verdict:'incomplete'};
  const invoke=verdict=>(program,args,options)=>{
    assert.equal(options.env.HOUSE_READ_TOKEN,undefined);assert.equal(options.env.GITHUB_TOKEN,undefined);assert.equal(options.env.GIT_CONFIG_COUNT,undefined);
    assert.equal(options.env.GIT_ALLOW_PROTOCOL,'file');assert.ok(args.some(value=>value.startsWith('--local-sources=')));
    return {status:1,stdout:JSON.stringify(verdict),stderr:'fixture prerequisite refusal'};
  };
  const result=await worker({controller,carriers,output,digest,execute:invoke(good)});assert.equal(result.status,1);
  await assert.rejects(worker({controller,carriers,output,digest,execute:invoke({...good,snapshot:'c'.repeat(40)})}),/differs from prepared/);
});

test('an immutable controller is not admitted merely because its SHA is well formed',t=>{
  const {helper}=fixture(t),file=join(helper,'reviewed-source-controllers.json');
  writeFileSync(file,JSON.stringify({kind:'guix.reviewed-source-controllers.v1',commits:[]}));
  assert.throws(()=>admitSourceController(helper,commit),/not reviewed/);
  writeFileSync(file,JSON.stringify({kind:'guix.reviewed-source-controllers.v1',commits:[commit]}));
  assert.equal(admitSourceController(helper,commit),commit);
  assert.throws(()=>admitSourceController(helper,'c'.repeat(40)),/not reviewed/);
});
