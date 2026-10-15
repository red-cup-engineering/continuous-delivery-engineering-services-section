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
    row.autodetect!==undefined||row.build!==undefined||row.gitFileSource!==undefined)
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

export function qualifyNativeCloudBuildResult(build,{id,triggerId,commit,repository,step}){
  exact('build ID',id,pattern.id);exact('trigger ID',triggerId,pattern.id);
  exact('source commit',commit,pattern.commit);exact('repository',repository,pattern.repo);
  exact('selected test step',step,/^[a-z][a-z0-9-]{2,63}$/u);
  if(!build||build.id!==id||build.status!=='SUCCESS'||build.buildTriggerId!==triggerId||
    build.substitutions?.COMMIT_SHA!==commit||
    build.substitutions?.REPO_FULL_NAME?.toLowerCase()!==repository.toLowerCase()||
    !Array.isArray(build.steps)||build.steps.length<1||build.steps.length>64||
    build.steps.some(x=>x.status!=='SUCCESS')||
    build.steps.filter(x=>x.id===step).length!==1)
    throw new Error('native provider build did not execute the exact source-custody tests');
  return {state:'TEST_EXECUTED',id,commit,repository,selectedStep:step,executedSteps:build.steps.length,
    logUrl:typeof build.logUrl==='string'?build.logUrl:null,providerReadback:true,
    billedMinutesVerified:false};
}

export function readNativeCloudBuildResult(request,{execute=execFileSync}={}){
  const project=exact('project',request?.project,pattern.project);
  const region=exact('region',request?.region,pattern.region);
  const id=exact('build',request?.id,pattern.id);
  const build=nativeGcloud(['builds','describe',id,'--project='+project,'--region='+region,'--format=json'],execute);
  return {...qualifyNativeCloudBuildResult(build,request),project,region};
}

const usage='Usage: cloudbuild-github-trigger inspect|ensure --project=ID --region=REGION --connection=ID --repository-id=ID --repository=OWNER/REPO --trigger=NAME --image=IMAGE@sha256:DIGEST --service-account=projects/ID/serviceAccounts/ci-...@ID.iam.gserviceaccount.com; or read-build --project=ID --region=REGION --id=BUILD --trigger-id=TRIGGER --commit=SHA --repository=OWNER/REPO --step=TEST_ID';
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  try {
    const [mode,...opts]=process.argv.slice(2);
    if(mode==='--help'){process.stdout.write(usage+'\n');}
    else {
      if(!['inspect','ensure','read-build'].includes(mode))throw new TypeError(usage);
      const fields={};
      for(const arg of opts){
        const m=/^--([a-z-]+)=(.+)$/u.exec(arg);
        if(!m||Object.hasOwn(fields,m[1]))throw new TypeError('invalid/duplicate option');
        fields[m[1]]=m[2];
      }
      const keys=mode==='read-build'
        ?['project','region','id','trigger-id','commit','repository','step']
        :['project','region','connection','repository-id','repository','trigger','image','service-account'];
      if(Object.keys(fields).length!==keys.length||Object.keys(fields).some(k=>!keys.includes(k)))
        throw new TypeError(usage);
      const value=mode==='read-build'
        ? readNativeCloudBuildResult({...fields,triggerId:fields['trigger-id']})
        : receiveCloudBuildTrigger({...fields,repositoryId:fields['repository-id'],
          serviceAccount:fields['service-account'],apply:mode==='ensure'});
      process.stdout.write(JSON.stringify(value)+'\n');
    }
  }catch(e){process.stderr.write('Cloud Build source receiving: '+e.message+'\n');process.exitCode=2;}
}
