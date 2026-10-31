import assert from 'node:assert/strict';
import test from 'node:test';
import { attune } from '../src/loop/attune.mjs';
import { deadSegment, pause } from '../src/loop/pause.mjs';

const G = name => `/gnu/store/${name.padEnd(32, '0')}-bare-cedar-fog-deployment-1`;
const OLD = G('sq5kwc4b6y2k7h7izqi6rjbadjvvagwy'), MID = G('95nx60hafpxm8hnd4vwspwivb3krbsdq'), NEW = G('f2ac4ayk7xb5sqihmbllbryfb98z6wlb');
const NOW = Date.parse('2026-10-30T22:00:00Z');

// Bare Cedar Fog as it stood on 2026-10-30, before anyone dug: the jams found by hand.
function host({ calm = false } = {}) {
  const units = calm
    ? { 'bare-cedar-fog-561-group.service': { active: 'active', exec: `${NEW}/node_modules/x/serve.mjs`, env: '' } }
    : {
      'release-on-landing.service': { active: 'active', exec: `${MID}/node_modules/lagoon/scripts/release-on-landing.mjs`, env: '',
        journal: JSON.stringify({ at: '2026-10-30T21:40:16Z', target: 'cold-red-gate', state: 'held', reason: 'native-release-drift-or-rollback', since: '2026-10-30T20:44:17Z' }) },
      'compose-on-publication.service': { active: 'failed', exec: `${OLD}/node_modules/gh/compose.mjs`, envFiles: `${OLD}/.guix-systemd/compose.environment` },
      'bare-cedar-fog-561-group.service': { active: 'active', exec: `${MID}/node_modules/x/serve.mjs`, envFiles: `${NEW}/.guix-systemd/environment` },
      'ci-runner-bare-cedar-fog-guix.service': { active: 'active', exec: '/colony/data/state/ci-runner-state/guix/run.sh', env: '' },
    };
  const files = {
    [`${OLD}/.guix-systemd/compose.environment`]: 'COMPOSE_STATE_DIR="/colony/services/561-group-services-section/services/ops/data/state/github-composition-service-state/bcf"\n',
    [`${NEW}/.guix-systemd/environment`]: 'CREDENTIALS_STORE="/colony/services/internal-services-section/data/state/credentials"\n',
    '/proc/pressure/memory': calm ? 'some avg10=0 avg60=0 avg300=0 total=1\nfull avg10=0.10 avg60=0.20 avg300=0.30 total=1\n'
      : 'some avg10=13 avg60=26 avg300=48 total=1\nfull avg10=12.54 avg60=23.06 avg300=39.45 total=1\n',
    '/proc/meminfo': 'MemAvailable: 5472716 kB\nSwapFree: 110028 kB\n',
  };
  // The colony is one repository; internal-services-section is a mounted section; the
  // 561-group-services-section tree was rebuilt by a stale writer and nothing tracks it.
  const dirs = new Set(['/colony', '/colony/services', '/colony/services/internal-services-section', '/colony/services/internal-services-section/data',
    '/colony/services/internal-services-section/data/state', '/colony/services/internal-services-section/data/state/credentials',
    '/colony/services/561-group-services-section', '/colony/services/561-group-services-section/services']);
  return {
    services: () => Object.entries(units).map(([unit, u]) => ({ unit, load: 'loaded', active: u.active, sub: u.active === 'active' ? 'running' : 'failed' })),
    show: unit => ({ ExecStart: `{ path=${units[unit].exec} }`, WorkingDirectory: '', EnvironmentFiles: units[unit].envFiles ? `${units[unit].envFiles} (ignore_errors=no)` : '', Environment: units[unit].env ?? '' }),
    lastJournal: unit => units[unit].journal ?? '',
    readFile: f => files[f] ?? null,
    exists: d => dirs.has(d) || [...dirs].some(x => x.startsWith(d + '/')),
    toplevel: d => d.startsWith('/colony/services/internal-services-section') ? '/colony/services/internal-services-section' : d.startsWith('/colony') ? '/colony' : null,
    tracked: (repo, rel) => repo === '/colony' ? ['services', 'services/internal-services-section'].includes(rel) : true,
    now: () => NOW,
  };
}
const capacity = calm => () => ({ availableBytes: calm ? 115e9 : 97.6e9, floorBytes: 100e9 });

test('the loop names every jam found by hand on 2026-10-30, each with an owner and an admissible action', () => {
  const obstructions = attune(pause(host(), { colony: '/colony', capacity: capacity(false) }));
  const kinds = obstructions.map(o => `${o.kind} ${o.subject}`).sort();
  assert.deepEqual(kinds, [
    'disk-below-floor host',
    'memory-stalled host',
    'mixed-generations host',
    'state-path-stray compose-on-publication.service',
    'unit-failed compose-on-publication.service',
    'unit-held-while-active release-on-landing.service',
    'unit-loads-two-generations bare-cedar-fog-561-group.service',
  ]);
  for (const o of obstructions) assert.ok(o.owner && o.actions.length, JSON.stringify(o));
  const stray = obstructions.find(o => o.kind === 'state-path-stray');
  assert.equal(stray.evidence.deadAt, '/colony/services/561-group-services-section');
  assert.deepEqual(obstructions.find(o => o.kind === 'unit-failed').actions, ['deliver-host']);
});

test('a calm host has nothing to attune to', () => {
  assert.deepEqual(attune(pause(host({ calm: true }), { colony: '/colony', capacity: capacity(true) })), []);
});

test('ignored runtime state under a live section is live, not stray', () => {
  assert.equal(deadSegment(host(), '/colony', '/colony/services/internal-services-section/data/state/credentials'), null);
});

test('runtime data its repository ignores is live; an untracked, unignored directory is stray', () => {
  const site = { ...host(), exists: () => true, toplevel: () => '/colony', tracked: (repo, rel) => rel === 'sites',
    ignored: (repo, rel) => rel === 'sites/data' };
  assert.equal(deadSegment(site, '/colony', '/colony/sites/data/settlement'), null);
  assert.equal(deadSegment(site, '/colony', '/colony/sites/old-copy/state'), '/colony/sites/old-copy');
});
