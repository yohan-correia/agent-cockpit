#!/usr/bin/env bash
# REPRO do card `fila-presa-com-barra-invertida-no-fim` — o que a TUI do Claude faz com a "\" FINAL.
#
# Repete os MESMOS send-keys de `digitarNaAba` (lib/abas.js): colagem delimitada \e[200~…\e[201~,
# 150 ms, Enter, e depois a conferência do composer a cada 400 ms reenviando Enter enquanto a caixa
# tem texto (TENTATIVAS_DE_ENTER = 3). Mostra o composer depois de cada passo e, no fim, o que o
# `.jsonl` gravou para cada mensagem.
#
# Medido em 13/10/2026 (CLI 2.1.280): "\" + Enter vira quebra de linha e a "\" some; é o Enter da
# conferência que submete; o .jsonl grava sem a "\" (só UMA: "\\" volta "\"). "\" no meio fica.
#
# tmux isolado: socket próprio e `-f /dev/null` (com HOME real o continuum-restore clona as
# sessões do usuário no socket novo). Custa turnos de verdade (haiku). NÃO roda no `npm test`.
#
# Uso: bash testes/repro-barra-final-tui.sh ['texto 1 \' '/handoff \' ...]
set -u
[ $# -gt 0 ] || set -- 'texto qualquer \' '/handoff \' 'colado\' 'eco duplo \\' 'a\b fim'
S="repro-barra-$$"
T() { tmux -L "$S" -f /dev/null "$@"; }
CWD="$(mktemp -d /tmp/repro-barra-final-XXXX)"
trap 'T kill-server 2>/dev/null' EXIT
T new-session -d -s m -c "$CWD" -x 120 -y 40 /usr/bin/claude --model haiku
for _ in $(seq 1 60); do
  T capture-pane -p -t m | grep -qiE 'trust this folder|Quick safety check|❯' && break; sleep 1
done
if T capture-pane -p -t m | grep -qiE 'trust this folder|Quick safety check'; then
  T send-keys -t m Down; sleep 0.4; T send-keys -t m Enter
fi
for _ in $(seq 1 60); do T capture-pane -p -t m | grep -q '❯' && break; sleep 1; done
sleep 3
PANEPID=$(T list-panes -t m -F '#{pane_pid}')

# A última linha de prompt é o composer — a mesma leitura de `composerTemTexto`.
composer() { T capture-pane -p -t m | grep '❯' | tail -1 | perl -CS -pe 's/^\s*❯//; s/^\s+|\s+$//g'; }
ocupado() { T capture-pane -p -t m | grep -q 'esc to interrupt'; }

for texto in "$@"; do
  echo "=== enviado: [$texto]"
  T send-keys -t m -l -- $'\e[200~'"$texto"$'\e[201~'
  sleep 0.15
  echo "  colado:               [$(composer)]"
  T send-keys -t m Enter
  for n in 1 2 3; do
    sleep 0.4
    c=$(composer)
    echo "  conferência $n:        [$c]"
    [ -z "$c" ] && break
    T send-keys -t m Enter
  done
  sleep 2
  for _ in $(seq 1 120); do ocupado || break; sleep 1; done
  sleep 2
done

ID=""
for p in $PANEPID $(pgrep -P "$PANEPID"); do
  f="$HOME/.claude/sessions/$p.json"
  [ -f "$f" ] && ID=$(node -e 'process.stdout.write(require(process.argv[1]).sessionId||"")' "$f")
done
ARQ=$(ls "$HOME"/.claude/projects/*/"$ID".jsonl 2>/dev/null | head -1)
echo "=== .jsonl: ${ARQ:-não achei}"
[ -n "$ARQ" ] && node -e '
const fs = require("fs");
for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) {
  const j = JSON.parse(l);
  if (j.type !== "user" || j.isMeta) continue;
  const c = j.message && j.message.content;
  if (typeof c !== "string") continue;
  console.log("  gravado:", JSON.stringify(c));
}' "$ARQ"
