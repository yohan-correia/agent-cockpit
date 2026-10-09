#!/usr/bin/env node
'use strict';
// GATE DAS REGRAS DA PERGUNTA EM CARTÃO — `lib/pergunta.js` (spec 2026-10-08-pergunta-do-agente-em-cartao).
//
// O cartão manda TECLAS para a TUI de um agente. O erro que importa não é "o cartão não apareceu"
// (isso cai no terminal cru, como hoje): é uma tecla sair no menu errado. Por isso este gate prova,
// em ordem: que a TUI falsa desenha igual às telas MEDIDAS (P-arreio); que o arquivo do hook só vira
// pergunta pendente quando todas as cercas V1-V6 fecham (P-pendente); a regra de resposta × recusa
// (P-situacao); a validação do corpo (P-corpo/P-respostas); o plano de teclas exato (P-plano); a
// conferência contra as telas medidas (P-tela); e `executar` contra a TUI falsa (P-executar): para no
// primeiro passo não conferido, nunca manda a tecla seguinte, nunca manda Escape/Up/Left/Right.
//
// Cada grupo isola o estouro dele (`grupo()`): a função que ainda não existe derruba SÓ o grupo, e é
// a saída por grupo que prova que cada asserção nasceu vermelha.
//
// P-integrado: `lib/abas.js` em processo, com tmux REAL num socket de teste (a pane mostra uma tela medida) —
// prova que `tela()` só devolve `cartao` quando a pergunta pendente E a conferência de início valem.
// P-rota: a rota POST /api/abas/:chave/pergunta por HTTP (servidor filho via `subirServidor`, porta 7958).
//
// Uso:  node testes/gate-pergunta.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const fx = require('./fixtures-arquivos');
const { criarTui } = require('./tui-pergunta-falsa');

let acertos = 0;
let falhas = 0;
const ok = (c, t) => {
  const bom = Boolean(c);
  console.log(`  ${bom ? '✅' : '❌'} ${t}`);
  if (bom) acertos++; else falhas++;
  return bom;
};
async function grupo(rotulo, fn) {
  console.log(rotulo);
  try {
    await fn();
  } catch (e) {
    ok(false, `${rotulo}: o grupo estourou — ${e.message}`);
  }
}

let pergunta = null;
try { pergunta = require('../lib/pergunta'); } catch (e) { ok(false, `lib/pergunta.js não carregou — ${e.message}`); }

const DIR_FIX = path.join(__dirname, 'fixtures', 'pergunta');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-offline-pergunta-'));
const GANCHO = path.join(__dirname, '..', 'bin', 'gancho-pergunta.js');
let contador = 0;
const pasta = () => { const p = path.join(TEMP, `m${contador++}`); fs.mkdirSync(p, { recursive: true }); return p; };

const tela = (nome) => fs.readFileSync(path.join(DIR_FIX, 'telas', `${nome}.txt`), 'utf8');
const gancho = (nome) => JSON.parse(fs.readFileSync(path.join(DIR_FIX, 'ganchos', `${nome}.json`), 'utf8'));
/** As perguntas do payload no formato do cartão (o que o lib/pergunta.js entrega ao cliente). */
const doPayload = (nome) => gancho(nome).tool_input.questions.map((q) => ({
  texto: q.question,
  cabecalho: q.header,
  multipla: q.multiSelect,
  opcoes: q.options.map((o) => ({ rotulo: o.label, descricao: o.description })),
}));

const CC = (n) => String.fromCharCode(n);

// Respostas das baterias medidas.
const RESP = {
  a: [{ opcoes: [1], texto: '' }],
  b: [{ opcoes: [0], texto: 'texto um 7' }, { opcoes: [], texto: 'texto dois, com "aspas"' }, { opcoes: [1], texto: '' }],
  c: [{ opcoes: [2], texto: '' }],
  e: [{ opcoes: [1], texto: '' }, { opcoes: [0], texto: '' }, { opcoes: [0], texto: '' }, { opcoes: [], texto: 'pera madura, bem doce' }],
};
const TECLAS_MEDIDAS = {
  a: ['2'],
  b: ['1', 'Down', 'Down', 'Down', '«texto um 7»', 'Down', 'Enter', 'Down', 'Down', '«texto dois, com "aspas"»', 'Enter', '2', 'Enter'],
  c: ['3', 'Down', 'Down', 'Down', 'Down', 'Enter', 'Enter'],
  e: ['2', '1', 'Down', 'Down', 'Down', 'Down', 'Enter', '1', 'Down', 'Down', '«pera madura, bem doce»', 'Enter', 'Enter'],
};
const emTeclas = (plano) => plano.map((p) => (p.tipo === 'texto' ? `«${p.valor}»` : p.valor));

const lancaCom = async (fn, codigo) => {
  try { await fn(); } catch (e) { return e.codigo === codigo; }
  return false;
};

// ---- P-arreio -----------------------------------------------------------------------------------

/** Da âncora (barra de abas) até "Chat about this" — ou até a última linha, na revisão. */
function regiao(texto) {
  const L = texto.split('\n').map((l) => l.trimEnd());
  let a = -1;
  L.forEach((l, i) => { if (l.startsWith('←') || /^ ☐ /.test(l)) a = i; });
  if (a < 0) return null;
  let f = L.findIndex((l, i) => i > a && /Chat about this/.test(l));
  if (f < 0) { f = L.length - 1; while (f > a && !L[f].trim()) f--; }
  return L.slice(a, f + 1);
}

async function pArreio() {
  const confere = (rotulo, tui, fixture) => {
    const a = regiao(tui.tela());
    const b = regiao(tela(fixture));
    const igual = a && b && JSON.stringify(a) === JSON.stringify(b);
    let onde = '';
    if (!igual && a && b) {
      const i = Array.from({ length: Math.max(a.length, b.length) }, (_, k) => k).find((k) => a[k] !== b[k]);
      onde = ` — linha ${i}: falsa ${JSON.stringify(a[i])} × medida ${JSON.stringify(b[i])}`;
    }
    ok(igual, `${rotulo}: a TUI falsa desenha igual à tela medida ${fixture}${onde}`);
  };
  const dar = (tui, ...passos) => passos.forEach((p) => (p.startsWith('«') ? tui.texto(p.slice(1, -1)) : tui.tecla(p)));

  let t = criarTui(doPayload('a-pre'));
  confere('a', t, 'a1-unica-aberta');
  t.tecla('2');
  ok(t.estado.respondida, 'a: o dígito responde na hora (a2)');

  t = criarTui(doPayload('b-pre'));
  confere('b', t, 'b1-tres-aberta');
  dar(t, '1'); confere('b', t, 'b2-multi-1');
  dar(t, 'Down', 'Down', 'Down'); confere('b', t, 'b3-cursor-type');
  dar(t, '«texto um 7»'); confere('b', t, 'b4-texto-sem-marcar');
  dar(t, 'Down'); confere('b', t, 'b5-cursor-next');
  dar(t, 'Enter'); confere('b', t, 'b6-aba-2');
  dar(t, 'Down', 'Down'); confere('b', t, 'b7-cursor-type-simples');
  dar(t, '«texto dois, com "aspas"»'); confere('b', t, 'b8-texto-simples');
  dar(t, 'Enter'); confere('b', t, 'b9-aba-3');
  dar(t, '2'); confere('b', t, 'b10-revisao');
  dar(t, 'Enter');
  ok(t.estado.respondida && JSON.stringify(t.estado.respostas) === JSON.stringify(RESP.b), 'b: o Enter em Submit answers grava as respostas esperadas (b11)');

  t = criarTui(doPayload('c-pre'));
  confere('c', t, 'c1-multi-unica');
  dar(t, '3'); confere('c', t, 'c2-multi-unica-3');
  dar(t, 'Down', 'Down', 'Down', 'Down'); confere('c', t, 'c3-cursor-submit');
  dar(t, 'Enter'); confere('c', t, 'c4-revisao-unica');

  t = criarTui(doPayload('e-pre'), { barraNaPergunta: true });
  confere('e', t, 'e1-longa-aberta');
  dar(t, '2'); confere('e', t, 'e2-longa-aba2');
  dar(t, '1', 'Down', 'Down', 'Down', 'Down'); confere('e', t, 'e3-multi-next');
  dar(t, 'Enter'); confere('e', t, 'e4-aba3');
  dar(t, '1'); confere('e', t, 'e5-aba4');
  dar(t, 'Down', 'Down', '«pera madura, bem doce»'); confere('e', t, 'e6-ultima-texto');
  dar(t, 'Enter'); confere('e', t, 'e7-revisao-longa');

  t = criarTui(doPayload('01-pre'), { barraNaPergunta: true });
  confere('01', t, 'm1-01-pergunta-aberta');

  // Texto com o cursor fora do campo some calado; dígito dentro do campo vira texto (medido).
  t = criarTui(doPayload('b-pre'));
  t.texto('perdido');
  ok(!t.tela().includes('perdido'), 'texto com o cursor fora da linha "Type something" é descartado');
  dar(t, 'Down', 'Down', 'Down', '7');
  ok(t.tela().includes('[✔] 7'), 'dígito dentro do campo vira texto');
}

// ---- P-pendente ---------------------------------------------------------------------------------

/** Grava o arquivo do hook RODANDO o próprio bin/gancho-pergunta.js (é o mesmo que produção lê). */
function mundoComHook(payloadNome = 'b-pre', { antes } = {}) {
  const base = pasta();
  const dir = path.join(base, 'perguntas');
  const jsonl = path.join(base, 'conversa.jsonl');
  fs.writeFileSync(jsonl, antes || '{"type":"user"}\n{"type":"assistant"}\n');
  const p = { ...gancho(payloadNome), transcript_path: jsonl };
  const r = spawnSync(process.execPath, [GANCHO], { input: JSON.stringify(p), env: { PATH: process.env.PATH, HOME: base, COCKPIT_PERGUNTAS_DIR: dir }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('o hook não rodou');
  const arquivo = path.join(dir, `${p.session_id}.json`);
  const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  return { base, dir, jsonl, arquivo, dados, sessaoId: p.session_id, statusDesde: dados.em + 30 };
}
const ler = (m, extra = {}) => pergunta.lerPendente({ dir: m.dir, sessaoId: m.sessaoId, arquivo: m.jsonl, statusDesde: m.statusDesde, ...extra });
const regravar = (m, mut) => { const d = JSON.parse(fs.readFileSync(m.arquivo, 'utf8')); mut(d); fs.writeFileSync(m.arquivo, JSON.stringify(d)); };

async function pPendente() {
  let m = mundoComHook();
  const base = ler(m);
  ok(base && base.toolUseId === m.dados.toolUseId && base.perguntas.length === 3 && base.offset === m.dados.offset, 'ok: pergunta pendente com toolUseId, 3 perguntas e offset');
  ok(base && JSON.stringify(base.perguntas) === JSON.stringify(doPayload('b-pre')), 'ok: perguntas no formato do cartão (texto, cabecalho, multipla, opcoes[rotulo, descricao])');

  ok(ler(m, { sessaoId: '00000000-0000-4000-8000-000000000000' }) === null, 'null: sessão sem arquivo');
  ok(ler(m, { sessaoId: '../../x' }) === null, 'null: sessaoId que não é UUID');
  fs.unlinkSync(m.arquivo);
  ok(ler(m) === null, 'null: arquivo do hook ausente');
  fs.writeFileSync(m.arquivo, '{nao json');
  ok(ler(m) === null, 'null: JSON inválido');

  const variantes = [
    ['versao ≠ 1', (d) => { d.versao = 2; }],
    ['sessionId do arquivo ≠ o da aba', (d) => { d.sessionId = '00000000-0000-4000-8000-000000000000'; }],
    ['toolUseId fora do formato', (d) => { d.toolUseId = 'a/b'; }],
    ['0 perguntas', (d) => { d.perguntas = []; }],
    ['5 perguntas', (d) => { d.perguntas = Array.from({ length: 5 }, (_, i) => ({ question: `P${i}?`, header: `H${i}`, options: [{ label: 'a', description: '' }, { label: 'b', description: '' }], multiSelect: false })); }],
    ['opção com preview', (d) => { d.perguntas[0].options[0].preview = 'x'; }],
    ['pergunta com chave extra', (d) => { d.perguntas[0].extra = 1; }],
    ['header de 61 chars', (d) => { d.perguntas[0].header = 'h'.repeat(61); }],
    ['label com \\n', (d) => { d.perguntas[0].options[0].label = 'a\nb'; }],
    ['pergunta com caractere de controle', (d) => { d.perguntas[0].question = `Quais${CC(27)}?`; }],
    ['duas perguntas com o mesmo texto', (d) => { d.perguntas[1].question = d.perguntas[0].question; }],
    ['1 opção só', (d) => { d.perguntas[1].options = [d.perguntas[1].options[0]]; }],
    ['5 opções', (d) => { d.perguntas[1].options = Array.from({ length: 5 }, (_, i) => ({ label: `o${i}`, description: '' })); }],
    ['multiSelect não booleano', (d) => { d.perguntas[0].multiSelect = 'sim'; }],
  ];
  for (const [rotulo, mut] of variantes) {
    m = mundoComHook();
    regravar(m, mut);
    ok(ler(m) === null, `null: ${rotulo}`);
  }

  // V3 — o transcript é o mesmo arquivo?
  m = mundoComHook();
  const outro = path.join(m.base, 'outra.jsonl');
  fs.writeFileSync(outro, '{}\n');
  ok(ler(m, { arquivo: outro }) === null, 'null: o transcript aponta outro arquivo');
  const elo = path.join(m.base, 'elo.jsonl');
  fs.symlinkSync(m.jsonl, elo);
  ok(ler(m, { arquivo: elo }) !== null, 'ok: a aba aponta um link para o mesmo arquivo (V3 por realpath)');

  // V4 — a janela entre o gancho e o waiting.
  m = mundoComHook();
  ok(ler(m, { statusDesde: m.dados.em - 5 }) === null, 'null: statusDesde − em = −5 (waiting antes do gancho)');
  ok(ler(m, { statusDesde: m.dados.em + 60001 }) === null, 'null: statusDesde − em = 60 001');
  ok(ler(m, { statusDesde: m.dados.em }) !== null && ler(m, { statusDesde: m.dados.em + 60000 }) !== null, 'ok: nas bordas 0 e 60 000');
  ok(ler(m, { statusDesde: null }) === null, 'null: statusDesde null');
  ok(ler(m, { statusDesde: undefined }) === null, 'null: statusDesde ausente');

  // V5 — a pergunta morre quando o `tool_result` dela entra no .jsonl (respondida OU recusada). O
  // `tool_use` sozinho NÃO mata: até a 2.1.294 ele só entrava junto do resultado, mas a 2.1.295 o
  // grava ~420 ms depois do gancho, com a pergunta ainda aberta (medido na prova real de 08/10).
  m = mundoComHook();
  fs.truncateSync(m.jsonl, 3);
  ok(ler(m) === null, 'null: .jsonl menor que o offset');
  const idV5 = gancho('b-pre').tool_use_id;
  const usoV5 = `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"${idV5}","name":"AskUserQuestion"}]}}\n`;
  m = mundoComHook();
  fs.appendFileSync(m.jsonl, usoV5);
  ok(ler(m) !== null, 'ok: SÓ o tool_use depois do offset (Claude Code 2.1.295, pergunta ainda aberta)');
  m = mundoComHook();
  fs.appendFileSync(m.jsonl, usoV5 + `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"${idV5}","content":"The user answered"}]},"toolUseResult":{"questions":[],"answers":{"x":"y"},"annotations":{}}}\n`);
  ok(ler(m) === null, 'null: tool_result de RESPOSTA depois do offset');
  m = mundoComHook();
  fs.appendFileSync(m.jsonl, usoV5 + `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"${idV5}","is_error":true,"content":"no"}]},"toolUseResult":"User rejected tool use"}\n`);
  ok(ler(m) === null, 'null: tool_result de RECUSA (Esc) depois do offset');
  m = mundoComHook();
  fs.appendFileSync(m.jsonl, `{"foo":"bar","ref":"${idV5}"}\n`);
  ok(ler(m) === null, 'null: o id depois do offset num formato desconhecido (nao-sei → fail-closed, #10)');
  m = mundoComHook('b-pre', { antes: `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"${gancho('b-pre').tool_use_id}"}]}}\n` });
  ok(ler(m) !== null, 'ok: toolUseId escrito ANTES do offset (outra volta da mesma pergunta)');

  // Nunca lança.
  ok(ler(m, { arquivo: '/nao/existe' }) === null, 'null: arquivo da aba inexistente (sem lançar)');
  ok(pergunta.lerPendente({ dir: '/nao/existe', sessaoId: m.sessaoId, arquivo: m.jsonl, statusDesde: 1 }) === null, 'null: pasta de perguntas inexistente (sem lançar)');
  let lancou = false;
  try { pergunta.lerPendente(undefined); pergunta.lerPendente({}); pergunta.lerPendente({ dir: 5, sessaoId: {}, arquivo: [], statusDesde: 'x' }); } catch { lancou = true; }
  ok(!lancou, 'lerPendente nunca lança, nem com argumento torto');
}

// ---- P-situacao ---------------------------------------------------------------------------------

const ID = 'toolu_01B9mvPsNgdPAsTYRBWgoKcv';
const linhaUso = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: ID, name: 'AskUserQuestion', input: {} }] } });
const linhaResposta = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'The user answered', tool_use_id: ID }] }, toolUseResult: { questions: [], answers: { 'Quais frutas?': 'Uva' }, annotations: {} } });
const linhaRecusa = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: "The user doesn't want to proceed", is_error: true, tool_use_id: ID }] }, toolUseResult: 'User rejected tool use' });

async function pSituacao() {
  const novo = (conteudo) => { const f = path.join(pasta(), 'c.jsonl'); fs.writeFileSync(f, conteudo); return f; };
  const antes = '{"type":"user"}\n';
  const off = Buffer.byteLength(antes);
  const sit = (conteudo, offset = off) => pergunta.situacaoNoArquivo(novo(conteudo), offset, ID);

  ok(sit(antes) === 'ausente', 'situacaoNoArquivo: sem linha → ausente');
  ok(sit(`${antes}${linhaUso}\n${linhaResposta}\n`) === 'respondida', 'situacaoNoArquivo: tool_result sem is_error e com answers objeto → respondida');
  ok(sit(`${antes}${linhaUso}\n${linhaRecusa}\n`) === 'recusada', 'situacaoNoArquivo: is_error → recusada');
  ok(sit(`${antes}{"foo":"bar","ref":"${ID}"}\n`) === 'nao-sei', 'situacaoNoArquivo: linha com o id em formato desconhecido → nao-sei');
  ok(sit(`${antes}${linhaUso}\n`) === 'ausente', 'situacaoNoArquivo: só o tool_use (sem resultado) → ausente');
  ok(sit(`${linhaResposta}\n${antes}`, Buffer.byteLength(linhaResposta) + 1 + off) === 'ausente', 'situacaoNoArquivo: a resposta ANTES do offset não conta');
  ok(sit(`${antes}${linhaUso}\n${linhaResposta.slice(0, linhaResposta.indexOf(ID) + 10)}`) === 'ausente', 'situacaoNoArquivo: linha cortada no fim (ainda sendo escrita) → ausente');
  ok(pergunta.situacaoNoArquivo('/nao/existe', 0, ID) === 'nao-sei', 'situacaoNoArquivo: arquivo ilegível → nao-sei');

  const dir = path.join(pasta(), 'perguntas');
  fs.mkdirSync(dir);
  const sid = '11111111-2222-4333-8444-555555555555';
  const arqHook = path.join(dir, `${sid}.json`);
  const final = (conteudo) => pergunta.situacaoFinal({ arquivo: novo(conteudo), offset: off, toolUseId: ID, dir, sessaoId: sid });

  ok(final(`${antes}${linhaUso}\n${linhaResposta}\n`) === 'respondida', 'situacaoFinal: .jsonl com resposta → respondida');
  ok(final(`${antes}${linhaUso}\n${linhaRecusa}\n`) === 'recusada', 'situacaoFinal: .jsonl com is_error → recusada');
  ok(final(antes) === 'respondida', 'situacaoFinal: sem linha e o arquivo do hook AUSENTE → respondida (o Post só dispara na resposta)');
  fs.writeFileSync(arqHook, JSON.stringify({ toolUseId: 'toolu_outra' }));
  ok(final(antes) === 'respondida', 'situacaoFinal: sem linha e o arquivo do hook com OUTRO toolUseId → respondida');
  fs.writeFileSync(arqHook, JSON.stringify({ toolUseId: ID }));
  ok(final(antes) === 'ausente', 'situacaoFinal: sem linha e o arquivo do hook ainda com o id → ausente');
  ok(final(`${antes}{"foo":"${ID}"}\n`) === 'nao-sei', 'situacaoFinal: formato desconhecido → nao-sei (não decide pelo hook)');
}

// ---- P-corpo e P-respostas ----------------------------------------------------------------------

async function pCorpo() {
  const bom = { toolUseId: ID, respostas: [{ opcoes: [0], texto: '' }] };
  const v = pergunta.validarCorpo(bom);
  ok(v && v.toolUseId === ID && v.respostas.length === 1, 'validarCorpo aceita o corpo bom');
  const recusas = [
    ['não-objeto (null)', null], ['não-objeto (array)', []], ['não-objeto (string)', 'x'],
    ['chave extra', { ...bom, extra: 1 }],
    ['sem respostas', { toolUseId: ID }],
    ['toolUseId número', { ...bom, toolUseId: 1 }],
    ['toolUseId fora do formato', { ...bom, toolUseId: 'a/b' }],
    ['toolUseId vazio', { ...bom, toolUseId: '' }],
    ['respostas não-array', { ...bom, respostas: {} }],
    ['item não-objeto', { ...bom, respostas: ['x'] }],
    ['item com chave extra', { ...bom, respostas: [{ opcoes: [], texto: '', x: 1 }] }],
    ['item sem texto', { ...bom, respostas: [{ opcoes: [] }] }],
    ['opcoes com não-inteiro (1.5)', { ...bom, respostas: [{ opcoes: [1.5], texto: '' }] }],
    ['opcoes com string', { ...bom, respostas: [{ opcoes: ['1'], texto: '' }] }],
    ['opcoes não-array', { ...bom, respostas: [{ opcoes: 1, texto: '' }] }],
    ['texto não-string', { ...bom, respostas: [{ opcoes: [], texto: 5 }] }],
  ];
  for (const [rotulo, corpo] of recusas) ok(await lancaCom(() => pergunta.validarCorpo(corpo), 400), `validarCorpo recusa (400): ${rotulo}`);
}

async function pRespostas() {
  const pb = doPayload('b-pre'); // Frutas (multi, 3), Bebida (simples, 2), Hora (simples, 2)
  const ps = doPayload('a-pre'); // Cor (simples, 2)
  const com = (i, r) => RESP.b.map((x, k) => (k === i ? r : x));
  const v = pergunta.validarRespostas(pb, RESP.b);
  ok(JSON.stringify(v) === JSON.stringify(RESP.b), 'validarRespostas aceita a bateria b e devolve normalizada');

  const recusas = [
    ['tamanho menor que o nº de perguntas', pb, RESP.b.slice(0, 2)],
    ['tamanho maior', ps, [{ opcoes: [0], texto: '' }, { opcoes: [0], texto: '' }]],
    ['índice −1', ps, [{ opcoes: [-1], texto: '' }]],
    ['índice = nº de opções', ps, [{ opcoes: [2], texto: '' }]],
    ['índice repetido (multi)', pb, com(0, { opcoes: [1, 1], texto: '' })],
    ['texto com \\n', ps, [{ opcoes: [], texto: `a${CC(10)}b` }]],
    ['texto com \\r', ps, [{ opcoes: [], texto: `a${CC(13)}b` }]],
    ['texto com ESC', ps, [{ opcoes: [], texto: `a${CC(27)}b` }]],
    ['texto com BEL', ps, [{ opcoes: [], texto: `a${CC(7)}b` }]],
    ['texto com DEL', ps, [{ opcoes: [], texto: `a${CC(127)}b` }]],
    ['texto com U+0085', ps, [{ opcoes: [], texto: `a${CC(0x85)}b` }]],
    ['texto com U+2028', ps, [{ opcoes: [], texto: `a${CC(0x2028)}b` }]],
    ['texto com U+2029', ps, [{ opcoes: [], texto: `a${CC(0x2029)}b` }]],
    ['texto que termina em \\n (recusa, não limpa)', ps, [{ opcoes: [], texto: `ola${CC(10)}` }]],
    ['texto de 501 chars', ps, [{ opcoes: [], texto: 'x'.repeat(501) }]],
    ['simples com opção e texto', ps, [{ opcoes: [0], texto: 'outra' }]],
    ['simples sem nada', ps, [{ opcoes: [], texto: '' }]],
    ['simples só com espaços', ps, [{ opcoes: [], texto: '   ' }]],
    ['simples com duas opções', ps, [{ opcoes: [0, 1], texto: '' }]],
    ['multi sem nada', pb, com(0, { opcoes: [], texto: '' })],
  ];
  for (const [rotulo, perg, resp] of recusas) ok(await lancaCom(() => pergunta.validarRespostas(perg, resp), 400), `validarRespostas recusa (400): ${rotulo}`);

  const aceita = (rotulo, resp, esperado) => {
    let r = null;
    try { r = pergunta.validarRespostas(ps, resp); } catch { /* ok(false) abaixo */ }
    ok(r && JSON.stringify(r) === JSON.stringify(esperado), `validarRespostas aceita: ${rotulo}`);
  };
  aceita('texto com aspas, vírgula, acento e dígitos', [{ opcoes: [], texto: 'só "um", 2 vezes: ação' }], [{ opcoes: [], texto: 'só "um", 2 vezes: ação' }]);
  aceita('texto aparado', [{ opcoes: [], texto: '  ola  ' }], [{ opcoes: [], texto: 'ola' }]);
  aceita('texto de 500 chars', [{ opcoes: [], texto: 'x'.repeat(500) }], [{ opcoes: [], texto: 'x'.repeat(500) }]);
  let multi = null;
  try { multi = pergunta.validarRespostas(pb, com(0, { opcoes: [2, 0], texto: '' })); } catch { /* ok(false) abaixo */ }
  ok(multi && JSON.stringify(multi[0].opcoes) === '[0,2]', 'validarRespostas ordena as opções da multi');
}

// ---- P-plano ------------------------------------------------------------------------------------

async function pPlano() {
  for (const k of ['a', 'b', 'c', 'e']) {
    const perguntas = doPayload(`${k}-pre`);
    const respostas = pergunta.validarRespostas(perguntas, RESP[k]);
    const plano = pergunta.planoDeTeclas(perguntas, respostas);
    const teclas = emTeclas(plano);
    ok(JSON.stringify(teclas) === JSON.stringify(TECLAS_MEDIDAS[k]), `planoDeTeclas ${k}: exatamente a sequência medida (${teclas.length} passos)`);
    ok(!teclas.some((x) => ['Escape', 'Up', 'Left', 'Right', 'Tab'].includes(x)), `planoDeTeclas ${k}: nunca Escape, Up, Left, Right nem Tab`);
    ok(plano.length > 0 && plano[plano.length - 1].espera.tipo === 'final', `planoDeTeclas ${k}: o último passo espera a resposta`);
  }
}

// ---- P-tela -------------------------------------------------------------------------------------

async function pTela() {
  const c = (nomeTela, espera, nomePayload, respostas) => pergunta.confere(tela(nomeTela), espera, doPayload(nomePayload), respostas);
  const INICIO = { tipo: 'inicio' };

  for (const [t, p] of [['m1-01-pergunta-aberta', '01-pre'], ['b1-tres-aberta', 'b-pre'], ['a1-unica-aberta', 'a-pre'], ['c1-multi-unica', 'c-pre'], ['e1-longa-aberta', 'e-pre']]) {
    ok(c(t, INICIO, p) === true, `inicio VERDADEIRO em ${t}`);
  }
  for (const [t, p, porque] of [
    ['b2-multi-1', 'b-pre', 'já tem ☒'], ['b3-cursor-type', 'b-pre', 'cursor fora do 1'], ['m1-02-apos-digito-2', '01-pre', 'já respondeu a 1ª'],
    ['m1-00-confianca', '01-pre', 'prompt de confiança'], ['m1-13-menu-auto-mode', '01-pre', 'menu do auto mode'],
    ['b11-apos-submit', 'b-pre', 'depois do envio'], ['a2-unica-apos-digito', 'a-pre', 'depois do dígito'],
    ['b10-revisao', 'b-pre', 'revisão'], ['b1-tres-aberta', 'a-pre', 'pergunta de outro payload'], ['c1-multi-unica', 'b-pre', 'pergunta de outro payload'],
  ]) {
    ok(c(t, INICIO, p) === false, `inicio FALSO em ${t} (${porque})`);
  }
  ok(pergunta.confere('', INICIO, doPayload('b-pre')) === false, 'inicio FALSO numa tela vazia');
  ok(pergunta.confere(tela('b1-tres-aberta'), INICIO, []) === false, 'inicio FALSO sem perguntas');
  // O prompt de cima (`❯ Use a ferramenta…`) nunca conta como cursor.
  ok(c('b1-tres-aberta', { tipo: 'cursor', q: 0, alvo: 1 }, 'b-pre') === true && c('b1-tres-aberta', { tipo: 'cursor', q: 0, alvo: 2 }, 'b-pre') === false, 'o histórico de cima não conta como cursor (b1: o cursor é só o do 1.)');
  ok(c('b3-cursor-type', INICIO, 'b-pre') === false, 'o ❯ do histórico não salva uma tela com o cursor fora do 1.');

  ok(c('b3-cursor-type', { tipo: 'cursor', q: 0, alvo: 4 }, 'b-pre') === true, 'cursor: b3 → 4');
  ok(c('b3-cursor-type', { tipo: 'cursor', q: 0, alvo: 3 }, 'b-pre') === false, 'cursor: b3 ≠ 3');
  ok(c('b5-cursor-next', { tipo: 'cursor', q: 0, alvo: 'next' }, 'b-pre') === true, "cursor: b5 → 'next'");
  ok(c('b5-cursor-next', { tipo: 'cursor', q: 0, alvo: 4 }, 'b-pre') === false, 'cursor: b5 ≠ 4');
  ok(c('c3-cursor-submit', { tipo: 'cursor', q: 0, alvo: 'submit' }, 'c-pre') === true, "cursor: c3 → 'submit'");
  ok(c('c3-cursor-submit', { tipo: 'cursor', q: 0, alvo: 'next' }, 'c-pre') === false, 'cursor: c3 ≠ next');
  ok(c('b7-cursor-type-simples', { tipo: 'cursor', q: 1, alvo: 3 }, 'b-pre') === true, 'cursor: b7 (simples) → 3');

  ok(c('b2-multi-1', { tipo: 'marca', q: 0, opcao: 0 }, 'b-pre') === true, 'marca: b2 opção 0');
  ok(c('b2-multi-1', { tipo: 'marca', q: 0, opcao: 1 }, 'b-pre') === false, 'marca: b2 opção 1 não está marcada');
  ok(c('b1-tres-aberta', { tipo: 'marca', q: 0, opcao: 0 }, 'b-pre') === false, 'marca: b1 ainda sem marca');

  ok(c('b4-texto-sem-marcar', { tipo: 'texto', q: 0, texto: 'texto um 7' }, 'b-pre') === true, 'texto: b4 com "texto um 7"');
  ok(c('b8-texto-simples', { tipo: 'texto', q: 1, texto: 'texto dois, com "aspas"' }, 'b-pre') === true, 'texto: b8 com aspas e vírgula');
  ok(c('b4-texto-sem-marcar', { tipo: 'texto', q: 0, texto: 'texto um' }, 'b-pre') === false, 'texto: IGUALDADE — "texto um" não casa "texto um 7"');
  ok(c('b3-cursor-type', { tipo: 'texto', q: 0, texto: 'texto um 7' }, 'b-pre') === false, 'texto: b3 (campo vazio) não casa');
  // Texto longo QUEBRA no campo da TUI (medido em 08/10, 2.1.295: quebra na palavra, recuo 5 na linha de
  // baixo). A conferência junta a continuação até a próxima opção/navegação/separador — e segue IGUALDADE.
  const corLonga = [{ texto: 'Qual cor?', cabecalho: 'Cor', multipla: false, opcoes: [{ rotulo: 'Azul', descricao: 'Azul' }, { rotulo: 'Verde', descricao: 'Verde' }] }];
  const TEXTO_LONGO = 'Quero um tom de verde bem escuro, quase petroleo, que combine com o logotipo antigo da clinica e que funcione bem no modo escuro do aplicativo, sem perder o contraste com o texto branco dos botoes principais e das etiquetas de aviso';
  ok(pergunta.confere(tela('f1-texto-longo'), { tipo: 'texto', q: 0, texto: TEXTO_LONGO }, corLonga) === true, 'texto: f1 — 232 chars quebrados em 2 linhas casam');
  ok(pergunta.confere(tela('f1-texto-longo'), { tipo: 'texto', q: 0, texto: TEXTO_LONGO.slice(0, 120) }, corLonga) === false, 'texto: f1 — só a 1ª linha NÃO casa (igualdade com o texto inteiro)');
  ok(pergunta.confere(tela('f1-texto-longo'), { tipo: 'cursor', q: 0, alvo: 3 }, corLonga) === true, 'cursor: f1 → 3 (a continuação não vira opção)');

  // Revisão EXATA (painel de execução): resposta a mais na tela reprova, não só resposta a menos.
  ok(c('b10-revisao', { tipo: 'revisao' }, 'b-pre', [{ opcoes: [0], texto: '' }, { opcoes: [], texto: 'texto dois, com "aspas"' }, { opcoes: [1], texto: '' }]) === false,
    'revisao: b10 com o texto da Frutas A MAIS na tela (não pedido) → falso');
  ok(c('c4-revisao-unica', { tipo: 'revisao' }, 'c-pre', [{ opcoes: [0, 2], texto: '' }]) === false, 'revisao: c4 (Roxo) não casa um pedido de Azul+Roxo');
  ok(c('b6-aba-2', { tipo: 'aba', q: 1 }, 'b-pre') === true, 'aba: b6 → q1');
  ok(c('b9-aba-3', { tipo: 'aba', q: 2 }, 'b-pre') === true, 'aba: b9 → q2');
  ok(c('b6-aba-2', { tipo: 'aba', q: 2 }, 'b-pre') === false, 'aba: b6 não é a q2');
  ok(c('b2-multi-1', { tipo: 'aba', q: 1 }, 'b-pre') === false, 'aba: b2 ainda é a q0');
  ok(c('b7-cursor-type-simples', { tipo: 'aba', q: 1 }, 'b-pre') === false, 'aba: b7 (cursor fora do 1.) não é a abertura da aba');

  ok(c('b10-revisao', { tipo: 'revisao' }, 'b-pre', RESP.b) === true, 'revisao: b10 com as respostas do b');
  ok(c('b10-revisao', { tipo: 'revisao' }, 'b-pre', RESP.b.map((x, i) => (i === 2 ? { opcoes: [0], texto: '' } : x))) === false, 'revisao: FALSA com a resposta da Hora trocada');
  ok(c('b10-revisao', { tipo: 'revisao' }, 'b-pre', RESP.b.map((x, i) => (i === 0 ? { opcoes: [0], texto: 'outro texto' } : x))) === false, 'revisao: FALSA com o texto da Frutas trocado');
  ok(c('c4-revisao-unica', { tipo: 'revisao' }, 'c-pre', RESP.c) === true, 'revisao: c4');
  ok(c('e7-revisao-longa', { tipo: 'revisao' }, 'e-pre', RESP.e) === true, 'revisao: e7 (pergunta longa com │)');
  ok(c('b9-aba-3', { tipo: 'revisao' }, 'b-pre', RESP.b) === false, 'revisao: FALSA fora da revisão');
  ok(c('b11-apos-submit', { tipo: 'revisao' }, 'b-pre', RESP.b) === false, 'revisao: FALSA depois do envio');
}

// ---- P-executar ---------------------------------------------------------------------------------

/** E/S da TUI falsa com RELÓGIO DE MENTIRA: `espera` só adianta o relógio, nada dorme de verdade. */
function montarIo(tui, { atraso = 0, ignorar = [], depoisDaTecla = null, identidadeRuim = null, situacao = null } = {}) {
  const relogio = { t: 0 };
  const enviadas = [];
  let pendente = null;
  const aplicar = () => {
    if (pendente && relogio.t - pendente.em >= atraso) { pendente.f(); pendente = null; }
  };
  const mandar = (rotulo, f) => {
    enviadas.push(rotulo);
    const n = enviadas.length;
    if (ignorar.includes(n)) return;
    if (atraso > 0) { aplicar(); pendente = { em: relogio.t, f }; } else f();
    if (depoisDaTecla) depoisDaTecla(n, rotulo);
  };
  const io = {
    capturar: async () => { aplicar(); return tui.tela(); },
    tecla: async (nome) => { mandar(nome, () => tui.tecla(nome)); },
    texto: async (t) => { mandar(`«${t}»`, () => tui.texto(t)); },
    identidade: async () => (identidadeRuim ? identidadeRuim(enviadas.length) : null),
    situacao: async () => {
      aplicar();
      if (situacao) return situacao();
      return tui.estado.respondida ? 'respondida' : (tui.estado.recusada ? 'recusada' : 'ausente');
    },
    espera: async (ms) => { relogio.t += ms; },
    agora: () => relogio.t,
  };
  return { io, enviadas, relogio };
}

const falha = async (fn) => { try { await fn(); } catch (e) { return e; } return null; };

async function pExecutar() {
  const todas = [];
  // 1. caminho feliz das quatro baterias medidas
  for (const k of ['a', 'b', 'c', 'e']) {
    const perguntas = doPayload(`${k}-pre`);
    const respostas = pergunta.validarRespostas(perguntas, RESP[k]);
    const tui = criarTui(perguntas, { barraNaPergunta: k === 'e' });
    const { io, enviadas } = montarIo(tui);
    const r = await pergunta.executar(pergunta.planoDeTeclas(perguntas, respostas), { perguntas, respostas, io });
    todas.push(...enviadas);
    ok(r && r.respondido === true, `${k}: executar devolve { respondido: true }`);
    ok(tui.estado.respondida && JSON.stringify(tui.estado.respostas) === JSON.stringify(RESP[k]), `${k}: a TUI falsa terminou respondida com as respostas esperadas`);
    ok(JSON.stringify(enviadas) === JSON.stringify(TECLAS_MEDIDAS[k]), `${k}: as teclas saíram na ordem do plano`);
  }

  const perguntasB = doPayload('b-pre');
  const respostasB = pergunta.validarRespostas(perguntasB, RESP.b);
  const planoB = () => pergunta.planoDeTeclas(perguntasB, respostasB);
  const rodarB = (tui, io, extra = {}) => pergunta.executar(planoB(), { perguntas: perguntasB, respostas: respostasB, io, ...extra });

  // 2. estado inicial mexido → 409 SEM parcial e zero teclas
  {
    const tui = criarTui(perguntasB);
    tui.tecla('Down');
    const { io, enviadas } = montarIo(tui);
    const e = await falha(() => rodarB(tui, io));
    ok(e && e.codigo === 409 && !e.parcial, 'estado inicial mexido: 409 sem parcial');
    ok(enviadas.length === 0, 'estado inicial mexido: ZERO teclas mandadas');
  }

  // 3. a TUI ignora a 3ª tecla → para ali
  {
    const tui = criarTui(perguntasB);
    const { io, enviadas } = montarIo(tui, { ignorar: [3] });
    const e = await falha(() => rodarB(tui, io));
    ok(e && e.codigo === 409 && e.parcial === true, 'TUI que ignora a 3ª tecla: 409 com parcial');
    ok(enviadas.length === 3, `TUI que ignora a 3ª tecla: a 4ª NÃO sai (saíram ${enviadas.length})`);
    ok(e && typeof e.message === 'string' && e.message.length > 10 && !/tempo esgotado/.test(e.message), 'TUI que ignora a 3ª tecla: a frase é a do passo, não a do orçamento');
  }

  // 4. identidade troca no meio
  {
    const tui = criarTui(perguntasB);
    const { io, enviadas } = montarIo(tui, { identidadeRuim: (n) => (n >= 2 ? 'a aba mudou de processo' : null) });
    const e = await falha(() => rodarB(tui, io));
    ok(e && e.codigo === 409 && e.parcial === true, 'identidade trocada depois da 2ª tecla: 409 parcial');
    ok(enviadas.length === 2, `identidade trocada: para ANTES da 3ª tecla (saíram ${enviadas.length})`);
  }

  // 5. Parar no meio (Escape fora da fila): o Enter final NÃO sai
  {
    const tui = criarTui(perguntasB);
    let confirmouRevisao = false;
    const base = montarIo(tui);
    const capturarOriginal = base.io.capturar;
    base.io.capturar = async () => {
      const t = await capturarOriginal();
      // A captura que confirma a revisão acabou de sair; o Parar (Escape) chega logo depois.
      if (!confirmouRevisao && tui.estado.revisao) { confirmouRevisao = true; tui.tecla('Escape'); }
      return t;
    };
    const e = await falha(() => rodarB(tui, base.io));
    ok(confirmouRevisao, 'Parar no meio: o cenário chegou à revisão antes do Escape');
    ok(e && e.codigo === 409 && e.parcial === true, 'Parar no meio: 409 parcial');
    ok(base.enviadas.length === 12 && base.enviadas[11] === '2' && !tui.estado.respondida, `Parar no meio: o Enter final NÃO sai (saíram ${base.enviadas.length}, a última foi ${base.enviadas[base.enviadas.length - 1]})`);
    todas.push(...base.enviadas);
  }

  // 5b. (painel de execução, Codex) uma opção A MAIS marcada no meio do envio — a revisão é
  // EXATA: o Enter final não sai. Molde da reprodução dele: c-pre, pede [0], intercala a tecla 2.
  {
    const perguntasC = doPayload('c-pre');
    const respostasC = pergunta.validarRespostas(perguntasC, [{ opcoes: [0], texto: '' }]);
    const tui = criarTui(perguntasC);
    const { io, enviadas } = montarIo(tui, { depoisDaTecla: (n) => { if (n === 1) tui.tecla('2'); } });
    const e = await falha(() => pergunta.executar(pergunta.planoDeTeclas(perguntasC, respostasC), { perguntas: perguntasC, respostas: respostasC, io }));
    ok(e && e.codigo === 409 && e.parcial === true, 'opção a mais intercalada: 409 parcial');
    ok(!tui.estado.respondida && enviadas[enviadas.length - 1] !== 'Enter#final' && enviadas.length === 6,
      `opção a mais intercalada: o Enter final NÃO sai (saíram ${enviadas.length}: ${enviadas.join(' ')})`);
  }

  // 5c. Parar com o cartão respondendo: a lib/abas.js marca "cancelar" em vez de mandar Escape, e o
  // executor confere a marca de forma SÍNCRONA logo antes de cada tecla — sem janela entre a captura
  // e o envio (painel de execução, Codex).
  {
    const tui = criarTui(perguntasB);
    const base = montarIo(tui);
    base.io.cancelado = () => base.enviadas.length >= 3;
    const e = await falha(() => rodarB(tui, base.io));
    ok(e && e.codigo === 409 && e.parcial === true && /Parar/.test(e.message), `cancelado pelo Parar: 409 parcial com a frase do Parar (${e && e.message})`);
    ok(base.enviadas.length === 3, `cancelado pelo Parar: nenhuma tecla depois da marca (saíram ${base.enviadas.length})`);
  }

  // 5d. A fiação do 5c em lib/abas.js, por TEXTO (#53 — depende dos símbolos `async function
  // interromper`, `cancelarRespostaEmCurso` e `cancelado:`): o Parar marca antes de qualquer
  // send-keys, e a E/S do executor lê a marca.
  {
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'lib', 'abas.js'), 'utf8');
    const ini = fonte.indexOf('async function interromper(');
    const corpo = ini >= 0 ? fonte.slice(ini, fonte.indexOf('\n}\n', ini)) : '';
    const iMarca = corpo.indexOf('cancelarRespostaEmCurso(');
    const iTecla = corpo.indexOf("'send-keys'");
    ok(ini >= 0 && iMarca > 0 && iTecla > iMarca, 'interromper() chama cancelarRespostaEmCurso ANTES do send-keys do Escape');
    ok(/cancelado:\s*\(\)\s*=>/.test(fonte), 'a E/S do responderNaAba passa `cancelado` ao executor');
  }

  // 6. fim recusado / fim sem confirmação
  {
    const tui = criarTui(perguntasB);
    const { io } = montarIo(tui, { situacao: () => 'recusada' });
    const e = await falha(() => rodarB(tui, io));
    ok(e && e.codigo === 409 && e.parcial === true && /cancelad/.test(e.message), 'fim recusada: 409 parcial com a frase de cancelamento');
  }
  {
    const tui = criarTui(perguntasB);
    const { io, relogio } = montarIo(tui, { situacao: () => 'nao-sei' });
    const e = await falha(() => rodarB(tui, io));
    ok(e && e.codigo === 409 && e.parcial === true && /confirmar/.test(e.message), 'fim nao-sei: 409 parcial, "não consegui confirmar"');
    ok(relogio.t >= 3000 && relogio.t < 40000, `fim nao-sei: esperou ao menos 3 s antes de desistir (relógio ${relogio.t} ms)`);
  }

  // 7. orçamento: a TUI mostra cada efeito só depois de 1,2 s (dentro do prazo de 1,5 s por passo)
  {
    const tui = criarTui(perguntasB);
    const { io, enviadas } = montarIo(tui, { atraso: 1200 });
    const e = await falha(() => rodarB(tui, io, { orcamentoMs: 10000 }));
    ok(e && e.codigo === 409 && e.parcial === true && /tempo esgotado/i.test(e.message), 'orçamento de 10 s: para NO MEIO, parcial, "tempo esgotado"');
    ok(enviadas.length > 3 && enviadas.length < 13, `orçamento de 10 s: parou no meio (saíram ${enviadas.length} de 13)`);
    const tui2 = criarTui(perguntasB);
    const m2 = montarIo(tui2, { atraso: 1200 });
    const r = await rodarB(tui2, m2.io);
    ok(r && r.respondido === true, 'com o orçamento de verdade (30 s) a mesma TUI lenta termina');
  }

  // 8. o espião de teclas
  ok(todas.length > 0 && !todas.some((t) => ['Escape', 'Up', 'Left', 'Right', 'Tab'].includes(t)), 'a E/S nunca recebeu Escape, Up, Left, Right nem Tab pelo plano');
}

// ---- P-integrado --------------------------------------------------------------------------------

const PREFIXO_SOCKET = /^cockpit-(offline|smoke)-/;

async function pIntegrado() {
  // O socket do runner (`COCKPIT_TMUX_SOCKET=cockpit-offline-<pid>`) ou um próprio. Nunca o padrão.
  const socketDoRunner = Boolean(process.env.COCKPIT_TMUX_SOCKET);
  const socket = process.env.COCKPIT_TMUX_SOCKET || `cockpit-smoke-pergunta-${process.pid}`;
  if (!PREFIXO_SOCKET.test(socket)) throw new Error(`recuso o socket "${socket}": só cockpit-offline-/cockpit-smoke-`);
  const casa = pasta();
  // lib/abas.js lê o socket e o HOME quando é carregado: tudo definido ANTES do require.
  process.env.COCKPIT_TMUX_SOCKET = socket;
  process.env.HOME = casa;
  process.env.LC_ALL = 'C.UTF-8'; // cliente fora de UTF-8 recebe os não-ASCII da tela como `_`
  const abas = require('../lib/abas');

  const tmux = (...args) => spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C.UTF-8' } });
  const sessao = `pergunta-${process.pid}`;
  const comando = (fixture) => `cat ${path.join(DIR_FIX, 'telas', `${fixture}.txt`)}; exec sleep 100000`;
  const criada = tmux('-f', '/dev/null', 'new-session', '-d', '-s', sessao, '-x', '140', '-y', '50', comando('b1-tres-aberta'));
  if (criada.status !== 0) throw new Error(`tmux não subiu a sessão: ${criada.stderr}`);
  try {
    const pane = tmux('display-message', '-p', '-t', sessao, '#{pane_id}').stdout.trim();
    const capturar = () => tmux('capture-pane', '-p', '-t', pane).stdout;
    const mostrar = async (fixture, trecho) => {
      tmux('respawn-pane', '-k', '-t', pane, comando(fixture));
      for (let i = 0; i < 60; i += 1) { if (capturar().includes(trecho)) return; await new Promise((r) => setTimeout(r, 50)); }
      throw new Error(`a pane não mostrou "${trecho}"`);
    };
    await mostrar('b1-tres-aberta', 'Quais frutas?');

    const m = mundoComHook();
    process.env.COCKPIT_PERGUNTAS_DIR = m.dir;
    const aba = (extra = {}) => ({
      chave: 'aba-p1', agente: 'claude', esperando: true, preSessao: false, sessaoId: m.sessaoId, arquivo: m.jsonl, statusDesde: m.statusDesde, pane, ...extra,
    });

    const r = await abas.tela(aba());
    ok(r.cartao && r.cartao.perguntas.length === 3 && r.cartao.toolUseId === m.dados.toolUseId, 'tela(aba) com b1 + hook: cartao com 3 perguntas e o toolUseId');
    ok(r.cartao && JSON.stringify(Object.keys(r.cartao).sort()) === '["perguntas","toolUseId"]', 'o cartao leva SÓ toolUseId e perguntas (nem offset, nem transcript, nem caminho — #22)');
    ok(r.chave === 'aba-p1' && typeof r.tela === 'string' && r.tela.includes('Quais frutas?') && 'motivo' in r, 'a tela crua continua vindo na mesma resposta');
    const pend = await abas.perguntaPendente(aba());
    ok(pend && pend.toolUseId === m.dados.toolUseId && pend.perguntas.length === 3, 'perguntaPendente(aba) devolve a pergunta');

    await mostrar('b2-multi-1', '[✔] Uva');
    const r2 = await abas.tela(aba());
    ok(r2.cartao === null && r2.tela.includes('[✔] Uva'), 'pane já mexida (b2): cartao null e a tela crua continua devolvida');
    ok((await abas.perguntaPendente(aba())) !== null, 'a pendente em si continua válida (é a conferência da tela que derruba o cartão)');
    await mostrar('b1-tres-aberta', 'Quais frutas?');

    ok((await abas.perguntaPendente(aba({ agente: 'codex' }))) === null && (await abas.tela(aba({ agente: 'codex' }))).cartao === null, 'agente codex: null (terminal cru)');
    ok((await abas.perguntaPendente(aba({ esperando: false, preSessao: true }))) === null && (await abas.tela(aba({ esperando: false, preSessao: true }))).cartao === null, 'preSessao: null (prompt de confiança fica no cru)');
    ok((await abas.perguntaPendente(aba({ esperando: false }))) === null, 'esperando false: perguntaPendente null');
    let lancou = null;
    try { await abas.tela(aba({ esperando: false })); } catch (e) { lancou = e; }
    ok(lancou && /pergunta aberta/.test(lancou.message), 'esperando false: tela() lança como hoje');
    for (const [rotulo, extra] of [['sem sessaoId', { sessaoId: null }], ['sem arquivo', { arquivo: null }], ['statusDesde null', { statusDesde: null }]]) {
      ok((await abas.perguntaPendente(aba(extra))) === null, `${rotulo}: null`);
    }
    ok((await abas.perguntaPendente(undefined)) === null && (await abas.perguntaPendente({})) === null, 'perguntaPendente nunca lança, nem sem aba');

    // `semGancho` (card pergunta-sem-gancho-avisa): o aviso de hook não instalado. O HOME falso deste
    // grupo (`casa`) começa SEM `.claude/settings.json` = hook ausente. Outra sessão = sem arquivo do
    // hook para ela = o mesmo que um menu que não é AskUserQuestion.
    const outraSessao = { sessaoId: '00000000-0000-4000-8000-0000000000aa' };
    const settingsDaCasa = path.join(casa, '.claude', 'settings.json');
    const sg = await abas.tela(aba(outraSessao));
    ok(sg.cartao === null && sg.semGancho === true, `sem hook no settings + pergunta no cru → semGancho true (veio ${sg.semGancho})`);
    // A `tela` é a captura crua da pane (a b1 medida cita um settings.json da TUI): o #22 se confere no RESTO.
    const { tela: _cru, ...semTela } = sg;
    ok(typeof sg.semGancho === 'boolean' && !JSON.stringify(sg).includes(casa) && !JSON.stringify(semTela).includes('settings.json'),
      'a resposta não leva caminho nenhum (#22): semGancho é só booleano, sem o HOME nem o settings');
    ok((await abas.tela(aba())).semGancho === false, 'com cartão → semGancho false');
    ok((await abas.tela(aba({ ...outraSessao, agente: 'codex' }))).semGancho === false, 'Codex → semGancho false, sempre');
    ok((await abas.tela(aba({ ...outraSessao, esperando: false, preSessao: true }))).semGancho === false, 'preSessao → semGancho false');
    const projeto = pasta();
    fs.mkdirSync(path.join(projeto, '.claude'), { recursive: true });
    const script = path.join(pasta(), 'gancho-pergunta.js');
    fs.writeFileSync(script, '// falso\n');
    const comHook = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `/usr/bin/node ${script} 2>/dev/null || true`, timeout: 5 }] }] } });
    fs.writeFileSync(path.join(projeto, '.claude', 'settings.json'), comHook);
    ok((await abas.tela(aba({ ...outraSessao, cwd: projeto }))).semGancho === false, 'hook só no settings do PROJETO da aba (cwd) → semGancho false');
    fs.mkdirSync(path.dirname(settingsDaCasa), { recursive: true });
    fs.writeFileSync(settingsDaCasa, comHook);
    ok((await abas.tela(aba(outraSessao))).semGancho === false, 'settings COM hook + sem arquivo do hook (menu que não é AskUserQuestion) → semGancho false');
    await mostrar('b2-multi-1', '[✔] Uva');
    const mexida = await abas.tela(aba());
    ok(mexida.cartao === null && mexida.semGancho === false, 'settings COM hook + pane mexida (cartão ausente por causa legítima) → semGancho false');
    await mostrar('b1-tres-aberta', 'Quais frutas?');
    fs.unlinkSync(script);
    ok((await abas.tela(aba(outraSessao))).semGancho === true, 'settings COM hook mas o script citado sumiu → semGancho true');
    fs.unlinkSync(settingsDaCasa);

    fs.appendFileSync(m.jsonl, `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"${m.dados.toolUseId}"}]}}\n`);
    ok((await abas.tela(aba())).cartao !== null, 'só o tool_use no .jsonl (2.1.295): o cartão continua');
    fs.appendFileSync(m.jsonl, `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"${m.dados.toolUseId}","content":"ok"}]},"toolUseResult":{"questions":[],"answers":{},"annotations":{}}}\n`);
    ok((await abas.perguntaPendente(aba())) === null && (await abas.tela(aba())).cartao === null, 'tool_result no .jsonl depois do offset: null (a pergunta já acabou)');
  } finally {
    tmux('kill-session', '-t', sessao);
    // Socket que EU criei (sem o do runner): o servidor sai com a última sessão; sobra só o arquivo.
    if (!socketDoRunner) {
      tmux('kill-server');
      try { fs.unlinkSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, socket)); } catch { /* já saiu */ }
    }
  }
}

// ---- P-rota -------------------------------------------------------------------------------------

function pedir(porta, rota, metodo, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
    const cab = dados === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) };
    const req = http.request({ hostname: '127.0.0.1', port: porta, path: rota, method: metodo, headers: cab, agent: false }, (res) => {
      let texto = '';
      res.on('data', (d) => { texto += d; });
      res.on('end', () => resolve({ status: res.statusCode, texto }));
    });
    req.on('error', reject);
    req.end(dados === null ? undefined : dados);
  });
}

async function pRota() {
  const PORTA = 7958;
  const raiz = fx.raizTemporaria('gate-pergunta-');
  const { fila } = fx.montarInbox(raiz);
  const binario = fx.binarioFalso(raiz);
  const caminhoSocket = path.join(raiz, 'ts.sock');
  const socket = fx.socketFalso(caminhoSocket, { filaDir: fila });
  await socket.pronto;
  let servidor = null;
  try {
    servidor = await fx.subirServidor({
      porta: PORTA,
      home: raiz,
      socket: caminhoSocket,
      binario,
      extras: {
        COCKPIT_TMUX_SOCKET: `cockpit-offline-pergunta-${process.pid}`,
        COCKPIT_PERGUNTAS_DIR: path.join(raiz, 'perguntas'),
        COCKPIT_PUSH_DIR: path.join(raiz, 'push'),
        COCKPIT_VIGIA_MS: '0',
        COCKPIT_MONITOR_MS: '0',
      },
    });
    const url = '/api/abas/aba-p999999/pergunta';
    const bom = { toolUseId: 'toolu_01B9mvPsNgdPAsTYRBWgoKcv', respostas: [{ opcoes: [0], texto: '' }] };
    const a = await pedir(PORTA, url, 'POST', '{nao json');
    ok(a.status === 400, `JSON inválido → 400 (veio ${a.status})`);
    const b = await pedir(PORTA, url, 'POST', bom);
    ok(b.status === 404, `corpo válido numa aba que não existe → 404 (veio ${b.status})`);
    const c = await pedir(PORTA, url, 'POST', { toolUseId: 1 });
    ok(c.status === 400, `{ toolUseId: 1 } → 400 (veio ${c.status})`);
    const d = await pedir(PORTA, url, 'POST', { ...bom, extra: 1 });
    ok(d.status === 400, `chave extra → 400 (veio ${d.status})`);
    const e = await pedir(PORTA, '/api/abas/aba-p999999/tela', 'GET');
    ok(e.status === 404, `GET …/tela de aba inexistente continua 404 (veio ${e.status})`);
    ok(!/home\/|\.cockpit/.test(a.texto + b.texto + c.texto), 'a resposta de erro não leva caminho');
  } finally {
    if (servidor) await servidor.matar();
    await socket.fechar();
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}

// ---- main ---------------------------------------------------------------------------------------

async function main() {
  await grupo('P-arreio — a TUI falsa desenha igual às telas MEDIDAS', pArreio);
  await grupo('P-pendente — V1-V6', pPendente);
  await grupo('P-situacao — respondida × recusada', pSituacao);
  await grupo('P-corpo — forma do corpo (400)', pCorpo);
  await grupo('P-respostas — conteúdo (400)', pRespostas);
  await grupo('P-plano — as teclas medidas, exatas', pPlano);
  await grupo('P-tela — conferências contra as telas medidas', pTela);
  await grupo('P-executar — a sequência conferida, contra a TUI falsa', pExecutar);
  await grupo('P-integrado — lib/abas.js: tela() → cartao, com tmux real', pIntegrado);
  await grupo('P-rota — POST /api/abas/:chave/pergunta por HTTP', pRota);
}

main().catch((e) => { ok(false, `exceção fora dos grupos — ${e.stack || e.message}`); }).finally(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
  console.log(`\n${acertos} ✅  ${falhas} ❌`);
  if (falhas) process.exitCode = 1;
});
