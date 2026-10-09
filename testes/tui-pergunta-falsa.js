'use strict';
// A TUI FALSA da pergunta do agente (AskUserQuestion) — o arreio do `gate-pergunta.js`.
//
// Reproduz o comportamento MEDIDO do Claude Code 2.1.294 (spec §3.1, telas em
// testes/fixtures/pergunta/telas): dígito, Down, Enter, texto só na linha "Type something",
// Next/Submit, revisão e "Submit answers". Desenha no formato das telas medidas. Não é um modelo da
// TUI inteira: é o suficiente para o `executar` do lib/pergunta.js rodar contra ela sem tmux, e a
// prova de que o desenho bate com a TUI real é o gate comparar a saída com as telas medidas.
//
// Tecla fora do esperado (texto com o cursor fora do campo, Left/Right/Tab) é DESCARTADA, como a
// TUI real faz — é isso que o `executar` precisa enxergar como "o efeito não veio".
//
//   const tui = criarTui(perguntas, { cabecalhoDeTela, barraNaPergunta });
//   tui.tela()            a pane inteira (string)
//   tui.tecla('Down')     '1'..'9', 'Down', 'Up', 'Enter', 'Escape'
//   tui.texto('abc')      send-keys -l
//   tui.estado            { respondida, recusada, revisao, q, cursor, respostas }
//
// `perguntas` no formato do cartão: [{ texto, cabecalho, multipla, opcoes: [{ rotulo, descricao }] }].
// `barraNaPergunta` desenha o prefixo `│ ` nas linhas da pergunta (e na revisão, na 1ª pergunta),
// como nas telas e1/e7 e m1-01/m1-11 (só na pergunta 0) — a regra de QUANDO a TUI real o desenha
// não é conhecida, por isso é opção do arreio.

const LARGURA = 129;
const SEPARADOR = '─'.repeat(LARGURA);

/** Quebra por palavras (guloso), cada linha com no máximo LARGURA colunas contando o prefixo. */
function quebrar(texto, prefixoPrimeira, prefixoResto) {
  const linhas = [];
  let atual = prefixoPrimeira;
  let vazia = true;
  for (const palavra of texto.split(' ')) {
    if (!vazia && (atual + ' ' + palavra).length > LARGURA) {
      linhas.push(atual);
      atual = prefixoResto + palavra;
    } else {
      atual = vazia ? atual + palavra : `${atual} ${palavra}`;
    }
    vazia = false;
  }
  linhas.push(atual);
  return linhas;
}

function criarTui(perguntas, { cabecalhoDeTela, barraNaPergunta = false } = {}) {
  const n = perguntas.length;
  const cabecalho = cabecalhoDeTela || ['❯ Use a ferramenta AskUserQuestion AGORA, sem fazer mais nada antes.'];
  const por = perguntas.map(() => ({ marcas: new Set(), texto: '', selecionada: null, feito: false }));
  const estado = { respondida: false, recusada: false, revisao: false, q: 0, cursor: 1, respostas: null };

  const aberta = () => !estado.respondida && !estado.recusada;
  const m = () => perguntas[estado.q].opcoes.length;
  const multi = () => perguntas[estado.q].multipla;
  // Última posição do cursor: simples = "Chat about this" (m+2); multi = Next/Submit (m+2) e Chat (m+3).
  const maxPos = () => (estado.revisao ? 2 : (multi() ? m() + 3 : m() + 2));

  const respondidaAba = (i) => (perguntas[i].multipla ? (por[i].marcas.size > 0 || por[i].texto !== '') : por[i].feito);

  function finalizar() {
    estado.respostas = perguntas.map((p, i) => (p.multipla
      ? { opcoes: [...por[i].marcas].sort((a, b) => a - b), texto: por[i].texto }
      : (por[i].selecionada !== null ? { opcoes: [por[i].selecionada], texto: '' } : { opcoes: [], texto: por[i].texto })));
    estado.respondida = true;
  }

  function avancar() {
    por[estado.q].feito = true;
    if (n === 1 && !perguntas[0].multipla) { finalizar(); return; }
    if (estado.q < n - 1) { estado.q += 1; estado.cursor = 1; return; }
    estado.revisao = true;
    estado.cursor = 1;
  }

  function selecionar(k) {
    const s = por[estado.q];
    if (multi()) {
      if (s.marcas.has(k)) s.marcas.delete(k); else s.marcas.add(k);
      return;
    }
    s.selecionada = k;
    s.texto = '';
    avancar();
  }

  function tecla(nome) {
    if (!aberta()) return;
    if (nome === 'Escape') { estado.recusada = true; return; }
    if (nome === 'Down') { estado.cursor = Math.min(estado.cursor + 1, maxPos()); return; }
    if (nome === 'Up') { estado.cursor = Math.max(estado.cursor - 1, 1); return; }
    if (estado.revisao) {
      if (nome === 'Enter') { if (estado.cursor === 1) finalizar(); else estado.recusada = true; }
      return;
    }
    const s = por[estado.q];
    if (/^[1-9]$/.test(nome)) {
      // Dígito dentro do campo de texto vira texto (medido, tela m1-09).
      if (estado.cursor === m() + 1) { s.texto += nome; return; }
      const k = Number(nome) - 1;
      if (k < m()) selecionar(k);
      return;
    }
    if (nome === 'Enter') {
      if (!multi()) {
        if (estado.cursor <= m()) selecionar(estado.cursor - 1);
        else if (estado.cursor === m() + 1 && s.texto !== '') { s.selecionada = null; avancar(); }
        return;
      }
      if (estado.cursor === m() + 2 && (s.marcas.size > 0 || s.texto !== '')) avancar();
    }
  }

  function texto(t) {
    if (!aberta() || estado.revisao) return;
    // Texto com o cursor FORA da linha "Type something" some calado (medido).
    if (estado.cursor === m() + 1) por[estado.q].texto += t;
  }

  function barra() {
    if (n === 1 && !perguntas[0].multipla) return ` ☐ ${perguntas[0].cabecalho}`;
    const abas = perguntas.map((p, i) => `${estado.revisao || respondidaAba(i) ? '☒' : '☐'} ${p.cabecalho}`);
    return `←  ${abas.join('  ')}  ✔ Submit  →`;
  }

  function desenharRevisao() {
    const L = [SEPARADOR, barra(), '', 'Review your answers', ''];
    perguntas.forEach((p, i) => {
      const comBarra = barraNaPergunta && i === 0;
      L.push(...quebrar(p.texto, comBarra ? ' │ ● ' : ' ● ', comBarra ? ' │   ' : '   '));
      const s = por[i];
      const partes = p.multipla
        ? [...[...s.marcas].sort((a, b) => a - b).map((k) => p.opcoes[k].rotulo), ...(s.texto ? [s.texto] : [])]
        : [s.selecionada !== null ? p.opcoes[s.selecionada].rotulo : s.texto];
      L.push(`   → ${partes.join(', ')}`);
    });
    L.push('', 'Ready to submit your answers?', '');
    L.push(`${estado.cursor === 1 ? '❯' : ' '} 1. Submit answers`, `${estado.cursor === 2 ? '❯' : ' '} 2. Cancel`);
    return L;
  }

  function desenharPergunta() {
    const p = perguntas[estado.q];
    const s = por[estado.q];
    const mm = p.opcoes.length;
    const cur = (pos) => (estado.cursor === pos ? '❯' : ' ');
    const L = [SEPARADOR, barra(), ''];
    // Nas telas medidas (e1..e7) só a PRIMEIRA pergunta, a longa, ganha o `│`.
    const comBarra = barraNaPergunta && estado.q === 0;
    L.push(...quebrar(p.texto, comBarra ? '│ ' : '', comBarra ? '│ ' : ''));
    L.push('');
    p.opcoes.forEach((o, k) => {
      const marca = p.multipla ? `[${s.marcas.has(k) ? '✔' : ' '}] ` : '';
      L.push(`${cur(k + 1)} ${k + 1}. ${marca}${o.rotulo}`);
      if (o.descricao) L.push(...quebrar(o.descricao, ' '.repeat(p.multipla ? 9 : 5), ' '.repeat(p.multipla ? 9 : 5)));
    });
    if (p.multipla) {
      L.push(`${cur(mm + 1)} ${mm + 1}. [${s.texto ? '✔' : ' '}] ${s.texto || 'Type something'}`);
      const ultima = estado.q === n - 1;
      L.push(`${estado.cursor === mm + 2 ? '❯' : ' '}    ${ultima ? 'Submit' : 'Next'}`);
    } else {
      L.push(`${cur(mm + 1)} ${mm + 1}. ${s.texto || 'Type something.'}`);
    }
    L.push(SEPARADOR);
    L.push(`${estado.cursor === maxPos() ? '❯' : ' '} ${mm + 2}. Chat about this`);
    const naMao = estado.cursor === mm + 1 || (p.multipla && estado.cursor === mm + 2);
    L.push('', `Enter to select · ${n === 1 ? '↑/↓' : 'Tab/Arrow keys'} to navigate${naMao ? ' · ctrl+g to edit in Vim' : ''} · Esc to cancel`);
    return L;
  }

  function tela() {
    const L = [...cabecalho];
    if (estado.recusada) return [...L, '  ⎿  User rejected tool use', '', SEPARADOR, '❯ ', SEPARADOR].join('\n');
    if (estado.respondida) return [...L, '● User answered Claude\'s questions:', '', SEPARADOR, '❯ ', SEPARADOR].join('\n');
    return [...L, ...(estado.revisao ? desenharRevisao() : desenharPergunta())].join('\n');
  }

  return { tela, tecla, texto, estado };
}

module.exports = { criarTui };
