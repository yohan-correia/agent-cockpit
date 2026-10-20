'use strict';
// Regra da casa (D96): toda tela do Cockpit abre DENTRO do app — mesma janela, mesmo PWA. Aba nova
// (`window.open`, `target="_blank"`) só para link EXTERNO de verdade; o `testes/gate-dentro-do-app.js`
// reprova qualquer outro. Esta é a porta única de saída do cockpit para uma página dele (diff, mapa):
// `abrir(url, extra)` guarda no `history.state` da entrada ATUAL o que estava aberto (`volta`) e navega NA
// MESMA ABA (molde `financas-entrada.js`, P10 do D92). A volta SEM bfcache recarrega o cockpit na lista; cada
// dono reabre o seu pedaço com `tomarVolta(chave)` — `app.js` o painel (`chave`/`emChat`), `revisar.js` o
// Pra revisar (`revisar`), `grafo.js` o diálogo de grafos (`grafos`). A marca no `sessionStorage` diz à página
// de destino que ela veio do cockpit NESTA aba (o referrer não serve: `Referrer-Policy: no-referrer`) — a
// MESMA string mora em `diff.js` e `grafo-mapa.js` (DJ7 do gate-ui). Carrega ANTES do `app.js`: `revisar.js`
// e `grafo.js` leem a volta no próprio boot. Todo acesso a `history`/`sessionStorage` em `try`: o modo
// privado LANÇA, e a ida tem de acontecer igual.
(function () {

const CHAVE_VEIO = 'cockpit-veio-do-app';

/** Sai para `url` (relativa ao `<base>`, #16) NA MESMA ABA, guardando `volta = { ...base, ...extra }`. */
function abrir(url, extra) {
  let base = {};
  try { if (typeof globalThis.cockpitVolta === 'function') base = globalThis.cockpitVolta() || {}; } catch { /* sem base: só o extra */ }
  try { history.replaceState({ ...(history.state || {}), volta: { ...base, ...(extra || {}) } }, ''); } catch { /* sem histórico: a ida funciona igual */ }
  try { sessionStorage.setItem(CHAVE_VEIO, '1'); } catch { /* modo privado: o destino cai no comportamento de link direto */ }
  location.assign(url);
}

/** Lê `history.state.volta[chave]` NA HORA, apaga SÓ essa chave e devolve o valor (`undefined` sem volta). */
function tomarVolta(chave) {
  try {
    const s = history.state;
    if (!s || !s.volta || !Object.prototype.hasOwnProperty.call(s.volta, chave)) return undefined;
    const resto = { ...s.volta };
    const valor = resto[chave];
    delete resto[chave];
    history.replaceState({ ...s, volta: Object.keys(resto).length ? resto : null }, '');
    return valor;
  } catch { return undefined; }
}

globalThis.cockpitDentro = { abrir, tomarVolta };

// M10 (D96): voltou pelo bfcache — a página já está como estava; só apaga a `volta`, pra um F5 depois não
// reabrir nada.
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pageshow', (e) => {
    if (!e || !e.persisted) return;
    try {
      const s = history.state;
      if (s && s.volta) history.replaceState({ ...s, volta: null }, '');
    } catch { /* sem histórico: nada a apagar */ }
  });
}

})();
