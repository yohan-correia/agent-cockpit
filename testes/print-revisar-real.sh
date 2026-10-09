#!/usr/bin/env bash
# Prints 390×844 da tela "Pra revisar" com os JOBS REAIS do disco (a pasta de jobs do orquestrador), num
# servidor de teste isolado como o do `prova-revisar-oraculo.sh` — só a pasta de jobs é real;
# HOME, push, tmux e cert são falsos, pra não acordar nada de produção (armadilha #78).
#
# Existe porque a regra de 25/08 manda print ANTES/DEPOIS "com os jobs reais, contagem visível":
# o `print-celular-revisar.mjs` tira o PNG, mas precisa de um servidor no ar — e subir o
# servidor à mão a cada rodada é trabalho que some com a sessão. Aqui ele é um comando só.
#
# Uso:
#   testes/print-revisar-real.sh <pasta-de-saida> <sufixo> [cena ...]
#     cena = lateral | lista | lista-atencao | lista-detalhe | job-relacionado (default: lista lista-atencao)
#   ex.: testes/print-revisar-real.sh ~/.cockpit/smoke-shots/2026-10-06-pra-revisar-v2 ANTES
#
# Saídas: 0 = todos os PNGs gravados · 1 = algum print reprovou · 2 = ambiente indisponível.
# Imprime também a contagem da rota (`jobs` e `atencao`) — é o número que o PNG tem de mostrar.

set -u
set -o pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$AQUI")"

SAIDA_DIR="${1:-}"
SUFIXO="${2:-}"
shift 2 2>/dev/null || { echo "uso: $0 <pasta-de-saida> <sufixo> [cena ...]"; exit 2; }
CENAS=("$@")
[ ${#CENAS[@]} -eq 0 ] && CENAS=(lista lista-atencao)

JOBS_DIR="${COCKPIT_JOBS_DIR_REAL:-}"
[ -n "$JOBS_DIR" ] || { echo "🟡 defina COCKPIT_JOBS_DIR_REAL=<pasta de jobs do orquestrador>"; exit 2; }
[ -d "$JOBS_DIR" ] || { echo "🟡 $JOBS_DIR não existe — ambiente indisponível."; exit 2; }

# Portas 7891-7898; nunca 7879 (produção) nem 7899 (#24).
PORTA=${PORT:-7895}
if [ "$PORTA" -lt 7891 ] || [ "$PORTA" -gt 7898 ]; then echo "🔴 porta $PORTA fora de 7891-7898."; exit 2; fi
if ss -H -lptn 2>/dev/null | awk '{print $4}' | grep -q ":$PORTA\$"; then echo "🔴 porta $PORTA ocupada."; exit 2; fi
if [ -n "${COCKPIT_TMUX_SOCKET:-}" ]; then echo "🔴 COCKPIT_TMUX_SOCKET herdado (\"$COCKPIT_TMUX_SOCKET\") — abortando."; exit 2; fi

# Isolamento por lista fechada (#57/#62/#78): nenhuma COCKPIT_* herdada passa (COCKPIT_USO_DIR
# herdada venceria o HOME falso). `JOBS_DIR` já foi lido acima; só as do bloco abaixo valem.
for v in $(compgen -e | grep '^COCKPIT_'); do unset "$v"; done

HOME_FALSO=$(mktemp -d)
PUSH_DIR_FALSO=$(mktemp -d)
SERVER_PID=""
limpar() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  rm -rf "$HOME_FALSO" "$PUSH_DIR_FALSO"
}
trap limpar EXIT

(
  cd "$REPO_ROOT" || exit 1
  HOME="$HOME_FALSO" PORT="$PORTA" HOST=127.0.0.1 COCKPIT_TOKEN= \
  COCKPIT_JOBS_DIR="$JOBS_DIR" COCKPIT_VIGIA_MS=0 COCKPIT_PUSH_DIR="$PUSH_DIR_FALSO" \
  COCKPIT_TMUX_SOCKET="print-revisar-real-$$" COCKPIT_CERT_DIR=/dev/null \
  exec node server.js
) &
SERVER_PID=$!

SUBIU=0
for _ in $(seq 1 40); do
  if curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORTA/api/jobs"; then SUBIU=1; break; fi
  sleep 0.1
done
[ "$SUBIU" -eq 1 ] || { echo "🔴 o servidor não respondeu na $PORTA."; exit 1; }

RESP=$(curl -s -m 20 "http://127.0.0.1:$PORTA/api/jobs?revisar=1")
echo "· rota ?revisar=1: jobs=$(echo "$RESP" | jq -r '.jobs | length') atencao=$(echo "$RESP" | jq -r '(.atencao // []) | length') habilitado=$(echo "$RESP" | jq -r .habilitado)"
echo "$RESP" | jq -r '.jobs[] | "  · \(.projeto) · \(.titulo) · \(.etiquetas | join(","))"'
echo "$RESP" | jq -r '(.atencao // [])[] | "  ⚠ \(.projeto) · \(.titulo) · \(.etiquetas | join(","))"'

mkdir -p "$SAIDA_DIR"
RC=0
N=0
for cena in "${CENAS[@]}"; do
  N=$((N + 1))
  ARQ="$SAIDA_DIR/$N-$cena-$SUFIXO.png"
  if ! node "$AQUI/print-celular-revisar.mjs" --porta "$PORTA" --saida "$ARQ" --cena "$cena"; then RC=1; fi
done
exit $RC
