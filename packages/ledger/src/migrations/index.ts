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
];
