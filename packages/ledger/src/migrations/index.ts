/**
 * Every shipped migration, in append order. New migrations are pushed onto
 * the end of this array; nothing already here is ever reordered or edited.
 */
import type { Migration } from '../migrate.ts';
import { migration0001InitialSchema } from './0001-initial-schema.ts';

export const MIGRATIONS: readonly Migration[] = [migration0001InitialSchema];
