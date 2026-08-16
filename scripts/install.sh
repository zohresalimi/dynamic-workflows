#!/bin/sh
# DeFlow's install script — the curl-to-shell entry point (KAR-20.2 AC1).
#
# It exists for one reason: the npx install presumes a Node, and a macOS
# machine with no Node cannot run the thing that would tell it so. This script
# can, and it says exactly what to install and stops.
#
# It is deliberately *not* a second, more powerful installer. Everything below
# either checks something or hands over to `deflow setup` — the same five
# steps, the same consent rules, the same profile edit as the npx route. It
# installs no package of its own, writes no file, and never uses sudo. That is
# the answer to "why would I pipe your script into my shell", and
# `test/install-script.test.ts` is what keeps it true.
#
# ## What this can be pointed at today (KAR-20.4 AC3)
#
# Not a URL. **Nothing serves this file** — this project publishes no website,
# and the host the header used to name resolves to a parking address that
# answers nothing, which is a worse first minute than a 404 and not a host this
# project controls. So the piped `curl … | sh` form this script is shaped for
# does not exist yet, and the route that does is the local one: a tarball
# packed out of a clone.
#
#     pnpm --filter deflowai pack --out /tmp/deflow.tgz
#     DEFLOW_PACKAGE=/tmp/deflow.tgz sh scripts/install.sh
#
# The registry route is not available either: the published package cannot be
# installed by npm (see REGISTRY_INSTALL_WORKS in
# packages/cli/src/command-name.ts for what was run and what it said). When it
# can, DEFLOW_PACKAGE's default below is already the right answer and this
# script needs no edit.
#
# Read it before you run it; it is one screen, and `less scripts/install.sh` is
# the whole ceremony.
#
# DEFLOW_PACKAGE pins what is installed — a packed tarball, which is the route
# above and what the release gate points it at, or, once there is a release
# that installs, a version (`deflowai@0.2.0`). Everything else is passed
# straight through to `deflow setup`, so `sh scripts/install.sh --yes` works.

set -eu

PACKAGE="${DEFLOW_PACKAGE:-deflowai}"
MIN_NODE_MAJOR=24

case "$(uname -s)" in
  Darwin | Linux) ;;
  *)
    echo "deflow setup: Windows is not supported until M3 (NF5) — use WSL2 and run this command inside it, following the Linux instructions in docs/03-local-development.md §1." >&2
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "deflow setup: this machine has no 'node' on PATH, and DeFlow is an npm package." >&2
  echo "Install Node ${MIN_NODE_MAJOR} or newer — https://nodejs.org/en/download — then run this again." >&2
  echo "Nothing was installed and nothing was changed." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR}" -lt "${MIN_NODE_MAJOR}" ]; then
  echo "deflow setup: node $(node --version) is too old — DeFlow needs ${MIN_NODE_MAJOR} or newer." >&2
  echo "Upgrade Node, then run this again. Nothing was installed and nothing was changed." >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "deflow setup: 'node' is on PATH but 'npx' is not, so the package cannot be fetched." >&2
  echo "Install npm alongside Node, then run this again." >&2
  exit 1
fi

# One handover, and every step after this line is `deflow setup`'s own — which
# is the whole claim this script makes about itself.
exec npx --yes --package="${PACKAGE}" -- deflow setup --from "${PACKAGE}" "$@"
