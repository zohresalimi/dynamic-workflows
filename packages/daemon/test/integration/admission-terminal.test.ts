/**
 * KAR-19.2 AC8 — a refused run is *over*, on every surface that can be asked.
 *
 * `created — no nodes yet` is the string the operator actually stared at, and
 * it was truthful. The defect is that it was also the final state, with nothing
 * in any surface saying so. So this spec asks the three questions a waiting
 * human's tools ask — what does the summary say, what does the stream deliver,
 * and does the stream ever stop — against a real daemon that has just refused a
 * real submission.
 *
 * Verifies: EPIC-19-S15 · AC2, AC8 · test plan #8
 */
import { RUN_REFUSAL_CODES } from '@DeFlow/adapters';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { chmodSync, writeFileSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { boot } from '../../src/boot.ts';

const fetch = authorizedFetch();

/** The reported machine: `claude` on PATH, no ACP bridge anywhere. */
async function vendorCliOnly(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await symlink(process.execPath, join(binDir, 'node'));
  const shim = join(binDir, 'claude');
  writeFileSync(shim, '#!/usr/bin/env node\nprocess.stdout.write("2.1.220\\n");\n', {
    mode: 0o755,
  });
  chmodSync(shim, 0o755);
}

interface RefusalBody {
  readonly error: { readonly code: string; readonly detail: { readonly runId?: string } };
}

interface RunSummary {
  readonly status: string;
  readonly refusal?: {
    readonly code: string;
    readonly message: string;
    readonly providers: readonly { readonly id: string; readonly state: string }[];
  };
}

suite('EPIC-19-S15 — a refused run is terminal', () => {
  it('reports a terminal status with the typed code, and closes the stream after the ending frame', async ({
    tmp,
  }) => {
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    await vendorCliOnly(binDir);

    const booted = await boot({
      dataDir,
      port: 0,
      dev: false,
      token: TEST_DAEMON_TOKEN,
      providerRoots: [binDir],
    });
    const origin = `http://127.0.0.1:${(booted.http.server.address() as AddressInfo).port}`;

    try {
      const refusal = (await (
        await fetch(`${origin}/api/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: { kind: 'text', text: 'Migrate the checkout module' },
            cwd: process.cwd(),
            permission: 'read',
          }),
        })
      ).json()) as RefusalBody;

      expect(refusal.error.code).toBe(RUN_REFUSAL_CODES.noUsableProvider);
      const runId = refusal.error.detail.runId ?? '';
      expect(runId).not.toBe('');

      // AC2, AC8 — the summary, which is what the UI's run view reads.
      const summary = (await (await fetch(`${origin}/api/runs/${runId}`)).json()) as RunSummary;
      expect(summary.status).toBe('aborted');
      expect(summary.refusal?.code).toBe(RUN_REFUSAL_CODES.noUsableProvider);
      expect(summary.refusal?.message).toContain('@agentclientprotocol/claude-agent-acp');
      expect(summary.refusal?.providers.find((entry) => entry.id === 'claude')?.state).toBe(
        'adapter-missing',
      );

      // AC8 — the stream. Attached after the refusal, which is when a human's
      // tools attach: `deflow run` submits and *then* follows, and the UI opens
      // the run it was just told about. The claim is not that the frame arrives
      // — a backfill would deliver it either way — it is that the socket then
      // *ends*, rather than sitting on keepalives for a run that will never
      // emit again.
      // `since=0` because a connection that names no cursor starts at the head
      // at open (§4.1's floor) — which is what every real client does through
      // `followRun`'s hydrate-then-stream, and what a run that ended a
      // millisecond ago requires in order to be delivered at all.
      const stream = await fetch(`${origin}/api/stream?runs=${runId}&since=0`);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');

      const body = await readToEnd(stream);
      expect(body).toContain('run.aborted');
      expect(body).not.toContain(': keepalive');

      // AC1's last clause — the refusal reaches the `runs=*` topic like any
      // other run ending, which is the subscription the run list and the
      // approval queue are already open on. This one is *not* closed by the
      // rule above: the global topic is about runs that do not exist yet.
      const global = await fetch(`${origin}/api/stream?runs=*&since=0`);
      expect(await readUntil(global, 'run.aborted')).toContain(runId);
    } finally {
      await booted.shutdown();
    }
  });
});

/**
 * Every byte of the stream, up to the server closing it.
 *
 * The read resolving at all *is* the assertion: a stream that stayed open would
 * hang here until the spec's own timeout, which is exactly the failure AC8
 * describes one layer down. A bounded wait rather than an unbounded one so the
 * failure is a message rather than a thirty-second stall.
 */
async function readToEnd(response: Response): Promise<string> {
  const stream = response.body;
  if (stream === null) throw new Error('the stream response carried no body');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = setTimeout(() => void reader.cancel('the stream never closed'), 10_000);
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Reads a stream until `phrase` appears, then cancels it.
 *
 * The counterpart of `readToEnd`, for the subscription that is *supposed* to
 * stay open: waiting for this one to close would be waiting for something the
 * contract promises will not happen.
 */
async function readUntil(response: Response, phrase: string): Promise<string> {
  const stream = response.body;
  if (stream === null) throw new Error('the stream response carried no body');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = setTimeout(() => void reader.cancel('the frame never arrived'), 10_000);
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += decoder.decode(value, { stream: true });
      if (text.includes(phrase)) return text;
    }
  } finally {
    clearTimeout(deadline);
    await reader.cancel().catch(() => undefined);
  }
}
