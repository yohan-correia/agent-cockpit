#!/usr/bin/env node
'use strict';
// GATE — o progresso das trilhas de leitura (lib/leituras.js) e as rotas que o expõem
// (card `leituras-trilhas`, 2026-10-02, spec
// docs/superpowers/specs/2026-10-02-leituras-trilhas-design.md, §8).
//
// Dois blocos: L1-L18 provam a LIB direto (sem servidor), com um catálogo (`COCKPIT_TRILHAS`)
// e uma pasta de progresso (`COCKPIT_LEITURAS_DIR`) próprios do gate — nunca o
// `~/.cockpit/leituras.json` de produção (R9/§10 da spec). R1-R10 sobem `server.js` DE
// VERDADE, em DOIS processos FILHO (um com a fixture, outro com catálogo ausente — nunca por
// `require`, que subiria na porta de produção).
//
// Uso: node testes/gate-leituras.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

let falhas = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); if (!cond) falhas += 1; return cond; };

// Uma pasta própria do gate — apagada inteira no fim. `DIR_LEITURAS` é o progresso
// (COCKPIT_LEITURAS_DIR); `FIXTURE` é o catálogo (COCKPIT_TRILHAS) — as duas ANTES do
// `require('../lib/leituras')`, porque o módulo resolve `DIR` no `require`, no processo de
// quem requer (mesma estrutura de `lib/lidas.js`, molde `gate-lidas.js:38-42`). Sem isto o
// `require` abaixo leria o `~/.cockpit/leituras.json` de produção do dono (armadilha #62/#78).
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-leituras-'));
const DIR_LEITURAS = path.join(RAIZ, 'leituras');
process.env.COCKPIT_LEITURAS_DIR = DIR_LEITURAS;
const FIXTURE = path.join(__dirname, 'fixtures', 'trilhas-teste.json');
process.env.COCKPIT_TRILHAS = FIXTURE;
const leituras = require('../lib/leituras');
const ARQ_LEITURAS = path.join(DIR_LEITURAS, 'leituras.json');

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────

/**
 * Uma cópia isolada do módulo, com pasta de progresso própria — molde `requerLidasEm` de
 * `gate-lidas.js:138-145`. Usada quando um caso precisa de um `leituras.json` que NADA mais
 * toca (teto/corrida não se aplicam aqui, mas corrupção e persistência sim).
 */
function requerEm(dirLeituras) {
  const anterior = process.env.COCKPIT_LEITURAS_DIR;
  process.env.COCKPIT_LEITURAS_DIR = dirLeituras;
  delete require.cache[require.resolve('../lib/leituras')];
  const modulo = require('../lib/leituras');
  process.env.COCKPIT_LEITURAS_DIR = anterior;
  return modulo;
}

// Catálogo escrito dentro de `RAIZ`, para os casos de inválido/versão/duplicado. O CASO troca
// `process.env.COCKPIT_TRILHAS` para o caminho devolvido e restaura no fim — `catalogoEm` só
// escreve o arquivo, não mexe no ambiente.
let contadorCatalogo = 0;
function catalogoEm(objOuTexto) {
  contadorCatalogo += 1;
  const caminho = path.join(RAIZ, `catalogo-${contadorCatalogo}.json`);
  fs.writeFileSync(caminho, typeof objOuTexto === 'string' ? objOuTexto : JSON.stringify(objOuTexto));
  return caminho;
}

/** `codigoDe(promessa)` — null se não lançou, o `.codigo` do erro tipado se lançou. */
async function codigoDe(promessa) {
  try { await promessa; return null; } catch (e) { return e.codigo; }
}

// ─── L1-L18 — a lib, sem servidor nenhum ────────────────────────────────────────────────

async function casoL1() {
  const anterior = process.env.COCKPIT_TRILHAS;
  const caminho = path.join(RAIZ, 'nao-existe.json');
  process.env.COCKPIT_TRILHAS = caminho;
  const r = await leituras.lerCatalogo();
  ok(r.ok === false && r.motivo === 'ausente' && r.caminho === caminho,
    `L1: catálogo ausente ⇒ { ok:false, motivo:'ausente', caminho } (veio ${JSON.stringify(r)})`);
  const e = await leituras.estado();
  ok(Array.isArray(e.trilhas) && e.trilhas.length === 0, 'L1: e estado().trilhas é [] com catálogo ausente');
  process.env.COCKPIT_TRILHAS = anterior;
}

async function casoL2() {
  const anterior = process.env.COCKPIT_TRILHAS;
  process.env.COCKPIT_TRILHAS = catalogoEm('{ "versao": 1, ');
  const r = await leituras.lerCatalogo();
  ok(r.ok === false && r.motivo === 'invalido' && typeof r.detalhe === 'string' && r.detalhe.length > 0,
    `L2: JSON quebrado ⇒ invalido com detalhe não vazio (veio ${JSON.stringify(r)})`);
  process.env.COCKPIT_TRILHAS = anterior;
}

async function casoL3() {
  const anterior = process.env.COCKPIT_TRILHAS;
  process.env.COCKPIT_TRILHAS = catalogoEm({ versao: 2, trilhas: [] });
  const r = await leituras.lerCatalogo();
  ok(r.ok === false && r.motivo === 'invalido' && r.detalhe.includes('versão'),
    `L3: versao 2 ⇒ invalido, detalhe cita "versão" (veio ${JSON.stringify(r)})`);
  process.env.COCKPIT_TRILHAS = anterior;
}

async function casoL4() {
  const anterior = process.env.COCKPIT_TRILHAS;
  process.env.COCKPIT_TRILHAS = catalogoEm({
    versao: 1,
    trilhas: [
      { id: 't1', titulo: 'T1', livros: [{ id: 'ia-0', titulo: 'Livro A' }] },
      { id: 't2', titulo: 'T2', livros: [{ id: 'ia-0', titulo: 'Livro B' }] },
    ],
  });
  const r = await leituras.lerCatalogo();
  ok(r.ok === false && r.motivo === 'invalido' && r.detalhe.includes('ia-0'),
    `L4: livro.id "ia-0" duplicado ENTRE trilhas ⇒ invalido citando ia-0 (veio ${JSON.stringify(r)})`);
  process.env.COCKPIT_TRILHAS = anterior;
}

async function casoL5() {
  const anterior = process.env.COCKPIT_TRILHAS;

  process.env.COCKPIT_TRILHAS = catalogoEm({ versao: 1, trilhas: [{ id: 't1', titulo: 'T1', livros: [{ id: 'x1' }] }] });
  let r = await leituras.lerCatalogo();
  ok(r.ok === false && r.motivo === 'invalido', `L5: livro sem título ⇒ invalido (veio ${JSON.stringify(r)})`);

  process.env.COCKPIT_TRILHAS = catalogoEm({ versao: 1, trilhas: [{ titulo: 'T1', livros: [{ id: 'x1', titulo: 'X' }] }] });
  r = await leituras.lerCatalogo();
  ok(r.ok === false && r.motivo === 'invalido', `L5: trilha sem id ⇒ invalido (veio ${JSON.stringify(r)})`);

  process.env.COCKPIT_TRILHAS = catalogoEm({ versao: 1, trilhas: [{ id: 't1', titulo: 'T1', livros: [{ id: 'a b', titulo: 'X' }] }] });
  r = await leituras.lerCatalogo();
  ok(r.ok === false && r.motivo === 'invalido', `L5: livro.id "a b" (fora da regex) ⇒ invalido (veio ${JSON.stringify(r)})`);

  process.env.COCKPIT_TRILHAS = anterior;
}

async function casoL6() {
  const r = await leituras.lerCatalogo();
  ok(r.ok === true, `L6: fixture válida (veio ${JSON.stringify(r)})`);
  ok(r.trilhas.length === 2 && r.trilhas[0].id === 'ia' && r.trilhas[1].id === 'economia',
    'L6: 2 trilhas, ordem preservada (ia antes de economia)');
  const ia = r.trilhas[0];
  const ia0 = ia.livros.find((l) => l.id === 'ia-0');
  ok(Boolean(ia0) && !('isbn' in ia0), 'L6: ia-0 não ganha a chave isbn — whitelist descarta campo extra');
  ok(ia0.opcional === false, 'L6: ia-0.opcional é false por padrão (não está marcado na fixture)');
  const ia2 = ia.livros.find((l) => l.id === 'ia-2');
  ok(ia2.opcional === true, 'L6: ia-2.opcional === true');
  const ia1 = ia.livros.find((l) => l.id === 'ia-1');
  ok(ia1.na_estante === true, 'L6: ia-1.na_estante === true');
  const economia = r.trilhas[1];
  const eco0 = economia.livros.find((l) => l.id === 'eco-0');
  ok(eco0.gratis === true, 'L6: eco-0.gratis === true');
}

async function casoL7() {
  const anterior = process.env.COCKPIT_TRILHAS;
  process.env.COCKPIT_TRILHAS = catalogoEm({
    versao: 1,
    trilhas: [
      { id: 'v', titulo: 'V', livros: [{ id: 'v-0', titulo: 'V0', preco: 34 }] },
      { id: 'vazia', titulo: 'Vazia', livros: [] },
    ],
  });
  const r = await leituras.lerCatalogo();
  ok(r.ok === true, `L7: catálogo válido (veio ${JSON.stringify(r)})`);
  const v0 = r.trilhas[0].livros.find((l) => l.id === 'v-0');
  ok(Boolean(v0) && !('preco' in v0), 'L7: preco numérico (tipo errado) é descartado — livro fica sem preco');
  const e = await leituras.estado();
  const vazia = e.trilhas.find((t) => t.id === 'vazia');
  ok(Boolean(vazia) && vazia.total === 0 && vazia.feitos === 0 && vazia.proximo === null,
    `L7: trilha com livros:[] ⇒ total 0, feitos 0, proximo null (veio ${JSON.stringify(vazia)})`);
  process.env.COCKPIT_TRILHAS = anterior;
}

async function casoL8() {
  const e = await leituras.estado();
  const ia = e.trilhas.find((t) => t.id === 'ia');
  ok(ia.feitos === 0 && ia.total === 3 && ia.proximo === 'ia-0',
    `L8: estado inicial da fixture — ia: feitos 0, total 3, proximo ia-0 (veio ${JSON.stringify({ feitos: ia.feitos, total: ia.total, proximo: ia.proximo })})`);
  ok(e.trilhas.every((t) => t.livros.every((l) => l.terminado_em === null)),
    'L8: todo terminado_em é null no estado inicial');
}

async function casoL9() {
  const r = await leituras.marcar('ia-0', true);
  ok(r.livroId === 'ia-0' && typeof r.terminado_em === 'string'
      && !Number.isNaN(Date.parse(r.terminado_em)) && r.terminado_em.endsWith('Z'),
    `L9: marcar(ia-0, true) devolve terminado_em ISO (veio ${JSON.stringify(r)})`);
  const e = await leituras.estado();
  const ia = e.trilhas.find((t) => t.id === 'ia');
  ok(ia.feitos === 1 && ia.proximo === 'ia-1',
    `L9: estado ⇒ ia feitos 1, proximo ia-1 (veio feitos=${ia.feitos}, proximo=${ia.proximo})`);
  const disco = JSON.parse(fs.readFileSync(ARQ_LEITURAS, 'utf8'));
  ok(JSON.stringify(disco) === JSON.stringify({ 'ia-0': { terminado_em: r.terminado_em } }),
    `L9: o arquivo em disco é { "ia-0": { "terminado_em": <mesmo ISO> } } (veio ${JSON.stringify(disco)})`);
}

async function casoL10() {
  const antes = await leituras.marcar('ia-0', true);
  const depois = await leituras.marcar('ia-0', true);
  ok(antes.terminado_em === depois.terminado_em,
    `L10: marcar de novo um livro já terminado mantém a MESMA data — S3 (veio ${antes.terminado_em} / ${depois.terminado_em})`);
}

async function casoL11() {
  const r = await leituras.marcar('ia-0', false);
  ok(r.terminado_em === null, `L11: desmarcar devolve terminado_em null (veio ${JSON.stringify(r)})`);
  const disco = JSON.parse(fs.readFileSync(ARQ_LEITURAS, 'utf8'));
  ok(!('ia-0' in disco), 'L11: a chave ia-0 SOME do arquivo (desmarcar remove, não grava null)');
  const e = await leituras.estado();
  const ia = e.trilhas.find((t) => t.id === 'ia');
  ok(ia.proximo === 'ia-0', `L11: proximo volta a ser ia-0 (veio ${ia.proximo})`);
}

async function casoL12() {
  await leituras.marcar('eco-0', true);
  const modulo = requerEm(DIR_LEITURAS);   // MÓDULO NOVO, mesma pasta de disco
  const e = await modulo.estado();
  const economia = e.trilhas.find((t) => t.id === 'economia');
  const eco0 = economia.livros.find((l) => l.id === 'eco-0');
  ok(eco0.terminado_em !== null,
    `L12: persistência — módulo novo lê o que o anterior gravou (veio ${JSON.stringify(eco0)})`);
}

async function casoL13() {
  const atual = JSON.parse(fs.readFileSync(ARQ_LEITURAS, 'utf8'));
  atual['sumiu-0'] = { terminado_em: '2026-01-01T00:00:00.000Z' };   // id que NÃO existe no catálogo
  fs.writeFileSync(ARQ_LEITURAS, JSON.stringify(atual));
  await leituras.marcar('ia-1', true);
  const e = await leituras.estado();
  const todosIds = e.trilhas.flatMap((t) => t.livros.map((l) => l.id));
  ok(!todosIds.includes('sumiu-0'), 'L13: estado() não menciona o id órfão sumiu-0');
  const depois = JSON.parse(fs.readFileSync(ARQ_LEITURAS, 'utf8'));
  ok('sumiu-0' in depois,
    'L13: mas o arquivo AINDA TEM sumiu-0 depois do marcar — o mapa inteiro é regravado, ninguém filtra pelo catálogo');
}

async function casoL14() {
  ok((await codigoDe(leituras.marcar('a b', true))) === 400, 'L14: livroId "a b" (fora da regex) ⇒ codigo 400');
  ok((await codigoDe(leituras.marcar('ia-0', 'sim'))) === 400, 'L14: terminado não-booleano ⇒ codigo 400');
  ok((await codigoDe(leituras.marcar('nao-existe', true))) === 404, 'L14: livro fora do catálogo ⇒ codigo 404');

  const anterior = process.env.COCKPIT_TRILHAS;
  process.env.COCKPIT_TRILHAS = path.join(RAIZ, 'l14-nao-existe.json');
  ok((await codigoDe(leituras.marcar('ia-0', true))) === 409, 'L14: catálogo indisponível ⇒ codigo 409');
  process.env.COCKPIT_TRILHAS = anterior;
}

async function casoL15() {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'corrompido-'));
  const arq = path.join(dir, 'leituras.json');
  fs.writeFileSync(arq, '{lixo');   // lixo de propósito — progresso ilegível
  const modulo = requerEm(dir);
  const e = await modulo.estado();
  ok(e.progresso.ok === false, `L15: progresso corrompido ⇒ estado().progresso.ok === false (veio ${JSON.stringify(e.progresso)})`);
  ok(e.progresso.detalhe === 'JSON corrompido',
    `L15: o detalhe do GET é só a CAUSA — a tela põe o prefixo (veio ${JSON.stringify(e.progresso.detalhe)})`);
  ok((await codigoDe(modulo.marcar('ia-0', true))) === 500, 'L15: marcar() com progresso corrompido rejeita com codigo 500');
  ok(fs.readFileSync(arq, 'utf8') === '{lixo', 'L15: o arquivo continua BYTE A BYTE "{lixo" — marcar() recusou gravar (R9)');
}

async function casoL16() {
  const anterior = process.env.COCKPIT_TRILHAS;
  const caminho = path.join(RAIZ, 'l16.json');
  fs.writeFileSync(caminho, JSON.stringify({ versao: 1, trilhas: [{ id: 't1', titulo: 'T1', livros: [] }] }));
  process.env.COCKPIT_TRILHAS = caminho;
  let e = await leituras.estado();
  ok(e.trilhas.length === 1, `L16: 1 trilha antes de reescrever o catálogo (veio ${e.trilhas.length})`);
  fs.writeFileSync(caminho, JSON.stringify({
    versao: 1,
    trilhas: [{ id: 't1', titulo: 'T1', livros: [] }, { id: 't2', titulo: 'T2', livros: [] }],
  }));
  e = await leituras.estado();
  ok(e.trilhas.length === 2,
    `L16: 2 trilhas depois de reescrever — relido sem reiniciar, MESMO módulo (veio ${e.trilhas.length})`);
  process.env.COCKPIT_TRILHAS = anterior;
}

/**
 * L17 — o fato-chave da spec §10 (degrau 4), provado por EXECUÇÃO: nenhuma leitura ou escrita
 * de progresso toca um BYTE do catálogo. E, por fonte, as três chamadas que gravam em disco
 * (`writeFile`, `rename`, `mkdir`) só existem dentro da função `gravar` — se alguém um dia
 * mover uma delas para fora, este caso fica vermelho.
 */
async function casoL17() {
  const dirCat = path.join(RAIZ, 'cat-intocado');
  fs.mkdirSync(dirCat, { recursive: true });
  const caminhoCat = path.join(dirCat, 'trilhas.json');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'trilhas-teste.json'), caminhoCat);

  const bytesAntes = fs.readFileSync(caminhoCat);
  const mtimeAntes = fs.statSync(caminhoCat).mtimeMs;
  const listagemAntes = fs.readdirSync(dirCat).sort();

  const dirLeiturasL17 = fs.mkdtempSync(path.join(RAIZ, 'l17-leituras-'));
  const modulo = requerEm(dirLeiturasL17);
  const anterior = process.env.COCKPIT_TRILHAS;
  process.env.COCKPIT_TRILHAS = caminhoCat;

  await modulo.estado();
  await modulo.marcar('ia-0', true);
  await modulo.marcar('ia-0', false);
  await modulo.marcar('eco-0', true);

  process.env.COCKPIT_TRILHAS = anterior;

  const bytesDepois = fs.readFileSync(caminhoCat);
  const mtimeDepois = fs.statSync(caminhoCat).mtimeMs;
  const listagemDepois = fs.readdirSync(dirCat).sort();

  ok(Buffer.compare(bytesAntes, bytesDepois) === 0,
    'L17: o catálogo não mudou um byte sequer depois de estado() + 3 marcar()');
  ok(mtimeAntes === mtimeDepois, 'L17: e o mtime do catálogo não mudou');
  ok(JSON.stringify(listagemAntes) === JSON.stringify(listagemDepois),
    'L17: a pasta do catálogo não ganhou nem perdeu arquivo nenhum');

  // Por fonte: toda ocorrência de writeFile/rename/mkdir mora dentro de `gravar`.
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'lib', 'leituras.js'), 'utf8');
  const linhas = fonte.split('\n');
  const inicioGravar = linhas.findIndex((l) => l.startsWith('async function gravar'));
  ok(inicioGravar !== -1, 'L17: lib/leituras.js tem uma função de topo `gravar`');
  let fimGravar = linhas.length;
  for (let i = inicioGravar + 1; i < linhas.length; i += 1) {
    if (/^(async function |function |let |const )/.test(linhas[i])) { fimGravar = i; break; }
  }
  const fatia = linhas.slice(inicioGravar, fimGravar).join('\n');
  const contarEm = (texto, termo) => (texto.match(new RegExp(termo, 'g')) || []).length;
  for (const termo of ['writeFile\\(', 'rename\\(', 'mkdir\\(']) {
    const noFonte = contarEm(fonte, termo);
    const naFatia = contarEm(fatia, termo);
    ok(noFonte === naFatia,
      `L17: toda ocorrência de ${termo} está dentro de \`gravar\` (fonte ${noFonte}, dentro de gravar ${naFatia})`);
  }
}

async function casoL18() {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'l18-'));
  const arq = path.join(dir, 'leituras.json');
  // `ia-1.terminado_em: 7` não é string — entra como lixo de tipo, não lixo de JSON.
  fs.writeFileSync(arq, JSON.stringify({ 'ia-0': { terminado_em: 'banana' }, 'ia-1': { terminado_em: 7 } }));
  const modulo = requerEm(dir);
  const e = await modulo.estado();
  const ia = e.trilhas.find((t) => t.id === 'ia');
  const ia0 = ia.livros.find((l) => l.id === 'ia-0');
  const ia1 = ia.livros.find((l) => l.id === 'ia-1');
  ok(ia0.terminado_em === null && ia1.terminado_em === null,
    `L18: terminado_em inválido vira null na tela, não "Invalid Date" (veio ia-0=${ia0.terminado_em}, ia-1=${ia1.terminado_em})`);
  ok(e.progresso.ok === true, 'L18: progresso.ok continua true — lixo em UM campo não derruba o mapa inteiro');

  await modulo.marcar('ia-0', true);
  const depois = JSON.parse(fs.readFileSync(arq, 'utf8'));
  ok(typeof depois['ia-0'].terminado_em === 'string' && !Number.isNaN(Date.parse(depois['ia-0'].terminado_em)),
    'L18: marcar(ia-0) grava uma data ISO nova, substituindo o lixo daquele livro');
  ok(Boolean(depois['ia-1']) && depois['ia-1'].terminado_em === 7,
    `L18: a entrada de ia-1 continua no arquivo IGUAL — não é apagada (veio ${JSON.stringify(depois['ia-1'])})`);
}

// ─── L19-L33 — "lendo agora" e a regra nova de próximo (D61) ────────────────────────────────
//
// Cada caso usa uma pasta própria (`requerEm(fs.mkdtempSync(...))`) — nunca `DIR_LEITURAS`
// compartilhado, que os casos L9-L13 continuam usando. Catálogo próprio só quando o caso pede
// (via `catalogoEm` + troca/restauro de `COCKPIT_TRILHAS`); senão usa a FIXTURE padrão.

async function casoL19() {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'l19-'));
  const modulo = requerEm(dir);
  const arq = path.join(dir, 'leituras.json');
  const r = await modulo.marcarLendo('ia-1', true);
  ok(typeof r.lendo_desde === 'string' && !Number.isNaN(Date.parse(r.lendo_desde)) && r.lendo_desde.endsWith('Z'),
    `L19: marcarLendo(ia-1, true) devolve lendo_desde ISO (veio ${JSON.stringify(r)})`);
  const e = await modulo.estado();
  const ia1 = e.trilhas.find((t) => t.id === 'ia').livros.find((l) => l.id === 'ia-1');
  ok(ia1.lendo_desde === r.lendo_desde, `L19: estado() mostra ia-1.lendo_desde igual (veio ${ia1.lendo_desde})`);
  const disco = JSON.parse(fs.readFileSync(arq, 'utf8'));
  ok(JSON.stringify(disco) === JSON.stringify({ 'ia-1': { lendo_desde: r.lendo_desde } }),
    `L19: disco é { "ia-1": { "lendo_desde": <ISO> } } (veio ${JSON.stringify(disco)})`);
  return { modulo, arq };
}

async function casoL20({ modulo, arq }) {
  const r = await modulo.marcarLendo('ia-1', false);
  ok(r.lendo_desde === null, `L20: marcarLendo(ia-1, false) devolve lendo_desde null (veio ${JSON.stringify(r)})`);
  const disco = JSON.parse(fs.readFileSync(arq, 'utf8'));
  ok(!('ia-1' in disco), 'L20: a chave ia-1 some do disco');
}

async function casoL21() {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'l21-'));
  const modulo = requerEm(dir);
  const arq = path.join(dir, 'leituras.json');
  await modulo.marcarLendo('ia-0', true);
  await modulo.marcarLendo('ia-1', true);
  await modulo.marcarLendo('eco-1', true);
  const e = await modulo.estado();
  const todos = e.trilhas.flatMap((t) => t.livros);
  for (const id of ['ia-0', 'ia-1', 'eco-1']) {
    const l = todos.find((x) => x.id === id);
    ok(typeof l.lendo_desde === 'string', `L21: estado() mostra ${id}.lendo_desde (veio ${l.lendo_desde})`);
  }
  const disco = JSON.parse(fs.readFileSync(arq, 'utf8'));
  for (const id of ['ia-0', 'ia-1', 'eco-1']) {
    ok(typeof disco[id]?.lendo_desde === 'string', `L21: disco[${id}].lendo_desde é string (veio ${JSON.stringify(disco[id])})`);
  }
}

async function casoL22() {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'l22-'));
  const modulo = requerEm(dir);
  const arq = path.join(dir, 'leituras.json');
  await modulo.marcarLendo('ia-1', true);
  const r = await modulo.marcar('ia-1', true);
  ok(typeof r.terminado_em === 'string', `L22: marcar(ia-1, true) devolve terminado_em (veio ${JSON.stringify(r)})`);
  const disco = JSON.parse(fs.readFileSync(arq, 'utf8'));
  ok(JSON.stringify(disco['ia-1']) === JSON.stringify({ terminado_em: r.terminado_em }),
    `L22: disco ia-1 é { terminado_em } sem lendo_desde (veio ${JSON.stringify(disco['ia-1'])})`);
  const e = await modulo.estado();
  const ia1 = e.trilhas.find((t) => t.id === 'ia').livros.find((l) => l.id === 'ia-1');
  ok(ia1.lendo_desde === null, `L22: estado().lendo_desde é null (veio ${ia1.lendo_desde})`);
  return { modulo, arq };
}

async function casoL23({ modulo, arq }) {
  const r = await modulo.marcar('ia-1', false);
  ok(r.terminado_em === null, `L23: marcar(ia-1, false) devolve terminado_em null (veio ${JSON.stringify(r)})`);
  const disco = JSON.parse(fs.readFileSync(arq, 'utf8'));
  ok(!('ia-1' in disco), 'L23: a entrada ia-1 some do disco');
  const e = await modulo.estado();
  const ia1 = e.trilhas.find((t) => t.id === 'ia').livros.find((l) => l.id === 'ia-1');
  ok(ia1.lendo_desde === null && ia1.terminado_em === null,
    `L23: estado() mostra lendo_desde null e terminado_em null — não volta a lendo (veio ${JSON.stringify({ lendo: ia1.lendo_desde, term: ia1.terminado_em })})`);
}

async function casoL24() {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'l24-'));
  const modulo = requerEm(dir);
  const arq = path.join(dir, 'leituras.json');
  await modulo.marcar('ia-0', true);
  const bytesAntes = fs.readFileSync(arq);
  const codigo = await codigoDe(modulo.marcarLendo('ia-0', true));
  ok(codigo === 409, `L24: marcarLendo num terminado ⇒ 409 (veio ${codigo})`);
  const bytesDepois = fs.readFileSync(arq);
  ok(Buffer.compare(bytesAntes, bytesDepois) === 0, 'L24: o arquivo continua byte a byte igual');
}

async function casoL25() {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'l25-'));
  const arq = path.join(dir, 'leituras.json');
  fs.writeFileSync(arq, JSON.stringify({ 'ia-0': { terminado_em: '2026-10-01T10:00:00.000Z' } }));
  const modulo = requerEm(dir);
  const e = await modulo.estado();
  ok(e.progresso.ok === true, 'L25: progresso.ok true no arquivo antigo (sem lendo_desde)');
  const ia = e.trilhas.find((t) => t.id === 'ia');
  const ia0 = ia.livros.find((l) => l.id === 'ia-0');
  ok(ia0.terminado_em === '2026-10-01T10:00:00.000Z', `L25: ia-0 terminado (veio ${ia0.terminado_em})`);
  ok(e.trilhas.flatMap((t) => t.livros).every((l) => l.lendo_desde === null), 'L25: todo lendo_desde é null');
  ok(ia.feitos === 1, `L25: feitos da ia é 1 (veio ${ia.feitos})`);
}

async function casoL26() {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'l26-'));
  const arq = path.join(dir, 'leituras.json');
  fs.writeFileSync(arq, '{lixo');
  const modulo = requerEm(dir);
  const codigo = await codigoDe(modulo.marcarLendo('ia-0', true));
  ok(codigo === 500, `L26: marcarLendo com progresso ilegível ⇒ 500 (veio ${codigo})`);
  ok(fs.readFileSync(arq, 'utf8') === '{lixo', 'L26: o arquivo continua byte a byte "{lixo"');
}

async function casoL27() {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'l27-'));
  const modulo = requerEm(dir);
  const anterior = process.env.COCKPIT_TRILHAS;
  process.env.COCKPIT_TRILHAS = catalogoEm({
    versao: 1,
    trilhas: [{ id: 't', titulo: 'T', livros: [
      { id: 'a0', titulo: 'A0', opcional: true },
      { id: 'a1', titulo: 'A1' },
      { id: 'a2', titulo: 'A2' },
    ] }],
  });
  const e = await modulo.estado();
  const t = e.trilhas.find((x) => x.id === 't');
  ok(t.proximo === 'a1', `L27: proximo pula o opcional a0 (veio ${t.proximo})`);
  process.env.COCKPIT_TRILHAS = anterior;
}

async function casoL28() {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'l28-'));
  const modulo = requerEm(dir);
  const anterior = process.env.COCKPIT_TRILHAS;
  process.env.COCKPIT_TRILHAS = catalogoEm({
    versao: 1,
    trilhas: [{ id: 't', titulo: 'T', livros: [
      { id: 'a0', titulo: 'A0', opcional: true },
      { id: 'a1', titulo: 'A1' },
      { id: 'a2', titulo: 'A2' },
    ] }],
  });
  await modulo.marcar('a1', true);
  await modulo.marcar('a2', true);
  const e = await modulo.estado();
  const t = e.trilhas.find((x) => x.id === 't');
  ok(t.proximo === null, `L28: só opcional sobrando ⇒ proximo null (veio ${t.proximo})`);
  process.env.COCKPIT_TRILHAS = anterior;
}

async function casoL29() {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'l29-'));
  const modulo = requerEm(dir);
  await modulo.marcarLendo('ia-0', true);
  let e = await modulo.estado();
  let ia = e.trilhas.find((t) => t.id === 'ia');
  ok(ia.proximo === 'ia-1', `L29: ia-0 lendo ⇒ proximo ia-1 (veio ${ia.proximo})`);
  await modulo.marcarLendo('ia-1', true);
  e = await modulo.estado();
  ia = e.trilhas.find((t) => t.id === 'ia');
  ok(ia.proximo === null, `L29: ia-0 e ia-1 lendo ⇒ proximo null, ia-2 é opcional (veio ${ia.proximo})`);
}

async function casoL30() {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'l30-'));
  const modulo = requerEm(dir);
  const arq = path.join(dir, 'leituras.json');
  const r1 = await modulo.marcarLendo('ia-0', true);
  const mtime1 = fs.statSync(arq).mtimeMs;
  const r2 = await modulo.marcarLendo('ia-0', true);
  const mtime2 = fs.statSync(arq).mtimeMs;
  ok(r1.lendo_desde === r2.lendo_desde, `L30: marcarLendo 2× mantém o MESMO lendo_desde (veio ${r1.lendo_desde} / ${r2.lendo_desde})`);
  ok(mtime1 === mtime2, 'L30: e o mtime não muda (não regravou)');

  const dir2 = fs.mkdtempSync(path.join(RAIZ, 'l30b-'));
  const modulo2 = requerEm(dir2);
  const arq2 = path.join(dir2, 'leituras.json');
  const r3 = await modulo2.marcarLendo('ia-0', false);
  ok(r3.lendo_desde === null, `L30: desmarcar sem estar lendo ⇒ 200 lendo_desde null (veio ${JSON.stringify(r3)})`);
  ok(!fs.existsSync(arq2), 'L30: e o arquivo não foi criado');

  ok((await codigoDe(modulo.marcarLendo('a b', true))) === 400, 'L30: livroId "a b" (fora da regex) ⇒ 400');
  ok((await codigoDe(modulo.marcarLendo('ia-0', 'sim'))) === 400, 'L30: lendo não-booleano ⇒ 400');
  ok((await codigoDe(modulo.marcarLendo('nao-existe', true))) === 404, 'L30: livro fora do catálogo ⇒ 404');

  const anterior = process.env.COCKPIT_TRILHAS;
  process.env.COCKPIT_TRILHAS = path.join(RAIZ, 'l30-nao-existe.json');
  ok((await codigoDe(modulo.marcarLendo('ia-0', true))) === 409, 'L30: catálogo indisponível ⇒ 409');
  process.env.COCKPIT_TRILHAS = anterior;
}

async function casoL31() {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'l31-'));
  const arq = path.join(dir, 'leituras.json');
  fs.writeFileSync(arq, JSON.stringify({ 'ia-0': { lendo_desde: 7 }, 'ia-1': { lendo_desde: 'banana' } }));
  const modulo = requerEm(dir);
  const e = await modulo.estado();
  ok(e.progresso.ok === true, 'L31: progresso.ok true com lixo de tipo em lendo_desde');
  const ia = e.trilhas.find((t) => t.id === 'ia');
  ok(ia.livros.find((l) => l.id === 'ia-0').lendo_desde === null
      && ia.livros.find((l) => l.id === 'ia-1').lendo_desde === null,
    'L31: os dois lendo_desde são null na tela');
  await modulo.marcarLendo('ia-0', true);
  const depois = JSON.parse(fs.readFileSync(arq, 'utf8'));
  ok(typeof depois['ia-0'].lendo_desde === 'string' && !Number.isNaN(Date.parse(depois['ia-0'].lendo_desde)),
    `L31: marcarLendo(ia-0) grava ISO novo (veio ${JSON.stringify(depois['ia-0'])})`);
  ok(depois['ia-1'].lendo_desde === 'banana',
    `L31: ia-1 continua "banana" no disco (veio ${JSON.stringify(depois['ia-1'])})`);
}

async function casoL32() {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'l32-'));
  const arq = path.join(dir, 'leituras.json');
  const iso = '2026-10-03T12:00:00.000Z';
  fs.writeFileSync(arq, JSON.stringify({ 'ia-1': { lendo_desde: iso } }));
  const modulo = requerEm(dir);
  const bytesAntes = fs.readFileSync(arq);
  const mtimeAntes = fs.statSync(arq).mtimeMs;
  const r = await modulo.marcar('ia-1', false);
  ok(r.terminado_em === null, `L32: marcar(ia-1, false) (desmarcar atrasado) devolve terminado_em null (veio ${JSON.stringify(r)})`);
  const bytesDepois = fs.readFileSync(arq);
  const mtimeDepois = fs.statSync(arq).mtimeMs;
  ok(Buffer.compare(bytesAntes, bytesDepois) === 0, 'L32: o disco continua igual — lendo_desde preservado');
  ok(mtimeAntes === mtimeDepois, 'L32: e o mtime não muda (não regravou)');
}

async function casoL33() {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'l33-'));
  const arq = path.join(dir, 'leituras.json');
  fs.writeFileSync(arq, JSON.stringify({
    'ia-0': { terminado_em: '2026-09-01T00:00:00.000Z', lendo_desde: '2026-09-02T00:00:00.000Z' },
  }));
  const modulo = requerEm(dir);
  await modulo.marcar('ia-0', true);
  const disco = JSON.parse(fs.readFileSync(arq, 'utf8'));
  ok(JSON.stringify(disco['ia-0']) === JSON.stringify({ terminado_em: '2026-09-01T00:00:00.000Z' }),
    `L33: disco ia-0 é { terminado_em } com a data original (veio ${JSON.stringify(disco['ia-0'])})`);
  const e = await modulo.estado();
  const ia0 = e.trilhas.find((t) => t.id === 'ia').livros.find((l) => l.id === 'ia-0');
  ok(ia0.terminado_em === '2026-09-01T00:00:00.000Z' && ia0.lendo_desde === null,
    `L33: estado() mostra terminado e lendo_desde null (veio ${JSON.stringify({ term: ia0.terminado_em, lendo: ia0.lendo_desde })})`);
}

async function casoL34() {
  // Padrão do catálogo sem COCKPIT_TRILHAS: <HOME>/.cockpit/trilhas.json, e NÃO a pasta de leituras (D78).
  const guardado = { trilhas: process.env.COCKPIT_TRILHAS, home: process.env.HOME, dir: process.env.COCKPIT_LEITURAS_DIR };
  const homeFalso = fs.mkdtempSync(path.join(RAIZ, 'l34-home-'));
  const outroDir = fs.mkdtempSync(path.join(RAIZ, 'l34-dir-'));
  try {
    delete process.env.COCKPIT_TRILHAS;
    process.env.HOME = homeFalso;
    const esperado = path.join(homeFalso, '.cockpit', 'trilhas.json');
    ok(leituras.caminhoCatalogo() === esperado, `L34: sem COCKPIT_TRILHAS, o catálogo é <HOME>/.cockpit/trilhas.json (veio ${leituras.caminhoCatalogo()})`);
    process.env.COCKPIT_LEITURAS_DIR = outroDir;
    ok(leituras.caminhoCatalogo() === esperado, 'L34: com COCKPIT_LEITURAS_DIR definida, o catálogo NÃO segue a pasta do progresso');
  } finally {
    for (const [k, v] of [['COCKPIT_TRILHAS', guardado.trilhas], ['HOME', guardado.home], ['COCKPIT_LEITURAS_DIR', guardado.dir]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ─── R1-R10 — as rotas, contra `server.js` DE VERDADE, em processo FILHO ────────────────────
//
// Nunca `require('server.js')` — subiria na porta de produção. Molde `gate-lidas.js:70-145`.

// Porta ESCOLHIDA na faixa alta, nunca chumbada — nunca 7879 (produção), 7899 (jobs) nem 7897
// (instância de teste do celular). Fail-closed: faixa inteira ocupada aborta sem subir nada.
function portaLivre(porta) {
  try {
    const saida = execFileSync('ss', ['-H', '-lptn'], { encoding: 'utf8' });
    return !saida.split('\n').some((linha) => (linha.trim().split(/\s+/)[3] || '').endsWith(`:${porta}`));
  } catch {
    return true;
  }
}
// SÓ da lista permitida — nunca `process.env.PORT`: um PORT=7879 herdado do shell subiria o
// filho na porta de produção (painel de execução, Codex).
const PORTA = [7893, 7892, 7891, 7894, 7895, 7898].find(portaLivre);
const PORTA2 = [7893, 7892, 7891, 7894, 7895, 7898].filter((p) => p !== PORTA).find(portaLivre);
const TOKEN = 'gate-leituras-token';

const RAIZ_ROTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-leituras-rotas-'));
const DIR_LEITURAS_ROTA = path.join(RAIZ_ROTAS, 'leituras-rota');
const CERT_DIR_VAZIO = path.join(RAIZ_ROTAS, 'cert-vazio');
fs.mkdirSync(CERT_DIR_VAZIO, { recursive: true });
const ARQ_LEITURAS_ROTA = path.join(DIR_LEITURAS_ROTA, 'leituras.json');

let filho = null;
let filho2 = null;

/** O ambiente sem nenhuma variável `COCKPIT_*` (molde `bin/testes.js:11`). */
function semCockpit(ambiente) {
  const limpo = { ...ambiente };
  for (const k of Object.keys(limpo)) if (k.startsWith('COCKPIT_')) delete limpo[k];
  return limpo;
}

function subirServidor({ porta, trilhas, dirLeituras }) {
  return new Promise((resolve, reject) => {
    const processo = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: path.join(__dirname, '..'),
      env: {
        // Lista FECHADA (#78): nada de `COCKPIT_*` herdado do shell — `COCKPIT_USO_DIR` e os
        // irmãos vencem o HOME falso e apontariam o filho para o disco de produção.
        ...semCockpit(process.env),
        PORT: String(porta), HOST: '127.0.0.1', COCKPIT_CERT_DIR: CERT_DIR_VAZIO,
        COCKPIT_TOKEN: TOKEN, COCKPIT_JOBS_DIR: path.join(RAIZ_ROTAS, 'jobs-inexistente'),
        COCKPIT_LIDAS_DIR: path.join(RAIZ_ROTAS, 'lidas'),
        COCKPIT_LEITURAS_DIR: dirLeituras, COCKPIT_TRILHAS: trilhas,
        // Socket que não existe: sem isto `COCKPIT_TMUX_SOCKET` cai no default (''), que É o
        // tmux de verdade de quem roda o gate.
        COCKPIT_TMUX_SOCKET: `gate-leituras-${process.pid}-${porta}`,
        COCKPIT_VIGIA_MS: '0', HOME: path.join(RAIZ_ROTAS, 'home'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let saiu = false;
    processo.once('exit', (codigo) => {
      if (!saiu) reject(new Error(`server.js caiu antes de subir (código ${codigo})`));
    });
    processo.stdout.on('data', (d) => {
      if (!saiu && String(d).includes('cockpit-agentes em')) { saiu = true; resolve(processo); }
    });
    processo.stderr.on('data', (d) => process.stderr.write(`[server.js:${porta}] ${d}`));
    setTimeout(() => { if (!saiu) { saiu = true; resolve(processo); } }, 2500);
  });
}

function derrubar(processo) {
  if (processo && !processo.killed) processo.kill('SIGTERM'); // pelo PID — nunca pkill (#19)
}

/** Manda `corpoTexto` CRU no corpo — é o que deixa mandar JSON deliberadamente inválido. */
function pedirBruto(porta, metodo, rota, corpoTexto, { semToken = false } = {}) {
  return new Promise((resolve, reject) => {
    const cabecalhos = {};
    if (!semToken) cabecalhos.authorization = `Bearer ${TOKEN}`;
    if (corpoTexto !== undefined) cabecalhos['content-type'] = 'application/json';
    const req = http.request(
      { host: '127.0.0.1', port: porta, path: rota, method: metodo, headers: cabecalhos },
      (res) => {
        let bruto = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { bruto += c; });
        res.on('end', () => {
          let corpo = null;
          try { corpo = bruto ? JSON.parse(bruto) : null; } catch { /* resposta não-JSON */ }
          resolve({ status: res.statusCode, corpo });
        });
      },
    );
    req.on('error', reject);
    if (corpoTexto !== undefined) req.write(corpoTexto);
    req.end();
  });
}

const pedir = (porta, metodo, rota, { corpo, semToken } = {}) =>
  pedirBruto(porta, metodo, rota, corpo === undefined ? undefined : JSON.stringify(corpo), { semToken });

async function casoR1() {
  const r = await pedir(PORTA, 'GET', '/api/leituras', { semToken: true });
  ok(r.status === 401, `R1: GET sem token ⇒ 401 (veio ${r.status})`);
}

async function casoR2() {
  const r = await pedir(PORTA, 'GET', '/api/leituras');
  ok(r.status === 200, `R2: GET com token ⇒ 200 (veio ${r.status})`);
  ok(r.corpo?.catalogo?.ok === true, `R2: catalogo.ok === true (veio ${JSON.stringify(r.corpo?.catalogo)})`);
  ok(Array.isArray(r.corpo?.trilhas) && r.corpo.trilhas.length === 2,
    `R2: 2 trilhas (veio ${r.corpo?.trilhas?.length})`);
  ok(r.corpo.trilhas[0].proximo === 'ia-0', `R2: trilhas[0].proximo === 'ia-0' (veio ${r.corpo.trilhas[0].proximo})`);
  const todosOsLivros = r.corpo.trilhas.flatMap((t) => t.livros);
  ok(todosOsLivros.every((l) => !('isbn' in l)), 'R2: nenhum livro tem a chave isbn (whitelist aplicada na rota)');
}

async function casoR3() {
  await pedir(PORTA, 'GET', '/api/leituras');
  await pedir(PORTA, 'GET', '/api/leituras');
  ok(!fs.existsSync(ARQ_LEITURAS_ROTA), 'R3: GET não grava nada — leituras.json não existe depois de 2 GETs');
}

async function casoR4() {
  const r = await pedir(PORTA, 'POST', '/api/leituras', { corpo: { livroId: 'ia-0', terminado: true } });
  ok(r.status === 200 && typeof r.corpo?.terminado_em === 'string',
    `R4: POST marcar ia-0 ⇒ 200, terminado_em ISO (veio ${JSON.stringify(r.corpo)})`);
  const g = await pedir(PORTA, 'GET', '/api/leituras');
  const ia = g.corpo.trilhas.find((t) => t.id === 'ia');
  ok(ia.feitos === 1 && ia.proximo === 'ia-1',
    `R4: GET seguinte ⇒ ia feitos 1, proximo ia-1 (veio feitos=${ia.feitos}, proximo=${ia.proximo})`);
}

async function casoR5() {
  const r = await pedir(PORTA, 'POST', '/api/leituras', { corpo: { livroId: 'ia-0', terminado: false } });
  ok(r.status === 200 && r.corpo?.terminado_em === null,
    `R5: POST desmarcar ia-0 ⇒ 200, terminado_em null (veio ${JSON.stringify(r.corpo)})`);
  const disco = JSON.parse(fs.readFileSync(ARQ_LEITURAS_ROTA, 'utf8'));
  ok(!('ia-0' in disco), 'R5: a chave ia-0 some do arquivo');
}

async function casoR6() {
  const r1 = await pedirBruto(PORTA, 'POST', '/api/leituras', '{nao json');
  ok(r1.status === 400, `R6: corpo não-JSON ⇒ 400 (veio ${r1.status})`);
  const r2 = await pedirBruto(PORTA, 'POST', '/api/leituras', 'null');
  ok(r2.status === 400, `R6: corpo "null" ⇒ 400 (veio ${r2.status})`);
  const r3 = await pedir(PORTA, 'POST', '/api/leituras', { corpo: { livroId: 'ia-0', terminado: 'sim' } });
  ok(r3.status === 400, `R6: terminado não-booleano ⇒ 400 (veio ${r3.status})`);
}

async function casoR7() {
  const r = await pedir(PORTA, 'POST', '/api/leituras', { corpo: { livroId: 'nao-existe', terminado: true } });
  ok(r.status === 404, `R7: livroId fora do catálogo ⇒ 404 (veio ${r.status})`);
}

async function casoR8() {
  const g = await pedir(PORTA2, 'GET', '/api/leituras');
  ok(g.status === 200 && g.corpo?.catalogo?.ok === false && g.corpo?.catalogo?.motivo === 'ausente',
    `R8: 2º servidor (catálogo ausente) — GET ⇒ 200, catalogo.ok false, motivo ausente (veio ${JSON.stringify(g.corpo?.catalogo)})`);
  ok(g.corpo?.catalogo?.caminho === path.join(RAIZ_ROTAS, 'nao-existe.json'),
    `R8: e o caminho é o mesmo que foi passado (veio ${g.corpo?.catalogo?.caminho})`);
  const p = await pedir(PORTA2, 'POST', '/api/leituras', { corpo: { livroId: 'ia-0', terminado: true } });
  ok(p.status === 409, `R8: POST no 2º servidor ⇒ 409 (veio ${p.status})`);
}

async function casoR9() {
  const r = await pedir(PORTA, 'PUT', '/api/leituras');
  ok(r.status !== 200, `R9: PUT /api/leituras não é 200 (veio ${r.status})`);
}

async function casoR11() {
  const p1 = await pedir(PORTA, 'POST', '/api/leituras', { corpo: { livroId: 'eco-1', lendo: true } });
  ok(p1.status === 200 && typeof p1.corpo?.lendo_desde === 'string',
    `R11: POST lendo:true ⇒ 200 com lendo_desde ISO (veio ${JSON.stringify(p1.corpo)})`);
  const g1 = await pedir(PORTA, 'GET', '/api/leituras');
  const economia1 = g1.corpo.trilhas.find((t) => t.id === 'economia');
  const eco1 = economia1.livros.find((l) => l.id === 'eco-1');
  ok(eco1.lendo_desde === p1.corpo.lendo_desde, `R11: GET mostra eco-1.lendo_desde igual (veio ${eco1.lendo_desde})`);
  ok(economia1.proximo === 'eco-0', `R11: economia.proximo === 'eco-0' (veio ${economia1.proximo})`);

  const p2 = await pedir(PORTA, 'POST', '/api/leituras', { corpo: { livroId: 'eco-1', lendo: false } });
  ok(p2.status === 200 && p2.corpo?.lendo_desde === null, `R11: POST lendo:false ⇒ 200 lendo_desde null (veio ${JSON.stringify(p2.corpo)})`);
  const g2 = await pedir(PORTA, 'GET', '/api/leituras');
  const eco1depois = g2.corpo.trilhas.find((t) => t.id === 'economia').livros.find((l) => l.id === 'eco-1');
  ok(eco1depois.lendo_desde === null, `R11: GET depois mostra eco-1.lendo_desde null (veio ${eco1depois.lendo_desde})`);
}

async function casoR12() {
  const r = await pedir(PORTA, 'POST', '/api/leituras', { corpo: { livroId: 'eco-1', terminado: true, lendo: true } });
  ok(r.status === 400, `R12: POST com terminado E lendo ⇒ 400 (veio ${r.status})`);
  const disco = fs.existsSync(ARQ_LEITURAS_ROTA) ? JSON.parse(fs.readFileSync(ARQ_LEITURAS_ROTA, 'utf8')) : {};
  ok(!('eco-1' in disco), 'R12: o disco não ganhou eco-1');
}

async function casoR13() {
  await pedir(PORTA, 'POST', '/api/leituras', { corpo: { livroId: 'eco-0', terminado: true } });
  const r = await pedir(PORTA, 'POST', '/api/leituras', { corpo: { livroId: 'eco-0', lendo: true } });
  ok(r.status === 409, `R13: POST lendo num terminado ⇒ 409 (veio ${r.status})`);
  await pedir(PORTA, 'POST', '/api/leituras', { corpo: { livroId: 'eco-0', terminado: false } });   // deixa o estado como achou
}

/**
 * R10 — a rede durável (molde do caso 14 de `gate-lidas.js:301-332`, §5.4/§10 da spec). Todo
 * arquivo de `testes/` que cita `api/leituras` aponta `COCKPIT_LEITURAS_DIR` — senão um teste
 * novo escreve progresso de leitura no `~/.cockpit/leituras.json` DE PRODUÇÃO sem ninguém ver.
 */
function casoR10() {
  const dir = __dirname;
  const excecoes = new Map([
    ['gate-ui.js', 'cita `api/leituras` só no `aoBuscar` de mentira, DOM falso; nunca sobe processo nem toca disco'],
    ['print-lista-conversas.mjs', 'cita `/api/leituras` só no servidor http DE MENTIRA dele (responde trilhas vazias); nunca sobe server.js nem toca disco'],
    ['print-pesquisar-pasta.mjs', 'cita `/api/leituras` só no servidor http DE MENTIRA dele (responde trilhas vazias); nunca sobe server.js nem toca disco'],
  ]);
  const faltando = [];
  for (const nome of fs.readdirSync(dir).filter((n) => /\.(js|mjs|py)$/.test(n)).sort()) {
    if (excecoes.has(nome)) continue;
    const fonte = fs.readFileSync(path.join(dir, nome), 'utf8');
    if (!fonte.includes('api/leituras')) continue;
    if (!fonte.includes('COCKPIT_LEITURAS_DIR')) faltando.push(nome);
  }
  ok(faltando.length === 0,
    `R10: todo teste que cita api/leituras aponta COCKPIT_LEITURAS_DIR${faltando.length ? ` — faltam: ${faltando.join(', ')}` : ''}`);
}

async function principal() {
  try {
    await casoL1();
    await casoL2();
    await casoL3();
    await casoL4();
    await casoL5();
    await casoL6();
    await casoL7();
    await casoL8();
    await casoL9();
    await casoL10();
    await casoL11();
    await casoL12();
    await casoL13();
    await casoL14();
    await casoL15();
    await casoL16();
    await casoL17();
    await casoL18();
    const l19 = await casoL19();
    await casoL20(l19);
    await casoL21();
    const l22 = await casoL22();
    await casoL23(l22);
    await casoL24();
    await casoL25();
    await casoL26();
    await casoL27();
    await casoL28();
    await casoL29();
    await casoL30();
    await casoL31();
    await casoL32();
    await casoL33();
    await casoL34();

    if (!PORTA || !PORTA2) {
      console.error('🔴 nenhuma porta livre na faixa — abortando sem subir servidor.');
      falhas += 1;
    } else {
      filho = await subirServidor({ porta: PORTA, trilhas: FIXTURE, dirLeituras: DIR_LEITURAS_ROTA });
      filho2 = await subirServidor({ porta: PORTA2, trilhas: path.join(RAIZ_ROTAS, 'nao-existe.json'), dirLeituras: path.join(RAIZ_ROTAS, 'leituras-rota-2') });
      await casoR1();
      await casoR2();
      await casoR3();
      await casoR4();
      await casoR5();
      await casoR6();
      await casoR7();
      await casoR8();
      await casoR9();
      await casoR11();
      await casoR12();
      await casoR13();
      casoR10();
    }
  } finally {
    derrubar(filho);
    derrubar(filho2);
    fs.rmSync(RAIZ, { recursive: true, force: true });
    fs.rmSync(RAIZ_ROTAS, { recursive: true, force: true });
  }
  console.log(`\n${falhas === 0 ? '✅ GATE VERDE' : `❌ GATE VERMELHO (${falhas} falha(s))`} — lib/leituras.js + /api/leituras\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

principal().catch((e) => {
  console.error('🔴 o gate estourou —', e);
  process.exit(1);
});
