/**
 * KAR-18.6 AC5 — a deliberately broken tarball, built on purpose, so this
 * suite can prove the verifier is able to go red. `packBrokenTarball` starts
 * from the *real* packed tarball (so its dependency versions are real,
 * resolved ones rather than the `catalog:` protocol only pnpm understands)
 * and edits only `files`.
 *
 * `files: ["dist/bin.mjs"]` — the epic's own literal example — is a harder
 * failure than the one this story names: `packages/cli/dist/bin.mjs` shares a
 * code-split chunk with `mcp.mjs` (tsdown's four entries are bundled
 * together), so trimming `files` down to one bin drops that chunk too and the
 * daemon never starts at all (`ERR_MODULE_NOT_FOUND`), which is not what
 * `GET /api/health still answers 200` describes. The variant built below
 * keeps every `.mjs` — the JS side, entries and shared chunks alike — and
 * narrows only `dist/ui`, to `dist/ui/index.html` with no `dist/ui/assets/*`.
 * That is the actual shape of "a missing files entry that drops dist/ui" the
 * epic's prose names: the daemon boots, `/` serves `index.html` happily
 * (the SPA fallback answers any unmatched path, `.js` extension included),
 * and only a referenced asset request exposes the blank page.
 *
 * Verifies: EPIC-18-S43 · AC5
 */
import { afterAll, afterEach, beforeAll, expect, it, describe as suite } from 'vitest';
import {
  assertUiShipped,
  type CliInstall,
  type CliProcess,
  cleanupPackedTarball,
  cleanupSystemToolsDir,
  makeCleanRoom,
  type PackedTarball,
  packBrokenTarball,
  packGoodTarball,
  removeCleanRoom,
  runInstalled,
  spawnInstalled,
  waitForUrl,
} from '../packages/cli/scripts/verify-install/lib.ts';

let good: PackedTarball;
let broken: PackedTarball;

beforeAll(() => {
  good = packGoodTarball();
  broken = packBrokenTarball(good, (pkg) => {
    pkg['files'] = ['dist/*.mjs', 'dist/ui/index.html'];
  });
}, 600_000);

const rooms: string[] = [];
const running: CliProcess[] = [];

async function room(): Promise<CliInstall> {
  const install = await makeCleanRoom();
  rooms.push(install.room);
  return install;
}

afterEach(async () => {
  for (const cli of running.splice(0)) await cli.stop();
  for (const dir of rooms.splice(0)) await removeCleanRoom(dir);
});

afterAll(() => {
  cleanupPackedTarball(good);
  cleanupPackedTarball(broken);
  cleanupSystemToolsDir();
});

suite('EPIC-18-S43 — a missing files entry drops dist/ui/ and serves a blank page', () => {
  it('health and / still answer, but the referenced asset 404s — and the verifier names it', async () => {
    const install = await room();
    const init = await runInstalled({ tgz: broken.tgz, bin: 'DeFlow', argv: ['init'], install });
    expect(init.status, init.stderr).toBe(0);

    const up = spawnInstalled({
      tgz: broken.tgz,
      bin: 'DeFlow',
      argv: ['up', '--no-open'],
      install,
    });
    running.push(up);
    const url = await waitForUrl(up);
    const baseUrl = new URL(url).origin;

    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);

    const page = await fetch(`${baseUrl}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const match = /(?:src|href)="(\/assets\/[^"]+\.(?:js|mjs))"/.exec(html);
    expect(match, html).not.toBeNull();
    const assetPath = match?.[1] as string;

    const asset = await fetch(`${baseUrl}${assetPath}`);
    // The SPA fallback answers 200 for *any* unmatched path — including this
    // one — with index.html's own content type. That is the blank page:
    // present at the HTTP layer, absent at the content layer.
    expect(asset.headers.get('content-type') ?? '').toMatch(/text\/html/);

    // And the verifier itself must fail here, not merely observe: this is
    // the assertion `pnpm verify:install` makes for real, exercised against
    // the broken bytes rather than the good ones.
    await expect(assertUiShipped(baseUrl)).rejects.toThrow(
      new RegExp(`GET ${assetPath.replaceAll('/', '\\/')}.*content-type "text\\/html`),
    );

    await up.stop();
  }, 120_000);
});
