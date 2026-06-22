#!/usr/bin/env bash
# AgentDesk Desktop — launcher com flags Wayland (Hyprland/Sway/GNOME-Wayland/KDE-Wayland)
# Uso:
#   ./scripts/run-desktop.sh          → build + run
#   ./scripts/run-desktop.sh dev      → modo dev (vite hot reload + electron)

set -euo pipefail

cd "$(dirname "$0")/.."

# Wayland: deixa o Electron escolher ozone automaticamente.
# Fallback: força wayland se quiser garantir.
export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-auto}"

# Caso queira forçar wayland em vez de auto, descomente:
# export ELECTRON_EXTRA_LAUNCH_ARGS="--enable-features=UseOzonePlatform,WaylandWindowDecorations --ozone-platform=wayland"

MODE="${1:-prod}"

if [[ "$MODE" == "dev" ]]; then
  exec npm run desktop:dev
else
  exec npm run desktop
fi
