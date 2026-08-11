/**
 * The soak body, run as its own `node --expose-gc` process.
 *
 * A separate process for one reason: the assertion is about **retained** heap,
 * and the only honest way to measure that is `process.memoryUsage().heapUsed`
 * immediately after a forced major collection. Vitest's worker holds the whole
 * runner, the module graph and every other spec's fixtures, so a sample taken
 * inside it measures the suite. This process holds a Pinia and a store.
 *
 * It prints one JSON line per phase to stdout and nothing else, so the spec
 * that spawns it (`./store-soak.test.ts`) does the asserting.
 *
 * Usage: `node --expose-gc store-soak-child.ts <nodes> <phases> <eventsPerPhase>`
 */
import { type Event, parseEvent } from '@DeFlow/core';
import { createPinia, setActivePinia } from 'pinia';
import { useRunStore } from '../../src/stores/useRunStore.ts';

const RUN = 'run_20260806T141133Z_9f2a1c';

const nodes = Number(process.argv[2] ?? 400);
const phases = Number(process.argv[3] ?? 8);
const perPhase = Number(process.argv[4] ?? 25_000);

const nodeId = (index: number) => `n-${String(index).padStart(4, '0')}`;

let seq = 0;

function envelope(kind: string, v: number, payload: unknown): Event {
  seq += 1;
  const parsed = parseEvent({
    seq,
    runId: RUN,
    ts: 1_754_140_000_000 + seq,
    kind,
    v,
    epoch: 7,
    payload,
  });
  if (parsed.status !== 'ok') {
    throw new Error(`the soak built an unreadable envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.event;
}

setActivePinia(createPinia());
const store = useRunStore();
store.open(RUN);

// The plan: `nodes` scheduled nodes, which is the bound every count below is
// asserted against.
for (let index = 0; index < nodes; index += 1) {
  store.applyEvent(
    envelope('node.scheduled', 1, {
      node: nodeId(index),
      provider: 'claude',
      permission: 'read',
    }),
  );
}

// A terminal per phase, adopted and disposed, so "zero undisposed Terminal
// instances" is a claim about a store that actually handled some.
let disposed = 0;

/** A forced major collection, then the retained heap. */
function retained(): number {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (typeof collect !== 'function') {
    throw new TypeError('the soak must run under --expose-gc; a heap sample without one is noise');
  }
  collect();
  collect();
  return process.memoryUsage().heapUsed;
}

for (let phase = 0; phase < phases; phase += 1) {
  const key = `terminal-${phase}`;
  store.adoptTerminal(key, {
    dispose() {
      disposed += 1;
    },
  });

  for (let n = 0; n < perPhase; n += 1) {
    // `node.progress` is the event a real run produces most of, and the one
    // docs/12 §5.2 says must reach the terminal buffer and *nowhere else*.
    store.applyEvent(
      envelope('node.progress', 1, {
        node: nodeId(n % nodes),
        attempt: 1,
        phase: 'running',
        message: `phase ${phase} tick ${n}`,
      }),
    );
  }

  // Read the selectors, because a lazy `computed` nobody reads does no work and
  // allocates no snapshots — a soak that never rendered would be measuring a
  // store nobody used.
  const rendered = store.planNodes.length + store.planEdges.length + store.timelineSpans.length;
  store.disposeTerminal(key);

  process.stdout.write(
    `${JSON.stringify({
      phase,
      applied: store.applied,
      seq: store.seq,
      rendered,
      counts: store.counts(),
      heapUsed: retained(),
    })}\n`,
  );
}

store.close();
process.stdout.write(
  `${JSON.stringify({ done: true, disposed, terminals: store.counts().terminals })}\n`,
);
