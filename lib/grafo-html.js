'use strict';
/**
 * `extrairHtml(texto)` → lista de referências LOCAIS de `<script src=…>`/`<link href=…>`
 * (comentário HTML removido antes; `http(s):`, `//`, `data:`, `mailto:` e `#` descartados; `?…`/
 * `#…` do fim tirados). A resolução para arquivo (relativo à pasta do `.html`, ou à raiz do repo
 * quando começa com `/`) mora em `grafo-extrator.js` — aqui só o que está escrito no HTML.
 */

const RE_REFERENCIA = /<(script|link)\b[^>]*?\b(?:src|href)\s*=\s*(['"])([^'"]*)\2[^>]*>/gi;

function extrairHtml(texto) {
  const semComentarios = texto.replace(/<!--[\s\S]*?-->/g, '');
  const refs = [];
  let m;
  RE_REFERENCIA.lastIndex = 0;
  while ((m = RE_REFERENCIA.exec(semComentarios))) {
    let v = m[3];
    if (!v) continue;
    if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(v)) continue; // http(s):// ou //cdn (protocol-relative)
    if (/^(data|mailto):/i.test(v)) continue;
    if (v.startsWith('#')) continue;
    v = v.split('#')[0].split('?')[0];
    if (!v) continue;
    refs.push(v);
  }
  return refs;
}

module.exports = { extrairHtml };
