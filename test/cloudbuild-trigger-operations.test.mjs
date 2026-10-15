import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readCommittedCloudBuildSteps,discoverNativeCloudBuildSource,selectCloudBuildSource,plannedNativeTrigger,receiveCloudBuildTrigger,
  qualifyNativeTrigger,qualifyNativeCloudBuildResult,readNativeCloudBuildResult,
  requestNativeCloudBuild}
  from '../scripts/cloudbuild-github-trigger.mjs';
const image='docker.io/library/node@sha256:'+'a'.repeat(64);
const input={project:'five-six-one-group-dev',region:'us-central1',connection:'red-cup-github',
  repositoryId:'git-services-section',repository:'red-cup-engineering/git-services-section',
  trigger:'git-source-custody',image,serviceAccount:
  'projects/five-six-one-group-dev/serviceAccounts/ci-git-source@five-six-one-group-dev.iam.gserviceaccount.com'};
const s=selectCloudBuildSource(input),id='01234567-89ab-4def-8123-456789abcdef';
const trigger={id,name:input.trigger,eventType:'REPO',filename:'cloudbuild.yaml',serviceAccount:input.serviceAccount,
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
    [{...trigger,repositoryEventConfig:{...trigger.repositoryEventConfig,push:{branch:'.*'}}}],
    [{...trigger,includedFiles:['no-real-source/**']}],
    [{...trigger,ignoredFiles:['**/*.mjs']}],
    [{...trigger,substitutions:{...trigger.substitutions,_SKIP_TESTS:'true'}}],
    [{...trigger,eventType:'WEBHOOK'}],
    [{...trigger,eventType:'PUSH'}]])
    assert.throws(()=>receiveCloudBuildTrigger({...input,apply:true},
      host({listRows,mutate:true})));
});
test('build readback requires a direct successful npm test after original preflight',()=>{
  const sourceResource=s.repoResource,serviceAccount=s.serviceAccount,command='npm run verify';
  const steps=[
    {id:'source-identity',status:'SUCCESS',name:image,entrypoint:'bash',
      args:['-euc','echo original source selected\n'],env:['BUILDER_IMAGE='+image]},
    {id:'source-custody-regressions',status:'SUCCESS',name:image,entrypoint:'npm',
      args:['run','verify'],env:['BUILDER_IMAGE='+image]}
  ];
  const build={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',projectId:s.project,
    buildTriggerId:id,status:'SUCCESS',
    source:{connectedRepository:{repository:sourceResource,revision:'refs/heads/main'}},
    sourceProvenance:{resolvedConnectedRepository:{repository:sourceResource,revision:'c'.repeat(40)}},
    serviceAccount,approval:{state:'APPROVED',config:{approvalRequired:true},result:{decision:'APPROVED'}},
    options:{machineType:'E2_STANDARD_2',logging:'CLOUD_LOGGING_ONLY'},
    substitutions:{COMMIT_SHA:'c'.repeat(40),REPO_FULL_NAME:input.repository,BRANCH_NAME:'main'},
    steps};
  const request={id:build.id,triggerId:id,commit:'c'.repeat(40),repository:input.repository,
    step:'source-custody-regressions',sourceResource,serviceAccount,image,command,
    expectedSteps:steps.map(({id,name,entrypoint,args,env})=>({id,name,entrypoint,args,env}))};
  assert.equal(qualifyNativeCloudBuildResult(build,request).state,'TEST_EXECUTED');
  const pinned={...build,source:{connectedRepository:{
    repository:sourceResource,revision:request.commit}},
    substitutions:{...build.substitutions,BRANCH_NAME:''}};
  assert.equal(qualifyNativeCloudBuildResult(pinned,request).state,'TEST_EXECUTED');
  for(const change of [
    {status:'FAILURE'}, {steps:[]},{buildTriggerId:'bad'},
    {substitutions:{...build.substitutions,COMMIT_SHA:'d'.repeat(40)}},
    {source:{storageSource:{bucket:'unrelated',object:'spoof.tgz'}}},
    {sourceProvenance:{resolvedConnectedRepository:{repository:sourceResource,revision:'d'.repeat(40)}}},
    {approval:{state:'PENDING',config:{approvalRequired:true}}},
    {serviceAccount:'projects/other/serviceAccounts/admin@other.iam.gserviceaccount.com'},
    {options:{machineType:'E2_STANDARD_2',logging:'CLOUD_LOGGING_ONLY',pool:{name:'wrong'}}},
    {steps:[{...steps[0]}, {...steps[1],entrypoint:'bash',
      args:['-euc','exit 0\nnpm run verify\n']}]},
    {steps:[{...steps[0]}, {...steps[1],args:['run','test']}]},
    {steps:[{...steps[0]}, {...steps[1],allowFailure:true}]},
    {steps:[{...steps[0]}, {...steps[1],exitCode:1}]},
    {steps:[{...steps[1]}, {...steps[0]}]},
    {steps:[{...steps[1]}]},
    {substitutions:{...build.substitutions,BRANCH_NAME:'feature'}}
  ]) assert.throws(()=>qualifyNativeCloudBuildResult({...build,...change},request));
  assert.throws(()=>qualifyNativeCloudBuildResult(build,
    {...request,command:'npm run test'}),/original source test/);
});

test('native 2nd-gen repository discovery requires one genuine matching GitHub connection',()=>{
  const calls=[];
  function provider({duplicate=false,missing=false}={}){
    return (program,args)=>{
      assert.equal(program,'gcloud');calls.push(args);
      if(args[0]==='projects')return JSON.stringify({projectId:s.project,lifecycleState:'ACTIVE'});
      if(args[0]==='billing')throw new Error('billing visibility is not needed for source discovery');
      if(args.slice(0,3).join(' ')==='builds connections list')
        return JSON.stringify(missing?[]:[{name:s.connectionResource,
          installationState:{stage:'COMPLETE'},githubConfig:{appInstallationId:'1234'}}]);
      if(args.slice(0,3).join(' ')==='builds repositories list')
        return JSON.stringify([{name:s.repoResource,
          remoteUri:'https://github.com/'+s.repository+'.git'},
          ...(duplicate?[{name:s.connectionResource+'/repositories/second-alias',
            remoteUri:'https://github.com/'+s.repository+'.git'}]:[])]);
      throw new Error('unexpected discovery call: '+args.join(' '));
    };
  }
  const request={project:s.project,region:s.region,repository:s.repository};
  const result=discoverNativeCloudBuildSource(request,{execute:provider()});
  assert.equal(result.repoResource,s.repoResource);
  assert.equal(result.connection,s.connection);
  assert.equal(result.sourceDiscovered,true);
  assert.ok(calls.every(x=>!x.includes('create')&&!x.includes('delete')));
  assert.throws(()=>discoverNativeCloudBuildSource(request,{execute:provider({duplicate:true})}),/ambiguous/);
  assert.throws(()=>discoverNativeCloudBuildSource(request,{execute:provider({missing:true})}),/not connected/);
});


test('native exact-commit request uses the installed approved trigger; dry-run cannot bill',()=>{
  const f=host(),commit='c'.repeat(40);
  const preview=requestNativeCloudBuild({...input,commit},f);
  assert.equal(preview.state,'READY_TO_REQUEST');
  assert.ok(preview.command.includes('--sha='+commit));
  assert.ok(preview.command.includes(id));
  assert.equal(preview.executed,false);
  assert.equal(f.calls.some(args=>args[2]==='run'),false);
  assert.throws(()=>requestNativeCloudBuild({...input,commit,apply:true},host()),
    /authorization/);
  assert.throws(()=>requestNativeCloudBuild({...input,commit:'HEAD'},host()),
    /invalid source commit/);
  assert.throws(()=>requestNativeCloudBuild({...input,commit},host({missing:true})),
    /install and independently receive/);
  assert.throws(()=>requestNativeCloudBuild({...input,commit},
    host({listRows:[{...trigger,approvalConfig:{approvalRequired:false}}]})),
    /approved main-source selection/);
});

test('native pending request has a provider build receipt; failure is never retried',()=>{
  const commit='c'.repeat(40),buildId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const build={id:buildId,projectId:input.project,buildTriggerId:id,
    status:'PENDING',serviceAccount:input.serviceAccount,
    source:{connectedRepository:{repository:s.repoResource,revision:commit}},
    substitutions:{COMMIT_SHA:commit,REPO_FULL_NAME:input.repository},
    approval:{state:'PENDING',config:{approvalRequired:true}}};
  function provider({result={id:buildId},readback=build,failRequest=false}={}){
    const base=host(),calls=[];
    return {calls,execute:(program,args)=>{
      calls.push(args);
      if(args[0]==='builds'&&args[1]==='triggers'&&args[2]==='run'){
        assert.deepEqual(args.slice(0,4),['builds','triggers','run',id]);
        assert.ok(args.includes('--sha='+commit));
        if(failRequest)throw new Error('provider timeout');
        return JSON.stringify(result);
      }
      if(args[0]==='builds'&&args[1]==='describe')
        return JSON.stringify(readback);
      return base.execute(program,args);
    }};
  }
  let f=provider();
  const r=requestNativeCloudBuild({...input,commit,apply:true,authorizeRequest:true},f);
  assert.equal(r.state,'PENDING_APPROVAL');
  assert.equal(r.buildId,buildId);
  assert.equal(r.executed,false);
  assert.equal(r.providerReadback,true);
  assert.equal(f.calls.filter(args=>args[2]==='run').length,1);
  for(const change of [{status:'SUCCESS'},{approval:{state:'APPROVED',config:{approvalRequired:true}}},
    {source:{connectedRepository:{repository:'foreign'}}},
    {substitutions:{COMMIT_SHA:'d'.repeat(40),REPO_FULL_NAME:input.repository}},
    {buildTriggerId:'wrong'}]){
    f=provider({readback:{...build,...change}});
    assert.throws(()=>requestNativeCloudBuild({...input,commit,apply:true,authorizeRequest:true},f),
      /reconcile before retry/);
    assert.equal(f.calls.filter(args=>args[2]==='run').length,1);
  }
  f=provider({result:{name:'projects/p/operations/unknown'}});
  assert.throws(()=>requestNativeCloudBuild({...input,commit,apply:true,authorizeRequest:true},f),
    /identity ambiguous/);
  f=provider({failRequest:true});
  assert.throws(()=>requestNativeCloudBuild({...input,commit,apply:true,authorizeRequest:true},f),
    /outcome unknown/);
  assert.equal(f.calls.filter(args=>args[2]==='run').length,1);
});

test('original immutable Git recipe executes source checks before a direct npm test',()=>{
  const root=mkdtempSync(join(tmpdir(),'cloudbuild-original-'));
  const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
  try{
    git('-C',root,'init','-q','--initial-branch=main');
    const yaml=[
      'timeout: 900s',
      'options:',
      '  machineType: E2_STANDARD_2',
      '  logging: CLOUD_LOGGING_ONLY',
      'steps:',
      '  - id: source-identity',
      '    name: "${_NODE_IMAGE}"',
      '    entrypoint: bash',
      '    env:',
      '      - "BUILDER_IMAGE=${_NODE_IMAGE}"',
      '    args:',
      '      - -euc',
      '      - |',
      '        echo "$COMMIT_SHA"',
      '        echo "$BRANCH_NAME"',
      '  - id: source-custody-regressions',
      '    name: "${_NODE_IMAGE}"',
      '    entrypoint: npm',
      '    env:',
      '      - "BUILDER_IMAGE=${_NODE_IMAGE}"',
      '    args:',
      '      - run',
      '      - verify',
    ].join('\n')+'\n';
    writeFileSync(join(root,'cloudbuild.yaml'),yaml);
    git('-C',root,'add','cloudbuild.yaml');
    git('-C',root,'-c','user.email=ci@example.invalid','-c','user.name=CI','commit','-qm','qualified source');
    const commit=git('-C',root,'rev-parse','HEAD');
    const expectedSource={sourceWorkspace:root,commit,repository:input.repository,
      image,step:'source-custody-regressions',command:'npm run verify'};
    const steps=readCommittedCloudBuildSteps(expectedSource);
    assert.equal(steps.length,2);
    assert.deepEqual(steps[0].args,['-euc','echo "'+commit+'"\necho "main"\n']);
    assert.equal(steps[1].entrypoint,'npm');
    assert.deepEqual(steps[1].args,['run','verify']);
    const build={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',projectId:s.project,
      buildTriggerId:id,status:'SUCCESS',
      source:{connectedRepository:{repository:s.repoResource,revision:'refs/heads/main'}},
      sourceProvenance:{resolvedConnectedRepository:{repository:s.repoResource,revision:commit}},
      serviceAccount:s.serviceAccount,
      approval:{state:'APPROVED',config:{approvalRequired:true},result:{decision:'APPROVED'}},
      options:{machineType:'E2_STANDARD_2',logging:'CLOUD_LOGGING_ONLY'},
      substitutions:{COMMIT_SHA:commit,REPO_FULL_NAME:input.repository,BRANCH_NAME:'main'},
      steps:steps.map(x=>({...x,status:'SUCCESS'}))};
    const request={...expectedSource,id:build.id,triggerId:id,sourceResource:s.repoResource,
      serviceAccount:s.serviceAccount,project:s.project,region:s.region};
    const receipt=readNativeCloudBuildResult(request,{execute:()=>JSON.stringify(build)});
    assert.equal(receipt.committedSourceCompared,true);
    assert.equal(receipt.state,'TEST_EXECUTED');
    const pinnedSteps=readCommittedCloudBuildSteps({...expectedSource,branchName:''});
    assert.equal(pinnedSteps[0].args[1],'echo "'+commit+'"\necho ""\n');
    const pinned={...build,source:{connectedRepository:{repository:s.repoResource,revision:commit}},
      substitutions:{...build.substitutions,BRANCH_NAME:''},
      steps:pinnedSteps.map(x=>({...x,status:'SUCCESS'}))};
    assert.equal(readNativeCloudBuildResult(request,{execute:()=>JSON.stringify(pinned)}).state,'TEST_EXECUTED');
    assert.throws(()=>readCommittedCloudBuildSteps({...expectedSource,branchName:'feature'}));
    // Even a script stored at the *correct* source commit cannot receive
    // test success if it replaces the direct npm process with an early exit.
    const malicious=yaml.replace('    entrypoint: npm','    entrypoint: bash')
      .replace('      - run\n      - verify','      - -euc\n      - |\n        exit 0\n        npm run verify');
    writeFileSync(join(root,'cloudbuild.yaml'),malicious);
    git('-C',root,'add','cloudbuild.yaml');
    git('-C',root,'-c','user.email=ci@example.invalid','-c','user.name=CI','commit','-qm','early exit source');
    const badCommit=git('-C',root,'rev-parse','HEAD');
    assert.throws(()=>readCommittedCloudBuildSteps({...expectedSource,commit:badCommit}));
    // Dirty workspace changes do not change the selected older Git object.
    assert.equal(readCommittedCloudBuildSteps(expectedSource).length,2);
    assert.throws(()=>readCommittedCloudBuildSteps({...expectedSource,commit:'a'.repeat(40)}));
  }finally{rmSync(root,{recursive:true,force:true});}
});
