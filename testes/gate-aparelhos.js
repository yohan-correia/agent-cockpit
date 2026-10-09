#!/usr/bin/env node
'use strict';
// GATE — o nome do aparelho (spec 2026-09-12-nome-do-aparelho-no-push-design.md §7.1).
//
// Prova o backend inteiro: o id derivado, a lista sem credencial, o renomear que não toca a
// inscrição, a régua de injeção de log, as duas rotas novas e as quatro linhas de journal que
// passaram a nomear.
//
// ORDEM DE REQUIRE IMPORTA: nativos → bloqueio de rede → isolamento do ambiente → só então os
// módulos do projeto (`lib/avisos.js` resolve a pasta de push no PRÓPRIO require, lib/avisos.js:19).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

require('node:https').request = () => { throw new Error('rede proibida no gate'); };

// Todo temporário do gate nasce DENTRO desta pasta, apagada no fim.
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-aparelhos-'));

// A proteção REAL é esta linha: sobrescrever INCONDICIONALMENTE, antes do require. `DIR` é const
// de módulo (lib/avisos.js:19) — depois do require não há mais o que fazer. Sem ela, um
// `renomear()` reescreveria o inscricoes.json de PRODUÇÃO, com os aparelhos vivos do dono.
process.env.COCKPIT_PUSH_DIR = fs.mkdtempSync(path.join(RAIZ, 'aparelhos-push-'));
// E a guarda que vale alguma coisa: provar que NÃO é a pasta do dono. Conferir se o tmp começa
// pelo tmp seria tautologia — nunca falharia. O caso real é um TMPDIR apontando para a casa.
if (process.env.COCKPIT_PUSH_DIR.startsWith(os.homedir())) {
  console.error('❌ COCKPIT_PUSH_DIR caiu dentro da casa do dono — abortando antes de escrever');
  process.exit(1);
}
// A guarda A10 de testes/gate-jobs-disco.js reprova quem menciona server.js sem esta variável —
// e A11/A12 sobem server.js de verdade.
process.env.COCKPIT_JOBS_DIR = fs.mkdtempSync(path.join(RAIZ, 'aparelhos-jobs-'));
// `contato()` LANÇA sem isto (lib/avisos.js) e `chaves()` escreve o vapid.json — dentro do
// COCKPIT_PUSH_DIR descartável, por isso a ordem acima importa.
process.env.COCKPIT_CONTATO ||= 'mailto:gate@example.invalid';
delete process.env.COCKPIT_VIGIA_MS;

const DIR_PUSH = process.env.COCKPIT_PUSH_DIR;
const ARQ = path.join(DIR_PUSH, 'inscricoes.json');

const entregas = require('../lib/entregas');
const avisos = require('../lib/avisos');
const push = require('../lib/push');

let falhas = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); if (!cond) falhas += 1; return cond; };

const CHAVES = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const inscricao = (endpoint, extra = {}) => ({ endpoint, keys: { ...CHAVES }, criadoEm: '2026-09-01T10:00:00.000Z', ...extra });

const semear = (itens) => fs.writeFileSync(ARQ, JSON.stringify(itens), { mode: 0o600 });
const lerDisco = () => JSON.parse(fs.readFileSync(ARQ, 'utf8'));
const limpar = () => { try { fs.unlinkSync(ARQ); } catch { /* nunca existiu */ } };

// Captura o que sai pelo console, para os casos que asserem LINHA DE LOG — o que o dono lê no
// journal é a entrega, não o retorno da função.
function capturando(tarefa) {
  const linhas = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => linhas.push(a.join(' '));
  console.error = (...a) => linhas.push(a.join(' '));
  return Promise.resolve()
    .then(tarefa)
    .finally(() => { console.log = log; console.error = err; })
    .then(() => linhas);
}

const ENVIAR_REAL = push.enviar;

// ── A1 — o id é o MESMO nome de arquivo que o livro de entregas grava no disco ───────────────
async function a1() {
  console.log('\nA1 — idDe() é estável, tem 32 hex e bate com o nome de arquivo do livro');
  const e1 = 'https://push.example/aparelho-1';
  const e2 = 'https://push.example/aparelho-2';
  ok(avisos.idDe(e1) === avisos.idDe(e1), 'o mesmo endpoint dá o mesmo id');
  ok(/^[0-9a-f]{32}$/.test(avisos.idDe(e1)), `32 hex (achei "${avisos.idDe(e1)}")`);
  ok(avisos.idDe(e1) !== avisos.idDe(e2), 'endpoints diferentes dão ids diferentes');

  // O livro direto, NÃO por avisar(): ali o evento sai de identidade(), que devolve null sem
  // `marco` válido, e umaVez com evento falso sai antes de tocar o disco — o assert nasceria
  // trivial. O que este caso pega é a CONVENÇÃO de nome de arquivo mudar no livro sem a lista
  // saber. Depois do §2.3, idDe É entregas.resumo: não há mais dois lados a comparar.
  const raiz = fs.mkdtempSync(path.join(RAIZ, 'livro-'));
  await entregas.criar(raiz).umaVez('evento-cravado', e1, async () => 'aceito');
  const arquivos = fs.readdirSync(path.join(raiz, 'evento-cravado'));
  ok(arquivos.some((a) => a.startsWith(avisos.idDe(e1))),
    `o livro gravou o arquivo com o id da lista (achei ${JSON.stringify(arquivos)})`);
}

// ── A2, A3 — listar() ────────────────────────────────────────────────────────────────────────
async function a2e3() {
  console.log('\nA2/A3 — listar() devolve id/nome/criadoEm e NENHUMA credencial');
  const e1 = 'https://push.example/l1';
  const e2 = 'https://push.example/l2';
  semear([inscricao(e1, { aparelho: 'Notebook' }), { endpoint: e2, keys: { ...CHAVES }, criadoEm: null }]);
  const r = await avisos.listar();
  const texto = JSON.stringify(r);
  ok(r.aparelhos.length === 2, `dois aparelhos na lista (achei ${r.aparelhos.length})`);
  // Assert sobre o JSON INTEIRO, não sobre campos escolhidos: é o que pega um campo novo que
  // alguém acrescente amanhã sem pensar.
  ok(!texto.includes('push.example'), 'o JSON inteiro não contém o endpoint');
  ok(!texto.includes(CHAVES.p256dh) && !texto.includes(CHAVES.auth), 'nem as keys');
  ok(Object.keys(r.aparelhos[0]).sort().join(',') === 'criadoEm,id,nome',
    `cada item tem exatamente id/nome/criadoEm (achei ${Object.keys(r.aparelhos[0]).sort().join(',')})`);
  ok(r.aparelhos[0].nome === 'Notebook', 'o nome vem como está no disco');
  ok(r.aparelhos[0].id === avisos.idDe(e1), 'e o id é o derivado do endpoint');
  ok(r.aparelhos[1].nome === null, 'A3: inscrição SEM o campo `aparelho` vem com nome: null');
  ok(r.aparelhos[1].criadoEm === null, 'e criadoEm ausente continua null — a tela decide a legenda');
}

// ── A4, A5, A6 — renomear ────────────────────────────────────────────────────────────────────
async function a4a5a6() {
  console.log('\nA4/A5/A6 — renomear troca SÓ o nome');
  const e1 = 'https://push.example/r1';
  semear([inscricao(e1, { aparelho: 'antigo' })]);
  const antes = lerDisco()[0];

  const r = await avisos.renomear(avisos.idDe(e1), 'Notebook');
  ok(r.renomeados === 1, `A4: renomeados:1 (achei ${r.renomeados})`);
  ok(lerDisco()[0].aparelho === 'Notebook', 'e o disco tem o nome novo');

  const mtimeAntes = fs.statSync(ARQ).mtimeMs;
  const r2 = await avisos.renomear('naoexiste'.padEnd(32, '0'), 'x');
  ok(r2.renomeados === 0, `A5: id desconhecido ⇒ renomeados:0 (achei ${r2.renomeados})`);
  ok(fs.statSync(ARQ).mtimeMs === mtimeAntes, 'e o arquivo NÃO foi regravado');

  const depois = lerDisco()[0];
  ok(depois.endpoint === antes.endpoint, 'A6: o endpoint é idêntico depois de renomear');
  ok(JSON.stringify(depois.keys) === JSON.stringify(antes.keys), 'e as keys também, byte a byte');
  const c = await avisos.conhece(e1);
  ok(c.conhecida === true, 'e conhece() continua true — renomear não invalida a inscrição');
}

// ── A7, A7b — a régua do nome, e a injeção de log ────────────────────────────────────────────
async function a7() {
  console.log('\nA7/A7b — a régua do nome: corte em 80, vazio, e nenhum caractere de controle');
  const e1 = 'https://push.example/n1';
  semear([inscricao(e1)]);
  const id = avisos.idDe(e1);

  ok((await avisos.renomear(id, 'x'.repeat(200))).nome.length === 80, 'A7: 200 caracteres viram 80');
  ok((await avisos.renomear(id, '     ')).nome === '', 'só espaços vira string vazia');
  ok((await avisos.renomear(id, null)).nome === '', 'null vira string vazia');
  ok((await avisos.renomear(id, undefined)).nome === '', 'ausente vira string vazia');

  // A7b: um `\n` no nome FABRICA uma linha de journal inteira. A régua mata controle e bidi.
  const sujo = 'Note\nbook\r\u001b[31m\u202EFAKE';
  const limpo = (await avisos.renomear(id, sujo)).nome;
  ok(!/[\u0000-\u001f\u007f\u202A-\u202E\u2066-\u2069]/.test(limpo),
    `A7b: nenhum controle nem bidi sobra (achei ${JSON.stringify(limpo)})`);
  ok(limpo.includes('Note') && limpo.includes('book'), 'e o texto legítimo continua lá');

  // O ZWJ (U+200D) NÃO é controle: a régua é \p{Cc} + os bidi, não \p{Cf} inteiro — senão
  // "👨‍💻 Notebook" viraria glifos soltos, calado.
  const emoji = '\u{1F468}\u200D\u{1F4BB} Notebook';
  ok((await avisos.renomear(id, emoji)).nome === emoji, 'e o emoji composto atravessa intacto, com o ZWJ');

  // A MESMA régua na outra porta de entrada: inscrever(). Sem isso a injeção volta pela
  // inscrição, que é justamente a porta que o dono não controla.
  const ins = await avisos.inscrever({ endpoint: 'https://push.example/n2', keys: { ...CHAVES }, aparelho: sujo });
  ok(!/[\u0000-\u001f\u007f\u202A-\u202E\u2066-\u2069]/.test(ins.nome),
    `A7b: inscrever() limpa igual (achei ${JSON.stringify(ins.nome)})`);
  ok(lerDisco().find((i) => i.endpoint === 'https://push.example/n2').aparelho === ins.nome,
    'e o que ele DEVOLVE é o que ficou no disco — server.js loga esse valor');

  // O caso LEGADO: um inscricoes.json escrito pelo slice(0,80) de hoje, que aceita \n no meio.
  // Sanitizar só o que entra deixaria o valor ANTIGO fabricando linha no log.
  semear([inscricao('https://push.example/legado', { aparelho: 'Velho\nPOSANDO: de servidor' })]);
  const lista = await avisos.listar();
  ok(!lista.aparelhos[0].nome.includes('\n'),
    `A7b legado: o nome sujo do disco sai limpo do listar() (achei ${JSON.stringify(lista.aparelhos[0].nome)})`);

  // E a contagem de linhas do journal: UMA por aparelho, não duas.
  push.enviar = async () => ({ status: 403 });
  const linhas = await capturando(() => avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: null, tag: 'a7b' }));
  push.enviar = ENVIAR_REAL;
  ok(linhas.length === 1, `A7b: uma linha de journal para um aparelho (achei ${linhas.length})`);
  ok(!linhas.join('\n').includes('POSANDO:\n') && linhas[0].split('\n').length === 1,
    'e ela não tem quebra no meio — o nome sujo não fabricou linha');
}

// ── A8 — o id que volta de conhece() e inscrever() ───────────────────────────────────────────
async function a8() {
  console.log('\nA8 — conhece() e inscrever() devolvem o id');
  const e1 = 'https://push.example/i1';
  limpar();
  const r1 = await avisos.inscrever({ endpoint: e1, keys: { ...CHAVES }, aparelho: 'Celular' });
  ok(r1.id === avisos.idDe(e1), 'inscrever() devolve o id derivado do endpoint');
  ok(r1.nome === 'Celular', 'e o nome já limpo');
  const r2 = await avisos.inscrever({ endpoint: e1, keys: { ...CHAVES }, aparelho: 'Celular novo' });
  ok(r2.id === r1.id, 'reinscrever no MESMO endpoint dá o MESMO id — o §4.4 depende disso');
  ok(r2.inscritos === 1, 'e não duplica a inscrição');

  const c1 = await avisos.conhece(e1);
  ok(c1.conhecida === true && c1.id === r1.id, 'conhece() de inscrição conhecida devolve o id');
  const c2 = await avisos.conhece('https://push.example/nunca-vista');
  ok(c2.conhecida === false && c2.id === null, 'e de desconhecida devolve id: null');
}

// ── A9, A9b, A9c — a fila, e o que listar() faz com arquivo ausente/ilegível ─────────────────
async function a9() {
  console.log('\nA9 — renomear e descadastrar REALMENTE simultâneos: não ressuscita');
  const e1 = 'https://push.example/s1';
  const e2 = 'https://push.example/s2';
  semear([inscricao(e1, { aparelho: 'a' }), inscricao(e2, { aparelho: 'b' })]);

  // Os DOIS disparados sem await no meio — é isso que faz o entrelaçamento existir. O roteiro
  // sequencial (await entre os dois) passaria verde com ou sem fila.
  const pRenomear = avisos.renomear(avisos.idDe(e1), 'Notebook');
  const pRemover = avisos.descadastrar(e1);
  const [rn] = await Promise.all([pRenomear, pRemover]);

  const disco = lerDisco();
  // O assert é sobre o ESTADO FINAL do disco, e só sobre ele: prova o invariante "não
  // ressuscita". Ele NÃO detecta a remoção do naFila — sem a fila, a ressurreição depende do
  // entrelaçamento de I/O e pode não acontecer na rodada. Prometer detecção seria dívida.
  ok(!disco.some((i) => i.endpoint === e1),
    `o endpoint descadastrado não voltou ao inscricoes.json (achei ${JSON.stringify(disco.map((i) => i.endpoint))})`);
  ok(disco.some((i) => i.endpoint === e2), 'e o vizinho continua inscrito');
  ok(typeof rn.renomeados === 'number', 'A9b: qual dos dois chegou primeiro é legítimo variar — renomeados não é asserido');

  console.log('\nA9c — listar() com o arquivo ausente e com o arquivo ilegível');
  limpar();
  ok(JSON.stringify(await avisos.listar()) === '{"aparelhos":[]}', 'arquivo ausente ⇒ { aparelhos: [] }');
  fs.writeFileSync(ARQ, '{isto não é json', { mode: 0o600 });
  let rejeitou = false;
  try { await avisos.listar(); } catch { rejeitou = true; }
  ok(rejeitou, 'arquivo ilegível ⇒ rejeita, como hoje — devolver [] seria o silêncio que o comentário existe para impedir');
  limpar();
}

// ── A10 — nomes na ORDEM do inscricoes.json, não na da rede ─────────────────────────────────
async function a10() {
  console.log('\nA10 — avisar() devolve os nomes dos aceitos, na ordem do disco');
  limpar();
  ok(JSON.stringify((await avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: null, tag: 'vazio' })).nomes) === '[]',
    'sem inscrito: nomes: []');

  const e1 = 'https://push.example/o1';
  const e2 = 'https://push.example/o2';
  const e3 = 'https://push.example/o3';
  semear([inscricao(e1, { aparelho: 'Um' }), inscricao(e2, { aparelho: '' }), inscricao(e3, { aparelho: 'Tres' })]);

  // Atrasos INVERTIDOS: o terceiro responde primeiro. Sem o índice, a ordem de `nomes` seria a
  // da rede e o par exibido na tela mudaria a cada clique.
  push.enviar = async ({ inscricao: i }) => {
    const ms = i.endpoint === e3 ? 0 : i.endpoint === e2 ? 20 : 40;
    await new Promise((r) => setTimeout(r, ms));
    return { status: 201 };
  };
  const r = await avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: null, tag: 'ordem' });
  push.enviar = ENVIAR_REAL;
  ok(JSON.stringify(r.nomes) === '["Um","Tres"]',
    `a ordem é a do inscricoes.json mesmo com o 3º respondendo antes (achei ${JSON.stringify(r.nomes)})`);
  ok(r.enviados === 3, 'os três foram aceitos — o vazio conta em `enviados`, só não entra em `nomes`');
}

// ── A13, A13b, A13c — as linhas de log ──────────────────────────────────────────────────────
async function a13() {
  console.log('\nA13 — as três linhas de avisar() nomeiam E mantêm o host');
  const e1 = 'https://fcm.example.test/aparelho-um';
  semear([inscricao(e1, { aparelho: 'Notebook' })]);

  push.enviar = async () => ({ status: 403 });      // definitiva ⇒ "recusou"
  let linhas = await capturando(() => avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: null, tag: 'l1' }));
  push.enviar = ENVIAR_REAL;
  ok(linhas.some((l) => l.includes('Notebook') && l.includes('fcm.example.test') && l.includes('recusou')),
    `a linha de recusa nomeia e mantém o host (achei ${JSON.stringify(linhas)})`);
  ok(!linhas.join('').includes('/aparelho-um'), 'e nenhuma linha traz o endpoint inteiro');

  push.enviar = async () => ({ status: 503 });      // transitória ⇒ "nova tentativa em"
  linhas = await capturando(() => avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: null, tag: 'l2' }));
  push.enviar = ENVIAR_REAL;
  ok(linhas.some((l) => l.includes('Notebook') && l.includes('fcm.example.test') && l.includes('nova tentativa em')),
    `a linha de nova tentativa também (achei ${JSON.stringify(linhas)})`);
  await avisos.descartarPendentes('l2');

  console.log('\nA13b — rotuloDeLog: 32 sai como nome, 33 vira id de 8 hex, nunca some');
  const n32 = 'x'.repeat(32);
  const n33 = 'x'.repeat(33);
  ok(avisos.rotuloDeLog(n32, e1) === n32, 'nome de 32 sai como nome');
  ok(avisos.rotuloDeLog(n33, e1) === avisos.idDe(e1).slice(0, 8),
    `nome de 33 vira o id de 8 hex (achei "${avisos.rotuloDeLog(n33, e1)}")`);
  ok(avisos.rotuloDeLog(null, e1) === avisos.idDe(e1).slice(0, 8), 'sem nome, idem — a linha nunca fica sem identificador');
  const daLista = (await avisos.listar()).aparelhos[0].id;
  ok(avisos.rotuloDeLog(null, e1) === daLista.slice(0, 8), 'e o id impresso é o MESMO que a lista mostra');

  console.log('\nA13c — o rótulo que chega ao LIVRO usa nomeCurto, não rotuloDeLog');
  // O livro já imprime o id (lib/entregas.js): o fallback ali daria "aparelho 9f8e7d6c
  // (9f8e7d6c)" — duplicado, e seria o que o dono veria PRIMEIRO com os 3 aparelhos de hoje.
  const livro = entregas.criar(fs.mkdtempSync(path.join(RAIZ, 'livro-rotulo-')));
  let saida = await capturando(async () => {
    await livro.umaVez('ev-a13c', e1, async () => 'aceito', { rotulo: 'Notebook' });
    await livro.umaVez('ev-a13c', e1, async () => 'aceito', { rotulo: 'Notebook' });
  });
  ok(saida.some((l) => l.includes(`aparelho ${avisos.idDe(e1).slice(0, 8)} (Notebook)`)),
    `com rótulo, a linha do livro traz o nome depois do id (achei ${JSON.stringify(saida)})`);

  const livro2 = entregas.criar(fs.mkdtempSync(path.join(RAIZ, 'livro-sem-rotulo-')));
  saida = await capturando(async () => {
    await livro2.umaVez('ev-a13c', e1, async () => 'aceito');
    await livro2.umaVez('ev-a13c', e1, async () => 'aceito');
  });
  ok(saida.some((l) => l.includes(`aparelho ${avisos.idDe(e1).slice(0, 8)}: aceito, não reenviado`)),
    `sem rótulo, a linha sai EXATAMENTE como hoje (achei ${JSON.stringify(saida)})`);

  // E o caminho de verdade: avisar() com nome comprido passa nomeCurto ⇒ null ⇒ linha de hoje.
  semear([inscricao(e1, { aparelho: 'y'.repeat(60) })]);
  ok(avisos.nomeDeAparelho({ aparelho: 'y'.repeat(60) }).length === 60, 'nomeDeAparelho devolve o nome inteiro (a régua é de quem loga)');
}

// ── A11, A12 — as rotas, por HTTP de verdade, em servidor filho isolado ─────────────────────
async function rotas() {
  console.log('\nA11/A12 — as duas rotas novas, por HTTP, com servidor filho isolado');
  const root = path.resolve(__dirname, '..');

  async function portaLivre() {
    const servidor = net.createServer();
    await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
    const porta = servidor.address().port;
    await new Promise((resolve) => servidor.close(resolve));
    return porta;
  }

  function pedir(porta, rota, metodo, corpo, token) {
    return new Promise((resolve, reject) => {
      const dados = corpo === undefined ? null : Buffer.from(JSON.stringify(corpo));
      const cabecalhos = {};
      if (dados) { cabecalhos['content-type'] = 'application/json'; cabecalhos['content-length'] = dados.length; }
      if (token) cabecalhos.authorization = `Bearer ${token}`;
      const req = http.request({ hostname: '127.0.0.1', port: porta, path: rota, method: metodo, headers: cabecalhos }, (res) => {
        let texto = '';
        res.on('data', (d) => { texto += d; });
        res.on('end', () => resolve({ status: res.statusCode, texto }));
      });
      req.on('error', reject);
      req.end(dados);
    });
  }

  async function withServer(extra, tarefa) {
    const porta = await portaLivre();
    const home = fs.mkdtempSync(path.join(RAIZ, 'aparelhos-servidor-'));
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (/^(COCKPIT_|CODEX_|CLAUDE|ANTHROPIC_|OPENAI_)/.test(k)) delete base[k];
    Object.assign(base, {
      HOME: home, HOST: '127.0.0.1', PORT: String(porta),
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TMUX_SOCKET: `cockpit-aparelhos-${process.pid}`,
      COCKPIT_JOBS_DIR: fs.mkdtempSync(path.join(RAIZ, 'aparelhos-jobs-servidor-')),
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_CONTATO: 'mailto:gate@example.invalid',
      ...extra,
    });
    const child = spawn(process.execPath, ['server.js'], { cwd: root, env: base, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout servidor')), 10000);
        child.stdout.on('data', (d) => { if (String(d).includes('cockpit-agentes em')) { clearTimeout(t); resolve(); } });
        child.once('exit', (codigo) => { clearTimeout(t); reject(new Error(`servidor saiu ${codigo}`)); });
      });
      await tarefa(porta);
    } finally {
      // #24: o filho morre no finally, exista sucesso ou falha no teste.
      if (child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
    }
  }

  const TOKEN = 'token-do-gate-aparelhos';
  const endpoint = 'https://fcm.example.test/o-aparelho-do-gate';
  const dir = fs.mkdtempSync(path.join(RAIZ, 'aparelhos-push-servidor-'));
  fs.writeFileSync(path.join(dir, 'inscricoes.json'),
    JSON.stringify([inscricao(endpoint, { aparelho: 'Notebook' })]), { mode: 0o600 });
  const id = avisos.idDe(endpoint);

  await withServer({ COCKPIT_PUSH_DIR: dir, COCKPIT_TOKEN: TOKEN }, async (porta) => {
    // A11: o 401 só existe com token configurado (server.js: `if (TOKEN) { … }`) — por isso o
    // filho sobe COM a variável. A primeira rota que LISTA aparelhos tem de estar fechada.
    const semToken = await pedir(porta, '/api/push/inscricoes', 'GET');
    ok(semToken.status === 401, `A11: GET /api/push/inscricoes sem token ⇒ 401 (achei ${semToken.status})`);

    const r = await pedir(porta, '/api/push/inscricoes', 'GET', undefined, TOKEN);
    ok(r.status === 200, `com token ⇒ 200 (achei ${r.status})`);
    ok(!r.texto.includes('o-aparelho-do-gate') && !r.texto.includes(CHAVES.p256dh),
      'e o corpo não contém o endpoint nem as keys');
    ok(JSON.parse(r.texto).aparelhos[0].id === id, 'o id da lista é o derivado');

    // A12
    const feliz = await pedir(porta, '/api/push/inscricao/nome', 'POST', { id, nome: 'Note da sala' }, TOKEN);
    ok(feliz.status === 200, `A12: caminho feliz ⇒ 200 (achei ${feliz.status})`);
    ok(JSON.parse(feliz.texto).nome === 'Note da sala', 'e devolve o nome como ficou no disco');
    ok(JSON.parse(fs.readFileSync(path.join(dir, 'inscricoes.json'), 'utf8'))[0].aparelho === 'Note da sala',
      'e o disco tem o nome novo');

    const semId = await pedir(porta, '/api/push/inscricao/nome', 'POST', { nome: 'x' }, TOKEN);
    ok(semId.status === 400, `sem id ⇒ 400 (achei ${semId.status})`);
    const idRuim = await pedir(porta, '/api/push/inscricao/nome', 'POST', { id: 'a'.repeat(32), nome: 'x' }, TOKEN);
    ok(idRuim.status === 404, `id desconhecido ⇒ 404 (achei ${idRuim.status})`);

    // A7b na ROTA: um gate que só olha o retorno passa verde com o buraco aberto no journal.
    const sujo = await pedir(porta, '/api/push/inscricao/nome', 'POST', { id, nome: 'Note\nPOSANDO: de servidor' }, TOKEN);
    ok(!JSON.parse(sujo.texto).nome.includes('\n'), 'e o nome sujo volta limpo da rota');
  });
}

(async () => {
  try {
    await a1();
    await a2e3();
    await a4a5a6();
    await a7();
    await a8();
    await a9();
    await a10();
    await a13();
    await rotas();
  } finally {
    push.enviar = ENVIAR_REAL;
    fs.rmSync(RAIZ, { recursive: true, force: true });
  }
  console.log(`\ngate-aparelhos: ${falhas} falha(s)`);
  if (falhas) process.exit(1);
  console.log('✅ GATE VERDE — o nome do aparelho');
})().catch((erro) => { console.error(erro); process.exit(1); });
