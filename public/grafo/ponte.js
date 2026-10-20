'use strict';
// Adaptador do dashboard do understand-anything (MIT, vendorizado em ./ua). Ele busca os dados por
// caminho ABSOLUTO (`/${arquivo}?token=`), que só funciona servido na raiz; aqui ele mora em
// /grafo/<projeto>/. A ponte reescreve SÓ os caminhos de dado conhecidos para relativos e fixa o sha do
// grafo que esta aba desenhou nos pedidos de código-fonte. Lista conferida contra o bundle pelo gate.
(function () {
  const DADOS = new Set(['/knowledge-graph.json', '/meta.json', '/config.json', '/staleness.json',
    '/domain-graph.json', '/diff-overlay.json', '/file-content.json']);
  const original = window.fetch.bind(window);
  // O sha é lido NA HORA de cada pedido de código, depois da espera: se o grafo chegar tarde (depois do
  // teto), os pedidos seguintes já saem com ele. O teto só destrava a espera — nunca congela o sha em null.
  let sha = null;
  let liberar;
  const espera = new Promise((r) => { liberar = r; });
  setTimeout(() => liberar(), globalThis.__PONTE_TETO_MS || 10000);
  function alvo(url) {
    if (typeof url !== 'string' || url[0] !== '/' || url[1] === '/') return null;
    const corte = url.search(/[?#]/);
    const caminho = corte < 0 ? url : url.slice(0, corte);
    return DADOS.has(caminho) ? { caminho, relativo: `.${url}` } : null;
  }
  window.fetch = function (entrada, opcoes) {
    const a = alvo(entrada);
    if (!a) return original(entrada, opcoes);
    if (a.caminho === '/file-content.json') {
      return espera.then(() => original(
        sha ? `${a.relativo}${a.relativo.includes('?') ? '&' : '?'}sha=${encodeURIComponent(sha)}` : a.relativo, opcoes));
    }
    const resposta = original(a.relativo, opcoes);
    if (a.caminho === '/knowledge-graph.json') {
      resposta.then((r) => r.clone().json())
        .then((g) => { sha = (g && g.project && g.project.gitCommitHash) || null; liberar(); }, () => liberar());
    }
    return resposta;
  };
})();
