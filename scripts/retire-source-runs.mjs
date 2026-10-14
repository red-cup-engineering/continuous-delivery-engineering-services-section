#!/usr/bin/env node
import {execFileSync,spawnSync} from 'node:child_process';
import {readFile,lstat,writeFile,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {gitWorktreePlan} from '@red-cup-engineering/git-services-section/git-command-codec';
import {retireQueuedSourceRuns,receiveSourceRunRetirements} from '../src/queued-source-runs.mjs';
const args=process.argv.slice(2),receiving=args[0]==='receive';
const [input,output,...extra]=receiving?[args[1],args[1],...args.slice(2)]:args;
if(!input||!output||extra.length)throw new TypeError('usage: retire-source-runs REQUEST.json RECEIPT.json | receive RECEIPT.json');
if(!receiving&&await lstat(output).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))
  throw new Error('receipt already exists; receive its cancellation outcomes before another invocation');
const entry=await lstat(input);
if(!entry.isFile()||entry.size>1024*1024)throw new Error('bounded regular request or receipt required');
const selection=JSON.parse(await readFile(input,'utf8'));
const workspace=receiving?undefined:await realpath(selection.workspace);
const git=(...args)=>execFileSync('git',['-C',workspace,...args],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024}).trim();
if(!receiving){
  if(await realpath(git('rev-parse','--show-toplevel'))!==workspace)throw new Error('actual source repository root required');
  const origin=git('remote','get-url','origin').replace(/^git@github.com:/,'https://github.com/').replace(/\.git$/,'');
  if(origin!==`https://github.com/${selection.repository}`)throw new Error('source origin differs from selected repository');
  if(git('rev-parse',`${selection.expectedDefault}^{commit}`)!==selection.expectedDefault)throw new Error('exact reviewed default object required');
}
let created=receiving;
const operations={
  request:async(method,path)=>{
    const result=execFileSync('gh',['api',path,'--method',method],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
    return result.trim()?JSON.parse(result):null;
  },
  isAncestor:async(older,current)=>{
    const plan=gitWorktreePlan.isAncestor(older,current);
    const result=spawnSync(plan.command,plan.arguments,{cwd:workspace,env:{...process.env,GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1'},stdio:'pipe',timeout:30000});
    return result.status===0;
  },
  retain:async(value)=>{
    await writeFile(output,JSON.stringify(value)+'\n',{flag:created?'w':'wx',mode:0o600}); created=true;
  },
};
const receipt=await (receiving?receiveSourceRunRetirements:retireQueuedSourceRuns)(selection,operations);
process.stdout.write(JSON.stringify({type:receipt.type,repository:receipt.repository,observedQueued:receipt.observedQueued,
  cancellationRequests:receipt.cancellationRequests,received:receipt.runs.filter(r=>r.state==='cancellation-received').length,
  retainedReceipt:resolve(output),executionReceiving:false})+'\n');
