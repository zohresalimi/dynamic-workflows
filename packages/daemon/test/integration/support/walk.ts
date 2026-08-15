/**
 * Every file under a directory, as sorted repository-relative paths.
 *
 * Written for KAR-22.1's "removing a project deletes no files" claim, where the
 * assertion has to be over the *whole tree* rather than over a file somebody
 * remembered to name. Directories are omitted and files are listed, because an
 * empty directory appearing or disappearing is not what the claim is about and
 * `.git` is full of them.
 *
 * A missing root returns an empty list rather than throwing: "the directory is
 * gone" is a legitimate observation for a spec about a vanished project, and it
 * should read as an empty tree rather than as a crashed helper.
 */
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export async function walk(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending: string[] = [root];

  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) continue;
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else found.push(relative(root, path).split(sep).join('/'));
    }
  }

  return found.toSorted();
}
