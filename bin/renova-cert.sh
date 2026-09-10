#!/usr/bin/env bash
# Renova o certificado TLS do cockpit e reinicia o serviço só se algo mudou.
#
# `tailscale cert` é idempotente: se o certificado ainda é válido por tempo suficiente,
# ele reescreve os mesmos bytes e não fala com a Let's Encrypt. Por isso o timer pode
# rodar todo dia sem medo — quem decide quando renovar é o Tailscale, não este script.
#
# Sem sudo de propósito: `tailscale serve` exigiria, e mexeria na configuração compartilhada
# que publica o /jobs. Aqui o certificado é só um par de arquivos que o Node lê.
set -euo pipefail

DIR="${COCKPIT_CERT_DIR:-$HOME/.cockpit/cert}"
mkdir -p "$DIR"

# O nome do certificado é o nome MagicDNS desta máquina. Descobrir na hora evita chumbar
# um domínio que muda se o tailnet for renomeado.
NOME="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
if [ -z "$NOME" ]; then
  echo "não descobri o nome MagicDNS desta máquina" >&2
  exit 1
fi

ANTES=""
[ -f "$DIR/servidor.crt" ] && ANTES="$(sha256sum "$DIR/servidor.crt" | cut -d' ' -f1)"

tailscale cert --cert-file "$DIR/servidor.crt" --key-file "$DIR/servidor.key" "$NOME"

DEPOIS="$(sha256sum "$DIR/servidor.crt" | cut -d' ' -f1)"
if [ "$ANTES" != "$DEPOIS" ]; then
  echo "certificado de $NOME mudou; reiniciando o cockpit"
  systemctl --user restart cockpit-agentes
else
  echo "certificado de $NOME inalterado"
fi
