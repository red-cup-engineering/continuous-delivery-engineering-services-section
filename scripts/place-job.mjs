#!/usr/bin/env node
// node scripts/place-job.mjs --job <job.json> --nodes <dir> [--used <observed minutes> --observed-at <ISO>] [--budget-stdin] [--now <iso>]
import fs from 'node:fs';
import path from 'node:path';
import { newLedger, newObservedBudget } from '../src/placement/allowance.mjs';
import { place } from '../src/placement/place.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const job = JSON.parse(fs.readFileSync(arg('job'), 'utf8'));
const dir = arg('nodes');
const nodes = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const now = arg('now', new Date().toISOString());
// Missing authoritative hosted usage is NOT zero. Allow local-held nodes to
// compete without a GitHub allowance; private hosted minutes refuse.
const used=arg('used');
const ledger=used===undefined?null:newLedger({plan:arg('plan','free'),
  month:now.slice(0,7),usedMinutes:Number(used),
  observedAt:arg('observed-at')});
let budgets={};
if(process.argv.includes('--budget-stdin')){
  // The caller's authenticated provider adapter passes ephemeral observations
  // through stdin. Never persist a guessed account/host source registry.
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  const records=Array.isArray(input)?input:[input];
  budgets=Object.fromEntries(records.map(record=>{
    const budget=newObservedBudget(record);
    return [budget.scope,budget];
  }));
  if(Object.keys(budgets).length!==records.length)
    throw new Error('duplicate provider scope in original budget observations');
}
console.log(JSON.stringify(place(job,nodes,{ledger,budgets,now}),
  (_k,v)=>v===Infinity?'unbounded':v,2));
