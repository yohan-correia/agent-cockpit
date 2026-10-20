#!/usr/bin/env bash
# MEDIÇÃO do card `mensagem-some-no-menu-do-auto-mode` — o diálogo "Teach auto mode about your
# environment?" que o Claude Code abre SOZINHO no fim de um turno.
#
# O gatilho (lido no binário 2.1.280, função `xP`): modo de permissão `auto` + `numStartups >= 5`
# + `autoModeEnvSetup.denials >= 5` no `.claude.json` GLOBAL + nada de `dismissed`/`dismissedAt`
# recente. O contador de negações é da MÁQUINA, não da sessão: a 5ª negação do classificador em
# qualquer aba arma o diálogo, e ele abre no fim do próximo turno de qualquer aba em modo auto.
#
# Mundo de mentira: HOME temporário (0700) com `.claude.json` sintético (denials = 5), settings com
# `defaultMode: auto`, e a credencial do dono por SYMLINK (nunca copiada, nunca lida por aqui — é o
# CLI quem lê). tmux em socket próprio com `-f /dev/null` (#tmux-isolado). Custa turnos de verdade
# (sonnet: o modo auto não existe no haiku). NÃO roda no `npm test`.
#
# Uso: bash testes/medir-menu-auto-mode.sh <pasta-de-saida> [colunas] [linhas] [binario]
# Sai 0 com as capturas na pasta; 2 = ambiente indisponível (o diálogo não abriu em 90 s).
set -u
SAIDA="${1:?pasta de saída}"; COLS="${2:-120}"; ROWS="${3:-40}"; BIN="${4:-/usr/bin/claude}"
mkdir -p "$SAIDA"
S="cockpit-smoke-automode-$$"
T() { tmux -L "$S" -f /dev/null "$@"; }
H="$(mktemp -d /tmp/medir-automode-home-XXXX)"; chmod 700 "$H"
W="$H/projeto"; mkdir -p "$W" "$H/.claude"
trap 'T kill-server 2>/dev/null; sleep 1; rm -rf "$H"' EXIT
ln -s "$HOME/.claude/.credentials.json" "$H/.claude/.credentials.json"
cat > "$H/.claude.json" <<EOF
{"hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.280","numStartups":10,"autoUpdates":false,
 "autoModeEnvSetup":{"denials":5},"hasSeenAutoModeEntryWarning":true,
 "hasResetAutoModeOptInForDefaultOffer":true,"theme":"dark",
 "projects":{"$W":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}
EOF
echo '{"permissions":{"defaultMode":"auto"}}' > "$H/.claude/settings.json"

CMD="env -i HOME=$H PATH=/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 $BIN --model sonnet"
# Duas subidas: a 1ª só aquece o cache de feature flags do `.claude.json` (`cachedGrowthBookFeatures`).
# Medido em 16/10: na 2.1.280 com HOME zerado e subida única o diálogo NÃO abre; com o cache
# aquecido, abre. O `.claude.json` do dono sempre tem esse cache.
T new-session -d -s aquece -c "$W" -x "$COLS" -y "$ROWS" "$CMD"
for _ in $(seq 1 40); do T capture-pane -p -t aquece | grep -q '❯' && break; sleep 1; done
sleep 8
T kill-session -t aquece; sleep 2
T new-session -d -s main -c "$W" -x "$COLS" -y "$ROWS" "$CMD"
for _ in $(seq 1 40); do T capture-pane -p -t main | grep -q '❯' && break; sleep 1; done
sleep 3
T capture-pane -p -t main > "$SAIDA/00-livre-antes.txt"
status() { for f in "$H"/.claude/sessions/*.json; do node -e 'const d=require(process.argv[1]);console.log(JSON.stringify({status:d.status,waitingFor:d.waitingFor??null}))' "$f"; done; }

cola() { T send-keys -t main -l -- $'\e[200~'"$1"$'\e[201~'; sleep 0.15; T send-keys -t main Enter; }
case "${MODO:-}" in
  citacao)
    # O falso positivo que a régua precisa recusar: o texto do diálogo CITADO na conversa.
    cola 'Responda com exatamente estas linhas, num bloco de código, e nada mais: ──────── / ❯ 1. Yes / 2. Not now / Enter to confirm · Esc to cancel (uma por linha, sem as barras)'
    ;;
  rascunho)
    # R3 da spec: o que UM Esc faz com rascunho na caixa — ocioso, e com o diálogo por cima.
    T send-keys -t main -l -- 'rascunho ocioso'; sleep 0.5
    T capture-pane -p -t main > "$SAIDA/00c-ocioso-com-rascunho.txt"
    T send-keys -t main Escape; sleep 0.8
    T capture-pane -p -t main > "$SAIDA/00d-ocioso-depois-de-um-esc.txt"
    T send-keys -t main C-u; sleep 0.3
    T send-keys -t main Escape; sleep 0.8
    T capture-pane -p -t main > "$SAIDA/00e-ocioso-vazio-depois-de-um-esc.txt"
    cola 'conte de 1 a 10 por extenso, um número por linha'
    sleep 1.5
    T send-keys -t main -l -- 'rascunho do dono'   # digitado com o turno rodando, sem Enter
    ;;
  fila)
    # A 2ª mensagem chega com o turno RODANDO (fila do CLI). Ela é processada antes do diálogo?
    cola 'conte de 1 a 15 por extenso, um número por linha'
    sleep 1.5
    T capture-pane -p -t main > "$SAIDA/00b-ocupado.txt"
    cola 'agora responda apenas: fila'
    ;;
  *) cola 'responda apenas: oi' ;;
esac
ABRIU=""
for _ in $(seq 1 180); do
  if T capture-pane -p -t main | grep -q 'Teach auto mode'; then ABRIU=1; break; fi
  sleep 0.5
done
[ -n "$ABRIU" ] || { echo "🟡 o diálogo não abriu em 90 s"; T capture-pane -p -t main; exit 2; }
date -u +%FT%T.%3NZ > "$SAIDA/01-hora-dialogo.txt"
# MODO=fila: o diálogo segura a fila? Espera 15 s com ele aberto antes de qualquer tecla.
[ "${MODO:-}" = fila ] && sleep 15
sleep 1
T capture-pane -p -t main > "$SAIDA/01-dialogo.txt"
T capture-pane -p -e -t main > "$SAIDA/01-dialogo.ansi.txt"
echo "status com o diálogo aberto: $(status)" | tee "$SAIDA/01-status.txt"

# MODO=sim: o Enter que o cockpit mandava — o "Yes" abre o assistente (status muda para waiting).
if [ "${MODO:-}" = sim ]; then
  T send-keys -t main Enter; sleep 1.5
  T capture-pane -p -t main > "$SAIDA/01b-assistente.txt"
  echo "status com o assistente aberto: $(status)" | tee "$SAIDA/01b-status.txt"
  T send-keys -t main Escape; sleep 1
  T capture-pane -p -t main > "$SAIDA/01c-depois-do-esc-no-assistente.txt"
  echo "status depois do Esc no assistente: $(status)" | tee "$SAIDA/01c-status.txt"
fi
# Esc no diálogo = "Not now" (onCancel → later). Composer livre depois?
date -u +%FT%T.%3NZ > "$SAIDA/02-hora-esc.txt"
T send-keys -t main Escape; sleep 0.6
T capture-pane -p -t main > "$SAIDA/02-depois-do-esc.txt"
echo "status depois do Esc: $(status)" | tee "$SAIDA/02-status.txt"

# A colagem + Enter com o composer livre — chega ao agente?
T send-keys -t main -l -- $'\e[200~responda apenas: tchau\e[201~'; sleep 0.15; T send-keys -t main Enter
for _ in $(seq 1 120); do T capture-pane -p -t main | grep -q 'esc to interrupt' || break; sleep 0.5; done
sleep 3
T capture-pane -p -t main > "$SAIDA/03-livre-depois.txt"
echo "status no fim: $(status)" | tee "$SAIDA/03-status.txt"
node -e '
const fs = require("fs");
const h = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).display);
console.log("history:", JSON.stringify(h));' "$H/.claude/history.jsonl" | tee "$SAIDA/04-history.txt"
jq -c '{autoModeEnvSetup}' "$H/.claude.json" | tee "$SAIDA/05-config.txt"
# Linha do tempo da sessão SINTÉTICA: quando cada fala humana entrou no `.jsonl`.
node -e '
const fs = require("fs");
for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) {
  const j = JSON.parse(l);
  const c = j.message && j.message.content;
  if (j.type === "user" && typeof c === "string") console.log(j.timestamp, "humano", JSON.stringify(c.slice(0, 40)));
  if (j.type === "system" && j.subtype === "turn_duration") console.log(j.timestamp, "fim de turno");
}' "$(ls "$H"/.claude/projects/*/*.jsonl | head -1)" | tee "$SAIDA/06-linha-do-tempo.txt"
