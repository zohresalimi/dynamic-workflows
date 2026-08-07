/**
 * KAR-09.7 AC8 — the exact counter exists, and nothing in DeFlowd can reach it.
 *
 * AR-1 is inviolable and verifiable by inspection (NF2), so this is written as
 * negative assertions over the whole daemon rather than as a positive one over
 * a module: *there is no code path in DeFlowd that reads a token file or sets
 * an auth env var to make this call work.* The credential is a parameter, it
 * has no constructor that reads anything, and the one module that names the
 * endpoint imports nothing that could supply it.
 *
 * **Note, 2026-08-06:** F3.3 (the direct-API adapter) moved to M2. The call
 * site and its selection logic are built here because they are what makes the
 * three-tier design honest, but only the negative half is exercisable at M1 —
 * nothing in a shipped configuration constructs a credential, so the positive
 * path has never run against the real endpoint and this suite does not pretend
 * otherwise. The HTTP-level half of the same claim, over a real subprocess run,
 * lives in `packages/adapters/test/integration/no-outbound-http.test.ts`.
 *
 * Verifies: EPIC-09-S40 · KAR-09.7 AC8
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import {
  COUNT_TOKENS_PATH,
  countTokensExact,
  type DirectApiCredential,
} from '../src/tokens/exact-count.ts';

const srcDir = new URL('../src/', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const files = sourceFiles(srcDir);
const EXACT_COUNT = 'tokens/exact-count.ts';

suite('the exact endpoint is named in exactly one file', () => {
  it('found source files to check at all', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('is named nowhere else in the daemon', () => {
    const naming = files
      .map((path) => path.slice(srcDir.length))
      .filter((path) => readFileSync(join(srcDir, path), 'utf8').includes(COUNT_TOKENS_PATH));
    expect(naming).toEqual([EXACT_COUNT]);
  });

  it('reads no credential of its own', () => {
    const code = readFileSync(join(srcDir, EXACT_COUNT), 'utf8');
    // The three ways a credential could arrive without the operator handing it
    // over: the environment, the filesystem, and a keychain-shaped import.
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/from\s*['"]node:fs/);
    expect(code).not.toMatch(/homedir|\.claude|credentials\.json/);
  });

  it('is called by nothing, because the adapter that would call it is M2', () => {
    // The package barrel re-exports it — that is the contract, not a call site.
    // What must not exist anywhere in DeFlowd is an *invocation*.
    const callers = files
      .map((path) => path.slice(srcDir.length))
      .filter((path) => path !== EXACT_COUNT)
      .filter((path) => /\bcountTokensExact\s*\(/.test(readFileSync(join(srcDir, path), 'utf8')));
    expect(
      callers,
      'a call site for the exact counter exists inside DeFlowd. Tier 3 is reachable only from ' +
        'the F3.3 direct-API adapter, under a key the operator supplied (AR-1).',
    ).toEqual([]);
  });

  it('is reached from the barrel only as a re-export', () => {
    const importers = files
      .map((path) => path.slice(srcDir.length))
      .filter((path) => path !== EXACT_COUNT)
      .filter((path) =>
        /from\s*['"][^'"]*exact-count\.ts['"]/.test(readFileSync(join(srcDir, path), 'utf8')),
      );
    expect(importers).toEqual(['index.ts']);
  });
});

suite('nothing in DeFlowd manufactures a credential (AR-1)', () => {
  /** The env vars §2.3 names as shadowing a provider's subscription auth. */
  const SHADOW_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

  it('assigns none of the shadowing variables, anywhere', () => {
    for (const path of files) {
      const code = readFileSync(path, 'utf8');
      for (const variable of SHADOW_VARS) {
        // An assignment — `process.env.X =`, or the name as a key in an object
        // literal with a value. Naming the variable is fine and necessary:
        // `proc/auth-shadow.ts` has to name them all to strip them.
        expect(
          new RegExp(`${variable}\\s*[:=][^=]`).test(code),
          `${path.slice(srcDir.length)} sets ${variable}. DeFlow never puts a vendor credential ` +
            'into a child environment that did not already ask for one (AR-1, KAR-08.8).',
        ).toBe(false);
      }
    }
  });

  it('reads no vendor credential file', () => {
    for (const path of files) {
      const code = readFileSync(path, 'utf8');
      expect(
        /\.claude\/\.credentials|credentials\.json|auth\.json/.test(code),
        `${path.slice(srcDir.length)} reads a vendor credential file.`,
      ).toBe(false);
    }
  });
});

suite('the call site refuses without a caller-supplied credential', () => {
  const credential: DirectApiCredential = {
    apiKey: 'sk-test-not-a-real-key',
    baseUrl: 'https://api.example.com',
    authMode: 'api_key',
  };

  it('refuses when the caller is on the subscription path', async () => {
    await expect(
      countTokensExact(
        { ...credential, authMode: 'subscription' },
        { model: 'model-a', prompt: 'hello' },
        async () => {
          throw new Error('no request should have been made');
        },
      ),
    ).rejects.toThrow(/subscription/i);
  });

  it('refuses an empty key rather than sending an unauthenticated request', async () => {
    await expect(
      countTokensExact(
        { ...credential, apiKey: '   ' },
        { model: 'model-a', prompt: 'hello' },
        async () => {
          throw new Error('no request should have been made');
        },
      ),
    ).rejects.toThrow(/key/i);
  });

  it('labels its answer with a method distinct from the Tier-2 label', async () => {
    const counted = await countTokensExact(
      credential,
      { model: 'model-a', prompt: 'hello' },
      async (url, init) => {
        expect(url).toBe(`https://api.example.com${COUNT_TOKENS_PATH}`);
        expect(init.headers['x-api-key']).toBe(credential.apiKey);
        return { input_tokens: 1_234 };
      },
    );
    expect(counted).toEqual({ estimated: 1_234, method: 'vendor-reported' });
  });

  it('refuses a response that does not carry an integer count', async () => {
    await expect(
      countTokensExact(credential, { model: 'model-a', prompt: 'hello' }, async () => ({
        input_tokens: 'lots',
      })),
    ).rejects.toThrow(/count/i);
  });
});
