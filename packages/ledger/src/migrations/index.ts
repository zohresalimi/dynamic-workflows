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

export const MIGRATIONS: readonly Migration[] = [
  migration0001InitialSchema,
  migration0002EventEpoch,
  migration0003DaemonEpoch,
  migration0004ProviderCapabilities,
  migration0005Process,
];
