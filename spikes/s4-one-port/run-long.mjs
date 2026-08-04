/**
 * The ten minutes of wall clock this spike is really about.
 *
 *   node spikes/s4-one-port/run-long.mjs   # ~11 minutes
 *
 * One harness on 127.0.0.1:7777 emitting one event per second, with:
 *   - a client connected directly to it for the full ten minutes;
 *   - a second client connected through a Vite dev proxy for the same ten
 *     minutes, because "long streams die after several minutes behind the
 *     proxy" is a claim about minutes and cannot be checked in seconds;
 *   - a `.vue` edit at t=300 s, with Vite's HMR websocket watched from here.
 *
 * The output — `measurements/*.csv` plus `measurements/ten-minutes.json` — is
 * committed, and `test/integration/spike-s4-one-port.test.ts` asserts AC2 and
 * AC3 against it. Re-running this file overwrites the recording; the assertions
 * then hold or they do not.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AC1_PORT,
  listeningSockets,
  MEASUREMENTS_DIR,
  observations,
  SPIKE_ROOT,
  sleep,
  startHarness,
  startProxy,
  stopAll,
} from './src/harness.ts';

const DURATION_SECONDS = Number(process.env.S4_DURATION_SECONDS ?? 600);
const EDIT_AT_SECONDS = Number(process.env.S4_EDIT_AT_SECONDS ?? 300);
const SFC = join(SPIKE_ROOT, 'app/src/Live.vue');
const MARKER = 'one port, one process';

mkdirSync(MEASUREMENTS_DIR, { recursive: true });

const runClient = (url, out, label) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        'client.mjs',
        '--url',
        url,
        '--seconds',
        String(DURATION_SECONDS),
        // One event per second for ten minutes is 600 of them; the first lands
        // a second after connecting, so the client waits for the last one
        // rather than hanging up on the stopwatch.
        '--until-events',
        String(DURATION_SECONDS),
        '--out',
        join(MEASUREMENTS_DIR, out),
        '--label',
        label,
      ],
      { cwd: SPIKE_ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
    );
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} client exited ${code}`)),
    );
  });

const harness = await startHarness({ S4_PORT: String(AC1_PORT), S4_INTERVAL_MS: '1000' });
const sockets = listeningSockets(harness.pid);
console.log(`harness pid ${harness.pid} listening on`, sockets);

const proxy = await startProxy(AC1_PORT);

// The browser's own HMR channel, watched from Node: this is how "an HMR update
// is applied" is observed without a browser in this particular run. The e2e
// spec asserts the browser half against a real Chromium.
const hmr = new WebSocket(`ws://127.0.0.1:${AC1_PORT}`, 'vite-hmr');
const hmrMessages = [];
hmr.addEventListener('message', (event) => {
  try {
    hmrMessages.push({ at: Date.now(), message: JSON.parse(String(event.data)) });
  } catch {
    // Vite only ever sends JSON frames.
  }
});
await new Promise((resolve, reject) => {
  hmr.addEventListener('open', resolve);
  hmr.addEventListener('error', () => reject(new Error('the HMR websocket would not open')));
});

// Put the SFC in Vite's module graph, which is what makes an edit an update
// rather than a full reload.
for (const path of ['/', '/src/main.ts', '/src/Live.vue', '/src/recorder.ts']) {
  await fetch(`${harness.origin}${path}`);
}

const clients = Promise.all([
  runClient(`${harness.origin}/api/stream`, 'ten-minutes-direct.csv', 'direct'),
  runClient(`${proxy.origin}/api/stream`, 'ten-minutes-proxied.csv', 'proxied'),
]);

await sleep(EDIT_AT_SECONDS * 1000);
const original = readFileSync(SFC, 'utf8');
const editAt = Date.now();
writeFileSync(SFC, original.replace(MARKER, `${MARKER}, still`));
console.log(`edited ${SFC} at t=${EDIT_AT_SECONDS}s`);

await sleep(10_000);
writeFileSync(SFC, original);
await sleep(5_000);

await clients;

// How long the backend takes to learn that a client went away — the third
// documented proxy failure mode, measured from the outside.
const closingAt = Date.now();
let backendSawCloseMs = null;
let openAfter = (await observations(harness.origin)).open;
for (let waited = 0; waited < 30_000; waited += 250) {
  openAfter = (await observations(harness.origin)).open;
  if (openAfter === 0) {
    backendSawCloseMs = Date.now() - closingAt;
    break;
  }
  await sleep(250);
}

const meta = (file) =>
  JSON.parse(readFileSync(join(MEASUREMENTS_DIR, `${file}.meta.json`), 'utf8'));
const direct = meta('ten-minutes-direct.csv');
const proxied = meta('ten-minutes-proxied.csv');

const updates = hmrMessages.filter(({ message }) => message.type === 'update');
const firstUpdate = updates.find(({ at }) => at >= editAt);

const summary = {
  recordedAt: new Date().toISOString(),
  node: process.version,
  vite: JSON.parse(readFileSync(join(SPIKE_ROOT, 'package.json'), 'utf8')).devDependencies.vite,
  port: AC1_PORT,
  durationSeconds: DURATION_SECONDS,
  intervalMs: 1_000,
  listeningSockets: sockets,
  direct: {
    csv: 'ten-minutes-direct.csv',
    events: direct.events,
    heldForMs: direct.heldForMs,
    endedEarly: direct.endedEarly,
    headers: direct.headers,
  },
  hmr: {
    file: 'app/src/Live.vue',
    editAtMs: editAt - direct.connectedWallClock,
    updateReceivedAtMs: firstUpdate === undefined ? -1 : firstUpdate.at - direct.connectedWallClock,
    updatedModules:
      firstUpdate === undefined
        ? []
        : (firstUpdate.message.updates ?? []).map((update) => update.path ?? update.acceptedPath),
    // The Node client has no reconnect logic at all, so what this records is
    // that it never had to: the body stayed open across the edit. The browser's
    // "readyState never left OPEN" is asserted in e2e/spike-s4-one-port.test.ts.
    streamEnded: direct.endedEarly,
    reconnects: 0,
    allMessageTypes: [...new Set(hmrMessages.map(({ message }) => message.type))],
  },
  proxied: {
    csv: 'ten-minutes-proxied.csv',
    events: proxied.events,
    diedAfterMs: proxied.endedEarly ? proxied.endedAtMs : null,
    headers: proxied.headers,
    backendSawCloseMs,
    backendStillOpenConnections: openAfter,
  },
};

writeFileSync(join(MEASUREMENTS_DIR, 'ten-minutes.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

await stopAll();
process.exit(0);
