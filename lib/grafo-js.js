'use strict';
/**
 * Extrator JS/TS zero-dependência — um lexer próprio (comentário, string, template literal com
 * `${}` aninhado, regex literal, JSX em .jsx/.tsx) e, sobre os tokens, as declarações de topo,
 * imports/require/import() dinâmico, exports e chamadas. Ver spec "Fase 1" e plano §1.2.
 *
 * `extrairJs(caminho, texto)` → `{ declaracoes, imports, chamadas, exportados, padrao }`.
 */

const PALAVRAS_REGEX_ANTERIOR = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

const PALAVRAS_CHAMADA_EXCLUIDA = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'super', 'import', 'require',
]);

function ehJsxPorExtensao(caminho) {
  return /\.(jsx|tsx)$/.test(caminho);
}

/**
 * tokens(texto, jsxHabilitado) → array de { t, v, linha }.
 * t ∈ 'id' | 'str' | 'num' | 'p' | 're'. Comentário, texto de template e texto de JSX são
 * pulados (não emitem token); `${...}` e `{...}` de JSX emitem tokens normais, inclusive as
 * chaves que os delimitam, para a contagem de profundidade do resto do extrator bater.
 */
function tokens(texto, jsxHabilitado) {
  const toks = [];
  let i = 0;
  let linha = 1;
  const n = texto.length;
  // shebang (`#!/usr/bin/env node`) na primeira linha não é código: pulado por inteiro, senão o
  // `/` de "/usr/bin/..." entraria em posição de expressão e seria lido como regex.
  if (texto.startsWith('#!')) {
    const nl = texto.indexOf('\n');
    i = nl < 0 ? n : nl + 1;
    linha = nl < 0 ? linha : linha + 1;
  }
  // pilha de modos: 'normal' | 'tpl' (texto crú de template) | 'expr' (dentro de `${}` ou `{}` de JSX)
  // | 'jsxTag' (nome + atributos da tag) | 'jsxChildren' (texto crú de filhos)
  const pilha = [{ modo: 'normal' }];
  let last = null;

  const topo = () => pilha[pilha.length - 1];
  const emit = (t) => { toks.push(t); last = t; return t; };

  const ehPosicaoDeExpressao = () => {
    if (!last) return true;
    if (last.t === 'p') return !(last.v === ')' || last.v === ']' || last.v === '}');
    if (last.t === 'id') return PALAVRAS_REGEX_ANTERIOR.has(last.v);
    return false;
  };

  while (i < n) {
    const modo = topo().modo;

    if (modo === 'tpl') {
      const c = texto[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { pilha.pop(); i += 1; continue; }
      if (c === '$' && texto[i + 1] === '{') {
        pilha.push({ modo: 'expr', braces: 0 });
        emit({ t: 'p', v: '{', linha });
        i += 2;
        continue;
      }
      if (c === '\n') linha += 1;
      i += 1;
      continue;
    }

    if (modo === 'jsxChildren') {
      const c = texto[i];
      if (c === '{') {
        pilha.push({ modo: 'expr', braces: 0 });
        emit({ t: 'p', v: '{', linha });
        i += 1;
        continue;
      }
      if (c === '<') {
        if (texto[i + 1] === '/') {
          // </nome> ou </> — fecha este nível de filhos
          let j = i + 2;
          while (j < n && texto[j] !== '>') { if (texto[j] === '\n') linha += 1; j += 1; }
          i = j + 1;
          pilha.pop();
          continue;
        }
        // <nome ...> ou <> — abre elemento filho
        pilha.push({ modo: 'jsxTag' });
        i += 1;
        continue;
      }
      if (c === '\n') linha += 1;
      i += 1;
      continue;
    }

    if (modo === 'jsxTag') {
      const c = texto[i];
      if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
      if (c === '\n') { linha += 1; i += 1; continue; }
      if (c === '{') {
        pilha.push({ modo: 'expr', braces: 0 });
        emit({ t: 'p', v: '{', linha });
        i += 1;
        continue;
      }
      if (c === "'" || c === '"') {
        const quote = c; let j = i + 1;
        while (j < n && texto[j] !== quote && texto[j] !== '\n') { if (texto[j] === '\\') j += 1; j += 1; }
        if (texto[j] === quote) j += 1;
        i = j;
        continue;
      }
      if (c === '/' && texto[i + 1] === '>') { pilha.pop(); i += 2; continue; }
      if (c === '>') { pilha.pop(); pilha.push({ modo: 'jsxChildren' }); i += 1; continue; }
      // nome de tag, nome de atributo, '=' etc — ignorados como tokens
      i += 1;
      continue;
    }

    // modo === 'normal' | 'expr'
    const frame = topo();
    const c = texto[i];

    if (c === '\n') { linha += 1; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }

    if (c === '/' && texto[i + 1] === '/') {
      i += 2;
      while (i < n && texto[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && texto[i + 1] === '*') {
      i += 2;
      while (i < n && !(texto[i] === '*' && texto[i + 1] === '/')) { if (texto[i] === '\n') linha += 1; i += 1; }
      i += 2;
      continue;
    }

    if (c === "'" || c === '"') {
      const quote = c;
      const startLinha = linha;
      let j = i + 1;
      let v = '';
      let fechou = false;
      while (j < n) {
        if (texto[j] === '\\') {
          v += texto[j];
          if (texto[j + 1] !== undefined) { if (texto[j + 1] === '\n') linha += 1; v += texto[j + 1]; j += 2; continue; }
          j += 1;
          continue;
        }
        if (texto[j] === quote) { j += 1; fechou = true; break; }
        if (texto[j] === '\n') break;
        v += texto[j];
        j += 1;
      }
      i = j;
      void fechou;
      emit({ t: 'str', v, linha: startLinha });
      continue;
    }

    if (c === '`') {
      pilha.push({ modo: 'tpl' });
      i += 1;
      continue;
    }

    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXoObB_.eE]/.test(texto[j])) j += 1;
      emit({ t: 'num', v: texto.slice(i, j), linha });
      i = j;
      continue;
    }

    if (/[A-Za-z_$#]/.test(c)) {
      // `j` sempre começa em `i + 1`: um `#` solto (não seguido de letra — por exemplo um
      // shebang `#!`) não é identificador de campo privado, mas tem que consumir ESSE caractere
      // mesmo assim, senão `i` nunca avança e o lexer trava (achado real: bin/check.js do
      // cockpit-agentes, piloto da Fase 3).
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(texto[j])) j += 1;
      emit({ t: 'id', v: texto.slice(i, j), linha });
      i = j;
      continue;
    }

    if (c === '<' && jsxHabilitado) {
      const prox = texto[i + 1];
      if (ehPosicaoDeExpressao() && (/[A-Za-z]/.test(prox) || prox === '>' || prox === '/')) {
        pilha.push({ modo: 'jsxTag' });
        i += 1;
        continue;
      }
    }

    if (c === '/') {
      if (ehPosicaoDeExpressao()) {
        let j = i + 1;
        let emColchete = false;
        let fechouRegex = false;
        while (j < n) {
          if (texto[j] === '\\') { j += 2; continue; }
          if (texto[j] === '[') emColchete = true;
          else if (texto[j] === ']') emColchete = false;
          else if (texto[j] === '/' && !emColchete) { j += 1; fechouRegex = true; break; }
          else if (texto[j] === '\n') break;
          j += 1;
        }
        if (fechouRegex) { while (j < n && /[a-zA-Z]/.test(texto[j])) j += 1; }
        emit({ t: 're', v: texto.slice(i, j), linha });
        i = j;
        continue;
      }
    }

    if (c === '{') {
      if (frame.modo === 'expr') frame.braces += 1;
      emit({ t: 'p', v: '{', linha });
      i += 1;
      continue;
    }
    if (c === '}') {
      if (frame.modo === 'expr') {
        emit({ t: 'p', v: '}', linha });
        if (frame.braces > 0) { frame.braces -= 1; }
        else { pilha.pop(); }
        i += 1;
        continue;
      }
      emit({ t: 'p', v: '}', linha });
      i += 1;
      continue;
    }

    if (c === '=' && texto[i + 1] === '>') { emit({ t: 'p', v: '=>', linha }); i += 2; continue; }

    emit({ t: 'p', v: c, linha });
    i += 1;
  }

  return toks;
}

// ─── declarações de topo ──────────────────────────────────────────────────────

const ID = (tok, v) => tok && tok.t === 'id' && tok.v === v;
const P = (tok, v) => tok && tok.t === 'p' && tok.v === v;

/** Acha a extremidade (índice) da `(` que casa com a aberta em `k` (tokens[k].v === '('). */
function casarParen(toks, k) {
  let prof = 0;
  for (let j = k; j < toks.length; j += 1) {
    if (P(toks[j], '(')) prof += 1;
    else if (P(toks[j], ')')) { prof -= 1; if (prof === 0) return j; }
  }
  return toks.length - 1;
}
/** Acha a extremidade (índice) da `{` que casa com a aberta em `k`. */
function casarChave(toks, k) {
  let prof = 0;
  for (let j = k; j < toks.length; j += 1) {
    if (P(toks[j], '{')) prof += 1;
    else if (P(toks[j], '}')) { prof -= 1; if (prof === 0) return j; }
  }
  return toks.length - 1;
}

/** Varre o corpo de uma classe (entre chaveAbre+1 e chaveFecha-1) achando métodos. */
function acharMetodos(toks, classeNome, chaveAbre, chaveFecha, declaracoes) {
  let k = chaveAbre + 1;
  while (k < chaveFecha) {
    const inicioK = k;
    while (k < chaveFecha && (ID(toks[k], 'static') || ID(toks[k], 'async') || ID(toks[k], 'get') || ID(toks[k], 'set'))) k += 1;
    if (k < chaveFecha && P(toks[k], '*')) k += 1;
    if (k < chaveFecha && toks[k].t === 'id' && P(toks[k + 1], '(')) {
      const nome = toks[k].v;
      const linhaIni = toks[inicioK].linha;
      const parenFecha = casarParen(toks, k + 1);
      let j = parenFecha + 1;
      if (j < chaveFecha && P(toks[j], '{')) {
        const chaveM = casarChave(toks, j);
        const linhaFim = toks[chaveM].linha;
        if (nome !== 'constructor') {
          declaracoes.push({ nome: `${classeNome}.${nome}`, tipo: 'function', ini: linhaIni, fim: linhaFim });
        }
        k = chaveM + 1;
        continue;
      }
    }
    k = inicioK + 1;
  }
}

/** true se, entre k e o fecha-parênteses de uma chamada, existe um argumento que é função/arrow. */
function temArgumentoFuncional(toks, parenAbre, parenFecha) {
  for (let j = parenAbre + 1; j < parenFecha; j += 1) {
    if (ID(toks[j], 'async') && (ID(toks[j + 1], 'function') || P(toks[j + 1], '('))) return true;
    if (ID(toks[j], 'function')) return true;
    if (P(toks[j], '(')) {
      const fim = casarParen(toks, j);
      if (fim + 1 < toks.length && P(toks[fim + 1], '=>')) return true;
    }
    if (toks[j].t === 'id' && P(toks[j + 1], '=>')) return true;
  }
  return false;
}

/**
 * Acha o fim de uma expressão iniciada em `inicio` (profundidade local 0): a `}`/`)` que a
 * fecha, ou o primeiro `;` na profundidade em que a expressão começou, ou o fim do arquivo.
 */
function fimDeExpressao(toks, inicio) {
  let chaves = 0; let parens = 0; let colchetes = 0;
  for (let j = inicio; j < toks.length; j += 1) {
    const tok = toks[j];
    if (P(tok, '{')) chaves += 1;
    else if (P(tok, '}')) { if (chaves === 0) return tok.linha; chaves -= 1; }
    else if (P(tok, '(')) parens += 1;
    else if (P(tok, ')')) { if (parens === 0) return tok.linha; parens -= 1; }
    else if (P(tok, '[')) colchetes += 1;
    else if (P(tok, ']')) { if (colchetes === 0) return tok.linha; colchetes -= 1; }
    else if (P(tok, ';') && chaves === 0 && parens === 0 && colchetes === 0) return tok.linha;
  }
  return toks.length ? toks[toks.length - 1].linha : 1;
}

function acharDeclaracoesDeTopo(toks) {
  const declaracoes = [];
  const exportLocal = new Set(); // nomes marcados `export` diretamente na declaração
  let padrao = null;
  const reexports = []; // { nome: 'default', referencia } para `export default Nome;`
  let k = 0;
  const n = toks.length;
  let chaves = 0;

  while (k < n) {
    if (chaves !== 0) {
      if (P(toks[k], '{')) chaves += 1;
      else if (P(toks[k], '}')) chaves -= 1;
      k += 1;
      continue;
    }

    const inicioK = k;
    let temExport = false; let temDefault = false;
    if (ID(toks[k], 'export')) { temExport = true; k += 1; }
    if (temExport && ID(toks[k], 'default')) { temDefault = true; k += 1; }

    // export default <Nome>;  (referência simples, não é definição)
    if (temExport && temDefault && toks[k] && toks[k].t === 'id' &&
        !ID(toks[k], 'function') && !ID(toks[k], 'class') && !ID(toks[k], 'async') &&
        (P(toks[k + 1], ';') || !toks[k + 1])) {
      padrao = toks[k].v;
      reexports.push({ local: toks[k].v, nome: 'default' });
      k += 2;
      continue;
    }

    let temAsync = false;
    if (ID(toks[k], 'async') && (ID(toks[k + 1], 'function') || P(toks[k + 1], '(') || (toks[k + 1] && toks[k + 1].t === 'id'))) {
      // só consome 'async' aqui se à frente vier function ou algo compatível com declaração
      if (ID(toks[k + 1], 'function')) { temAsync = true; k += 1; }
    }

    // function [*] Nome ( ... ) { ... }
    if (ID(toks[k], 'function')) {
      let j = k + 1;
      if (P(toks[j], '*')) j += 1;
      if (toks[j] && toks[j].t === 'id') {
        const nome = toks[j].v;
        const linhaIni = toks[inicioK].linha;
        const parenAbre = j + 1;
        if (P(toks[parenAbre], '(')) {
          const parenFecha = casarParen(toks, parenAbre);
          let b = parenFecha + 1;
          if (P(toks[b], '{')) {
            const chaveFecha = casarChave(toks, b);
            declaracoes.push({ nome, tipo: 'function', ini: linhaIni, fim: toks[chaveFecha].linha });
            if (temExport && !temDefault) exportLocal.add(nome);
            if (temDefault) { padrao = nome; reexports.push({ local: nome, nome: 'default' }); }
            k = chaveFecha + 1;
            continue;
          }
        }
      }
    }

    // class Nome [extends ...] { ... }
    if (ID(toks[k], 'class')) {
      let j = k + 1;
      if (toks[j] && toks[j].t === 'id') {
        const nome = toks[j].v;
        const linhaIni = toks[inicioK].linha;
        j += 1;
        if (ID(toks[j], 'extends')) { j += 1; while (j < n && !P(toks[j], '{')) j += 1; }
        if (P(toks[j], '{')) {
          const chaveFecha = casarChave(toks, j);
          declaracoes.push({ nome, tipo: 'class', ini: linhaIni, fim: toks[chaveFecha].linha });
          if (temExport && !temDefault) exportLocal.add(nome);
          if (temDefault) { padrao = nome; reexports.push({ local: nome, nome: 'default' }); }
          acharMetodos(toks, nome, j, chaveFecha, declaracoes);
          k = chaveFecha + 1;
          continue;
        }
      }
    }

    // const|let|var Nome = ...
    if (ID(toks[k], 'const') || ID(toks[k], 'let') || ID(toks[k], 'var')) {
      let j = k + 1;
      if (toks[j] && toks[j].t === 'id') {
        const nome = toks[j].v;
        if (P(toks[j + 1], '=')) {
          const linhaIni = toks[inicioK].linha;
          let r = j + 2;
          let asyncAqui = false;
          if (ID(toks[r], 'async')) { asyncAqui = true; }
          const rr = asyncAqui ? r + 1 : r;
          // async? function ...
          if (ID(toks[rr], 'function')) {
            let b = rr + 1;
            if (P(toks[b], '*')) b += 1;
            if (toks[b] && toks[b].t === 'id') b += 1; // nome opcional da função
            if (P(toks[b], '(')) {
              const parenFecha = casarParen(toks, b);
              let bb = parenFecha + 1;
              if (P(toks[bb], '{')) {
                const chaveFecha = casarChave(toks, bb);
                declaracoes.push({ nome, tipo: 'function', ini: linhaIni, fim: toks[chaveFecha].linha });
                if (temExport) exportLocal.add(nome);
                k = chaveFecha + 1;
                continue;
              }
            }
          }
          // async? ( ... ) => ...
          if (P(toks[rr], '(')) {
            const parenFecha = casarParen(toks, rr);
            if (P(toks[parenFecha + 1], '=>')) {
              let corpo = parenFecha + 2;
              let fimLinha;
              if (P(toks[corpo], '{')) { const cf = casarChave(toks, corpo); fimLinha = toks[cf].linha; k = cf + 1; }
              else { fimLinha = fimDeExpressao(toks, corpo); k = r; /* reavaliado abaixo */ }
              declaracoes.push({ nome, tipo: 'function', ini: linhaIni, fim: fimLinha });
              if (temExport) exportLocal.add(nome);
              if (!P(toks[corpo], '{')) {
                // avança até a linha de término real (achar o token com essa linha ou ';')
                let jj = corpo;
                while (jj < n && toks[jj].linha <= fimLinha && !(P(toks[jj], ';') && toks[jj].linha === fimLinha)) jj += 1;
                k = Math.min(jj + 1, n);
              }
              continue;
            }
          }
          // id => ...  (arrow de 1 parâmetro sem parênteses)
          if (toks[rr] && toks[rr].t === 'id' && P(toks[rr + 1], '=>')) {
            const corpo = rr + 2;
            let fimLinha;
            let proxK;
            if (P(toks[corpo], '{')) { const cf = casarChave(toks, corpo); fimLinha = toks[cf].linha; proxK = cf + 1; }
            else {
              fimLinha = fimDeExpressao(toks, corpo);
              let jj = corpo;
              while (jj < n && toks[jj].linha <= fimLinha && !(P(toks[jj], ';') && toks[jj].linha === fimLinha)) jj += 1;
              proxK = Math.min(jj + 1, n);
            }
            declaracoes.push({ nome, tipo: 'function', ini: linhaIni, fim: fimLinha });
            if (temExport) exportLocal.add(nome);
            k = proxK;
            continue;
          }
          // chamada(...) com argumento funcional — HOF
          if (toks[rr] && toks[rr].t === 'id' && P(toks[rr + 1], '(')) {
            const parenFecha = casarParen(toks, rr + 1);
            if (temArgumentoFuncional(toks, rr + 1, parenFecha)) {
              declaracoes.push({ nome, tipo: 'function', ini: linhaIni, fim: toks[parenFecha].linha });
              if (temExport) exportLocal.add(nome);
              k = parenFecha + 1;
              continue;
            }
          }
        }
      }
    }

    // exports.nome = function ...  /  module.exports.nome = function ...
    if ((ID(toks[k], 'exports') && P(toks[k + 1], '.') && toks[k + 2] && toks[k + 2].t === 'id' && P(toks[k + 3], '=')) ||
        (ID(toks[k], 'module') && P(toks[k + 1], '.') && ID(toks[k + 2], 'exports') && P(toks[k + 3], '.') && toks[k + 4] && toks[k + 4].t === 'id' && P(toks[k + 5], '='))) {
      const viaModule = ID(toks[k], 'module');
      const nome = viaModule ? toks[k + 4].v : toks[k + 2].v;
      let r = viaModule ? k + 6 : k + 4;
      const linhaIni = toks[k].linha;
      if (ID(toks[r], 'async')) r += 1;
      if (ID(toks[r], 'function')) {
        let b = r + 1;
        if (toks[b] && toks[b].t === 'id') b += 1;
        if (P(toks[b], '(')) {
          const parenFecha = casarParen(toks, b);
          let bb = parenFecha + 1;
          if (P(toks[bb], '{')) {
            const chaveFecha = casarChave(toks, bb);
            declaracoes.push({ nome, tipo: 'function', ini: linhaIni, fim: toks[chaveFecha].linha });
            exportLocal.add(nome);
            reexports.push({ local: nome, nome });
            k = chaveFecha + 1;
            continue;
          }
        }
      }
    }

    if (P(toks[k], '{')) chaves += 1;
    k += 1;
  }

  void temAsyncUnused();
  function temAsyncUnused() { return undefined; }

  return { declaracoes, exportLocal, padrao, reexports };
}

// ─── exports (statements soltos) ───────────────────────────────────────────

function acharExportsSoltos(toks) {
  const exportados = []; // { local, nome }
  let moduleExportsIgual = null; // { tipo: 'objeto'|'nome', pares: [{local, nome}] } | { tipo:'nome', nome }
  for (let k = 0; k < toks.length; k += 1) {
    // export { a, b as c }  [from '...']
    if (ID(toks[k], 'export') && P(toks[k + 1], '{')) {
      const fecha = casarChave(toks, k + 1);
      let j = k + 2;
      while (j < fecha) {
        if (toks[j].t === 'id' && !ID(toks[j], 'type')) {
          const local = toks[j].v;
          let nome = local;
          let adiante = j + 1;
          if (ID(toks[adiante], 'as') && toks[adiante + 1] && toks[adiante + 1].t === 'id') {
            nome = toks[adiante + 1].v;
            adiante += 2;
          }
          exportados.push({ local, nome });
          j = adiante;
        }
        j += 1;
      }
    }

    // module.exports = { a, b: c, d() {} }   ou   module.exports = Nome
    if (ID(toks[k], 'module') && P(toks[k + 1], '.') && ID(toks[k + 2], 'exports') && P(toks[k + 3], '=')) {
      let j = k + 4;
      if (P(toks[j], '{')) {
        const fecha = casarChave(toks, j);
        const pares = [];
        let p = j + 1;
        while (p < fecha) {
          if (toks[p].t === 'id') {
            const nome = toks[p].v;
            if (P(toks[p + 1], ':') && toks[p + 2] && toks[p + 2].t === 'id') {
              pares.push({ local: toks[p + 2].v, nome });
              p += 3;
            } else if (P(toks[p + 1], '(')) {
              // d() {} — método direto no objeto; local=nome (não há outra declaração a apontar)
              pares.push({ local: nome, nome });
              const pf = casarParen(toks, p + 1);
              let b = pf + 1;
              if (P(toks[b], '{')) { const cf = casarChave(toks, b); p = cf + 1; continue; }
              p += 1;
            } else {
              pares.push({ local: nome, nome });
              p += 1;
            }
          } else { p += 1; }
        }
        moduleExportsIgual = { tipo: 'objeto', pares };
      } else if (toks[j] && toks[j].t === 'id') {
        moduleExportsIgual = { tipo: 'nome', nome: toks[j].v };
      }
    }
  }
  return { exportados, moduleExportsIgual };
}

// ─── imports ────────────────────────────────────────────────────────────────

function acharImports(toks) {
  const imports = [];
  let k = 0;
  while (k < toks.length) {
    if (ID(toks[k], 'import') && !P(toks[k + 1], '(')) {
      const linha = toks[k].linha;
      let j = k + 1;
      if (ID(toks[j], 'type') && !ID(toks[j + 1], 'from')) j += 1; // `import type ... from` — tratado como import normal
      // import 'x';
      if (toks[j] && toks[j].t === 'str') {
        imports.push({ especificador: toks[j].v, tipo: 'efeito', nomes: [], linha });
        k = j + 1;
        continue;
      }
      // import * as N from 'x'
      if (P(toks[j], '*')) {
        j += 1;
        if (ID(toks[j], 'as') && toks[j + 1] && toks[j + 1].t === 'id') {
          const local = toks[j + 1].v;
          j += 2;
          if (ID(toks[j], 'from') && toks[j + 1] && toks[j + 1].t === 'str') {
            imports.push({ especificador: toks[j + 1].v, tipo: 'namespace', nomes: [{ importado: '*', local }], linha });
            k = j + 2;
            continue;
          }
        }
      }
      // import X [, { ... } | , * as N] from 'x'
      if (toks[j] && toks[j].t === 'id') {
        const localDefault = toks[j].v;
        let r = j + 1;
        if (P(toks[r], ',')) {
          r += 1;
          if (P(toks[r], '*')) {
            r += 1;
            if (ID(toks[r], 'as') && toks[r + 1] && toks[r + 1].t === 'id') {
              const local2 = toks[r + 1].v;
              r += 2;
              if (ID(toks[r], 'from') && toks[r + 1] && toks[r + 1].t === 'str') {
                const esp = toks[r + 1].v;
                imports.push({ especificador: esp, tipo: 'padrao', nomes: [{ importado: 'default', local: localDefault }], linha });
                imports.push({ especificador: esp, tipo: 'namespace', nomes: [{ importado: '*', local: local2 }], linha });
                k = r + 2;
                continue;
              }
            }
          } else if (P(toks[r], '{')) {
            const fecha = casarChave(toks, r);
            const nomeados = lerNomeadosImport(toks, r, fecha);
            let adiante = fecha + 1;
            if (ID(toks[adiante], 'from') && toks[adiante + 1] && toks[adiante + 1].t === 'str') {
              const esp = toks[adiante + 1].v;
              imports.push({ especificador: esp, tipo: 'padrao', nomes: [{ importado: 'default', local: localDefault }], linha });
              imports.push({ especificador: esp, tipo: 'nomeados', nomes: nomeados, linha });
              k = adiante + 2;
              continue;
            }
          }
        } else if (ID(toks[r], 'from') && toks[r + 1] && toks[r + 1].t === 'str') {
          imports.push({ especificador: toks[r + 1].v, tipo: 'padrao', nomes: [{ importado: 'default', local: localDefault }], linha });
          k = r + 2;
          continue;
        }
      }
      // import { ... } from 'x'
      if (P(toks[j], '{')) {
        const fecha = casarChave(toks, j);
        const nomeados = lerNomeadosImport(toks, j, fecha);
        let adiante = fecha + 1;
        if (ID(toks[adiante], 'from') && toks[adiante + 1] && toks[adiante + 1].t === 'str') {
          imports.push({ especificador: toks[adiante + 1].v, tipo: 'nomeados', nomes: nomeados, linha });
          k = adiante + 2;
          continue;
        }
      }
    }

    // export { a } from 'x'  /  export * from 'x'
    if (ID(toks[k], 'export')) {
      const linha = toks[k].linha;
      if (P(toks[k + 1], '{')) {
        const fecha = casarChave(toks, k + 1);
        let adiante = fecha + 1;
        if (ID(toks[adiante], 'from') && toks[adiante + 1] && toks[adiante + 1].t === 'str') {
          imports.push({ especificador: toks[adiante + 1].v, tipo: 'efeito', nomes: [], linha });
          k = adiante + 2;
          continue;
        }
      } else if (P(toks[k + 1], '*')) {
        let r = k + 2;
        if (ID(toks[r], 'as') && toks[r + 1] && toks[r + 1].t === 'id') r += 2;
        if (ID(toks[r], 'from') && toks[r + 1] && toks[r + 1].t === 'str') {
          imports.push({ especificador: toks[r + 1].v, tipo: 'efeito', nomes: [], linha });
          k = r + 2;
          continue;
        }
      }
    }

    // import('x') dinâmico
    if (ID(toks[k], 'import') && P(toks[k + 1], '(') && toks[k + 2] && toks[k + 2].t === 'str' && P(toks[k + 3], ')')) {
      imports.push({ especificador: toks[k + 2].v, tipo: 'dinamico', nomes: [], linha: toks[k].linha });
      k += 4;
      continue;
    }

    k += 1;
  }
  return imports;
}

function lerNomeadosImport(toks, abre, fecha) {
  const nomes = [];
  let j = abre + 1;
  while (j < fecha) {
    if (toks[j].t === 'id') {
      if (ID(toks[j], 'type') && toks[j + 1] && toks[j + 1].t === 'id' && !P(toks[j + 1], ',')) { j += 1; continue; }
      const importado = toks[j].v;
      let local = importado;
      let adiante = j + 1;
      if (ID(toks[adiante], 'as') && toks[adiante + 1] && toks[adiante + 1].t === 'id') {
        local = toks[adiante + 1].v;
        adiante += 2;
      }
      nomes.push({ importado, local });
      j = adiante;
      continue;
    }
    j += 1;
  }
  return nomes;
}

// ─── require(...) ───────────────────────────────────────────────────────────

function acharRequires(toks) {
  const imports = [];
  for (let k = 0; k < toks.length; k += 1) {
    if (!(ID(toks[k], 'require') && P(toks[k + 1], '(') && toks[k + 2] && toks[k + 2].t === 'str' && P(toks[k + 3], ')'))) continue;
    const linha = toks[k].linha;
    const esp = toks[k + 2].v;
    // const|let|var <pattern> = require(...)
    // procura, voltando a partir de k-1 ('='), o padrão e a palavra-chave.
    if (P(toks[k - 1], '=')) {
      if (toks[k - 2] && toks[k - 2].t === 'id' && (ID(toks[k - 3], 'const') || ID(toks[k - 3], 'let') || ID(toks[k - 3], 'var'))) {
        imports.push({ especificador: esp, tipo: 'namespace', nomes: [{ importado: '*', local: toks[k - 2].v }], linha });
        continue;
      }
      if (P(toks[k - 2], '}')) {
        const fecha = k - 2;
        const abre = acharAberturaChave(toks, fecha);
        if (abre >= 0 && (ID(toks[abre - 1], 'const') || ID(toks[abre - 1], 'let') || ID(toks[abre - 1], 'var'))) {
          const nomes = [];
          let p = abre + 1;
          while (p < fecha) {
            if (toks[p].t === 'id') {
              const importado = toks[p].v;
              let local = importado;
              let adiante = p + 1;
              if (P(toks[adiante], ':') && toks[adiante + 1] && toks[adiante + 1].t === 'id') {
                local = toks[adiante + 1].v;
                adiante += 2;
              }
              nomes.push({ importado, local });
              p = adiante;
              continue;
            }
            p += 1;
          }
          imports.push({ especificador: esp, tipo: 'nomeados', nomes, linha });
          continue;
        }
      }
    }
    imports.push({ especificador: esp, tipo: 'efeito', nomes: [], linha });
  }
  return imports;
}

function acharAberturaChave(toks, fecha) {
  let prof = 0;
  for (let j = fecha; j >= 0; j -= 1) {
    if (P(toks[j], '}')) prof += 1;
    else if (P(toks[j], '{')) { prof -= 1; if (prof === 0) return j; }
  }
  return -1;
}

// ─── chamadas ───────────────────────────────────────────────────────────────

function acharChamadas(toks, declaracoes) {
  const chamadas = [];
  const donoPorLinha = (linha) => {
    // uma `class` nunca é dona de chamada (quem possui é o método, mesmo com o mesmo
    // lineRange de uma classe de uma linha só) — por isso ela fica fora da disputa.
    let melhor = null;
    for (const d of declaracoes) {
      if (d.tipo === 'class') continue;
      if (linha >= d.ini && linha <= d.fim) {
        if (!melhor || (d.fim - d.ini) < (melhor.fim - melhor.ini)) melhor = d;
      }
    }
    return melhor ? melhor.nome : null;
  };

  for (let k = 0; k < toks.length; k += 1) {
    if (toks[k].t !== 'id') continue;
    if (!P(toks[k + 1], '(')) continue;
    const nome = toks[k].v;
    if (PALAVRAS_CHAMADA_EXCLUIDA.has(nome)) continue;
    // nome logo depois de `function` (definição) — pula
    if (ID(toks[k - 1], 'function') || P(toks[k - 1], '*')) {
      if (ID(toks[k - 1], 'function') || (P(toks[k - 1], '*') && ID(toks[k - 2], 'function'))) continue;
    }
    // definição de método no corpo da classe: nome '(' ... ') {' logo após modificadores, numa
    // posição onde o token anterior é um identificador-modificador ou '}'/';' de outro membro —
    // heurística: se o que vem IMEDIATAMENTE antes é '.', é acesso a propriedade, trata como chamada
    // via `obj.nome(`, não definição. Se o próprio nome é seguido por '(' ... ') {' e o token anterior
    // não é '.', ';' , nada, '=' nem outro iniciador de expressão, não distinguimos aqui: a exclusão de
    // métodos já foi tratada em acharMetodos (eles não emitem token diferente); como heurística final,
    // uma chamada precedida de `new` é `new Nome(` (conta como chamada); chamadas obj.nome( tratadas abaixo.
    if (ID(toks[k - 1], 'new')) {
      chamadas.push({ nome, objeto: null, dono: donoPorLinha(toks[k].linha), linha: toks[k].linha });
      continue;
    }
    if (P(toks[k - 1], '.') && toks[k - 2] && toks[k - 2].t === 'id') {
      const objeto = toks[k - 2].v;
      // só conta se o objeto é um id "simples": o token antes do objeto não pode ser '.' (encadeado)
      if (!P(toks[k - 3], '.')) {
        chamadas.push({ nome, objeto, dono: donoPorLinha(toks[k].linha), linha: toks[k].linha });
      }
      continue;
    }
    if (P(toks[k - 1], '.')) continue; // cadeia mais longa (x.y.nome(): ignorada)
    chamadas.push({ nome, objeto: null, dono: donoPorLinha(toks[k].linha), linha: toks[k].linha });
  }
  return chamadas;
}

// ─── extrairJs ──────────────────────────────────────────────────────────────

function extrairJs(caminho, texto) {
  const jsxHabilitado = ehJsxPorExtensao(caminho);
  const toks = tokens(texto, jsxHabilitado);
  const { declaracoes, exportLocal, padrao: padraoDecl, reexports } = acharDeclaracoesDeTopo(toks);
  const { exportados: exportadosSoltos, moduleExportsIgual } = acharExportsSoltos(toks);
  const importsEstaticos = acharImports(toks);
  const importsRequire = acharRequires(toks);
  const chamadas = acharChamadas(toks, declaracoes);

  const exportados = [];
  for (const nome of exportLocal) exportados.push({ local: nome, nome });
  for (const r of reexports) exportados.push(r);
  for (const e of exportadosSoltos) exportados.push(e);

  let padrao = padraoDecl;
  if (moduleExportsIgual) {
    if (moduleExportsIgual.tipo === 'nome') {
      padrao = moduleExportsIgual.nome;
      exportados.push({ local: moduleExportsIgual.nome, nome: 'default' });
      exportados.push({ local: moduleExportsIgual.nome, nome: '*' });
    } else {
      for (const par of moduleExportsIgual.pares) exportados.push(par);
    }
  }

  return {
    declaracoes,
    imports: [...importsEstaticos, ...importsRequire],
    chamadas,
    exportados,
    padrao,
  };
}

module.exports = { extrairJs, tokens, EHJSX: ehJsxPorExtensao };
