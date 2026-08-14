#!/bin/sh
# DeFlow's install script — the curl-to-shell entry point (KAR-20.2 AC1).
#
# It exists for one reason: `npx deflow setup` presumes a Node, and a macOS
# machine with no Node cannot run the thing that would tell it so. This script
# can, and it says exactly what to install and stops.
#
# It is deliberately *not* a second, more powerful installer. Everything below
# either checks something or hands over to `deflow setup`, which is the same
# code path `npx deflow setup` runs — the same five steps, the same consent
# rules, the same profile edit. It installs no package of its own, writes no
# file, and never uses sudo. That is the answer to "why would I pipe your
# script into my shell", and `test/install-script.test.ts` is what keeps it
# true.
#
# Read it before you run it:
#     curl -fsSL https://deflow.dev/install.sh -o install.sh
#     less install.sh
#     sh install.sh
#
# DEFLOW_PACKAGE pins what is installed — a version (`deflow@0.2.0`) or a
# packed tarball, which is what the release gate points it at. Everything else
# is passed straight through to `deflow setup`, so `sh install.sh --yes` works.

set -eu

PACKAGE="${DEFLOW_PACKAGE:-deflow}"
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
