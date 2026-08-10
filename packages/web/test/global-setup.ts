/**
 * Starts the SSE origin the browser specs connect to, once for the whole `web`
 * slice, and hands its URL to them through `inject('sseOrigin')`.
 *
 * `globalSetup` rather than a `beforeAll`: this runs in Node, and a spec that
 * runs in Chromium cannot start a server for itself. See `./sse-origin.ts` for
 * why it is a separate origin from the page's.
 */
import type { TestProject } from 'vitest/node';
import { startSseOrigin } from './sse-origin.ts';

declare module 'vitest' {
  interface ProvidedContext {
    readonly sseOrigin: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const origin = await startSseOrigin();
  project.provide('sseOrigin', origin.origin);
  return () => origin.close();
}
