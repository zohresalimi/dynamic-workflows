/**
 * KAR-22.6 test plan #5 — a service cannot be registered without saying who
 * holds its credential.
 *
 * KAR-22.4's whole argument is that DeFlow holds nothing and that the screen
 * says, in prose, where the credential actually is. That argument survives the
 * *first* service by attention. It survives the third by the type: a service
 * with no answer to "whose application authorises this, and who ends up holding
 * the token" must not compile, because the failure it produces is not a crash —
 * it is a row on the connectors screen with four empty paragraphs, which reads
 * as an oversight rather than as the ADR being quietly dropped.
 *
 * Two halves, and both are needed. The runtime half walks every registered
 * service and requires real prose in all four answers, because a type cannot
 * stop somebody writing `''`. The type half is a `@ts-expect-error` over a
 * descriptor missing `credential` — `packages/daemon/tsconfig.json` includes
 * `src`, so this file is in `pnpm typecheck`'s program and the assertion is
 * enforced by the same command that builds the daemon.
 *
 * Verifies: EPIC-22-S75, EPIC-22-S70 · KAR-22.6 AC1, AC2
 */
import { expect, it, describe as suite } from 'vitest';
import type { ConnectorService } from './registry.ts';
import { asServiceId, SERVICES, serviceById } from './services.ts';

/** Prose, rather than a placeholder somebody meant to come back to. */
const isProse = (value: string): boolean => value.trim().length >= 20;

suite('EPIC-22-S70 — the three services this build registers (AC1)', () => {
  it('registers GitHub, Linear and Jira, in one array and once each', () => {
    expect(SERVICES.map((service) => service.id)).toEqual(['github', 'linear', 'jira']);
  });

  it('resolves each id through the one lookup, and refuses anything else', () => {
    for (const service of SERVICES) {
      expect(asServiceId(service.id)).toBe(service.id);
      expect(serviceById(service.id).label).toBe(service.label);
    }
    expect(asServiceId('bitbucket')).toBeNull();
    expect(asServiceId('')).toBeNull();
  });
});

suite('EPIC-22-S75 — no service is registered without a credential statement (AC2)', () => {
  it.each(SERVICES.map((service) => [service.id, service] as const))(
    '%s answers all four credential questions in prose',
    (_id, service) => {
      expect(isProse(service.credential.authorisedBy)).toBe(true);
      expect(isProse(service.credential.holder)).toBe(true);
      expect(isProse(service.credential.livesIn)).toBe(true);
      expect(isProse(service.credential.deflowStores)).toBe(true);
      // What removing the connector does and does not do, always answered —
      // even by a service whose answer is "there is nothing to revoke".
      expect(isProse(service.credential.revoke.affects)).toBe(true);
    },
  );

  it.each(SERVICES.map((service) => [service.id, service] as const))(
    '%s promises no credential of DeFlow’s own',
    (_id, service) => {
      // The one sentence the screen shows about DeFlow itself has to be about
      // what DeFlow does *not* keep. A service claiming otherwise is a service
      // that has taken a token.
      expect(service.credential.deflowStores.toLowerCase()).toContain('no credential');
    },
  );

  it('does not typecheck a service that omits its credential statement', () => {
    // @ts-expect-error — `credential` is required, and this line failing to
    // error is itself a typecheck failure. That is the assertion.
    const missing: ConnectorService = {
      id: 'github',
      label: 'Nameless',
      requiredScopes: [],
      authorisation: { kind: 'unavailable', whyNotConnectable: 'x' },
      probe: () => Promise.reject(new Error('never called')),
      listIssues: () => Promise.reject(new Error('never called')),
    };

    expect(missing.label).toBe('Nameless');
  });
});

suite('EPIC-22-S70 — a service that cannot be connected says so instead (AC2)', () => {
  it('gives every service either a route to authorisation or a reason there is none', () => {
    for (const service of SERVICES) {
      if (service.authorisation.kind === 'command') {
        expect(service.authorisation.command.length).toBeGreaterThan(0);
      } else {
        // AC2's escape, and it is an *answer* rather than an absence: a row
        // with no button has to say why there is no button.
        expect(isProse(service.authorisation.whyNotConnectable)).toBe(true);
      }
    }
  });

  it('says of Linear that DeFlow will not hold its credential, and offers no command', () => {
    const linear = serviceById('linear');

    expect(linear.authorisation.kind).toBe('unavailable');
    // The sentence an operator reads. Not "coming soon" — the actual reason,
    // which is that connecting would mean DeFlow holding a credential.
    expect(
      linear.authorisation.kind === 'unavailable' ? linear.authorisation.whyNotConnectable : '',
    ).toMatch(/hold/i);
    // Nothing to revoke, because nothing was ever granted — said rather than
    // filled in with a plausible command.
    expect(linear.credential.revoke.command).toBeNull();
  });

  it('says of Jira that Atlassian’s own acli holds it, and names the login command', () => {
    const jira = serviceById('jira');

    expect(jira.authorisation.kind).toBe('command');
    expect(jira.authorisation.kind === 'command' ? jira.authorisation.command : '').toContain(
      'acli jira auth login',
    );
    expect(jira.credential.holder).toContain('acli');
    expect(jira.credential.revoke.command).toBe('acli jira auth logout');
  });
});
