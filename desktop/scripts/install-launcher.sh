#!/usr/bin/env bash
# Instala o AgentDesk no launcher de aplicativos do usuário (XDG/Rofi/HyDE).
# Não usa sudo e pode ser executado novamente após mover o repositório.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DESKTOP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
RUNNER="${SCRIPT_DIR}/run-desktop.sh"
ICON="${DESKTOP_DIR}/ui/public/icon.png"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
APPLICATIONS_DIR="${DATA_HOME}/applications"
ENTRY="${APPLICATIONS_DIR}/agentdesk.desktop"

if [[ ! -x "${RUNNER}" ]]; then
  printf 'Erro: launcher executável não encontrado em %s\n' "${RUNNER}" >&2
  exit 1
fi

if [[ ! -f "${ICON}" ]]; then
  printf 'Erro: ícone não encontrado em %s\n' "${ICON}" >&2
  exit 1
fi

# O campo Exec usa aspas para continuar válido caso o projeto esteja em um
# diretório com espaços. Aspas em nomes de diretório são raras e ambíguas na
# especificação Desktop Entry; nesse caso, paramos com uma mensagem clara.
if [[ "${RUNNER}" == *'"'* || "${RUNNER}" == *$'\n'* || "${ICON}" == *$'\n'* ]]; then
  printf 'Erro: o caminho do AgentDesk contém aspas ou quebra de linha não suportadas.\n' >&2
  exit 1
fi

mkdir -p -- "${APPLICATIONS_DIR}"
TMP_ENTRY="$(mktemp --suffix=.desktop "${APPLICATIONS_DIR}/.agentdesk.XXXXXX")"
trap 'rm -f -- "${TMP_ENTRY}"' EXIT

printf '%s\n' \
  '[Desktop Entry]' \
  'Version=1.0' \
  'Type=Application' \
  'Name=AgentDesk' \
  'GenericName=Coordenador de agentes' \
  'Comment=Equipe autônoma de agentes trabalhando em paralelo' \
  "Exec=\"${RUNNER}\"" \
  "TryExec=${RUNNER}" \
  "Icon=${ICON}" \
  'Terminal=false' \
  'StartupNotify=true' \
  'StartupWMClass=agentdesk-desktop' \
  'Categories=Development;ProjectManagement;' \
  'Keywords=AgentDesk;agentes;Claude;MCP;IA;equipe;' \
  > "${TMP_ENTRY}"

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "${TMP_ENTRY}"
fi

chmod 0644 "${TMP_ENTRY}"
mv -f -- "${TMP_ENTRY}" "${ENTRY}"
trap - EXIT

if command -v update-desktop-database >/dev/null 2>&1; then
  if ! update-desktop-database "${APPLICATIONS_DIR}"; then
    printf 'Aviso: a entrada foi instalada, mas o cache de aplicativos não pôde ser atualizado.\n' >&2
  fi
fi

printf 'AgentDesk instalado no launcher: %s\n' "${ENTRY}"
printf 'Abra o menu de aplicativos e pesquise por AgentDesk.\n'
