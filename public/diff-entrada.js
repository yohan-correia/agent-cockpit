'use strict';
// Entrada da diff de commit e de job (card `ver-a-diff-do-codigo`, D95; NA MESMA ABA desde D96) — três
// lugares (#btn-commits, "Ver mudanças" do painel do job, "Ver mudanças" do Pra revisar) montam a URL por
// `urlDaDiff`, pura, sem depender de `diff.js` (molde `urlDoMapa` de `public/grafo.js`), e saem pela porta
// única `cockpitDentro.abrir` (`public/dentro-do-app.js`). Sem token na URL: mesma origem e mesma aba, a diff
// lê o `localStorage` do cockpit. `cockpitDiffEntrada`/`cockpitDentro` só são lidos DENTRO de cada `onclick`
// (R4): nada aqui é tocado na criação do painel/card, só no toque do usuário.
(function () {

/** Mesma ordem fixa de `public/diff.js` (`montarHash`): projeto, commit, job. Função PRÓPRIA — não
 * depende de `diff.js`, que nem é carregado no `index.html` (este script vem DEPOIS do `app.js`; V13 sobrescrita no plano). */
function montarHash(estado) {
  const partes = [];
  for (const chave of ['projeto', 'commit', 'job']) {
    if (estado[chave] !== undefined && estado[chave] !== null) partes.push(`${chave}=${encodeURIComponent(estado[chave])}`);
  }
  return partes.length ? `#${partes.join('&')}` : '';
}

/** Relativa ao `<base>` do documento (#16: sob `/cockpit/` vira `/cockpit/diff/`), sem token (D96). */
function urlDaDiff(estado) {
  return `diff/${montarHash(estado || {})}`;
}

globalThis.cockpitDiffEntrada = { urlDaDiff };

if (typeof document !== 'undefined' && document.getElementById('btn-commits')) {
  document.getElementById('btn-commits').onclick = () => {
    globalThis.cockpitDentro.abrir(urlDaDiff({}), null);
  };
}

})();
