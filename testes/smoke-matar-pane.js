#!/usr/bin/env node
'use strict';
// SMOKE DE `matarAgora()` SOB A CHAVE POR PANE — o único lugar onde a diferença entre
// `kill-pane` e `kill-window` é exercitada contra um tmux de verdade.
//
// Por que ele existe, e por que NÃO mora no `gate-codex.js`: aquele gate é declarado "zero
// token, zero tmux, zero rede", e ele é o primeiro comando da bateria final. Montar e
// derrubar janelas ali passaria a criar sessões de tmux logo na abertura de todo gate.
//
// O que está em jogo: a chave da aba virou por PANE, e o comando que fecha uma aba passou a
// depender do FORMATO dela. Errar isso não deixa mensagem de erro — mata trabalho vivo. O
// caso concreto medido em 31/08: `aba-p71` (o codex) mora na janela `@5` junto do claude da
// `%5`; um `kill-window` ali leva os dois. É a ARMADILHA #42 ao contrário — o alvo de tmux
// é sempre o objeto que você mediu, nunca o pai dele.
//
// FAIL-CLOSED em quatro camadas, na mesma ordem do `smoke-abas-tmux.js`:
//
//   1. lê o valor HERDADO de COCKPIT_TMUX_SOCKET. Se existir e não casar
//      `^cockpit-matar-probe-`, ABORTA — vazio NÃO aborta, porque `node
//      testes/smoke-matar-pane.js` nu é o comando do próprio gate e ele tem que rodar;
//   2. FABRICA o nome, `cockpit-matar-probe-<pid>`, ignorando qualquer valor herdado;
//   3. RECUSA se aquele socket já existir;
//   4. CARIMBA a posse: a janela âncora nasce com `dono-<pid>-<carimbo>`, e a limpeza
//      confere que ela está lá antes de derrubar qualquer coisa.
//
// Códigos de saída:  0 = verde · 1 = defeito · 2 = ambiente indisponível.
// A ÚLTIMA linha do stdout é o nome do socket — é o que o gate final lê para o teardown.

const http = require('node:http');
const { execFileSync } = require('node:child_process');

let falhas = 0;
let feitos = 0;
const ok = (c, t) => { feitos += 1; if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };

// ─── Fail-closed, na ordem ───────────────────────────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-matar-probe-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — este smoke só trabalha em socket `
    + 'próprio (^cockpit-matar-probe-). Abortando antes de tocar em qualquer coisa.');
  process.exit(1);
}

// `tmux -V` antes de tudo: sem tmux no disco isto é ambiente ausente (2), não defeito (1).
try {
  execFileSync('tmux', ['-V'], { stdio: ['ignore', 'ignore', 'ignore'] });
} catch {
  console.error('⚠ não há tmux nesta máquina — nada a provar aqui.');
  process.exit(2);
}

const SOCKET = `cockpit-matar-probe-${process.pid}`;
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
const SESSAO = 'probe';
const SESSOES_MINHAS = new Set([SESSAO, 'vizinha']);

/** tmux NO SOCKET DE TESTE. Nunca sem `-L`: é a diferença entre o smoke e um acidente. */
function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
}

/** tmux no socket PADRÃO — SÓ LEITURA, e só para a asserção final de que nada dele sumiu. */
function padraoLeitura(args) {
  try {
    return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

// ─── Modo `--teardown <socket>`: só derruba, não testa nada ──────────────────
//
// Ele RECUSA um nome fora do prefixo e um socket sem sessão viva. É o que o `finally` do
// gate final chama, e é por isso que ele não pode aceitar qualquer string: um nome vazio
// ou torto viraria comando de tmux no socket PADRÃO, onde vivem as abas do usuário.
if (process.argv[2] === '--teardown') {
  const alvo = String(process.argv[3] || '');
  if (!/^cockpit-matar-probe-\d+$/.test(alvo)) {
    console.error(`🔴 --teardown recusado: "${alvo}" não é um socket deste smoke.`);
    process.exit(1);
  }
  const vivo = (() => {
    try {
      execFileSync('tmux', ['-L', alvo, 'has-session', '-t', `${SESSAO}:`],
        { stdio: ['ignore', 'ignore', 'ignore'] });
      return true;
    } catch { return false; }
  })();
  if (!vivo) {
    console.error(`🔴 --teardown recusado: o socket "${alvo}" não tem a sessão ${SESSAO} viva.`);
    process.exit(1);
  }
  try {
    execFileSync('tmux', ['-L', alvo, 'kill-server'], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch { /* já foi */ }
  console.log(`socket ${alvo} derrubado`);
  process.exit(0);
}

if (t(['ls'], { tolerante: true }).trim()) {
  console.error(`🔴 o socket ${SOCKET} JÁ EXISTE — não é meu. Abortando.`);
  process.exit(1);
}

t(['new-session', '-d', '-s', SESSAO, '-n', CARIMBO, '-c', '/tmp', 'sleep 900']);

process.env.COCKPIT_TMUX_SOCKET = SOCKET;
process.env.COCKPIT_TMUX_SESSAO = SESSAO;
process.env.COCKPIT_BIN_CLAUDE = '/bin/sleep';
delete process.env.COCKPIT_CARENCIA_ABA_MS;

const abas = require('../lib/abas');

// ─── Utilidades ──────────────────────────────────────────────────────────────

const linhas = (texto) => String(texto).split('\n').map((l) => l.trim()).filter(Boolean);

const janelasDe = (sessao) => linhas(t(['list-windows', '-t', `${sessao}:`, '-F', '#{window_id}'], { tolerante: true }));
const panesDaJanela = (janelaId) => linhas(t(['list-panes', '-t', janelaId, '-F', '#{pane_id}'], { tolerante: true }));
const panesDaSessao = (sessao) => linhas(t(['list-panes', '-s', '-t', `${sessao}:`, '-F', '#{pane_id}'], { tolerante: true }));

const ancora = () => linhas(t(['list-windows', '-t', `${SESSAO}:`, '-F', '#{window_id}\t#{window_name}'], { tolerante: true }))
  .map((l) => l.split('\t')).find(([, nome]) => nome === CARIMBO)?.[0] || null;

/** Deixa a sessão com a âncora e mais nada. Nenhum caso herda contagem do anterior. */
function soAncora() {
  const dono = ancora();
  if (!dono) throw new Error('a janela âncora sumiu — recusando-me a mexer nesta sessão');
  for (const id of janelasDe(SESSAO)) if (id !== dono) t(['kill-window', '-t', id], { tolerante: true });
  return dono;
}

const novaJanela = (nome = 'extra') => t(['new-window', '-d', '-t', `${SESSAO}:`, '-n', nome, '-c', '/tmp',
  '-P', '-F', '#{window_id}', 'sleep 900']).trim();

/** Divide a janela e devolve o `pane_id` da pane NOVA. */
const dividir = (janelaId) => t(['split-window', '-d', '-t', janelaId, '-c', '/tmp',
  '-P', '-F', '#{pane_id}', 'sleep 900']).trim();

const chaveDePane = (paneId) => abas.chaveDaAba({ paneId });
const chaveDeJanela = (janelaId) => abas.chaveDaAba({ janelaId });

const codigoDe = async (p) => p.then(() => null, (e) => e.codigo ?? `sem-codigo:${e.message}`);

const CASOS = [];
const caso = (id, titulo, fn) => CASOS.push({ id, titulo, fn });

// ─── Os casos ────────────────────────────────────────────────────────────────

caso('57', 'pane vizinha: matar `aba-p<b>` usa kill-pane e a janela SOBREVIVE', async () => {
  soAncora();
  const janela = novaJanela('duas-panes');
  const a = panesDaJanela(janela)[0];
  const b = dividir(janela);
  ok(panesDaJanela(janela).length === 2, `a janela ${janela} tem 2 panes antes (${panesDaJanela(janela).join(',')})`);

  const r = await abas.matar(chaveDePane(b)).then((x) => x, (e) => e);
  ok(r && r.morta === true, `matar(${chaveDePane(b)}) responde 200 (${JSON.stringify(r?.message || r)})`);
  // É ISTO que o caso existe para provar: a pane vizinha e a janela continuam de pé. Um
  // `kill-window` aqui teria levado as duas — o defeito que a regra da chave impede.
  ok(janelasDe(SESSAO).includes(janela), 'a JANELA continua viva — não foi kill-window');
  const sobrou = panesDaJanela(janela);
  ok(sobrou.length === 1 && sobrou[0] === a, `e a pane vizinha ${a} continua lá (${sobrou.join(',')})`);
  ok(!panesDaSessao(SESSAO).includes(b), `a pane ${b} morreu, e só ela`);
  soAncora();
});

caso('58', 'última pane da janela: kill-pane degrada e leva a janela; a outra janela vive', async () => {
  soAncora();
  const alvo = novaJanela('uma-pane');
  const fica = novaJanela('fica');
  const pane = panesDaJanela(alvo)[0];
  ok(panesDaJanela(alvo).length === 1, `a janela ${alvo} tem uma pane só (${pane})`);

  const r = await abas.matar(chaveDePane(pane)).then((x) => x, (e) => e);
  ok(r && r.morta === true, `matar(${chaveDePane(pane)}) responde 200 (${JSON.stringify(r?.message || r)})`);
  // O tmux destrói a janela junto ao matar a última pane dela — medido em 31/08. É por isso
  // que o `matarAgora()` não precisa do ramo condicional "é a única pane ⇒ kill-window".
  ok(!janelasDe(SESSAO).includes(alvo), `a janela ${alvo} foi junto — o kill-pane degradou sozinho`);
  ok(janelasDe(SESSAO).includes(fica), `e a janela vizinha ${fica} continua viva`);
  soAncora();
});

caso('59', 'única pane da única janela: 409, e a SESSÃO continua de pé', async () => {
  const dono = soAncora();
  const pane = panesDaJanela(dono)[0];
  ok(panesDaSessao(SESSAO).length === 1, `a sessão tem uma pane só (${pane})`);

  const codigo = await codigoDe(abas.matar(chaveDePane(pane)));
  ok(codigo === 409, `matar a última pane da última janela recusa com 409 (${codigo})`);
  // O `has-session` DEPOIS é o ponto: medido em 27/08, matar a última coisa da sessão leva a
  // SESSÃO inteira. É guarda contra dano colateral, não trava que trava o usuário.
  let viva = true;
  try { t(['has-session', '-t', `${SESSAO}:`]); } catch { viva = false; }
  ok(viva, 'e a sessão continua viva DEPOIS da recusa — conferido com has-session');
  ok(Boolean(ancora()), 'a janela âncora, com o carimbo de posse, continua lá');

  // A mesma guarda pelo lado da chave de JANELA.
  const porJanela = await codigoDe(abas.matar(chaveDeJanela(dono)));
  ok(porJanela === 409, `e a chave de janela na última janela também é 409 (${porJanela})`);
});

caso('60', 'pane que não existe: 404, NÃO 409 — a ordem das checagens', async () => {
  soAncora();
  // Sessão com uma pane só de propósito: é o cenário em que a ordem errada apareceria. Se
  // "é a última" viesse antes de "não existe", uma chave fantasma responderia 409.
  ok(panesDaSessao(SESSAO).length === 1, 'a sessão tem uma pane só — o cenário que separa 404 de 409');
  const codigo = await codigoDe(abas.matar('aba-p999999'));
  ok(codigo === 404, `aba-p999999 é 404 mesmo com uma pane só na sessão (${codigo})`);
  const porJanela = await codigoDe(abas.matar('aba-999999'));
  ok(porJanela === 404, `e aba-999999 (formato de janela) idem (${porJanela})`);
});

caso('61', 'chave forjada de OUTRA sessão do mesmo socket: 404 — o filtro da #41', async () => {
  soAncora();
  novaJanela('companhia');   // a sessão-alvo precisa de 2 janelas, senão o 409 chegaria antes
  t(['new-session', '-d', '-s', 'vizinha', '-n', 'x', '-c', '/tmp', 'sleep 900'], { tolerante: true });
  const janelaDaOutra = janelasDe('vizinha')[0];
  const paneDaOutra = linhas(t(['list-panes', '-t', janelaDaOutra, '-F', '#{pane_id}'], { tolerante: true }))[0];

  const codigo = await codigoDe(abas.matar(chaveDePane(paneDaOutra)));
  ok(codigo === 404, `pane de outra sessão é inalcançável por chave forjada: 404 (${codigo})`);
  ok(janelasDe('vizinha').includes(janelaDaOutra), 'e a janela dela continua viva — job do orquestrador fica fora do alcance');

  const porJanela = await codigoDe(abas.matar(chaveDeJanela(janelaDaOutra)));
  ok(porJanela === 404, `e a chave de JANELA da outra sessão também é 404 (${porJanela})`);
  ok(janelasDe('vizinha').includes(janelaDaOutra), 'a janela dela continua viva depois das duas tentativas');

  t(['kill-session', '-t', 'vizinha'], { tolerante: true });
  soAncora();
});

caso('62', 'chave de JANELA nunca vira `%<n>` acidental — o formato manda no comando', async () => {
  soAncora();
  // Uma janela com TRÊS panes e uma pane `%<n>` cujo número coincide com o `@<n>` do alvo é
  // impossível de montar de propósito; o que se prova aqui é o invariável: uma chave
  // `aba-<n>` só alcança JANELA, e nenhuma pane morre por ela quando a janela não existe.
  const janela = novaJanela('tres-panes');
  dividir(janela);
  dividir(janela);
  const antes = panesDaSessao(SESSAO);
  ok(panesDaJanela(janela).length === 3, `a janela ${janela} tem 3 panes (${panesDaJanela(janela).join(',')})`);

  // `aba-999999` no formato de janela: não existe janela `@999999`, então 404 — e nenhuma
  // pane `%999999` (nem qualquer outra) pode ter sido tocada no caminho.
  const codigo = await codigoDe(abas.matar('aba-999999'));
  ok(codigo === 404, `chave de janela inexistente é 404, nunca um kill-pane às cegas (${codigo})`);
  ok(panesDaSessao(SESSAO).length === antes.length,
    `e NENHUMA pane morreu no caminho (${antes.length} antes, ${panesDaSessao(SESSAO).length} depois)`);
  soAncora();
});

caso('62b', 'janela SEM agente com 3 panes: kill-window, e a aba NÃO volta na lista', async () => {
  soAncora();
  const janela = novaJanela('sem-agente');
  dividir(janela);
  dividir(janela);
  ok(panesDaJanela(janela).length === 3, `a janela ${janela} tem 3 panes (${panesDaJanela(janela).join(',')})`);

  // A regra (a): janela sem CLI em pane nenhuma vira UMA aba, e com 2+ panes essa aba
  // representa a JANELA — chave `aba-<window_id>`. É esta a linha que o usuário vê.
  const lista = await abas.listar();
  const aba = lista.find((a) => a.alvo === janela);
  ok(Boolean(aba), `a janela sem agente aparece como UMA aba na lista (${aba?.chave})`);
  ok(aba?.chave === chaveDeJanela(janela),
    `e a chave dela é a da JANELA, não a de uma das três panes (${aba?.chave} vs ${chaveDeJanela(janela)})`);
  ok(lista.filter((a) => a.alvo === janela).length === 1,
    'UMA aba, não três: pane sem agente não vira linha na lista');

  const r = await abas.matar(aba.chave).then((x) => x, (e) => e);
  ok(r && r.morta === true, `matar(${aba.chave}) responde 200 (${JSON.stringify(r?.message || r)})`);
  // O ponto do caso, e o defeito que a regra da chave conserta: com `kill-pane` aqui, o
  // usuário recebia 200, uma das três panes morria, a janela sobrevivia e a aba VOLTAVA na
  // lista seguinte com a chave da pane seguinte.
  ok(!janelasDe(SESSAO).includes(janela), 'a JANELA inteira morreu — foi kill-window');
  const depois = await abas.listar();
  ok(!depois.some((a) => a.alvo === janela), 'e a aba NÃO volta no listar() seguinte');
  soAncora();
});

// ─── Corrida ─────────────────────────────────────────────────────────────────

// O socket PADRÃO não pode ter perdido janela nenhuma. Comparação de SUBCONJUNTO, não
// textual: o usuário pode abrir uma aba no meio do smoke, e isso não é defeito.
const conjuntoPadrao = () => new Set(linhas(
  padraoLeitura(['list-windows', '-a', '-F', '#{session_name}:#{window_id}']),
));
const PADRAO_ANTES = conjuntoPadrao();

/** Limpeza FAIL-CLOSED: só derruba o que ele mesmo criou, e só com o carimbo na mão. */
function limpar() {
  const vivas = linhas(t(['list-sessions', '-F', '#{session_name}'], { tolerante: true }));
  const intrusas = vivas.filter((s) => !SESSOES_MINHAS.has(s));
  if (intrusas.length) {
    console.error(`  🔴 o socket ${SOCKET} tem sessão que NÃO é minha (${intrusas.join(', ')}) — `
      + 'não dou kill-server. Derrubando só as minhas.');
    for (const s of vivas.filter((x) => SESSOES_MINHAS.has(x))) t(['kill-session', '-t', s], { tolerante: true });
    return;
  }
  if (!ancora() && vivas.length) {
    console.error(`  🔴 a janela âncora (${CARIMBO}) sumiu — não provo a posse deste socket. Não derrubo nada.`);
    return;
  }
  t(['kill-server'], { tolerante: true });
}

(async () => {
  let saida = 0;
  try {
    for (const c of CASOS) {
      console.log(`\n  · caso ${c.id} — ${c.titulo}`);
      try {
        await c.fn();
      } catch (e) {
        ok(false, `caso ${c.id} estourou: ${e.message}`);
      }
    }
  } finally {
    limpar();
    const PADRAO_DEPOIS = conjuntoPadrao();
    const sumiram = [...PADRAO_ANTES].filter((x) => !PADRAO_DEPOIS.has(x));
    ok(sumiram.length === 0,
      `nenhuma janela do socket PADRÃO sumiu${sumiram.length ? ` — SUMIU: ${sumiram.join(', ')}` : ''}`);
    saida = falhas ? 1 : 0;
    console.log(`\n${falhas ? '❌ SMOKE VERMELHO' : '✅ SMOKE VERDE'} — ${feitos - falhas}/${feitos} asserções`);
  }
  // A ÚLTIMA linha do stdout é o nome do socket. O gate final a lê para o `--teardown`, e
  // é por isso que nada pode ser impresso depois dela.
  console.log(SOCKET);
  process.exit(saida);
})().catch((e) => {
  console.error('\n❌ o smoke quebrou:', e.message, '\n');
  limpar();
  console.log(SOCKET);
  process.exit(1);
});
