#!/usr/bin/env node
// Native Cloud Build receiving in the owning Continuous Delivery section.
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const pattern = {
  project:/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u,
  region:/^[a-z]+-[a-z0-9]+[0-9]$/u,
  part:/^[A-Za-z0-9_-]{1,64}$/u,
  repo:/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
  image:/^[a-z0-9][a-z0-9.\/:_-]+@sha256:[a-f0-9]{64}$/u,
  commit:/^[a-f0-9]{40}$/u,
  id:/^[a-f0-9-]{20,64}$/u,
};
const exact=(name,value,regex)=>{
  if(typeof value!=='string'||!regex.test(value))throw new TypeError('invalid '+name);
  return value;
};

export function selectCloudBuildSource(input) {
  const project=exact('project',input?.project,pattern.project);
  const region=exact('region',input?.region,pattern.region);
  const connection=exact('existing connection',input?.connection,pattern.part);
  const repositoryId=exact('repository ID',input?.repositoryId,pattern.part);
  const repository=exact('GitHub owner/repository',input?.repository,pattern.repo);
  const trigger=exact('trigger',input?.trigger,pattern.part);
  const image=exact('digest-pinned builder',input?.image,pattern.image);
  const serviceAccount=exact('service account',input?.serviceAccount,
    /^projects\/[a-z][a-z0-9-]+\/serviceAccounts\/[a-z][a-z0-9-]*@[a-z][a-z0-9-]*\.iam\.gserviceaccount\.com$/u);
  const email=serviceAccount.split('/').at(-1);
  if(serviceAccount.split('/')[1]!==project ||
    !email.endsWith('@'+project+'.iam.gserviceaccount.com') ||
    !/^(ci|build)-[a-z0-9-]+@/u.test(email))
    throw new TypeError('dedicated, project-owned build principal required');
  return Object.freeze({project,region,connection,repositoryId,repository,trigger,image,serviceAccount,
    repoResource:'projects/'+project+'/locations/'+region+'/connections/'+connection+'/repositories/'+repositoryId,
    connectionResource:'projects/'+project+'/locations/'+region+'/connections/'+connection});
}

function remoteName(uri) {
  try {
    const u=new URL(uri);
    if(u.protocol!=='https:'||u.hostname!=='github.com'||u.port||u.username||u.password||u.search||u.hash)return null;
    const p=u.pathname.replace(/^\//u,'').replace(/\.git$/u,'');
    return pattern.repo.test(p)?p.toLowerCase():null;
  }catch{return null;}
}

export function nativeGcloud(args,execute=execFileSync) {
  let stdout;
  try { stdout=execute('gcloud',args,{encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe']}); }
  catch(e){throw new Error('gcloud '+args.slice(0,3).join(' ')+' failed ('+(e?.code??e?.status??'unknown')+')');}
  try{return JSON.parse(stdout);}catch{throw new Error('gcloud returned invalid JSON for '+args.slice(0,3).join(' '));}
}

/** Resolve one existing 2nd-gen private GitHub repository without a new
 * catalogue, account, connection or provider write. */
export function discoverNativeCloudBuildSource(input,{execute=execFileSync}={}){
  const project=exact('project',input?.project,pattern.project);
  const region=exact('region',input?.region,pattern.region);
  const repository=exact('GitHub owner/repository',input?.repository,pattern.repo);
  const read=args=>nativeGcloud(args,execute);
  const current=read(['projects','describe',project,'--format=json']);
  if(current.projectId!==project||current.lifecycleState!=='ACTIVE')
    throw new Error('selected Google Cloud project unavailable');
  // Discovery is a read-only source lookup. Billing permissions must not block
  // finding an existing connection; inspect/ensure still qualify billing before writes.
  const connections=read(['builds','connections','list','--project='+project,
    '--region='+region,'--format=json']);
  if(!Array.isArray(connections)||connections.length>32)
    throw new Error('complete bounded native connection population required');
  const matches=[];
  for(const conn of connections){
    if(typeof conn?.name!=='string'||
      !conn.name.startsWith('projects/'+project+'/locations/'+region+'/connections/'))
      throw new Error('foreign provider connection');
    const connection=exact('connection',conn.name.split('/').at(-1),pattern.part);
    if(conn.disabled===true||conn.reconciling===true||
      conn.installationState?.stage!=='COMPLETE'||
      !/^\d+$/u.test(conn.githubConfig?.appInstallationId??''))continue;
    const rows=read(['builds','repositories','list','--connection='+connection,
      '--project='+project,'--region='+region,'--format=json']);
    if(!Array.isArray(rows)||rows.length>500)
      throw new Error('complete bounded connected repository list required');
    for(const entry of rows){
      if(typeof entry?.name!=='string'||
        !entry.name.startsWith(conn.name+'/repositories/'))
        throw new Error('connected source outside owning connection');
      const repositoryId=exact('repository ID',entry.name.split('/').at(-1),pattern.part);
      if(remoteName(entry.remoteUri)===repository.toLowerCase())
        matches.push({project,region,repository,connection,repositoryId,
          repoResource:entry.name,connectionResource:conn.name});
    }
  }
  if(matches.length!==1)throw new Error(matches.length===0
    ?'selected GitHub repository is not connected in this GCP project/region'
    :'ambiguous duplicate private GitHub repository connections');
  return {...matches[0],sourceDiscovered:true,providerReadback:true,triggerInstalled:false};
}

export function plannedNativeTrigger(source) {
  return ['builds','triggers','create','github','--name='+source.trigger,
    '--project='+source.project,'--region='+source.region,
    '--repository='+source.repoResource,'--branch-pattern=^main$',
    '--build-config=cloudbuild.yaml','--service-account='+source.serviceAccount,
    '--substitutions=_NODE_IMAGE='+source.image,'--require-approval','--format=json'];
}

export function qualifyNativeTrigger(row,source){
  if(!row||!pattern.id.test(row.id??'')||row.name!==source.trigger||row.disabled===true||
    row.filename!=='cloudbuild.yaml'||row.serviceAccount!==source.serviceAccount||
    row.approvalConfig?.approvalRequired!==true||
    row.repositoryEventConfig?.repository!==source.repoResource||
    row.repositoryEventConfig?.push?.branch!=='^main$'||
    row.repositoryEventConfig?.push?.invertRegex===true||
    row.substitutions?._NODE_IMAGE!==source.image||
    row.github!==undefined||row.triggerTemplate!==undefined||
    row.autodetect!==undefined||row.build!==undefined||row.gitFileSource!==undefined||
    (row.includedFiles?.length??0)!==0||(row.ignoredFiles?.length??0)!==0||
    (row.filter!==undefined&&row.filter!=='')||
    (row.eventType!==undefined&&row.eventType!=='REPO')||
    row.repositoryEventConfig?.pullRequest!==undefined||
    (row.repositoryEventConfig?.repositoryType!==undefined&&
      row.repositoryEventConfig.repositoryType!=='GITHUB')||
    Object.keys(row.substitutions??{}).length!==1)
    throw new Error('Cloud Build trigger contradicts private approved main-source selection');
  return {id:row.id,name:row.name,repository:source.repository,project:source.project,
    region:source.region,approvalRequired:true,providerIdentityChecked:true};
}

/** Inspect or create one native trigger, observing provider identity before and after.
 * No guessed GCP connection, billed run, private-source mirror or second state store.
 */
export function receiveCloudBuildTrigger(input,{execute=execFileSync}={}){
  const s=selectCloudBuildSource(input),read=args=>nativeGcloud(args,execute);
  const project=read(['projects','describe',s.project,'--format=json']);
  if(project.projectId!==s.project||project.lifecycleState!=='ACTIVE')throw new Error('project not active');
  const billing=read(['billing','projects','describe',s.project,'--format=json']);
  if(billing.projectId!==s.project||billing.billingEnabled!==true)throw new Error('project billing unavailable');
  const connection=read(['builds','connections','describe',s.connection,
    '--project='+s.project,'--region='+s.region,'--format=json']);
  if(connection.name!==s.connectionResource||connection.disabled===true||
    connection.reconciling===true||connection.installationState?.stage!=='COMPLETE'||
    !/^\d+$/u.test(connection.githubConfig?.appInstallationId??''))
    throw new Error('GitHub Cloud Build connection is not installed');
  const repo=read(['builds','repositories','describe',s.repositoryId,
    '--connection='+s.connection,'--project='+s.project,'--region='+s.region,'--format=json']);
  if(repo.name!==s.repoResource||remoteName(repo.remoteUri)!==s.repository.toLowerCase())
    throw new Error('connected GitHub repository identity mismatch');
  const email=s.serviceAccount.split('/').at(-1);
  const account=read(['iam','service-accounts','describe',email,'--project='+s.project,'--format=json']);
  if(account.email!==email||account.disabled===true)throw new Error('build service account unavailable');
  const list=()=>{
    const rows=read(['builds','triggers','list','--project='+s.project,'--region='+s.region,'--format=json']);
    if(!Array.isArray(rows)||rows.length>400)throw new Error('complete native trigger population required');
    return rows;
  };
  const choose=rows=>{
    const ours=rows.filter(x=>x.name===s.trigger);
    if(ours.length>1)throw new Error('duplicate trigger names');
    if(rows.some(x=>x.name!==s.trigger&&x.repositoryEventConfig?.repository===s.repoResource&&
      x.repositoryEventConfig?.push!==undefined&&x.filename==='cloudbuild.yaml'))
      throw new Error('another source trigger already receives this repository');
    return ours[0]??null;
  };
  let rows=list(),existing=choose(rows);
  const describe=row=>read(['builds','triggers','describe',row.id,'--project='+s.project,
    '--region='+s.region,'--format=json']);
  if(existing)return {state:'EXISTING',...qualifyNativeTrigger(describe(existing),s),
    executed:false,remainingFreeQuotaChecked:false};
  const command=plannedNativeTrigger(s);
  if(input.apply!==true)return {state:'READY',project:s.project,repository:s.repository,
    command,executed:false,remainingFreeQuotaChecked:false};
  read(command);
  rows=list();existing=choose(rows);
  if(!existing)throw new Error('created trigger not visible on readback; reconcile before retry');
  return {state:'CREATED',...qualifyNativeTrigger(describe(existing),s),
    executed:false,remainingFreeQuotaChecked:false};
}


/** Request one existing, approved-configuration Cloud Build trigger at an exact
 * Git revision. A request creates only a pending-approval build; it does not
 * approve, execute, or establish a successful CI receipt. No source registry,
 * credential, runner or second state store is created.
 *
 * In case of provider timeout or ambiguous response, callers MUST reconcile
 * native Cloud Build state before another request (never automatic retry).
 */
export function requestNativeCloudBuild(input,{execute=execFileSync}={}){
  const commit=exact('source commit',input?.commit,pattern.commit);
  const trigger=receiveCloudBuildTrigger({...input,apply:false},{execute});
  if(trigger.state!=='EXISTING')
    throw new Error('install and independently receive the existing approved trigger first');
  const request=['builds','triggers','run',trigger.id,
    '--project='+input.project,'--region='+input.region,
    '--sha='+commit,'--format=json'];
  if(input.apply!==true)return {state:'READY_TO_REQUEST',project:input.project,
    repository:input.repository,commit,triggerId:trigger.id,command:request,
    executed:false,approvalRequired:true,remainingFreeQuotaChecked:false};
  if(input.authorizeRequest!==true)
    throw new Error('an explicit pending-build request authorization is required');
  let response;
  try {response=nativeGcloud(request,execute);}
  catch {throw new Error('provider request outcome unknown; inspect native builds before any retry');}
  // gcloud releases can expose the Build directly or as operation metadata.
  // Never mistake an operation ID for a Build without an independent describe.
  const ids=[response?.id,response?.metadata?.build?.id,response?.response?.id]
    .filter(value=>typeof value==='string'&&pattern.id.test(value));
  const distinct=[...new Set(ids)];
  if(distinct.length!==1)
    throw new Error('provider request identity ambiguous; inspect native builds before any retry');
  let build;
  try {build=nativeGcloud(['builds','describe',distinct[0],
    '--project='+input.project,'--region='+input.region,'--format=json'],execute);}
  catch {throw new Error('provider returned a build ID but its receipt is not readable; reconcile before retry');}
  if(build?.id!==distinct[0]||build.projectId!==input.project||
    build.buildTriggerId!==trigger.id||
    build.substitutions?.COMMIT_SHA!==commit||
    build.substitutions?.REPO_FULL_NAME?.toLowerCase()!==input.repository.toLowerCase()||
    build.source?.connectedRepository?.repository!==
      selectCloudBuildSource(input).repoResource||
    build.serviceAccount!==input.serviceAccount||
    build.approval?.config?.approvalRequired!==true||
    build.approval?.state!=='PENDING'||build.status!=='PENDING')
    throw new Error('requested build lacks exact source/identity/approval readback; reconcile before retry');
  return {state:'PENDING_APPROVAL',project:input.project,repository:input.repository,
    commit,triggerId:trigger.id,buildId:build.id,
    executed:false,approvalRequired:true,providerReadback:true,
    remainingFreeQuotaChecked:false};
}

/** An executed CI receipt needs independently resolved immutable provider source
 * and actual executable test steps. Event substitutions and display step names
 * alone are insufficient: a successful unrelated build can claim both. */
export function qualifyNativeCloudBuildResult(build,{
    id,triggerId,commit,repository,step,sourceResource,serviceAccount,image,command
  }){
  exact('build ID',id,pattern.id);exact('trigger ID',triggerId,pattern.id);
  exact('source commit',commit,pattern.commit);exact('repository',repository,pattern.repo);
  exact('selected test step',step,/^[a-z][a-z0-9-]{2,63}$/u);
  exact('connected source resource',sourceResource,
    /^projects\/[a-z][a-z0-9-]+\/locations\/[a-z]+-[a-z0-9]+[0-9]\/connections\/[A-Za-z0-9_-]+\/repositories\/[A-Za-z0-9_-]+$/u);
  exact('build service account',serviceAccount,
    /^projects\/[a-z][a-z0-9-]+\/serviceAccounts\/[a-z][a-z0-9-]*@[a-z][a-z0-9-]*\.iam\.gserviceaccount\.com$/u);
  exact('builder image digest',image,pattern.image);
  if(typeof command!=='string'||command.length>256||
     !/^(?:npm|pnpm|yarn|node) [A-Za-z0-9_ ./:-]+$/u.test(command))
    throw new TypeError('exact original test command required');
  const [project,region]=[sourceResource.split('/')[1],sourceResource.split('/')[3]];
  const selected=Array.isArray(build?.steps)?build.steps.filter(x=>x.id===step):[];
  const actual=selected[0];
  const lines=typeof actual?.args?.[1]==='string'
    ? actual.args[1].split(/\r?\n/u).map(x=>x.trim()):[];
  const source=build?.sourceProvenance?.resolvedConnectedRepository;
  if(!build||build.id!==id||build.projectId!==project||
    (build.name!==undefined&&build.name!==`projects/${project}/locations/${region}/builds/${id}`)||
    build.status!=='SUCCESS'||build.buildTriggerId!==triggerId||
    build.substitutions?.COMMIT_SHA!==commit||
    build.substitutions?.REPO_FULL_NAME?.toLowerCase()!==repository.toLowerCase()||
    !((build.substitutions?.BRANCH_NAME==='main' &&
       build.source?.connectedRepository?.revision==='refs/heads/main') ||
      (build.source?.connectedRepository?.revision===commit &&
       [undefined,'','main'].includes(build.substitutions?.BRANCH_NAME)))||
    build.source?.connectedRepository?.repository!==sourceResource||
    source?.repository!==sourceResource||source?.revision!==commit||
    build.serviceAccount!==serviceAccount||
    build.approval?.state!=='APPROVED'||
    build.approval?.config?.approvalRequired!==true||
    build.approval?.result?.decision!=='APPROVED'||
    build.options?.machineType!=='E2_STANDARD_2'||
    build.options?.logging!=='CLOUD_LOGGING_ONLY'||
    build.options?.pool!==undefined||build.options?.workerPool!==undefined||
    build.availableSecrets!==undefined||
    (Array.isArray(build.secrets)&&build.secrets.length>0)||
    !Array.isArray(build.steps)||build.steps.length<1||build.steps.length>64||
    build.steps.some(x=>x.status!=='SUCCESS')||selected.length!==1||
    actual.name!==image||actual.entrypoint!=='bash'||
    actual.args?.[0]!=='-euc'||!lines.includes(command)||
    !Array.isArray(actual.env)||!actual.env.includes('BUILDER_IMAGE='+image))
    throw new Error('provider did not execute the approved original source test on the connected Git revision');
  return {state:'TEST_EXECUTED',id,commit,repository,
    sourceResource,selectedStep:step,executedSteps:build.steps.length,
    logUrl:typeof build.logUrl==='string'?build.logUrl:null,providerReadback:true,
    billedMinutesVerified:false};
}

export function readNativeCloudBuildResult(request,{execute=execFileSync}={}){
  const project=exact('project',request?.project,pattern.project);
  const region=exact('region',request?.region,pattern.region);
  const id=exact('build',request?.id,pattern.id);
  const sourceResource=exact('source resource',request?.sourceResource,
    /^projects\/[a-z][a-z0-9-]+\/locations\/[a-z]+-[a-z0-9]+[0-9]\/connections\/[A-Za-z0-9_-]+\/repositories\/[A-Za-z0-9_-]+$/u);
  if(!sourceResource.startsWith('projects/'+project+'/locations/'+region+'/'))
    throw new TypeError('build source does not belong to selected project and region');
  if(typeof request?.serviceAccount!=='string'||
     !request.serviceAccount.startsWith('projects/'+project+'/serviceAccounts/'))
    throw new TypeError('build principal differs from selected project');
  const build=nativeGcloud(['builds','describe',id,'--project='+project,'--region='+region,'--format=json'],execute);
  return {...qualifyNativeCloudBuildResult(build,request),project,region};
}

const usage='Usage: cloudbuild-github-trigger plan-build|request-build --project=ID --region=REGION --connection=ID --repository-id=ID --repository=OWNER/REPO --trigger=NAME --image=IMAGE@sha256:DIGEST --service-account=projects/ID/serviceAccounts/ci-...@ID.iam.gserviceaccount.com --commit=SHA [--authorize-request=pending for request-build only]; or discover --project=ID --region=REGION --repository=OWNER/REPO; or inspect|ensure --project=ID --region=REGION --connection=ID --repository-id=ID --repository=OWNER/REPO --trigger=NAME --image=IMAGE@sha256:DIGEST --service-account=projects/ID/serviceAccounts/ci-...@ID.iam.gserviceaccount.com; or read-build --project=ID --region=REGION --id=BUILD --trigger-id=TRIGGER --commit=SHA --repository=OWNER/REPO --step=TEST_ID --source-resource=projects/.../repositories/... --service-account=projects/.../serviceAccounts/... --image=IMAGE@sha256:DIGEST --command="npm run verify"';
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  try {
    const [mode,...opts]=process.argv.slice(2);
    if(mode==='--help'){process.stdout.write(usage+'\n');}
    else {
      if(!['discover','inspect','ensure','read-build','plan-build','request-build'].includes(mode))throw new TypeError(usage);
      const fields={};
      for(const arg of opts){
        const m=/^--([a-z-]+)=(.+)$/u.exec(arg);
        if(!m||Object.hasOwn(fields,m[1]))throw new TypeError('invalid/duplicate option');
        fields[m[1]]=m[2];
      }
      const keys=mode==='discover'
        ?['project','region','repository']
        :mode==='read-build'
        ?['project','region','id','trigger-id','commit','repository','step','source-resource','service-account','image','command']
        :['plan-build','request-build'].includes(mode)
        ?['project','region','connection','repository-id','repository','trigger','image','service-account','commit',
          ...(mode==='request-build'?['authorize-request']:[])]
        :['project','region','connection','repository-id','repository','trigger','image','service-account'];
      if(Object.keys(fields).length!==keys.length||Object.keys(fields).some(k=>!keys.includes(k)))
        throw new TypeError(usage);
      const value=mode==='discover'
        ? discoverNativeCloudBuildSource(fields)
        :mode==='read-build'
        ? readNativeCloudBuildResult({...fields,triggerId:fields['trigger-id'],sourceResource:fields['source-resource'],serviceAccount:fields['service-account']})
        :['plan-build','request-build'].includes(mode)
        ?requestNativeCloudBuild({...fields,repositoryId:fields['repository-id'],
          serviceAccount:fields['service-account'],apply:mode==='request-build',
          authorizeRequest:fields['authorize-request']==='pending'})
        : receiveCloudBuildTrigger({...fields,repositoryId:fields['repository-id'],
          serviceAccount:fields['service-account'],apply:mode==='ensure'});
      process.stdout.write(JSON.stringify(value)+'\n');
    }
  }catch(e){process.stderr.write('Cloud Build source receiving: '+e.message+'\n');process.exitCode=2;}
}
