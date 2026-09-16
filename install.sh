#!/usr/bin/env bash
#
# CacheSnipe installer.
#
#   ./install.sh                 build, show every change, ask before writing
#   ./install.sh --dry-run       build and show changes, write nothing
#   ./install.sh --yes           build and apply without prompting
#   ./install.sh --stats-dir <d> use a different stats directory
#   ./install.sh --strict-freeze replay session-start blocks so restarts keep their prefix
#   ./install.sh --no-commands   skip installing the three /cache-* commands
#
# It never rewrites your config: scripts/patch-config.mjs inserts the settings
# textually, verifies the result by re-parsing, and keeps a timestamped backup.
# Re-running is safe and idempotent.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${HOME}/.config/opencode"
CONFIG_FILES=("${CONFIG_DIR}/opencode.json" "${CONFIG_DIR}/opencode.jsonc")
COMMAND_FILES=(cache-stats.md cache-graph.md cache-reset.md)
STATS_DIR="${HOME}/.local/share/opencode/deepseek-cache"

DRY_RUN=0
ASSUME_YES=0
INSTALL_COMMANDS=1
STRICT_FREEZE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --no-commands) INSTALL_COMMANDS=0 ;;
    --strict-freeze) STRICT_FREEZE=1 ;;
    --stats-dir) STATS_DIR="${2:?--stats-dir needs a value}"; shift ;;
    --help|-h)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

step "environment"
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }
NODE_VERSION="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "node >= 22 is required (found ${NODE_VERSION})" >&2
  exit 1
fi
say "node ${NODE_VERSION}"
say "repo ${REPO_DIR}"
say "stats ${STATS_DIR}"
if [ ! -d "${CONFIG_DIR}" ]; then
  echo "opencode config directory not found: ${CONFIG_DIR}" >&2
  echo "Start OpenCode once, then re-run this script." >&2
  exit 1
fi

step "build"
if [ ! -d "${REPO_DIR}/node_modules" ]; then
  say "installing devDependencies (typescript, @opencode-ai/plugin, @types/node)"
  (cd "${REPO_DIR}" && npm install --no-audit --no-fund)
fi
(cd "${REPO_DIR}" && npx tsc -p tsconfig.json)
PLUGIN_ENTRY="${REPO_DIR}/dist/src/plugin.js"
[ -f "${PLUGIN_ENTRY}" ] || { echo "build did not produce ${PLUGIN_ENTRY}" >&2; exit 1; }
say "built ${PLUGIN_ENTRY}"

PLUGIN_SPEC="file://${PLUGIN_ENTRY}"
if [ -n "${STATS_DIR}" ] && [ "${STATS_DIR}" != "${HOME}/.local/share/opencode/deepseek-cache" ]; then
  say "note: pass a custom stats dir through plugin options: [\"${PLUGIN_SPEC}\", {\"statsDir\": \"${STATS_DIR}\"}]"
fi

if [ "${STRICT_FREEZE}" -eq 1 ]; then
  say "strictFreeze: session-start blocks will be replayed (restarts keep their prefix; mid-session skill/MCP changes wait for the next session)"
fi

if [ "${INSTALL_COMMANDS}" -eq 1 ]; then
  step "commands"
  mkdir -p "${CONFIG_DIR}/commands"
  for name in "${COMMAND_FILES[@]}"; do
    src="${REPO_DIR}/commands/${name}"
    dst="${CONFIG_DIR}/commands/${name}"
    if [ ! -f "${src}" ]; then
      say "missing ${src}; skipping"
      continue
    fi
    if [ -f "${dst}" ] && cmp -s "${src}" "${dst}"; then
      say "ok    ${dst} (already current)"
      continue
    fi
    if [ "${DRY_RUN}" -eq 1 ]; then
      say "would install ${dst}"
      continue
    fi
    if [ -f "${dst}" ]; then
      backup="${dst}.bak-$(date +%Y%m%dT%H%M%S)"
      cp "${dst}" "${backup}"
      say "backed up ${dst} -> ${backup}"
    fi
    cp "${src}" "${dst}"
    say "ok    installed ${dst}"
  done
fi

step "opencode config"
PLUGIN_FLAGS=("--plugin-spec" "${PLUGIN_SPEC}")
if [ "${STRICT_FREEZE}" -eq 1 ]; then PLUGIN_FLAGS+=("--strict-freeze"); fi
for file in "${CONFIG_FILES[@]}"; do
  [ -f "${file}" ] || { say "skip  ${file} (does not exist)"; continue; }
  if [ "${DRY_RUN}" -eq 1 ]; then
    node "${REPO_DIR}/scripts/patch-config.mjs" --file "${file}" "${PLUGIN_FLAGS[@]}" --dry-run
    continue
  fi
  node "${REPO_DIR}/scripts/patch-config.mjs" --file "${file}" "${PLUGIN_FLAGS[@]}" --dry-run
  if [ "${ASSUME_YES}" -eq 1 ]; then
    node "${REPO_DIR}/scripts/patch-config.mjs" --file "${file}" "${PLUGIN_FLAGS[@]}" --apply
  else
    printf 'apply the changes above to %s? [y/N] ' "${file}"
    read -r reply
    case "${reply}" in
      y|Y|yes|YES) node "${REPO_DIR}/scripts/patch-config.mjs" --file "${file}" "${PLUGIN_FLAGS[@]}" --apply ;;
      *) say "left ${file} unchanged" ;;
    esac
  fi
done

step "next steps"
say "1. Restart the OpenCode desktop app so it reloads plugins."
say "2. Send a message with deepseek/deepseek-v4-flash, then run /cache-stats."
say "3. Confirm the plugin loaded:"
say "     grep -a cachesnipe \"\${HOME}/.local/share/opencode/log/opencode.log\" | tail -5"
say "     tail -5 \"${STATS_DIR}/cachesnipe.log\""
say "4. Measure cache reuse independently of the plugin:"
say "     (cd \"${REPO_DIR}\" && npm run verify)"
if [ "${DRY_RUN}" -eq 1 ]; then
  say ""
  say "dry run: nothing was written."
fi
