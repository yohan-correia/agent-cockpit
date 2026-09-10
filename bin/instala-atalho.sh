#!/usr/bin/env bash
# Cria um atalho no computador que acessa o Cockpit.
# COCKPIT_URL escolhe o endereço; o perfil atual do navegador preserva o login.
set -euo pipefail

URL="${COCKPIT_URL:-http://localhost:7879/}"
CLASSE="cockpit-agentes"
APPS="$HOME/.local/share/applications"
ICONES="$HOME/.local/share/icons"

# Zen e LibreWolf são Firefox por baixo e aceitam as mesmas opções.
NAVEGADOR=""
for candidato in zen zen-browser firefox librewolf floorp; do
  if command -v "$candidato" >/dev/null 2>&1; then NAVEGADOR="$candidato"; break; fi
done
if [ -z "$NAVEGADOR" ]; then
  echo "não achei firefox, zen nem librewolf no PATH." >&2
  echo "se o seu navegador tem outro nome, rode: COCKPIT_NAVEGADOR=<nome> bash $0" >&2
  [ -n "${COCKPIT_NAVEGADOR:-}" ] && NAVEGADOR="$COCKPIT_NAVEGADOR" || exit 1
fi
[ -n "${COCKPIT_NAVEGADOR:-}" ] && NAVEGADOR="$COCKPIT_NAVEGADOR"

mkdir -p "$APPS" "$ICONES"

# O ícone vem do próprio cockpit. -k porque o certificado é válido, mas a máquina pode
# não estar com o tailnet de pé na hora; se falhar, o atalho fica sem ícone e só.
if ! curl -fsS --max-time 10 "${URL%/}/icone-512.png" -o "$ICONES/cockpit-agentes.png"; then
  echo "não consegui baixar o ícone. O atalho vai sem ícone."
fi

cat > "$APPS/cockpit-agentes.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Cockpit de Agentes
Comment=Conversar com agentes no seu servidor
Exec=$NAVEGADOR --new-window --class=$CLASSE "$URL"
Icon=$ICONES/cockpit-agentes.png
Terminal=false
Categories=Development;Utility;
StartupWMClass=$CLASSE
DESKTOP

chmod +x "$APPS/cockpit-agentes.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" || true

echo "pronto: procure por 'Cockpit de Agentes' no menu de aplicativos."
echo "navegador: $NAVEGADOR"
echo "endereço:  $URL"
echo
echo "Se o servidor exigir token, use o token configurado por quem o instalou."
