/**
 * The measuring client: connects to an SSE endpoint, records when each event
 * *arrived*, and writes the receipts to a CSV.
 *
 *   node client.mjs --url http://127.0.0.1:7777/api/stream \
 *                   --seconds 600 --out measurements/ten-minutes-direct.csv
 *
 * A CSV rather than a log line per event, because AC2 is a distribution: "600
 * events with inter-arrival gaps clustered at ~1000 ms and no gap greater than
 * 3 s — measured from the CSV, not by watching a terminal". A terminal scrolling
 * once a second looks identical whether the gaps are 1000 ms or 900/1100, and
 * it looks fine right up until the stream dies.
 *
 * Alongside the CSV it writes `<out>.meta.json`: the wall clock the client
 * started at (so an edit made elsewhere can be placed on the same timeline),
 * and whether the body ended before the run was over — which is how "the stream
 * dies silently after several minutes" is detected rather than assumed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { connectSse } from './src/sse-client.ts';

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const url = flag('url', 'http://127.0.0.1:7777/api/stream');
const seconds = Number(flag('seconds', '600'));
/**
 * Stay connected until the run is both long enough *and* complete. Ten minutes
 * of a one-per-second stream is 600 events, but the first one lands a second
 * after connecting, so a client that hangs up at exactly 600.0 s has 599 of
 * them and AC2 reads as failed for a reason that is about the stopwatch rather
 * than about the stream. Waiting for the six hundredth is the honest fix;
 * trimming or padding the CSV afterwards would not be.
 */
const untilEvents = Number(flag('until-events', '0'));
const graceMs = Number(flag('grace-ms', '60000'));
const out = resolve(process.cwd(), flag('out', 'measurements/stream.csv'));
const label = flag('label', 'direct');

const startedWallClock = Date.now();
const stream = await connectSse(url);
const connectedWallClock = Date.now();

const deadline = connectedWallClock + seconds * 1000;
const hardDeadline = deadline + graceMs;
for (;;) {
  const now = Date.now();
  if (now >= hardDeadline) break;
  // A stream that died is not going to reach the count; stop and say so.
  if (stream.ended()) break;
  if (now >= deadline && stream.events().length >= untilEvents) break;
  await new Promise((done) => setTimeout(done, 100));
}

// Read these *before* closing: closing the client ends the body too, and a
// stream that died on its own would then be indistinguishable from one we
// hung up on.
const endedEarly = stream.ended();
const endedAtMs = stream.endedAtMs();
stream.close();

const events = stream.events();
const rows = ['seq,event,receivedAtMs,gapMs'];
for (const [index, event] of events.entries()) {
  const previous = index === 0 ? undefined : events[index - 1];
  const gap = previous === undefined ? '' : (event.receivedAtMs - previous.receivedAtMs).toFixed(3);
  rows.push(`${event.seq},${event.event},${event.receivedAtMs.toFixed(3)},${gap}`);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${rows.join('\n')}\n`);
writeFileSync(
  `${out}.meta.json`,
  `${JSON.stringify(
    {
      label,
      url,
      seconds,
      untilEvents,
      startedWallClock,
      connectedWallClock,
      heldForMs: Date.now() - connectedWallClock,
      events: events.length,
      // A body that ended before we closed it is a stream that died.
      endedEarly,
      endedAtMs,
      error: stream.error() === undefined ? null : String(stream.error()),
      headers: {
        'content-type': stream.responseHeaders().get('content-type'),
        'cache-control': stream.responseHeaders().get('cache-control'),
        'x-accel-buffering': stream.responseHeaders().get('x-accel-buffering'),
        'content-encoding': stream.responseHeaders().get('content-encoding'),
      },
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(`${label}: ${events.length} events -> ${out}\n`);
