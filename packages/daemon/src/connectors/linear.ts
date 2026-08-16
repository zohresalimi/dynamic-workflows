/**
 * KAR-22.6 — the Linear connector, which does not connect. **This file is the
 * story's most important one, and it is the one with the least code in it.**
 *
 * ## What was actually checked, before this was written
 *
 * KAR-22.4's answer for GitHub was *"the vendor's own first-party CLI holds the
 * credential; DeFlow spawns it"*, and KAR-22.4 was split precisely because that
 * answer might not generalise. For Linear it does not, and the three ways it
 * could have are each closed:
 *
 *  - **A personal API key.** Linear's own documented path. DeFlow would hold
 *    it, which is the one thing ADR-0003 says DeFlow never does.
 *  - **An OAuth application.** DeFlow has not registered one with Linear. A
 *    client id in this repository would be fabricated or somebody else's, and
 *    both are worse than saying so.
 *  - **A first-party CLI, the way `gh` and `acli` work.** `@linear/cli` (`lin`)
 *    is Linear-authored, was last published in 2021, keeps an API key in a
 *    config file of its own, and has exactly two commands — `lin new` and `lin
 *    checkout`. There is no search and no list, so it could not serve an issue
 *    picker even if delegating to it were acceptable.
 *
 * ## Why the row exists at all
 *
 * Because the alternative is worse. A missing row reads as an oversight and
 * invites the next person to add one — with a token field, because that is the
 * only thing that would make it work. A row that says *DeFlow cannot connect
 * this without holding your credential, and it does not hold credentials* is a
 * decision an operator can read, disagree with, and route around by pasting a
 * reference, which has never needed a connector.
 *
 * So this service registers, answers every question the type requires, probes
 * without spawning anything, and offers **no authorisation route**. The
 * connectors screen renders no button for it and `../http/api.ts` refuses its
 * connect route outright, so "not supported yet" is a state of the product
 * rather than a button that goes nowhere.
 *
 * See ADR-0003's second amendment of 2026-08-16, which makes this the rule for
 * every future service in the same position rather than a one-off.
 *
 * Verifies: EPIC-22-S70, EPIC-22-S71 · KAR-22.6 AC1, AC2, AC4
 */
import type { ConnectorIssue, ConnectorService, ConnectorState, ProbePorts } from './registry.ts';

/** What would have to become true for Linear to become a connector. */
const WHAT_WOULD_CHANGE =
  'This becomes connectable the day Linear publishes a command-line tool that holds the ' +
  'credential itself — the way GitHub’s `gh` and Atlassian’s `acli` do — or the day DeFlow ' +
  'registers a Linear application of its own under a superseding decision. Until then, pasting a ' +
  'Linear issue reference into the composer works and has never needed a connector.';

const CANNOT_CONNECT =
  'DeFlow cannot connect Linear without holding a Linear credential itself, and it does not hold ' +
  'credentials. Reaching Linear’s API needs either a personal API key, which DeFlow would then ' +
  'be storing, or an OAuth application DeFlow has not registered and will not fake a client id ' +
  'for.';

export const LINEAR: ConnectorService = {
  id: 'linear',
  label: 'Linear',
  /** None, because there is no credential whose grants could be short. */
  requiredScopes: [],
  credential: {
    authorisedBy:
      'Nobody, yet. Linear authorises either a personal API key you create yourself or an OAuth ' +
      'application — and DeFlow has no Linear application, so there is no authorisation for it ' +
      'to be part of.',
    holder:
      'Nobody, and that is the point. There is no first-party Linear tool for DeFlow to delegate ' +
      'to, so the only way to connect Linear would be for DeFlow to hold your credential itself.',
    livesIn:
      'Nowhere on this machine, as far as DeFlow is concerned. It has never asked Linear for a ' +
      'credential and has nowhere to put one if it were given one.',
    deflowStores:
      'DeFlow stores no credential for Linear, and no row either — connecting is refused rather ' +
      'than recorded, so there is nothing here at all.',
    revoke: {
      // Null rather than a plausible command: there is no grant to revoke, and
      // an instruction that fails in a terminal reads as the operator's error.
      command: null,
      affects:
        'There is nothing to revoke. DeFlow was never granted anything by Linear and holds ' +
        'nothing, so nothing on this machine changes.',
    },
  },
  authorisation: {
    kind: 'unavailable',
    whyNotConnectable: `${CANNOT_CONNECT} ${WHAT_WOULD_CHANGE}`,
  },

  /**
   * Answers without looking, because there is nothing on this machine to look
   * at.
   *
   * `not-installed` of the six states, and it is the literal truth rather than
   * the nearest fit: the thing that would have to be installed is a first-party
   * Linear CLI that holds the credential, and there is not one to install. The
   * `action` is `null` for the same reason `unreachable`'s is — naming a
   * command here would send an operator to install something that does not
   * exist.
   */
  probe(_ports: ProbePorts, _repoPath: string): Promise<ConnectorState> {
    return Promise.resolve({
      state: 'not-installed',
      account: null,
      scopes: [],
      missingScopes: [],
      message: `${CANNOT_CONNECT} ${WHAT_WOULD_CHANGE}`,
      action: null,
    });
  },

  /**
   * Never reached: `../connectors.ts` only lists issues for a service whose
   * probe said `connected`, and this one never does. Present because the type
   * requires it, empty because inventing rows would be worse than the honest
   * nothing, and it spawns no child so the "nothing ran for Linear" assertion
   * in `packages/daemon/test/integration/connectors-linear-jira.test.ts` is
   * about this module rather than about an empty `PATH`.
   */
  listIssues(
    _ports: ProbePorts,
    _repoPath: string,
    _query: string,
  ): Promise<readonly ConnectorIssue[]> {
    return Promise.resolve([]);
  },
};
