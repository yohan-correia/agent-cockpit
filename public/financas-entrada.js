'use strict';
// Entrada da Página de Finanças (card `pagina-financas`, D92) — o `#btn-financas` da lateral do
// Cockpit. Toda a lógica de abrir o modal (D90) saiu daqui: o clique agora navega pra
// `financas.html` NA MESMA ABA (P10) — aba nova dependeria de o `localStorage` do PWA ser visto
// pela aba nova no celular, e isso nunca foi provado (painel do plano, Claude #1). `atualizarEntrada()`
// e o `visibilitychange` são os MESMOS de `public/financas.js:377-388` antes desta fase — só
// decidem se o botão aparece, nunca baixam o resumo inteiro. Sem `tr()`: não tem texto nenhum
// aqui (o botão não tem rótulo visível, só `aria-label` fixo no HTML).
(function () {

const $ = (id) => document.getElementById(id);

// Token lido A CADA CHAMADA (mesmo motivo de financas.js/grafo.js/revisar.js).
const tokenAgora = () => { try { return localStorage.getItem('cockpit-token') || ''; } catch { return ''; } };

/** Só GET, com o mesmo `Authorization` do resto do app — erro aqui só esconde o botão. */
async function api(rota) {
  const cabecalhos = {};
  const token = tokenAgora();
  if (token) cabecalhos.authorization = `Bearer ${token}`;
  const resposta = await fetch(rota, { headers: cabecalhos });
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  return resposta.json();
}

if (typeof document !== 'undefined' && document.getElementById('btn-financas')) {

const btn = $('btn-financas');

async function atualizarEntrada() {
  try {
    const dados = await api('api/financas/estado');
    btn.hidden = !dados.ligado;
  } catch {
    btn.hidden = true;
  }
}
atualizarEntrada();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') atualizarEntrada();
});

btn.onclick = () => { location.assign('financas.html'); };

} // fim do guard `typeof document !== 'undefined'`

})();
