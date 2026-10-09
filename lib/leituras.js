'use strict';
// Progresso das trilhas de leitura (card `leituras-trilhas`, D59) — mora no SERVIDOR, molde
// `lib/lidas.js` (D53). Ver docs/superpowers/specs/2026-10-02-leituras-trilhas-design.md.
// Lendo agora + próximo que pula opcional: card `leituras-v2`, D61 (docs/superpowers/specs/2026-10-04-leituras-v2-design.md).
//
// `COCKPIT_LEITURAS_DIR` é DUAS coisas ao mesmo tempo — configuração de onde o progresso mora,
// e o INTERRUPTOR que isola os testes — e ela VENCE um `HOME` falso: `DIR = env || homedir()`
// resolve a env var primeiro, então isolar `HOME` sozinho não protege ninguém. Mesma estrutura
// da `COCKPIT_LIDAS_DIR` (armadilha #62/#78): um gate rodado à mão, fora do `bin/testes.js`,
// com esta env var esquecida no shell, grava no `~/.cockpit/leituras.json` DE PRODUÇÃO do
// o dono — marcando livros dele como lidos de verdade.
//
// O CATÁLOGO é de OUTRO projeto (servidor de mídia) e é SÓ LEITURA: nenhuma função de escrita
// deste módulo recebe `caminhoCatalogo()`. Só `lerCatalogo()` chama `fsp.readFile` nele — a
// prova disso é o caso L17 do gate (execução + grep de fonte).
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const DIR = process.env.COCKPIT_LEITURAS_DIR || path.join(os.homedir(), '.cockpit');
const ARQ = path.join(DIR, 'leituras.json');
// Mesma preocupação de `lib/lidas.js:21-31`: o id vira CHAVE de um objeto em disco.
const ID = /^[\w.-]{1,64}$/;

// Erro TIPADO, no mesmo padrão de `lib/lidas.js:23`: o código HTTP vem junto.
const erro = (codigo, mensagem) => Object.assign(new Error(mensagem), { codigo });
// O progresso ilegível leva a CAUSA à parte: a mensagem completa serve ao POST (vira
// "não salvou: progresso ilegível: …"), e o GET entrega só a causa, porque a tela já escreve o
// prefixo traduzido — mandar a mensagem inteira duplicava "progresso ilegível:" (painel de
// execução, Claude).
const ilegivel = (causa) => Object.assign(erro(500, `progresso ilegível: ${causa}`), { causa });

// Resolvida A CADA CHAMADA (não no `require`, ao contrário de `DIR` acima) — deixa o dono
// editar o catálogo sem reiniciar o serviço, e deixa o gate trocar de catálogo sem recarregar
// o módulo (decisão 4 da spec).
function caminhoCatalogo() {
  return process.env.COCKPIT_TRILHAS
    || path.join(os.homedir(), '.cockpit', 'trilhas.json');
}

const textoNaoVazio = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Valida o contrato v1 (docs/contrato-trilhas.md) e devolve só os campos da WHITELIST — campo
 * a mais no JSON do dono é ignorado, nunca atravessa para a tela. Lança uma STRING (o
 * `detalhe`, em português, diagnóstico de quem edita o JSON — não rótulo de interface, por
 * isso sem par EN).
 */
function validar(bruto) {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) throw 'catálogo: raiz não é objeto';
  if (bruto.versao !== 1) throw `versão não suportada: ${bruto.versao}`;
  if (!Array.isArray(bruto.trilhas)) throw 'catálogo: "trilhas" não é array';

  const idsDeTrilha = new Set();
  const idsDeLivro = new Set();
  const trilhas = bruto.trilhas.map((t) => {
    if (!t || typeof t !== 'object') throw 'trilha inválida (não é objeto)';
    if (!textoNaoVazio(t.id)) throw 'trilha sem id';
    if (idsDeTrilha.has(t.id)) throw `trilha id duplicado: ${t.id}`;
    idsDeTrilha.add(t.id);
    if (!textoNaoVazio(t.titulo)) throw `trilha sem título: ${t.id}`;
    if (!Array.isArray(t.livros)) throw `trilha sem "livros" array: ${t.id}`;

    const livros = t.livros.map((l) => {
      if (!l || typeof l !== 'object') throw `livro inválido na trilha ${t.id}`;
      if (!(typeof l.id === 'string' && ID.test(l.id))) throw `livro id inválido: ${l.id}`;
      if (idsDeLivro.has(l.id)) throw `livro id duplicado: ${l.id}`;
      idsDeLivro.add(l.id);
      if (!textoNaoVazio(l.titulo)) throw `livro sem título: ${l.id}`;
      // Os quatro campos de texto só entram SE forem string — não só `preco` (achado do
      // painel [Claude]): um `autor: {}` bruto viraria "[object Object]" na tela.
      const saida = { id: l.id, titulo: l.titulo };
      for (const campo of ['n', 'original', 'autor', 'preco']) {
        if (typeof l[campo] === 'string') saida[campo] = l[campo];
      }
      saida.opcional = l.opcional === true;
      saida.gratis = l.gratis === true;
      saida.na_estante = l.na_estante === true;
      return saida;
    });

    return { id: t.id, titulo: t.titulo, livros };
  });

  return trilhas;
}

async function lerCatalogo() {
  const caminho = caminhoCatalogo();
  let texto;
  try {
    texto = await fsp.readFile(caminho, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, caminho, motivo: 'ausente', detalhe: 'arquivo não existe' };
    return { ok: false, caminho, motivo: 'invalido', detalhe: `não deu para ler: ${e.code || e.message}` };
  }
  try {
    return { ok: true, caminho, trilhas: validar(JSON.parse(texto)) };
  } catch (e) {
    return { ok: false, caminho, motivo: 'invalido', detalhe: typeof e === 'string' ? e : `JSON inválido: ${e.message}` };
  }
}

/**
 * Um `terminado_em` só vale se for string de data parseável. Lixo editado à mão (ou um campo
 * de tipo errado, como número) conta como NÃO terminado na tela — nunca vira "Invalid Date" —
 * e é substituído no próximo check daquele livro, sem apagar as outras entradas (L18).
 */
const dataValida = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * ENOENT → mapa vazio (primeira vez). Qualquer OUTRA falha LANÇA 500: diferente do molde
 * `lib/lidas.js` (onde perder o mapa custa um `◆` a mais numa lista), aqui perder o mapa
 * apagaria o histórico de livros terminados do dono — R9 da spec, achado [Alta] do painel.
 */
async function progresso() {
  let texto;
  try {
    texto = await fsp.readFile(ARQ, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return Object.create(null);
    throw ilegivel(e.code);
  }
  let obj;
  try {
    obj = JSON.parse(texto);
  } catch {
    throw ilegivel('JSON corrompido');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw ilegivel('raiz não é objeto');
  return Object.assign(Object.create(null), obj);
}

/**
 * Grava o mapa inteiro, atômico — molde `gravarJson` (ex-`gravarMapa`) de `lib/lidas.js`. ÚNICA função
 * deste arquivo que escreve em disco: o caso L17 do gate prova, por fonte, que `writeFile`,
 * `rename` e `mkdir` só aparecem AQUI DENTRO — nenhum mira o caminho do catálogo.
 */
async function gravar(mapa) {
  await fsp.mkdir(DIR, { recursive: true });
  const tmp = path.join(DIR, `leituras.${process.pid}.${process.hrtime.bigint()}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(mapa), { mode: 0o600 });
  await fsp.rename(tmp, ARQ);
}

// Fila contra corrida NO MESMO processo — molde `lib/lidas.js:91-92`.
let fila = Promise.resolve();
const naFila = (tarefa) => { fila = fila.then(tarefa, tarefa); return fila; };

async function estado() {
  const catalogo = await lerCatalogo();
  let mapa = Object.create(null);
  let prog = { ok: true };
  try {
    mapa = await progresso();
  } catch (e) {
    prog = { ok: false, detalhe: e.causa ?? e.message };
  }
  const trilhas = catalogo.ok ? catalogo.trilhas.map((t) => {
    const livros = t.livros.map((l) => {
      const entrada = mapa[l.id];
      const terminado = dataValida(entrada?.terminado_em) ? entrada.terminado_em : null;
      // S5/S12: lendo só vale com data válida E sem terminado — terminado prevalece na leitura.
      const lendo = !terminado && dataValida(entrada?.lendo_desde) ? entrada.lendo_desde : null;
      return { ...l, terminado_em: terminado, lendo_desde: lendo };
    });
    // D61 (regra 3 + S6): o primeiro não terminado, NÃO opcional e que ainda não começou.
    const proximo = livros.find((l) => !l.terminado_em && !l.opcional && !l.lendo_desde);
    return {
      id: t.id, titulo: t.titulo,
      feitos: livros.filter((l) => l.terminado_em).length,
      total: livros.length,
      proximo: proximo ? proximo.id : null,
      livros,
    };
  }) : [];
  // Catálogo sem as trilhas cruas — a rota devolve forma/motivo/detalhe, não o conteúdo bruto.
  const { trilhas: _t, ...cab } = catalogo;
  return { catalogo: cab, progresso: prog, trilhas };
}

async function marcar(livroId, terminado) {
  return naFila(async () => {
    if (typeof livroId !== 'string' || !ID.test(livroId)) throw erro(400, 'livroId inválido');
    if (typeof terminado !== 'boolean') throw erro(400, 'terminado tem de ser booleano');
    const catalogo = await lerCatalogo();
    if (!catalogo.ok) throw erro(409, 'catálogo indisponível');
    if (!catalogo.trilhas.some((t) => t.livros.some((l) => l.id === livroId))) throw erro(404, 'livro fora do catálogo');
    const mapa = await progresso();   // lança 500 se ilegível — não grava por cima do lixo (R9)
    const entrada = mapa[livroId];
    const ehObjeto = entrada !== null && typeof entrada === 'object' && !Array.isArray(entrada);
    const v = entrada?.terminado_em;
    const atual = dataValida(v) ? v : null;
    if (terminado) {
      // S3: idempotente, mantém a data. Só não grava se não houver `lendo_desde` a limpar (D61).
      if (atual && !(ehObjeto && Object.hasOwn(entrada, 'lendo_desde'))) return { livroId, terminado_em: atual };
      const data = atual || new Date().toISOString();
      mapa[livroId] = { terminado_em: data };   // terminar LIMPA o lendo (D61)
      await gravar(mapa);
      return { livroId, terminado_em: data };
    }
    if (!(livroId in mapa)) return { livroId, terminado_em: null };
    // S13: entrada só com `lendo_desde` é o "desmarcar terminado" atrasado de outro aparelho —
    // apagá-la jogaria fora o lendo que ele acabou de gravar.
    if (ehObjeto && !Object.hasOwn(entrada, 'terminado_em')) return { livroId, terminado_em: null };
    delete mapa[livroId];
    await gravar(mapa);
    return { livroId, terminado_em: null };
  });
}

/** Liga/desliga "lendo agora" (D61). Mesmas validações e mesmo R9 do `marcar`. */
async function marcarLendo(livroId, lendo) {
  return naFila(async () => {
    if (typeof livroId !== 'string' || !ID.test(livroId)) throw erro(400, 'livroId inválido');
    if (typeof lendo !== 'boolean') throw erro(400, 'lendo tem de ser booleano');
    const catalogo = await lerCatalogo();
    if (!catalogo.ok) throw erro(409, 'catálogo indisponível');
    if (!catalogo.trilhas.some((t) => t.livros.some((l) => l.id === livroId))) throw erro(404, 'livro fora do catálogo');
    const mapa = await progresso();   // lança 500 se ilegível — nunca grava por cima (R9)
    const entrada = mapa[livroId];
    const ehObjeto = entrada !== null && typeof entrada === 'object' && !Array.isArray(entrada);
    if (lendo) {
      // S5: terminado e lendo nunca juntos — reler é desmarcar terminado antes.
      if (dataValida(entrada?.terminado_em)) throw erro(409, 'livro já terminado');
      if (dataValida(entrada?.lendo_desde)) return { livroId, lendo_desde: entrada.lendo_desde };   // S11
      const agora = new Date().toISOString();
      mapa[livroId] = { ...(ehObjeto ? entrada : {}), lendo_desde: agora };
      await gravar(mapa);
      return { livroId, lendo_desde: agora };
    }
    if (!ehObjeto || !Object.hasOwn(entrada, 'lendo_desde')) return { livroId, lendo_desde: null };
    const resto = { ...entrada };
    delete resto.lendo_desde;
    // Entrada sem nenhum dos dois campos some (regra do brief) — presença da CHAVE, não validade.
    if (Object.hasOwn(resto, 'terminado_em')) mapa[livroId] = resto;
    else delete mapa[livroId];
    await gravar(mapa);
    return { livroId, lendo_desde: null };
  });
}

module.exports = { caminhoCatalogo, lerCatalogo, progresso, estado, marcar, marcarLendo };
