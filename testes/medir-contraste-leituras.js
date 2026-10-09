#!/usr/bin/env node
'use strict';
// MEDIÇÃO — contraste WCAG dos pares texto/fundo da vista de leituras (card `leituras-v2`,
// 2026-10-04, spec docs/superpowers/specs/2026-10-04-leituras-v2-design.md §6).
//
// Lê os tokens DIRETO de public/estilo.css — o :root escuro, o :root do prefers-color-scheme
// claro e os blocos `[data-tema="…"]` — e calcula a razão de contraste de cada par usado na
// vista, HOJE (develop de 04/10) e PROPOSTO. Fundo translúcido (`--accent-suave`) é composto
// sobre o fundo da lateral (`--fundo-2`) antes de medir: é a cor que o olho vê.
//
// Não é gate do `npm test`: imprime a tabela que a spec cita. Com `--falhar`, sai 1 se algum
// par PROPOSTO de texto ficar abaixo de 4.5:1 no tema padrão (escuro ou claro) — os dois temas
// que a spec promete em AA.
//
// Uso: node testes/medir-contraste-leituras.js [--falhar] [--todos]

const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'estilo.css'), 'utf8');

/** As declarações `--x: valor;` de um trecho de CSS (comentários fora). */
function variaveis(trecho) {
  const limpo = trecho.replace(/\/\*[\s\S]*?\*\//g, '');
  const mapa = {};
  for (const m of limpo.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) mapa[m[1]] = m[2].trim();
  return mapa;
}

/** O corpo do bloco cujo seletor começa em `inicio` (índice do `{`), até a chave que fecha. */
function corpoDoBloco(inicio) {
  let nivel = 0;
  for (let i = inicio; i < css.length; i += 1) {
    if (css[i] === '{') nivel += 1;
    else if (css[i] === '}') { nivel -= 1; if (nivel === 0) return css.slice(inicio + 1, i); }
  }
  throw new Error('bloco sem fim');
}

const raiz = variaveis(corpoDoBloco(css.indexOf('{', css.indexOf('\n:root {'))));
const mediaClaro = css.indexOf('@media (prefers-color-scheme: light)');
const claro = { ...raiz, ...variaveis(corpoDoBloco(css.indexOf('{', css.indexOf(':root {', mediaClaro)))) };

const temas = [['padrão escuro', raiz], ['padrão claro', claro]];
for (const m of css.matchAll(/^\[data-tema="([^"]+)"\] \{/gm)) {
  temas.push([m[1], { ...raiz, ...variaveis(corpoDoBloco(m.index + m[0].length - 1)) }]);
}

function rgba(valor) {
  const v = valor.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1);
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) {
    const p = m[1].split(',').map((x) => Number(x.trim()));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  throw new Error(`cor que não sei ler: ${valor}`);
}

/** `cima` (com alfa) composta sobre `baixo` (opaca). */
const compor = (cima, baixo) => [0, 1, 2].map((i) => cima[i] * cima[3] + baixo[i] * (1 - cima[3])).concat(1);

function luminancia([r, g, b]) {
  const canal = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}
function razao(a, b) {
  const [l1, l2] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// Os fundos possíveis de uma linha de livro. A lateral é `--fundo-2` (estilo.css `.lateral`).
const FUNDOS = {
  lateral: (v) => rgba(v['--fundo-2']),
  // O campo de busca tem fundo próprio (spec §6.7) — medir o texto dele contra a lateral mentiria.
  busca: (v) => rgba(v['--fundo']),
  'fundo-3': (v) => rgba(v['--fundo-3']),
  'accent-suave': (v) => compor(rgba(v['--accent-suave']), rgba(v['--fundo-2'])),
};

// [rótulo, token do texto, fundo] — `hoje` é a develop de 04/10 (estilo.css:641-658),
// `proposto` é o desenho da spec §6.
const PARES = {
  hoje: [
    ['título do livro', '--texto', 'lateral'],
    ['autor', '--texto-3', 'lateral'],
    ['autor no próximo', '--texto-3', 'fundo-3'],
    ['nº do livro', '--texto-3', 'lateral'],
    ['contador k/N', '--texto-3', 'lateral'],
    ['cabeçalho da trilha', '--texto-2', 'lateral'],
    ['título terminado', '--texto-3', 'lateral'],
    ['data dd/mm', '--texto-3', 'lateral'],
  ],
  proposto: [
    ['título do livro', '--texto', 'lateral'],
    ['título no próximo', '--texto', 'accent-suave'],
    ['autor', '--texto-2', 'lateral'],
    ['autor no próximo', '--texto-2', 'accent-suave'],
    ['nº do livro', '--texto-2', 'lateral'],
    ['contador k/N', '--texto-2', 'lateral'],
    ['cabeçalho da trilha', '--texto', 'lateral'],
    ['título terminado', '--texto-2', 'lateral'],
    ['data dd/mm', '--texto-2', 'lateral'],
    // A cor das etiquetas mora na BORDA/fundo, não no texto: `--accent` e `--ok` como TEXTO
    // reprovam no tema claro (3.84 e 2.23 sobre --fundo-2, medido por este script em 04/10).
    ['etiqueta grátis/próximo (texto; cor na borda)', '--texto', 'lateral'],
    ['botão "● lendo" ativo (texto sobre accent-suave)', '--texto', 'accent-suave'],
    ['etiqueta opcional/na estante', '--texto-2', 'lateral'],
    ['chip ativo (texto sobre accent-suave)', '--texto', 'accent-suave'],
    ['chip inativo', '--texto-2', 'lateral'],
    ['texto digitado na busca', '--texto', 'busca'],
    ['placeholder da busca', '--texto-2', 'busca'],
    ['trilha escolhida no seletor', '--texto', 'busca'],
    ['seta ▸/▾ do cabeçalho da trilha', '--texto-2', 'lateral'],
  ],
};

const args = new Set(process.argv.slice(2));
const lista = args.has('--todos') ? temas : temas.slice(0, 2);
let reprovados = 0;

for (const [fase, pares] of Object.entries(PARES)) {
  console.log(`\n## ${fase.toUpperCase()}\n`);
  console.log(`| par | ${lista.map(([n]) => n).join(' | ')} |`);
  console.log(`|---|${lista.map(() => '---:').join('|')}|`);
  for (const [rotulo, token, fundo] of pares) {
    const celulas = lista.map(([nome, v]) => {
      const r = razao(rgba(v[token]), FUNDOS[fundo](v));
      const passa = r >= 4.5;
      if (fase === 'proposto' && !passa && (nome === 'padrão escuro' || nome === 'padrão claro')) reprovados += 1;
      return `${r.toFixed(2)}${passa ? '' : ' ✗'}`;
    });
    console.log(`| ${rotulo} (${token} / ${fundo}) | ${celulas.join(' | ')} |`);
  }
}

console.log(`\n✗ = abaixo de 4.5:1 (AA texto normal). Pares PROPOSTOS reprovados no tema padrão: ${reprovados}`);
if (args.has('--falhar') && reprovados > 0) process.exit(1);
