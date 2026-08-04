import { expect } from 'vitest';
// Deliberately the module and not the "@DeFlow/testkit" entry point: this file
// is loaded by every spec in every slice, and the package entry pulls in execa
// and better-sqlite3's native binding, which the unit slice must never pay for.
import { createSnapshotSerializers } from '../packages/testkit/src/snapshot.ts';

// Registered here, and here only, so that it is in place before the first
// snapshot in the run is written or read (docs/14-testing-strategy.md §9). The
// ordering is the requirement, not a nicety: a serializer added after snapshots
// exist rewrites all of them at once, and a snapshot mechanism that produces a
// diff on every run stops being read — at which point `-u` becomes a reflex and
// the snapshots will happily record a regression.
//
// Nothing else belongs in this file. It is loaded by every project slice.
for (const serializer of createSnapshotSerializers()) expect.addSnapshotSerializer(serializer);
