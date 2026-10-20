'use strict';
// A régua que reconhece o DIÁLOGO que o Claude Code abre SOZINHO acima do composer — card
// `mensagem-some-no-menu-do-auto-mode`, D85a. Spec:
// docs/superpowers/specs/2026-10-16-mensagem-some-no-menu-do-auto-mode-design.md
// Gate: testes/gate-menu-claude-dialogo.js (fixtures em testes/fixtures/menu-auto-mode/).
//
// Responde UMA pergunta de ESTADO — "há um diálogo na caixa acima do composer?" —, nunca o que
// está escrito nele (D4: a tela do Claude não vira conversa; D-D de 18/09: não se destaca opção).
// Só é chamada por `estadoDoMenu()` com o status do CLI PARADO: com `busy`/`waiting` o arquivo
// `sessions/<pid>.json` já responde e a tela nem é capturada.
//
// Os três sinais, TODOS medidos (2.1.280 e 2.1.295, 120 e 60 colunas):
//   1. a caixa do composer — a última linha com `❯` na COLUNA 0 tem uma borda `─` logo acima;
//   2. o rodapé do diálogo — a 1ª linha não-vazia acima dessa borda tem `Esc to cancel` ou
//      `Enter to confirm`;
//   3. a caixa do diálogo — subindo dali, um item marcado RECUADO (`  ❯ 1. Yes`) e uma borda
//      `─` na coluna 0 fechando o bloco por cima.
// Conversa citada não engana: tudo que a TUI desenha da conversa vem recuado (`● `, dois
// espaços, `⎿`); borda `─` na coluna 0 só existe no cromo da TUI (fixture sintética).
//
// `desconhecido` é SÓ "não achei o composer" (assistente em tela cheia, captura vazia, layout
// novo do CLI). Composer achado sem os sinais 2 e 3 é `livre`.

// A linha INTEIRA de `─` (depois de tirar o espaço do fim) — nunca "começa com `─`".
const BORDA = /^─{8,}$/;
const COMPOSER = /^❯/;
const ITEM_MARCADO = /^\s+❯\s+\d+\.\s/;
const RODAPE = /Esc to cancel|Enter to confirm/;

/** `'menu' | 'livre' | 'desconhecido'` para a captura (`capture-pane -p`) de uma pane de Claude. */
function classificarTela(tela) {
  const linhas = String(tela || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  let composer = -1;
  for (let i = linhas.length - 1; i > 0; i -= 1) {
    if (COMPOSER.test(linhas[i]) && BORDA.test(linhas[i - 1])) { composer = i; break; }
  }
  if (composer < 0) return 'desconhecido';
  let i = composer - 2;                      // a linha logo acima da borda de cima do composer
  while (i >= 0 && !linhas[i].trim()) i -= 1;
  if (i < 0 || !RODAPE.test(linhas[i])) return 'livre';
  let temItem = false;
  for (let j = i - 1; j >= 0; j -= 1) {
    if (BORDA.test(linhas[j])) return temItem ? 'menu' : 'livre';
    if (ITEM_MARCADO.test(linhas[j])) temItem = true;
  }
  return 'livre';                            // bloco sem borda por cima: não é caixa de diálogo
}

module.exports = { classificarTela };
