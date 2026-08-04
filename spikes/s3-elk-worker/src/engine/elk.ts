/**
 * The recipe under test, in six lines: Vite's `?worker` import plus ELK's
 * `workerFactory`.
 *
 * ELK's own documentation offers `workerUrl` instead, and that is the option
 * that cannot work here — it wants a path that is publicly served under a name
 * known at authoring time, and `vite build` renames the file to
 * `elk-worker.min-<hash>.js`. `?worker` is what teaches Vite the file is a
 * worker entry, so it gets its own chunk, its own hash, and a URL the built
 * bundle already knows.
 *
 * `elk-worker.min.js` rather than `elk-worker.js`: 1.6 MB against 4.8 MB, and
 * 1.6 MB is the number AC2 is written about.
 *
 * The Worker constructor is wrapped before ELK reaches it purely so the spec
 * can assert on the URL the browser really fetched. Nothing else here is
 * instrumented; the layout call is ELK's own.
 */
import ElkConstructor, { type ELK } from 'elkjs/lib/elk-api.js';
import ElkWorker from 'elkjs/lib/elk-worker.min.js?worker';

let workerUrl: string | null = null;

export const elkAvailable = true;

export function lastWorkerUrl(): string | null {
  return workerUrl;
}

export function createEngine(): ELK {
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = class RecordingWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      workerUrl = new URL(String(url), globalThis.location.href).href;
      super(url, options);
    }
  };
  try {
    return new ElkConstructor({ workerFactory: () => new ElkWorker() });
  } finally {
    globalThis.Worker = NativeWorker;
  }
}
