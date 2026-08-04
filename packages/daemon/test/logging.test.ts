/**
 * KAR-01.3 AC6 and AC9 — redaction and per-subsystem namespacing, configured
 * from the first commit that has a logger at all.
 *
 * Redaction is asserted behaviourally, by serialising a real record through a
 * real pino instance into a capture stream: an assertion on the `paths` array
 * alone would pass for a logger that never applies it.
 *
 * Verifies: KAR-01.3 test plan #7 (unit)
 */
import { describe as suite, expect, it } from 'vitest';
import { CENSOR, createLogger, REDACT_PATHS } from '../src/logging.ts';

interface Capture {
  readonly stream: { write(chunk: string): void };
  readonly records: () => Record<string, unknown>[];
}

function capture(): Capture {
  const lines: string[] = [];
  return {
    stream: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
    records: () =>
      lines
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

suite('redaction (AC6)', () => {
  it('lists exactly the paths the story names', () => {
    expect([...REDACT_PATHS].sort()).toEqual(
      [
        '*.authorization',
        '*.token',
        '*.headers.cookie',
        'env.ANTHROPIC_API_KEY',
        'env.OPENAI_API_KEY',
        'env.GITHUB_TOKEN',
      ].sort(),
    );
  });

  it('censors an authorization field one level down', () => {
    const sink = capture();
    createLogger({ destination: sink.stream, level: 'info' }).info(
      { req: { authorization: 'Bearer sk-ant-secret' } },
      'request',
    );
    const record = sink.records()[0];
    expect(JSON.stringify(record)).not.toContain('sk-ant-secret');
    expect((record?.req as Record<string, unknown>).authorization).toBe(CENSOR);
  });

  it('censors a token, a cookie header and the two provider keys', () => {
    const sink = capture();
    createLogger({ destination: sink.stream, level: 'info' }).info(
      {
        adapter: { token: 'tok-live-1' },
        res: { headers: { cookie: 'session=abc' } },
        env: { ANTHROPIC_API_KEY: 'sk-ant-1', OPENAI_API_KEY: 'sk-oai-1', PATH: '/usr/bin' },
      },
      'probe',
    );
    const serialised = JSON.stringify(sink.records()[0]);
    for (const secret of ['tok-live-1', 'session=abc', 'sk-ant-1', 'sk-oai-1']) {
      expect(serialised, `${secret} must not reach a log line`).not.toContain(secret);
    }
    // Redaction is surgical: the non-secret sibling survives, so the log stays useful.
    expect(serialised).toContain('/usr/bin');
  });
});

suite('per-subsystem namespacing (AC9)', () => {
  it('a child logger carries mod and runId on every line', () => {
    const sink = capture();
    const scheduler = createLogger({ destination: sink.stream, level: 'info' }).child({
      mod: 'scheduler',
      runId: 'run_01H',
    });
    scheduler.info('tick');
    scheduler.warn('backpressure');

    const records = sink.records();
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.mod).toBe('scheduler');
      expect(record.runId).toBe('run_01H');
    }
  });

  it('emits ndjson, so "pnpm dev | pino-pretty | grep \'\\"mod\\":\\"scheduler\\"\'" works', () => {
    const sink = capture();
    const log = createLogger({ destination: sink.stream, level: 'info' });
    log.child({ mod: 'scheduler' }).info('tick');
    log.child({ mod: 'http' }).info('listening');

    const lines = sink
      .records()
      .map((record) => JSON.stringify(record))
      .filter((line) => line.includes('"mod":"scheduler"'));
    expect(lines).toHaveLength(1);
  });

  it('honours DeFlow_LOG_LEVEL through the level option', () => {
    const sink = capture();
    createLogger({ destination: sink.stream, level: 'warn' }).info('should not appear');
    expect(sink.records()).toEqual([]);
  });
});
