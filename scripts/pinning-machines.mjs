// Which machines a repository's change must be tested against: every machine snapshot whose sources.json pins it.
//   node pinning-machines.mjs OWNER/REPO MACHINE=SOURCES_JSON [MACHINE=SOURCES_JSON ...]
// prints a JSON array of the machines (owner/repo) that pin OWNER/REPO, in the order given. A machine whose
// sources.json could not be read (an empty or missing file) is listed on stderr and left out, never guessed.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The machines among READINGS ({machine: sources.json value}) whose repositories include REPOSITORY. */
export function machinesPinning(repository, readings) {
  const wanted = repository.toLowerCase();
  return Object.entries(readings)
    .filter(([, sources]) => Array.isArray(sources?.repositories)
      && sources.repositories.some((source) => String(source?.repository ?? '').toLowerCase() === wanted))
    .map(([machine]) => machine);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [repository, ...pairs] = process.argv.slice(2);
  if (!repository || !pairs.length || pairs.some((pair) => !/^[^=\s]+\/[^=\s]+=.+$/.test(pair))) {
    process.stderr.write('usage: pinning-machines.mjs OWNER/REPO MACHINE=SOURCES_JSON [MACHINE=SOURCES_JSON ...]\n');
    process.exit(1);
  }
  const readings = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const machine = pair.slice(0, at), file = pair.slice(at + 1);
    try { readings[machine] = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { process.stderr.write(`unread: ${machine} (${error.message})\n`); }
  }
  process.stdout.write(`${JSON.stringify(machinesPinning(repository, readings))}\n`);
}
