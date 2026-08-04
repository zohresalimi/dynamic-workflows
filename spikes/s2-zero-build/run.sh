#!/usr/bin/env bash
# KAR-00.2 — runs the zero-build-dev-loop matrix by hand, the same steps
# test/integration/spike-s2-zero-build.test.ts asserts structurally. Use this
# when you want to eyeball the raw output (a stderr message, a tarball's
# package.json) rather than read an assertion. See ../../docs/spikes/S2-zero-build.md
# for the recorded result.
#
# Node binaries for majors 24 and 26 are resolved the same way the test does:
# an override env var, then the highest matching nvm-installed version.
#   SPIKE_NODE_24_BIN=/path/to/node ./run.sh
#   SPIKE_NODE_26_BIN=/path/to/node ./run.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

resolve_node() {
  local major="$1"
  local override_var="SPIKE_NODE_${major}_BIN"
  local override="${!override_var:-}"
  if [ -n "$override" ]; then
    echo "$override"
    return
  fi
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  local match
  match=$(ls -d "$nvm_dir"/versions/node/v"$major".* 2>/dev/null | sort -V | tail -n1 || true)
  if [ -n "$match" ]; then
    echo "$match/bin/node"
    return
  fi
  if node --version | grep -q "^v$major\."; then
    echo "node"
    return
  fi
  echo "error: no Node $major binary found. Install one (nvm install $major) or set $override_var." >&2
  exit 1
}

NODE24=$(resolve_node 24)
NODE26=$(resolve_node 26)
echo "Node 24 binary: $NODE24 ($($NODE24 --version))"
echo "Node 26 binary: $NODE26 ($($NODE26 --version))"
echo

echo "== pnpm install =="
pnpm install
echo

echo "== node a/src/main.ts, both majors (AC2) =="
for node_bin in "$NODE24" "$NODE26"; do
  echo "-- $($node_bin --version) --"
  (cd a && "$node_bin" src/main.ts)
done
echo

echo "== vitest / tsc -b / vite build resolve the same symlink (AC3) =="
(cd a && pnpm exec vitest run)
pnpm exec tsc -b
(cd a && pnpm exec vite build)
echo

echo "== banned syntax fails at runtime, not just at compile time (AC4) =="
cp b/src/index.ts /tmp/s2-zero-build-index.ts.bak
trap 'cp /tmp/s2-zero-build-index.ts.bak b/src/index.ts; rm -f /tmp/s2-zero-build-index.ts.bak' EXIT
for snippet in \
  'enum Status2 { Ok, Fail }' \
  'namespace X { export const y = 1; }' \
  'class C { constructor(private readonly db: string) {} }'
do
  cp /tmp/s2-zero-build-index.ts.bak b/src/index.ts
  echo "$snippet" >> b/src/index.ts
  echo "-- $snippet --"
  (cd a && "$NODE26" src/main.ts) && echo "UNEXPECTED: exited 0" || echo "rejected, as expected"
done
cp /tmp/s2-zero-build-index.ts.bak b/src/index.ts
echo

echo "== pnpm pack on b: exports point at dist/, not src/ (AC5) =="
(cd b && pnpm pack && tar -xzOf spike-b-*.tgz package/package.json && rm -f spike-b-*.tgz)
echo

echo "Matrix complete. Compare against docs/spikes/S2-zero-build.md."
