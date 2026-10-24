#!/usr/bin/env node
// One native placement entrypoint for a single original job or an entire
// bounded original office shift. No external dispatch or ledger persistence.
 // Verified SHP Work articles can be unpacked into this original --jobs reader
 // via stdin; a packet's hash/rights must be qualified by the SHP receiver.
import fs from 'node:fs';
import path from 'node:path';
import { newLedger, newObservedBudget } from '../src/placement/allowance.mjs';
import { place, planFleet } from '../src/placement/place.mjs';
import { recoverFleetCapacity } from '../src/placement/recover.mjs';

const MAX_WORK_INPUT_BYTES=8*1024*1024;
const args={};
const words=process.argv.slice(2);
const flags=new Set(['budget-stdin','recover-capacity']);
const values=new Set(['job','jobs','nodes','now','used','observed-at','plan']);
for(let i=0;i<words.length;i++){
  const token=words[i],key=token.startsWith('--')?token.slice(2):'';
  if((!flags.has(key)&&!values.has(key))||Object.hasOwn(args,key))
    throw new TypeError('unknown or duplicate original placement argument: '+token);
  if(flags.has(key)){args[key]=true;continue;}
  const value=words[++i];
  if(value===undefined||value.startsWith('--'))
    throw new TypeError('missing original placement argument '+token);
  args[key]=value;
}
if(args['recover-capacity']&&!args.jobs)
  throw new TypeError('capacity recovery only applies to an original --jobs batch');
if(Boolean(args.job)===Boolean(args.jobs)||!args.nodes)
  throw new TypeError('exactly one of --job or --jobs and the original --nodes required');
const at=args.now??new Date().toISOString();
if(!Number.isFinite(Date.parse(at)))
  throw new TypeError('valid placement observation time required');
// --jobs - accepts the exact JSON produced by the source-owned SHP
// "unpack-work" command, without creating an unchecked intermediate file.
// Never share stdin between Work and provider-budget observations.
const workPath=args.jobs??args.job;
if(workPath==='-'&&args['budget-stdin'])
  throw new TypeError('original Work and independent provider budget may not share stdin');
const readWork=async()=>{
  if(workPath!=='-'){
    const stats=fs.statSync(workPath);
    if(!stats.isFile()||stats.size>MAX_WORK_INPUT_BYTES)
      throw new TypeError('original Work input must be a regular file of at most 8 MiB');
    return fs.readFileSync(workPath,'utf8');
  }
  const chunks=[];let length=0;
  for await(const chunk of process.stdin){
    length+=chunk.length;
    if(length>MAX_WORK_INPUT_BYTES)
      throw new TypeError('original Work stdin exceeds 8 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,length).toString('utf8');
};
const input=JSON.parse(await readWork());
const nodes=fs.readdirSync(args.nodes).filter(f=>f.endsWith('.json')).sort()
  .map(f=>JSON.parse(fs.readFileSync(path.join(args.nodes,f),'utf8')));
if((args.jobs&&!Array.isArray(input))||(!args.jobs&&Array.isArray(input)))
  throw new TypeError('job/batch input shape does not match selected mode');
// Hosted private GitHub minutes remain unobserved unless both usage and
// the independent source time are present. No missing observation means zero.
if((args.used===undefined)!==(args['observed-at']===undefined))
  throw new TypeError('hosted usage and observed-at must be supplied together');
const ledger=args.used===undefined?null:newLedger({
  plan:args.plan??'free',month:at.slice(0,7),
  usedMinutes:Number(args.used),observedAt:args['observed-at']
});
let budgets={};
if(args['budget-stdin']){
  const source=JSON.parse(fs.readFileSync(0,'utf8'));
  const records=Array.isArray(source)?source:[source];
  budgets=Object.fromEntries(records.map(record=>{
    const budget=newObservedBudget(record);
    return [budget.scope,budget];
  }));
  if(Object.keys(budgets).length!==records.length)
    throw new Error('duplicate original provider scope in current budget observations');
}
const ctx={ledger,budgets,now:at};
const proposal=args.jobs?
  (args['recover-capacity']?recoverFleetCapacity(input,nodes,ctx):planFleet(input,nodes,ctx)):
  place(input,nodes,ctx);
process.stdout.write(JSON.stringify(proposal,(_k,v)=>v===Infinity?'unbounded':v,2)+'\n');
