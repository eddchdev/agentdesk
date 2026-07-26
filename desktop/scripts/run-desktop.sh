#!/usr/bin/env bash
# AgentDesk Desktop — inicialização rápida para launchers Linux.
# O build pronto é executado diretamente, sem manter um processo npm e sem
# recompilar a aplicação a cada abertura.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DESKTOP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
cd -- "${DESKTOP_DIR}"

export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-auto}"

if [[ "${1:-}" == "dev" ]]; then
  shift
  exec npm run dev -- "$@"
fi

ELECTRON_BIN="${DESKTOP_DIR}/node_modules/electron/dist/electron"
if [[ ! -x "${ELECTRON_BIN}" ]]; then
  printf 'AgentDesk: dependencias ausentes. Rode "npm install" em %s\n' "${DESKTOP_DIR}" >&2
  exit 1
fi

if [[ ! -f "${DESKTOP_DIR}/dist-electron/main.js" || ! -f "${DESKTOP_DIR}/dist-ui/index.html" ]]; then
  printf 'AgentDesk: preparando o primeiro build...\n'
  npm run build
fi

exec "${ELECTRON_BIN}" "${DESKTOP_DIR}" "$@"
