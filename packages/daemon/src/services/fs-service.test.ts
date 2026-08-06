/**
 * KAR-08.2 — the fs service honours the path policy, and honours it *first*.
 *
 * Two claims, and both are about something that must **not** happen:
 *
 * - a denied read never opens the file. EPIC-08-S10's cheapest attack is an
 *   agent that reads a credential file and puts it in its own output, and a
 *   service that opened the file and then consulted the policy would have
 *   already lost — the bytes are in the process. The `FsIo` port is here so a
 *   recording double can say "zero opens" rather than a test asserting the
 *   absence of an observable it does not have.
 * - a write goes to the path the policy *resolved*, never to the string the
 *   agent sent. Deciding on the resolved path and then writing the raw one
 *   reintroduces the whole traversal class (EPIC-08-S7, last scenario).
 *
 * Verifies: EPIC-08-S7, EPIC-08-S10 · AC1, AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { createFsService, type FsIo, type PathPolicy } from './fs-service.ts';

/** Every call the service made to a filesystem, in order. */
function recordingIo(files: Readonly<Record<string, string>> = {}): FsIo & {
  readonly opens: string[];
  readonly writes: { path: string; content: string }[];
} {
  const opens: string[] = [];
  const writes: { path: string; content: string }[] = [];
  return {
    opens,
    writes,
    readFile: (path) => {
      opens.push(path);
      const content = files[path];
      if (content === undefined) return Promise.reject(new Error(`ENOENT ${path}`));
      return Promise.resolve(content);
    },
    writeFile: (path, content) => {
      writes.push({ path, content });
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
  };
}

class Refused extends Error {}

/** A policy that resolves `path` to `<root>/<basename>` and refuses anything
 * whose first segment is `secret`. Stands in for the real mediator, which has
 * its own suite in ./path-mediation.test.ts. */
const policy = (root: string): PathPolicy => ({
  resolve: (_operation, requested) => {
    if (requested.startsWith('secret')) return Promise.reject(new Refused(requested));
    return Promise.resolve(`${root}/${requested.split('/').pop() ?? ''}`);
  },
});

suite('a denied read never opens the file', () => {
  it('rejects, and the io port logs zero opens for that path', async () => {
    const io = recordingIo({ '/wt/credentials': 'aws_secret_access_key = synthetic' });
    const fs = createFsService({ root: '/wt', policy: policy('/wt'), io });

    await expect(fs.readText({ path: 'secret/credentials' })).rejects.toBeInstanceOf(Refused);

    expect(io.opens).toEqual([]);
  });

  it('opens the resolved path when the policy allows it', async () => {
    const io = recordingIo({ '/wt/a.ts': 'export const a = 1;\n' });
    const fs = createFsService({ root: '/wt', policy: policy('/wt'), io });

    expect(await fs.readText({ path: 'src/../a.ts' })).toBe('export const a = 1;\n');
    expect(io.opens).toEqual(['/wt/a.ts']);
  });
});

suite('a write goes to the resolved path, never to the agent’s string', () => {
  it('writes where the policy said, not where the agent asked', async () => {
    const io = recordingIo();
    const fs = createFsService({ root: '/wt', policy: policy('/wt'), io });

    await fs.writeText({ path: '../../etc/passwd', content: 'x' });

    expect(io.writes).toEqual([{ path: '/wt/passwd', content: 'x' }]);
  });

  it('does not write at all when the policy refuses', async () => {
    const io = recordingIo();
    const fs = createFsService({ root: '/wt', policy: policy('/wt'), io });

    await expect(fs.writeText({ path: 'secret/x', content: 'x' })).rejects.toBeInstanceOf(Refused);

    expect(io.writes).toEqual([]);
  });
});
