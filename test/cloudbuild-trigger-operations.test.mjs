import test from 'node:test';
import assert from 'node:assert/strict';
import {selectCloudBuildSource,plannedNativeTrigger,receiveCloudBuildTrigger,
  qualifyNativeTrigger,qualifyNativeCloudBuildResult,readNativeCloudBuildResult}
  from '../scripts/cloudbuild-github-trigger.mjs';
const image='docker.io/library/node@sha256:'+'a'.repeat(64);
const input={project:'five-six-one-group-dev',region:'us-central1',connection:'red-cup-github',
  repositoryId:'git-services-section',repository:'red-cup-engineering/git-services-section',
  trigger:'git-source-custody',image,serviceAccount:
  'projects/five-six-one-group-dev/serviceAccounts/ci-git-source@five-six-one-group-dev.iam.gserviceaccount.com'};
const s=selectCloudBuildSource(input),id='01234567-89ab-4def-8123-456789abcdef';
const trigger={id,name:input.trigger,filename:'cloudbuild.yaml',serviceAccount:input.serviceAccount,
  approvalConfig:{approvalRequired:true},repositoryEventConfig:{
    repository:s.repoResource,push:{branch:'^main$'}},substitutions:{_NODE_IMAGE:image}};
function host({missing=false,mutate=false,connection={},repo={},billing={},account={},listRows=null}={}){
  const calls=[];let present=!missing;
  const execute=(cmd,args)=>{
    assert.equal(cmd,'gcloud');calls.push(args);
    let result;
    if(args[0]==='projects')result={projectId:s.project,lifecycleState:'ACTIVE'};
    else if(args[0]==='billing')result={projectId:s.project,billingEnabled:true,...billing};
    else if(args[0]==='builds'&&args[1]==='connections')result={
      name:s.connectionResource,installationState:{stage:'COMPLETE'},
      githubConfig:{appInstallationId:'1234'},...connection};
    else if(args[0]==='builds'&&args[1]==='repositories')result={
      name:s.repoResource,remoteUri:'https://github.com/'+s.repository+'.git',...repo};
    else if(args[0]==='iam')result={
      email:s.serviceAccount.split('/').at(-1),...account};
    else if(args[0]==='builds'&&args[1]==='triggers'&&args[2]==='list')
      result=listRows??(present?[trigger]:[]);
    else if(args[0]==='builds'&&args[1]==='triggers'&&args[2]==='describe')
      result=(listRows??[trigger]).find(x=>x.id===args[3])??trigger;
    else if(args[0]==='builds'&&args[1]==='triggers'&&args[2]==='create'){
      assert.equal(mutate,true);present=true;result=trigger;
    } else throw new Error('unexpected provider call: '+args.join(' '));
    return JSON.stringify(result);
  };
  return {execute,calls};
}
test('native owner creates precisely one approved exact-main 2nd-gen trigger',()=>{
  const args=plannedNativeTrigger(s);
  for(const flag of ['--repository='+s.repoResource,'--branch-pattern=^main$',
    '--service-account='+s.serviceAccount,'--require-approval',
    '--substitutions=_NODE_IMAGE='+s.image])
    assert.ok(args.includes(flag));
  assert.equal(qualifyNativeTrigger(trigger,s).approvalRequired,true);
});
test('invalid identities and wrong provider connections refuse before mutation',()=>{
  for(const delta of [{image:'node:24'},{repository:'invalid'},{region:'global'},
    {serviceAccount:'projects/other/serviceAccounts/ci-fake@other.iam.gserviceaccount.com'}])
    assert.throws(()=>selectCloudBuildSource({...input,...delta}));
  for(const change of [{repo:{remoteUri:'https://github.com/other/git-services-section.git'}},
    {connection:{installationState:{stage:'PENDING_INSTALL_APP'}}},
    {billing:{billingEnabled:false}},{account:{disabled:true}}]){
    const f=host(change);assert.throws(()=>receiveCloudBuildTrigger({...input,apply:true},f));
    assert.equal(f.calls.some(x=>x.includes('create')),false);
  }
});
test('inspect never creates; ensure creates once then reads provider native state',()=>{
  let f=host({missing:true});
  assert.equal(receiveCloudBuildTrigger(input,f).state,'READY');
  assert.equal(f.calls.some(x=>x.includes('create')),false);
  f=host({missing:true,mutate:true});
  assert.equal(receiveCloudBuildTrigger({...input,apply:true},f).state,'CREATED');
  assert.equal(f.calls.filter(x=>x[2]==='create').length,1);
  assert.equal(f.calls.filter(x=>x[2]==='list').length,2);
  f=host({mutate:true});
  assert.equal(receiveCloudBuildTrigger({...input,apply:true},f).state,'EXISTING');
  assert.equal(f.calls.some(x=>x[2]==='create'),false);
});
test('provider trigger conflicts and missing manual approval are refused',()=>{
  const other={...trigger,id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'other-trigger'};
  for(const listRows of [[other],[{...trigger,approvalConfig:{approvalRequired:false}}],
    [{...trigger,substitutions:{_NODE_IMAGE:'wrong'}}],
    [{...trigger,repositoryEventConfig:{...trigger.repositoryEventConfig,push:{branch:'.*'}}}]])
    assert.throws(()=>receiveCloudBuildTrigger({...input,apply:true},
      host({listRows,mutate:true})));
});
test('build readback observes actual successful step and rejects switched identity',()=>{
  const build={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',buildTriggerId:id,
    status:'SUCCESS',substitutions:{COMMIT_SHA:'c'.repeat(40),REPO_FULL_NAME:input.repository},
    steps:[{id:'source-custody-regressions',status:'SUCCESS'}]};
  const request={id:build.id,triggerId:id,commit:'c'.repeat(40),repository:input.repository,step:'source-custody-regressions'};
  assert.equal(qualifyNativeCloudBuildResult(build,request).state,'TEST_EXECUTED');
  for(const changed of [{status:'FAILURE'}, {steps:[]},{buildTriggerId:'bad'},
    {substitutions:{COMMIT_SHA:'d'.repeat(40),REPO_FULL_NAME:input.repository}}])
    assert.throws(()=>qualifyNativeCloudBuildResult({...build,...changed},request));
  const result=readNativeCloudBuildResult({project:input.project,region:input.region,...request},
    {execute:(cmd,args)=>{assert.equal(args[1],'describe');return JSON.stringify(build);}});
  assert.equal(result.providerReadback,true);
  const alternate={...build,steps:[{id:'different-test-suite',status:'SUCCESS'}]};
  assert.equal(qualifyNativeCloudBuildResult(alternate,{...request,step:'different-test-suite'}).selectedStep,'different-test-suite');
  assert.throws(()=>qualifyNativeCloudBuildResult(alternate,request));
});
