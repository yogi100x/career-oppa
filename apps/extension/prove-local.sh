#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

test_database_url="${DATABASE_TEST_URL:-}"
if [[ -z "$test_database_url" ]]; then
  printf '%s\n' 'Set DATABASE_TEST_URL to the local career_workspace_test database.' >&2
  exit 1
fi
node - "$test_database_url" <<'NODE'
const url = new URL(process.argv[2]);
if (url.pathname !== '/career_workspace_test') {
  throw new Error('Extension proof only accepts career_workspace_test.');
}
NODE

if lsof -nP -iTCP:3002 -sTCP:LISTEN >/dev/null 2>&1; then
  printf '%s\n' 'Port 3002 is already in use; stop that server before running the proof.' >&2
  exit 1
fi

server_pid=''
server_log="$(mktemp -t career-workspace-extension-server.XXXXXX)"
cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [[ -n "$server_pid" ]]; then
    local listener_pid
    listener_pid="$(lsof -tiTCP:3002 -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
    if [[ -n "$listener_pid" ]]; then
      kill "$listener_pid" 2>/dev/null || true
    fi
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  unset VITE_SYNC_HOST VITE_API_BASE_URL
  if ! pnpm --filter @career-workspace/extension build >/dev/null; then
    printf '%s\n' 'Could not restore the default extension build.' >&2
    exit_code=1
  fi
  rm -f "$server_log"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM
trap 'exit 130' INT
trap 'exit 143' TERM

export DATABASE_URL="$test_database_url"
export VITE_SYNC_HOST=http://localhost:3002
export VITE_API_BASE_URL=http://localhost:3002
pnpm --filter @career-workspace/extension build >/dev/null
node <<'NODE'
const fs = require('node:fs');
const path = 'apps/extension/dist/manifest.json';
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
manifest.host_permissions = [...new Set([
  ...manifest.host_permissions,
  'http://localhost:3002/*',
])];
fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

PORT=3002 APP_URL=http://localhost:3002 \
DATABASE_URL="$test_database_url" NEXT_DIST_DIR=.next-extension-proof \
FEATURE_PRACTICE=true FEATURE_PUBLISHING=true STORAGE_DRIVER=local \
pnpm --filter @career-workspace/web dev >"$server_log" 2>&1 &
server_pid=$!

ready=false
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:3002/sign-in >/dev/null 2>&1; then
    ready=true
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  printf '%s\n' 'The isolated web server did not become ready; its log was kept out of the terminal to avoid exposing configuration.' >&2
  exit 1
fi

DATABASE_TEST_URL="$test_database_url" pnpm exec tsx apps/web/e2e/extension-popup-proof.ts
