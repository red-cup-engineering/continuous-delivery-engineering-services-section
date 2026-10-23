#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exactPin = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha(?:224|256|384|512)\.[A-Za-z0-9+/=]+)?$/;

/** Receive the caller's PNPM pin and existing frozen graph before any execution. */
export function planPnpmInstall({directory, temporary, pnpmVersion='', registry='', username='', token='', password=''}){
  const cwd=fs.realpathSync(directory);
  const manifest=path.join(cwd,'package.json'), lock=path.join(cwd,'pnpm-lock.yaml');
  const declared=JSON.parse(fs.readFileSync(manifest,'utf8')).packageManager;
  const match=typeof declared==='string' && exactPin.exec(declared);
  if(pnpmVersion && !/^\d+\.\d+\.\d+$/.test(pnpmVersion))throw new TypeError('an exact stable pnpm workflow pin is required');
  if(declared!==undefined&&!match)throw new TypeError('an exact stable pnpm packageManager pin is required');
  if(!match&&!pnpmVersion)throw new TypeError('an exact stable pnpm packageManager or workflow pin is required');
  if(match&&pnpmVersion&&match[1]!==pnpmVersion)throw new TypeError('source manifest and workflow PNPM pins conflict');
  if(!fs.statSync(lock).isFile())throw new TypeError('an existing pnpm-lock.yaml is required');
  if(!path.isAbsolute(temporary)||temporary.includes('\0'))throw new TypeError('absolute runner-owned temporary directory required');
  const base=fs.realpathSync(temporary);
  if(base===os.homedir()||base===path.parse(base).root||base===cwd)throw new TypeError('dedicated runner temporary custody required');
  if(token&&password)throw new TypeError('choose one registry token or password');
  if((token||password)&&!registry)throw new TypeError('credentials require an explicit registry');
  if(password&&!username)throw new TypeError('registry password requires its named username');
  let config='';
  if(registry){
    const url=new URL(registry);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new TypeError('credential-free HTTPS registry URL required');
    if(!url.pathname.endsWith('/'))url.pathname+='/';
    const prefix='//'+url.host+url.pathname+':';
    for(const value of [username,token,password])if(/[\r\n\0]/.test(value))throw new TypeError('single-line registry credentials required');
    if(token)config=prefix+'_authToken='+token+'\n';
    if(password)config=prefix+'username='+username+'\n'+prefix+'_password='+Buffer.from(password).toString('base64')+'\n';
  }
  return {cwd,base,version:pnpmVersion||(match&&match[1]),pinSource:pnpmVersion?'workflow':'manifest',manifest,lock,before:{manifest:digest(manifest),lock:digest(lock)},config};
}

/** Install the original graph; credentials never reach lifecycle scripts or later tests. */
export function installPnpm(options,{run=spawnSync,environment=process.env}={}){
  const plan=planPnpmInstall(options);
  const stage=fs.mkdtempSync(path.join(plan.base,'node-package-install-'));
  fs.chmodSync(stage,0o700);
  const userconfig=path.join(stage,'registry.npmrc');
  const store=path.join(plan.base,'node-package-store'), cache=path.join(plan.base,'node-package-cache');
  const redact = text => [options.token,options.password,options.password&&Buffer.from(options.password).toString('base64')]
    .filter(Boolean).reduce((s,secret)=>s.split(secret).join('[redacted]'),String(text??''));
  try{
    fs.writeFileSync(userconfig,plan.config,{mode:0o600});
    const env={...environment,NODE_OPTIONS:'--max-old-space-size=512',XDG_CACHE_HOME:cache};
    for(const key of Object.keys(env))if(/^(?:REGISTRY_(?:TOKEN|PASSWORD)|NODE_AUTH_TOKEN|NPM_TOKEN|NPM_PUBLISHER_PASSWORD|UNION_PRIVATE_NPM_REGISTRY_PASSWORD)$/i.test(key))delete env[key];
    const args=['exec','--yes','--ignore-scripts','--cache='+path.join(cache,'bootstrap'),
      '--userconfig='+userconfig,'--package=pnpm@'+plan.version,'--','pnpm','install','--frozen-lockfile','--ignore-scripts',
      '--network-concurrency=4','--child-concurrency=1','--store-dir='+store,'--config.cache-dir='+cache,'--config.userconfig='+userconfig];
    const result=run('npm',args,{cwd:plan.cwd,env,encoding:'utf8',maxBuffer:8*1024*1024});
    if(result.stdout)process.stdout.write(redact(result.stdout));
    if(result.stderr)process.stderr.write(redact(result.stderr));
    if(result.error||result.status!==0)throw new Error('frozen PNPM installation failed'+(Number.isInteger(result.status)?' (exit '+result.status+')':''));
    if(digest(plan.manifest)!==plan.before.manifest||digest(plan.lock)!==plan.before.lock)throw new Error('frozen install changed source package or lock');
    return {kind:'continuous-delivery.pnpm-install',version:plan.version,pinSource:plan.pinSource,frozen:true,lifecycleScripts:false,credentialsRemoved:true};
  }finally{fs.rmSync(stage,{recursive:true,force:true});}
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{console.log(JSON.stringify(installPnpm({directory:process.cwd(),temporary:process.env.RUNNER_TEMP??'',
    pnpmVersion:process.env.PNPM_VERSION??'',
    registry:process.env.REGISTRY_URL??'',username:process.env.REGISTRY_USERNAME??'',
    token:process.env.REGISTRY_TOKEN??'',password:process.env.REGISTRY_PASSWORD??''})));}
  catch(error){console.error(error.message);process.exitCode=1;}
}

