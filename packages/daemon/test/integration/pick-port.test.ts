/**
 * KAR-18.2 AC4 — step 5 of the boot sequence: "7777, or the next free one via
 * `get-port`" (docs/03-local-development.md §9).
 *
 * Real sockets on real ports. The whole behaviour under test is what happens
 * when somebody else already holds the port, which a fake cannot have an
 * opinion about.
 *
 * Verifies: EPIC-18-S9, EPIC-18-S10 · AC4
 */
import { createServer, type Server } from 'node:net';
import { afterEach, expect, it, describe as suite } from 'vitest';
import { PortInUse, pickPort } from '../../src/http/pick-port.ts';
import { DEFAULT_PORT } from '../../src/http/server.ts';

const occupied: Server[] = [];

afterEach(async () => {
  await Promise.all(
    occupied.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/** Binds `port` (0 for any) on loopback and keeps it until the test ends. */
function occupy(port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      occupied.push(server);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine the bound port'));
        return;
      }
      resolve(address.port);
    });
  });
}

suite('the default port, when nothing holds it', () => {
  it('is the preferred one', async () => {
    const preferred = await occupy(0);
    await new Promise<void>((resolve) => {
      occupied.pop()?.close(() => resolve());
    });

    expect(await pickPort({ preferred })).toBe(preferred);
  });

  it('defaults to 7777, which is the number the runbook prints', () => {
    expect(DEFAULT_PORT).toBe(7777);
  });
});

suite('the preferred port is occupied by an unrelated process (EPIC-18-S9)', () => {
  it('picks a different free port and leaves the occupant alone', async () => {
    const preferred = await occupy(0);

    const chosen = await pickPort({ preferred });

    expect(chosen).not.toBe(preferred);
    expect(chosen).toBeGreaterThan(0);
    // The occupant is untouched: it still answers a connection on its port.
    expect(occupied[0]?.listening).toBe(true);
    // And the port handed back is genuinely free.
    await expect(occupy(chosen)).resolves.toBe(chosen);
  });
});

suite('an explicitly pinned port (EPIC-18-S10)', () => {
  it('is returned unchanged when it is free', async () => {
    const free = await occupy(0);
    await new Promise<void>((resolve) => {
      occupied.pop()?.close(() => resolve());
    });

    expect(await pickPort({ requested: free })).toBe(free);
  });

  it('is refused rather than silently replaced when it is occupied', async () => {
    const taken = await occupy(0);

    await expect(pickPort({ requested: taken })).rejects.toBeInstanceOf(PortInUse);
    await expect(pickPort({ requested: taken })).rejects.toThrow(String(taken));
  });

  it('carries the port on the error, so the CLI does not re-parse its own message', async () => {
    const taken = await occupy(0);

    const refusal = await pickPort({ requested: taken }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(PortInUse);
    expect((refusal as PortInUse).port).toBe(taken);
  });

  it('passes 0 straight through, because "any port" cannot be in use', async () => {
    expect(await pickPort({ requested: 0 })).toBe(0);
  });
});
