/**
 * Every shipped migration, in append order. New migrations are pushed onto
 * the end of this array; nothing already here is ever reordered or edited.
 */
import type { Migration } from '../migrate.ts';
import { migration0001InitialSchema } from './0001-initial-schema.ts';
import { migration0002EventEpoch } from './0002-event-epoch.ts';
import { migration0003DaemonEpoch } from './0003-daemon-epoch.ts';
import { migration0004ProviderCapabilities } from './0004-provider-capabilities.ts';
import { migration0005Process } from './0005-process.ts';
import { migration0006EffectJournalGuards } from './0006-effect-journal-guards.ts';
import { migration0007EffectScaffold } from './0007-effect-scaffold.ts';
import { migration0008Worktrees } from './0008-worktrees.ts';
import { migration0009ConflictProbe } from './0009-conflict-probe.ts';
import { migration0010TokenCalibration } from './0010-token-calibration.ts';
import { migration0011Blackboard } from './0011-blackboard.ts';
import { migration0012ArtifactFts } from './0012-artifact-fts.ts';
import { migration0013RateLimitIndex } from './0013-rate-limit-index.ts';
import { migration0014IntakeKeys } from './0014-intake-keys.ts';
import { migration0015IntakeKeysIntoEffects } from './0015-intake-keys-into-effects.ts';
import { migration0016Projects } from './0016-projects.ts';

export const MIGRATIONS: readonly Migration[] = [
  migration0001InitialSchema,
  migration0002EventEpoch,
  migration0003DaemonEpoch,
  migration0004ProviderCapabilities,
  migration0005Process,
  migration0006EffectJournalGuards,
  migration0007EffectScaffold,
  migration0008Worktrees,
  migration0009ConflictProbe,
  migration0010TokenCalibration,
  migration0011Blackboard,
  migration0012ArtifactFts,
  migration0013RateLimitIndex,
  migration0014IntakeKeys,
  migration0015IntakeKeysIntoEffects,
  migration0016Projects,
];
