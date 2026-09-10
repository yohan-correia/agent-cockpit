'use strict';
// Cor: contraste WCAG e leitura das paletas do CSS, sem dependência nenhuma.
//
// Nasceu para o "te esperando" (22/08), que usava a MESMA variável do "trabalhando" e
// deixava os dois estados indistinguíveis no celular. O que o gate precisa saber para
// isso não vale só para ele: "essa cor lê sobre esse fundo?" e "essas duas cores são
// diferentes o bastante de relance?" são perguntas que voltam toda vez que a paleta cresce.
//
// De propósito NÃO tem varredura do arquivo inteiro aqui: quem decide o que auditar é o
// gate. Este módulo só responde perguntas.

/** '#rgb' ou '#rrggbb' → [r, g, b] em 0..255. Devolve null para o que não for hex. */
function paraRgb(cor) {
  const bruto = String(cor || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(bruto)) return null;
  const cheio = bruto.length === 3 ? bruto.split('').map((c) => c + c).join('') : bruto;
  return [0, 2, 4].map((i) => parseInt(cheio.slice(i, i + 2), 16));
}

/** Luminância relativa da WCAG 2.x. É ela que manda no contraste, não o "quão claro parece". */
function luminancia(cor) {
  const rgb = paraRgb(cor);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Razão de contraste entre duas cores, de 1 (iguais) a 21 (preto × branco). */
function contraste(a, b) {
  const la = luminancia(a);
  const lb = luminancia(b);
  if (la === null || lb === null) return null;
  const [alto, baixo] = la > lb ? [la, lb] : [lb, la];
  return (alto + 0.05) / (baixo + 0.05);
}

/** Matiz em graus (0–360). Cinza puro não tem matiz: devolve 0 com saturação 0. */
function matiz(cor) {
  const rgb = paraRgb(cor);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => v / 255);
  const maior = Math.max(r, g, b);
  const menor = Math.min(r, g, b);
  const d = maior - menor;
  if (d === 0) return 0;
  let h;
  if (maior === r) h = 60 * (((g - b) / d) % 6);
  else if (maior === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  return h < 0 ? h + 360 : h;
}

/** Diferença de matiz pelo caminho curto do círculo: 350° e 10° distam 20, não 340. */
function distanciaDeMatiz(a, b) {
  const ha = matiz(a);
  const hb = matiz(b);
  if (ha === null || hb === null) return null;
  const bruta = Math.abs(ha - hb);
  return Math.min(bruta, 360 - bruta);
}

// Dois tons do mesmo âmbar são "strings diferentes" e não resolvem nada: #e0a233 × #e0a234
// passaria num teste de igualdade e continuaria indistinguível. O critério é perceptivo —
// ou o matiz anda o bastante, ou uma é claramente mais escura que a outra.
const MATIZ_MINIMA = 20;      // graus
const CONTRASTE_MINIMO = 1.5; // razão entre as duas cores, não com o fundo

/** As duas cores dão para separar de relance? Devolve os números junto, para a mensagem. */
function distinguiveis(a, b) {
  const dh = distanciaDeMatiz(a, b);
  const dc = contraste(a, b);
  if (dh === null || dc === null) return { ok: false, matiz: dh, contraste: dc };
  return { ok: dh >= MATIZ_MINIMA || dc >= CONTRASTE_MINIMO, matiz: dh, contraste: dc };
}

/**
 * Quebra o CSS em blocos, guardando o contexto de quem está dentro de `@media`.
 *
 * Mini-parser com pilha em vez de regex porque o `:root` do `prefers-color-scheme` mora
 * DENTRO de outro bloco: um regex de bloco-folha acharia os dois `:root` e não saberia
 * dizer qual é qual — e é justamente o par escuro/claro que não pode ser confundido.
 */
function blocos(css) {
  const limpo = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  const achados = [];
  const pilha = [];
  let buffer = '';
  for (const c of limpo) {
    if (c === '{') { pilha.push(buffer.trim()); buffer = ''; }
    else if (c === '}') {
      const seletor = pilha.pop() || '';
      if (seletor && !seletor.startsWith('@')) {
        achados.push({ seletor, dentroDe: pilha.filter(Boolean).join(' '), corpo: buffer });
      }
      buffer = '';
    } else buffer += c;
  }
  return achados;
}

/** As `--variaveis` declaradas num corpo de bloco, como mapa nome → valor. */
function variaveis(corpo) {
  const mapa = {};
  for (const m of String(corpo).matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    mapa[m[1]] = m[2].trim();
  }
  return mapa;
}

/**
 * Os blocos que definem paleta: o `:root` de cima, o `:root` do prefers-color-scheme e
 * cada `[data-tema="..."]`. O rótulo é o que aparece na mensagem do gate.
 */
function paletas(css) {
  return blocos(css)
    .filter((b) => b.seletor === ':root' || /^\[data-tema="[\w-]+"\]$/.test(b.seletor))
    .map((b) => ({
      rotulo: b.seletor === ':root' ? (b.dentroDe ? ':root (claro do sistema)' : ':root') : b.seletor,
      variaveis: variaveis(b.corpo),
    }));
}

module.exports = {
  paraRgb, luminancia, contraste, matiz, distanciaDeMatiz, distinguiveis,
  blocos, variaveis, paletas, MATIZ_MINIMA, CONTRASTE_MINIMO,
};
