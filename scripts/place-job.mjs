#!/usr/bin/env node
// One native placement entrypoint for a single original job or an entire
// bounded original office shift. No external dispatch or ledger persistence.
import fs from 'node:fs';
import path from 'node:path';
import { newLedger, newObservedBudget } from '../src/placement/allowance.mjs';
import { place, planFleet } from '../src/placement/place.mjs';

const args={};
const words=process.argv.slice(2);
const flags=new Set(['budget-stdin']);
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
if(Boolean(args.job)===Boolean(args.jobs)||!args.nodes)
  throw new TypeError('exactly one of --job or --jobs and the original --nodes required');
const at=args.now??new Date().toISOString();
if(!Number.isFinite(Date.parse(at)))
  throw new TypeError('valid placement observation time required');
const input=JSON.parse(fs.readFileSync(args.jobs??args.job,'utf8'));
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
// Session jobs can be described by the original job/node JSON, but this CLI is
// not an authenticated host-admission reader. Do not accept an admission file,
// executable callback path, environment flag or boolean as a substitute. Its
// session proposals therefore retain session-admission-unreceived until the
// existing owning host composes the read-only receiver with place/planFleet.
const ctx={ledger,budgets,now:at};
const proposal=args.jobs?planFleet(input,nodes,ctx):place(input,nodes,ctx);
process.stdout.write(JSON.stringify(proposal,(_k,v)=>v===Infinity?'unbounded':v,2)+'\n');
