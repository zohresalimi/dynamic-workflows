/**
 * KAR-07.5 §5.2 — the copy-on-write fast path, behind a capability probe
 * (docs/09-workspace-and-safety.md).
 *
 * Reflink cloning an existing `node_modules` is genuinely near-free *where
 * supported* — btrfs and XFS via `FICLONE`, APFS via `clonefile` — and simply
 * absent on ext4, which is still the most common Linux root filesystem. So it
 * cannot be a strategy; it can only be an accelerator, and the way to find out
 * whether it works here is to try it, in the directory it would be used in.
 *
 * **The probe writes and clones a real one-byte file in the target
 * directory.** Not a `statfs` on the filesystem type, and not a probe in
 * `/tmp`: the answer is per-*directory* in practice, because `/tmp` is
 * frequently tmpfs while the repository is not, and because a bind mount or an
 * overlay can support cloning on one path and refuse it on a sibling.
 *
 * `COPYFILE_FICLONE_FORCE` is the whole probe: Node fails the copy outright
 * when the filesystem cannot clone, where plain `COPYFILE_FICLONE` would
 * silently fall back to a byte copy and report success — which would make the
 * probe answer "yes" everywhere and the fast path a full copy everywhere.
 *
 * A failure here is **not an error**. It is ext4. Nothing is surfaced to the
 * user, nothing is appended to the ledger, and provisioning falls through to
 * the package manager (AC7).
 */
import { constants } from 'node:fs';
import { copyFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Injected so a spec can be ext4 on a machine that is not. */
export type ReflinkProbe = (dir: string) => Promise<boolean>;

/**
 * Can this directory's filesystem clone a file?
 *
 * Always resolves — never rejects. Every failure mode (unsupported
 * filesystem, unwritable directory, a directory that does not exist yet) has
 * the same correct answer, which is "no, use the ordinary path".
 */
export const probeReflink: ReflinkProbe = async (dir: string): Promise<boolean> => {
  let scratch: string | undefined;
  try {
    // Inside `dir`, so the answer is about the filesystem provisioning will
    // actually use; `mkdtemp` so two nodes probing at once cannot collide.
    scratch = await mkdtemp(join(dir, '.DeFlow-reflink-'));
    const source = join(scratch, 'probe');
    await writeFile(source, '1');
    await copyFile(source, join(scratch, 'clone'), constants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch {
    return false;
  } finally {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
};

/**
 * Clone a tree, reflinking each file where the filesystem allows it.
 *
 * `COPYFILE_FICLONE` rather than the `_FORCE` the probe used: by this point
 * the probe has already established that cloning works in the target
 * directory, and a single file that cannot be cloned — one crossing a mount
 * point inside a large `node_modules`, say — should cost a byte copy rather
 * than fail the whole provisioning.
 */
export async function cloneTree(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, mode: constants.COPYFILE_FICLONE });
}
