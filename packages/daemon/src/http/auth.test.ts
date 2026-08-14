/**
 * KAR-15.2 test plan #2, #4, #6 — the primitives the auth middleware decides
 * with, tested as the pure functions they are.
 *
 * Verifies: EPIC-15-S8 (the constant-time half), EPIC-15-S9 (the allowlist
 * outline), EPIC-15-S11 (`Host`, and the absent `Origin`) · AC2, AC3, AC5,
 * AC6, AC12
 *
 * Unit, and it has to be: *"timing analysis over loopback is a marginal threat
 * and the control is nearly free"*, and a test that tried to **measure** the
 * timing would be a flake generator. So the assertion is the one EPIC-15-S8
 * actually asks for — that the comparison is built on a `timingSafeEqual`-style
 * primitive rather than on `===`, and that unequal lengths do not short-circuit
 * it — which is a property of the module, readable from the module.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import {
  allowedOrigins,
  assertLoopbackBind,
  bearerToken,
  constantTimeEqual,
  DAEMON_TOKEN_BYTES,
  isAllowedHost,
  isAllowedOrigin,
  mintDaemonToken,
  NonLoopbackBindRefused,
} from './auth.ts';

const PORT = 7777;

suite('the token itself (AC7)', () => {
  it('is 32 bytes of crypto randomness, base64url-encoded', () => {
    const token = mintDaemonToken();

    expect(DAEMON_TOKEN_BYTES).toBe(32);
    // base64url: no "+", no "/", no "=" padding — so it survives a URL
    // fragment, a JSON file and a shell argument without re-encoding.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('is different every time it is minted', () => {
    const minted = new Set(Array.from({ length: 32 }, () => mintDaemonToken()));
    expect(minted.size).toBe(32);
  });
});

suite('constantTimeEqual (AC2, test plan #2)', () => {
  it('is true for equal strings and false for different ones', () => {
    expect(constantTimeEqual('a-token', 'a-token')).toBe(true);
    expect(constantTimeEqual('a-token', 'b-token')).toBe(false);
  });

  it('handles unequal lengths without throwing and without an early return', () => {
    // `timingSafeEqual` on the raw bytes throws RangeError on unequal lengths,
    // and the usual "fix" is a length check in front of it — which is itself
    // the early return this rules out. Hashing first makes both operands the
    // same width, so the comparison runs in full for every input.
    expect(constantTimeEqual('short', 'a-much-longer-token-than-that')).toBe(false);
    expect(constantTimeEqual('', 'x')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('does not agree with a prefix, however long the shared prefix is', () => {
    expect(constantTimeEqual('abcdefgh', 'abcdefg')).toBe(false);
    expect(constantTimeEqual('abcdefg', 'abcdefgh')).toBe(false);
  });

  it('is implemented on timingSafeEqual rather than on === (AC2)', () => {
    // The assertion EPIC-15-S8 names in so many words: *"it is implemented on
    // a timingSafeEqual-style primitive, not on '==='. And a unit test asserts
    // the primitive is the one used."* Read off the module, because the
    // behaviour of `===` and of a constant-time comparison is identical and no
    // black-box test can tell them apart.
    const source = readFileSync(fileURLToPath(new URL('./auth.ts', import.meta.url)), 'utf8');
    const body = source.slice(source.indexOf('export function constantTimeEqual'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 2);

    expect(source).toContain("from 'node:crypto'");
    expect(fn).toContain('timingSafeEqual');
    expect(fn).not.toMatch(/===|!==|\.length\s*[!=]==/);
  });
});

suite('bearerToken', () => {
  it('reads the credential out of a Bearer header', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
  });

  it('is null for anything that carries no bearer credential', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken('Basic dXNlcjpwdw==')).toBeNull();
  });
});

suite('the Origin allowlist (AC3, AC6, test plan #4)', () => {
  it("is the daemon's own two origins, and nothing else", () => {
    expect(allowedOrigins(PORT, '127.0.0.1')).toEqual([
      'http://127.0.0.1:7777',
      'http://localhost:7777',
    ]);
  });

  it.each([
    ['http://127.0.0.1:7777', true],
    ['http://localhost:7777', true],
    ['http://attacker.example', false],
    // A different scheme is a different origin: a page served over TLS from a
    // rebound name is still not this daemon.
    ['https://127.0.0.1:7777', false],
    // The opaque origin a sandboxed iframe or a redirected form sends.
    ['null', false],
    // The right name on the wrong port is a different daemon, or a different
    // program entirely.
    ['http://127.0.0.1:7778', false],
  ] as const)('%s is %s', (origin, accepted) => {
    expect(isAllowedOrigin(origin, PORT, '127.0.0.1')).toBe(accepted);
  });

  it('accepts an absent Origin, because the CLI and curl send none (AC6)', () => {
    // Getting this backwards locks out `curl`, `deflow run` and every script,
    // and the pressure to relax it usually removes the check rather than
    // fixing the condition. Origin validation rejects a *present and wrong*
    // origin, never an absent one.
    expect(isAllowedOrigin(undefined, PORT, '127.0.0.1')).toBe(true);
  });

  it('adds the configured bind address when the daemon was told to leave loopback', () => {
    expect(allowedOrigins(7777, '192.168.1.10')).toContain('http://192.168.1.10:7777');
  });
});

suite('Host validation (AC5, test plan #6)', () => {
  it.each([
    ['127.0.0.1:7777', true],
    ['localhost:7777', true],
    ['localhost', true],
    ['[::1]:7777', true],
    ['127.0.0.53:7777', true],
    ['attacker.example', false],
    ['attacker.example:7777', false],
    // The DNS-rebinding request's *other* shape: a name that resolves to
    // loopback is still not a loopback name.
    ['rebind.attacker.example:7777', false],
  ] as const)('Host: %s is %s', (host, accepted) => {
    expect(isAllowedHost(host, '127.0.0.1')).toBe(accepted);
  });

  it('accepts the configured bind address even when it is not loopback', () => {
    expect(isAllowedHost('192.168.1.10:7777', '192.168.1.10')).toBe(true);
    expect(isAllowedHost('192.168.1.11:7777', '192.168.1.10')).toBe(false);
  });

  it('rejects a request with no Host header at all', () => {
    // HTTP/1.1 requires one. A request without it is either malformed or
    // deliberate, and neither deserves the benefit of the doubt.
    expect(isAllowedHost(undefined, '127.0.0.1')).toBe(false);
  });
});

suite('the bind refusal (AC12)', () => {
  it('allows loopback with no flag at all', () => {
    expect(() => assertLoopbackBind('127.0.0.1', false)).not.toThrow();
    expect(() => assertLoopbackBind('localhost', false)).not.toThrow();
    expect(() => assertLoopbackBind('::1', false)).not.toThrow();
  });

  it('refuses 0.0.0.0 without the explicit flag', () => {
    // *"There is no configuration path that silently falls back to
    // 0.0.0.0."* The refusal is a throw rather than a fallback to loopback,
    // because silently binding somewhere other than where the operator asked
    // is its own surprise.
    expect(() => assertLoopbackBind('0.0.0.0', false)).toThrow(NonLoopbackBindRefused);
    expect(() => assertLoopbackBind('192.168.1.10', false)).toThrow(NonLoopbackBindRefused);
    expect(() => assertLoopbackBind('::', false)).toThrow(NonLoopbackBindRefused);
  });

  it('allows it once the flag is explicitly set', () => {
    expect(() => assertLoopbackBind('0.0.0.0', true)).not.toThrow();
  });

  it('names the flag in the refusal, so the operator can act on it', () => {
    expect(() => assertLoopbackBind('0.0.0.0', false)).toThrow(/DeFlow_ALLOW_NON_LOOPBACK/);
  });
});
