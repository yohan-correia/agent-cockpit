'use strict';
// A régua que reconhece um MENU aberto na TUI do Codex — card `menu-da-tui-do-codex-na-tela`.
//
// Spec: docs/superpowers/specs/2026-09-10-menu-da-tui-do-codex-na-tela-design.md
// Plano: docs/superpowers/plans/2026-09-10-menu-da-tui-do-codex-na-tela-plano.md
// Gate:  testes/gate-menu-codex.js (as 42 fixtures em testes/fixtures/menu-codex/)
//
// Sem I/O e sem `require('./abas')` — mesmo desenho de `lib/status-codex.js`, que também
// nasceu separado para não fechar um import circular (aquele módulo importaria este de
// volta assim que `lib/abas.js` chamasse os dois).
//
// ─── O QUE FOI MEDIDO (e o que não foi) ─────────────────────────────────────────────────
//
// Codex CLI 0.153.4, TUI real, socket tmux próprio, provider HTTP local, zero token da
// assinatura, nenhuma pane do usuário tocada. 8 rodadas de medição, 42 fixtures no repo.
//
//   • CINCO formatos de rodapé de menu (`/model`/`/skills`/`/review` dizem uma frase,
//     `/keymap` outra, `/statusline` outra, `/plugins` outra, o transcript Esc-Esc outra) —
//     não existe um rodapé FIXO, e o card que pedia casar uma frase específica estava errado.
//   • TRUNCAMENTO em 40 colunas: o rodapé do menu não quebra linha, ele CORTA — nem
//     igualdade nem `endsWith` sobrevivem (fixtures `menu-keymap-40col`, `menu-plugins-40col`
//     e as variantes de 50col).
//   • O `pane_title` do tmux NÃO serve — é `'cwd'` nos 11 estados testados, inclusive com
//     menu aberto (M1 da spec).
//   • O STATUSLINE é configurável campo a campo (`/statusline`): desmarcando
//     `model-with-reasoning` o rodapé ocioso vira `  /tmp/x/cwd` puro, sem `·` nenhum
//     (fixture `livre-rodape-personalizado`). Não existe forma estável de "rodapé de
//     trabalho" para reconhecer — é por isso que a v6 abaixo não tenta.
//   • TRÊS falsos positivos que uma busca por frase pegaria, todos com fixture própria: a
//     frase do card citada DENTRO de uma mensagem (`livre-frase-do-rodape-citada`), o
//     rodapé ocioso aparecendo como PREVIEW dentro do `/statusline`
//     (`menu-statusline`), e a dica `esc again to edit previous message` depois de um Esc
//     (`livre-rodape-esc-again`) — menciona tecla e não é menu.
//   • O modal de APROVAÇÃO (provavelmente o estado bloqueante mais comum na vida real) NÃO
//     foi reproduzido: quatro tentativas com `approval_policy`/`sandbox_mode` diferentes e o
//     Codex sempre executou sem perguntar (M5 da spec). Esta régua não depende de conhecer
//     esse modal — `desconhecido` é a rede para qualquer coisa não medida.
//
// ─── AS CINCO RÉGUAS QUE MORRERAM ANTES DESTA (cada uma tem fixture que a matou) ────────
//
//   v1  "livre quando há no máximo 1 linha não-vazia depois do último `›`" — um RASCUNHO
//       MULTILINHA (`livre-rascunho-multilinha`, 3 linhas de texto do usuário) virava
//       'menu', e o dono não conseguiria mandar uma mensagem de 3 linhas do celular.
//   v2  "rodapé com exatamente um ` · `" — `menu-keymap-40col` trunca para
//       `left/right group · enter edit shortcut`, um separador só, DENTRO de um menu de
//       verdade: o menu ficava fora da régua.
//   v3  "lado direito do `·` parece um caminho" — `livre-rodape-personalizado` (statusline
//       sem `model-with-reasoning`) não tem `·` nenhum, e um rascunho multilinha nesse
//       statusline voltava a virar 'menu'.
//   v4  mesma ideia de v3, outra heurística de caminho — morta pela mesma fixture.
//   v5  "só a forma do item, sem olhar o rodapé" — `livre-rascunho-lista-na-primeira-linha`
//       (o usuário digitando "1. comprar pão" como rascunho) virava 'menu'.
//
// Se um dia alguém achar a v6 "complicada demais" e tentar tirar um dos dois sinais do
// passo 3, é uma destas cinco que vai voltar. Por isso o gate nomeia as fixtures que
// derrubaram cada régua morta, não só as testa de passagem.
//
// ─── A LACUNA ASSUMIDA ───────────────────────────────────────────────────────────────────
//
// `naopega-transcript-esc-esc.txt` — a tela de transcript (depois de Esc-Esc) é bloqueante
// (não aceita texto normal) e esta régua sai 'livre' para ela. É falso NEGATIVO, de
// propósito: o único `›` que sobra ali é de uma fala antiga do histórico, sem forma de
// item de menu, então o sinal (a) do passo 3 falha e a régua não tem como saber. A
// alternativa — soltar o sinal (a) para pegar esse caso — reintroduz a trava que a v5
// morreu por causar (rascunho em forma de lista virando 'menu'). Entre não prevenir esta
// tela específica e travar o envio de mensagens normais, o projeto escolhe não prevenir —
// é a D13 (trava que pode travar o dono sem ele querer custa mais do que o dano que
// previne). A fixture leva o prefixo `naopega-` e o gate afirma o 'livre' explicitamente,
// para a lacuna ficar visível e travada nos dois sentidos.

const { sanitizarTela } = require('./status-codex');

// A última linha do composer (ou de um item de menu) começa com `›` seguido de espaço OU
// de fim de linha. Mesmo marcador que `lib/status-codex.js` usa para achar o composer do
// `/status` — não duplicado aqui, só reconhecido pelo mesmo formato.
const ULTIMA_MARCA_COMPOSER = /^›(?: |$)/;

// Sinal (a): a linha tem FORMA de item de menu selecionado.
//   `› 1. `        — item numerado (`/model`, `/skills`, `/review`, o prompt de confiança)
//   `› [x] `       — checkbox marcado/desmarcado/parcial (`/plugins`)
//   `› Rótulo  `   — rótulo em maiúscula seguido de 2+ espaços (`/keymap`: "Global         Open…")
// Medido: a INDENTAÇÃO não distingue — menu e composer usam exatamente UM espaço depois do
// `›` (`› 1. gpt-6-astra (default)` e `› 1. comprar pão` são idênticos por espaçamento).
// Trocar `\s+` por `\s{2,}` foi a primeira ideia e está errada — por isso o teste explícito
// de `\s{2,}` só existe no TERCEIRO ramo (rótulo + colunas), nunca no primeiro.
const ITEM_DE_MENU = /^›\s+(?:\d+\.\s|\[[ x-]\]\s|[A-Z][\w/]*\s{2,})/;

// Sinal (b): a ÚLTIMA linha da tela menciona uma tecla, DELIMITADA POR ESPAÇO.
// `(?:^|\s)…(?:$|[\s;,.])`, nunca `[^\w]`: com `[^\w]` a barra de um caminho delimitaria, e
// um projeto em `~/projetos/space` ou `~/projetos/tab-x` faria o rodapé de TRABALHO parecer
// dica de tecla — um rascunho em forma de lista nesse cwd viraria 'menu' por acidente,
// dependendo do NOME DA PASTA. Conferido nas variantes com a regex por espaço: todas saem
// 'livre'. As setas (`↑↓←→`) não precisam de delimitador — não fazem parte de palavra.
const DICA_DE_TECLA = /(?:^|\s)(?:enter|esc|space|tab|ctrl|shift|pgup|pgdn)(?:$|[\s;,.])|[↑↓←→]/i;

/**
 * Classifica a tela CAPTURADA de uma pane de Codex: `'menu' | 'livre' | 'desconhecido'`.
 *
 * A régua v6 — a sexta tentativa (ver o histórico das cinco anteriores no topo do arquivo):
 *
 *   1. Sanitizar (tira ANSI/CR/controle — `.ansi.txt` e `.txt` classificam igual, é o que
 *      prova que a limpeza roda ANTES da régua), quebrar em linhas, aparar cada linha à
 *      DIREITA, descartar as linhas vazias do FIM. Nada sobrou ⇒ `'desconhecido'` — captura
 *      vazia/só-espaço/só-quebra não pode virar autorização de escrita por engano (R2).
 *   2. Achar, de BAIXO para cima, a última linha que casa `ULTIMA_MARCA_COMPOSER`. Não achou
 *      nenhuma ⇒ `'desconhecido'` — ausência de sinal nunca vira afirmação de 'livre'.
 *   3. `'menu'` só quando OS DOIS sinais valem ao mesmo tempo: (a) aquela última linha `›`
 *      tem forma de item de menu, E (b) a última linha da TELA inteira menciona uma tecla.
 *      Qualquer outra combinação ⇒ `'livre'`.
 *
 * Por que os dois juntos, e por que soltar QUALQUER um deles trava o dono (medido na TUI):
 *   • só o sinal (a) — `› 1. comprar pão`, `› [x] feito` e `› Olá␣␣mundo` (rascunho comum,
 *     por coincidência com a FORMA de um item) viram 'menu'. No pré-Enter isso é PIOR que
 *     recusar o envio: o texto já foi COLADO e a mensagem fica presa numa TUI que o dono
 *     não vê do celular.
 *   • só o sinal (b) — `esc again to edit previous message` (a dica que aparece depois de um
 *     Esc, sem menu nenhum aberto) vira 'menu'.
 *   As quatro fixtures `livre-rascunho-{lista-na-primeira-linha,checkbox,duas-colunas,
 *   lista-tres}` existem para travar essa regressão especificamente.
 *
 * O que ela NÃO tenta: reconhecer a FORMA do rodapé de trabalho (matou as réguas v2/v3/v4 —
 * ver o histórico acima). O statusline é configurável campo a campo; o que sobrevive à
 * configuração é a PRESENÇA de palavras de tecla no rodapé de menu, não o formato dele.
 *
 * @param {string} bruto — a saída de `capture-pane`, com ou sem ANSI.
 * @returns {'menu'|'livre'|'desconhecido'}
 */
function classificarTela(bruto) {
  const linhas = sanitizarTela(bruto).split('\n').map((l) => l.replace(/\s+$/, ''));
  while (linhas.length && linhas[linhas.length - 1] === '') linhas.pop();
  if (!linhas.length) return 'desconhecido';

  let i = linhas.length - 1;
  while (i >= 0 && !ULTIMA_MARCA_COMPOSER.test(linhas[i])) i -= 1;
  if (i < 0) return 'desconhecido';

  const temItemDeMenu = ITEM_DE_MENU.test(linhas[i]);
  const temDicaDeTecla = DICA_DE_TECLA.test(linhas[linhas.length - 1]);
  return (temItemDeMenu && temDicaDeTecla) ? 'menu' : 'livre';
}

module.exports = { classificarTela };
