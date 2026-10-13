// Discover pins only from complete readable source declarations. Unknown coverage is an error, never [].
//   node pinning-machines.mjs OWNER/REPO MACHINE=SOURCES_JSON [MACHINE=SOURCES_JSON ...]
// The workflow's --plan form binds each machine snapshot to the immutable repository commit read at discovery.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const isCommit = (value) => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/.test(value);
const isRepository = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+(?![\s\S])/i.test(value)
  && !['.', '..'].includes(value.split('/')[1]);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Canonical repository spelling, preserving the case-sensitive snapshot path. */
export function machineName(value) {
  if (typeof value !== 'string') throw new Error('invalid machine identity');
  const [repository, snapshot, extra] = value.split(':');
  if (!isRepository(repository) || extra !== undefined || (snapshot !== undefined
    && (!snapshot || snapshot.split('/').some((part) => !/^[a-z0-9_.-]+(?![\s\S])/i.test(part) || ['.', '..'].includes(part))))) {
    throw new Error(`invalid machine identity: ${value}`);
  }
  return repository.toLowerCase() + (snapshot === undefined ? '' : `:${snapshot}`);
}

export function machineEntry(machine, machineCommit) {
  machine = machineName(machine);
  if (!isCommit(machineCommit)) throw new Error(`invalid machine commit: ${machine}`);
  return { machine, machineCommit, id: createHash('sha256').update(JSON.stringify([machine, machineCommit])).digest('hex') };
}

export function validatePlan(plan) {
  if (!Array.isArray(plan)) throw new Error('invalid expected machine coverage: an array is required');
  const seen = new Set();
  return plan.map((entry) => {
    if (!object(entry)) throw new Error('invalid expected machine entry');
    const normalized = machineEntry(entry.machine, entry.machineCommit);
    if (entry.machine !== normalized.machine || entry.id !== normalized.id) throw new Error(`invalid machine identity: ${entry.machine}`);
    if (seen.has(normalized.machine)) throw new Error(`duplicate expected machine: ${normalized.machine}`);
    seen.add(normalized.machine);
    return normalized;
  });
}

/** The machines among READINGS whose valid repositories include REPOSITORY. */
export function machinesPinning(repository, readings) {
  if (!isRepository(repository) || !object(readings)) throw new Error('invalid repository or machine readings');
  const wanted = repository.toLowerCase(), seenMachines = new Set(), pinned = [];
  for (const [machine, sources] of Object.entries(readings)) {
    const canonical = machineName(machine);
    if (seenMachines.has(canonical)) throw new Error(`duplicate machine: ${machine}`);
    seenMachines.add(canonical);
    if (!object(sources) || !Array.isArray(sources.repositories)) throw new Error(`unread or invalid sources: ${machine}`);
    const repositories = new Set();
    for (const source of sources.repositories) {
      if (!object(source) || !isRepository(source.repository) || !isCommit(source.commit)) throw new Error(`invalid source pin: ${machine}`);
      const name = source.repository.toLowerCase();
      if (repositories.has(name)) throw new Error(`duplicate source pin: ${machine} (${name})`);
      repositories.add(name);
    }
    if (repositories.has(wanted)) pinned.push(machine);
  }
  return pinned;
}

function readJson(file, name) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`unread or invalid JSON: ${name}`); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--candidates') {
      const candidates = args[1] ? [args[1]] : JSON.parse(args[2]);
      if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('invalid machine candidates: an array is required');
      const names = candidates.map(machineName);
      if (new Set(names).size !== names.length) throw new Error('duplicate machine candidates');
      if (names.length) process.stdout.write(names.join('\n') + '\n');
    } else if (args[0] === '--commit') {
      const commit = readJson(args[1], 'machine commit')?.sha;
      if (!isCommit(commit)) throw new Error('invalid machine commit');
      process.stdout.write(commit + '\n');
    } else {
      const plan = ['--plan', '--forced-plan'].includes(args[0]), forced = args[0] === '--forced-plan';
      if (plan) args.shift();
      const [repository, ...pairs] = args;
      if (!isRepository(repository) || (!plan && !pairs.length) || (forced && pairs.length !== 1)) throw new Error('invalid discovery arguments');
      const readings = Object.create(null), entries = [];
      for (const pair of pairs) {
        const at = pair.indexOf('='), identity = pair.slice(0, at), file = pair.slice(at + 1);
        if (at < 1 || !file) throw new Error('invalid machine source pair');
        const split = plan ? identity.lastIndexOf('@') : -1;
        const machine = machineName(plan ? identity.slice(0, split) : identity);
        if (Object.hasOwn(readings, machine)) throw new Error(`duplicate machine: ${machine}`);
        if (plan) entries.push(machineEntry(machine, identity.slice(split + 1)));
        readings[machine] = forced ? null : readJson(file, machine);
      }
      const pinned = forced ? Object.keys(readings) : machinesPinning(repository, readings);
      process.stdout.write(JSON.stringify(plan ? entries.filter((entry) => pinned.includes(entry.machine)) : pinned) + '\n');
    }
  } catch (error) {
    process.stderr.write(`pinning-machines: ${error.message}\n`);
    process.exitCode = 1;
  }
}
