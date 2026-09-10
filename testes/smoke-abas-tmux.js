#!/usr/bin/env node
'use strict';
// SMOKE DE `criar`/`matar` NUM SOCKET DE TESTE — o único lugar onde o caminho feliz é
// exercitado de verdade, porque é o único que tem socket próprio.
//
// Por que ele existe: `lib/abas.js` passou a MATAR janela, e as janelas do socket padrão
// são as do usuário (Projeto-a, Projeto-d, Projeto-b e mais seis). Medido em 27/08: `kill-window`
// na ÚLTIMA janela de uma sessão DESTRÓI A SESSÃO INTEIRA. Um smoke desatento aqui não
// deixa mensagem de erro — deixa o usuário sem terminal.
//
// Por isso ele é FAIL-CLOSED em quatro camadas, nesta ordem (a ordem é o que faz a guarda
// valer):
//
//   1. lê o valor HERDADO de COCKPIT_TMUX_SOCKET. Se existir e não casar `^cockpit-smoke-`,
//      ABORTA — `cockpit` é o socket do próprio cockpit (lib/sessoes.js) e um `kill-server`
//      nele derrubaria as sessões dele. Vazio não aborta: é o caso normal, e o passo 2 o
//      preenche;
//   2. FABRICA o nome, `cockpit-smoke-<pid>`, ignorando qualquer valor herdado — quem
//      escolhe o socket é o script, não quem o chamou;
//   3. RECUSA se aquele socket já existir;
//   4. CARIMBA a posse: a janela âncora nasce com o nome `dono-<pid>-<carimbo>`, e o
//      `finally` confere que ela está lá antes de derrubar qualquer coisa.
//
// Só então `process.env.COCKPIT_TMUX_SOCKET` é escrito e `lib/abas.js` é carregado.
//
// Códigos de saída:  0 = verde · 1 = defeito · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

let falhas = 0;
let feitos = 0;
const ok = (c, t) => { feitos += 1; if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };

// ─── Fail-closed, na ordem ───────────────────────────────────────────────────

// (1) O valor herdado. Só o nosso prefixo passa; qualquer outro aborta antes de tudo.
const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — este smoke só trabalha em socket `
    + 'próprio (^cockpit-smoke-). Abortando antes de tocar em qualquer coisa.');
  process.exit(1);
}

// (2) O nome é FABRICADO aqui. Nada do ambiente entra nele.
const SOCKET = `cockpit-smoke-${process.pid}`;
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
const SESSOES_MINHAS = new Set(['teste', 'outra']);

/** tmux NO SOCKET DE TESTE. Nunca sem `-L`: é a diferença entre o smoke e um acidente. */
function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
}

/** tmux no socket PADRÃO — SÓ LEITURA, e só para a asserção 10. */
function padraoLeitura(args) {
  try {
    return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

// (3) O socket não pode existir. Se existir, é de outra pessoa.
if (t(['ls'], { tolerante: true }).trim()) {
  console.error(`🔴 o socket ${SOCKET} JÁ EXISTE — não é meu. Abortando.`);
  process.exit(1);
}

// (4) A sessão de teste, com a janela âncora carimbada.
t(['new-session', '-d', '-s', 'teste', '-n', CARIMBO, '-c', '/tmp', 'sleep 600']);

process.env.COCKPIT_TMUX_SOCKET = SOCKET;
process.env.COCKPIT_TMUX_SESSAO = 'teste';
// O bloco A roda SEM `claude` no disco e sem login: `criar()` sempre valida o binário, então
// dizer "estes casos não dependem do CLI" enquanto eles chamam `criar()` seria falso.
process.env.COCKPIT_BIN_CLAUDE = '/bin/sleep';
delete process.env.COCKPIT_CARENCIA_ABA_MS;

const abas = require('../lib/abas');

// ─── Utilidades dos casos ────────────────────────────────────────────────────

const servidores = [];   // { nome, filho } — mortos pelo PID exato no finally (#24)

const janelasDe = (sessao) => t(['list-windows', '-t', `${sessao}:`, '-F', '#{window_id}'], { tolerante: true })
  .split('\n').map((l) => l.trim()).filter(Boolean);

const ancora = () => t(['list-windows', '-t', 'teste:', '-F', '#{window_id}\t#{window_name}'], { tolerante: true })
  .split('\n').map((l) => l.split('\t')).find(([, nome]) => nome === CARIMBO)?.[0] || null;

/** Deixa a sessão `teste` com a âncora e mais nada. Nenhum caso herda contagem do anterior. */
function soAncora() {
  const dono = ancora();
  if (!dono) throw new Error('a janela âncora sumiu — recusando-me a mexer nesta sessão');
  for (const id of janelasDe('teste')) if (id !== dono) t(['kill-window', '-t', id], { tolerante: true });
  return dono;
}

const novaJanela = (nome = 'extra') => t(['new-window', '-d', '-t', 'teste:', '-n', nome, '-c', '/tmp',
  '-P', '-F', '#{window_id}', 'sleep 600']).trim();

/**
 * A CHAVE da aba que aquela janela produz no `listar()`.
 *
 * A chave é por PANE desde 31/08, e as janelas deste smoke têm uma pane só — então a aba
 * É a pane e leva `aba-p<pane_id>`. Resolver aqui, e não montar `aba-<window_id>` à mão, é
 * o que impede o smoke de afirmar uma chave que o módulo nunca produz: sem isto todo caso
 * de 404/409 passaria por acidente, pela chave errada.
 */
const paneDaJanela = (janelaId) => t(['list-panes', '-t', janelaId, '-F', '#{pane_id}'], { tolerante: true })
  .split('\n').map((l) => l.trim()).filter(Boolean)[0] || null;
const chaveDe = (janelaId) => {
  const pane = paneDaJanela(janelaId);
  if (!pane) throw new Error(`a janela ${janelaId} não tem pane — não há chave a montar`);
  return abas.chaveDaAba({ paneId: pane });
};

const codigoDe = async (p) => p.then(() => null, (e) => e.codigo ?? `sem-codigo:${e.message}`);

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * O ambiente do BLOCO B: um projeto de verdade em `~/projetos` e o `claude` no disco.
 *
 * Faltando qualquer um dos dois, o bloco B inteiro vai para a lista de smoke manual
 * PENDENTE do relatório, nomeado caso a caso — e o smoke sai com 2, não com 0. Isso não
 * reprova as travas: o bloco A roda sem `claude` nenhum e é nele que mora o risco de
 * destruir a sessão do usuário.
 */
function ambienteDoBlocoB() {
  const raiz = path.join(os.homedir(), 'projetos');
  let primeiro = null;
  try {
    primeiro = fs.readdirSync(raiz, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))[0] || null;
  } catch { primeiro = null; }
  if (!primeiro) return { pronto: false, porque: 'não há projeto em ~/projetos' };
  const bin = '/usr/bin/claude';
  const info = fs.statSync(bin, { throwIfNoEntry: false });
  if (!info || !info.isFile()) return { pronto: false, porque: `não há claude em ${bin}` };
  try { fs.accessSync(bin, fs.constants.X_OK); } catch {
    return { pronto: false, porque: `${bin} não é executável` };
  }
  return { pronto: true, nome: primeiro, cwd: path.join(raiz, primeiro) };
}

const PROJETO = ambienteDoBlocoB();
// As abas que o bloco B criou com `claude` de verdade. O `finally` não depende disto (o
// `kill-server` do socket leva tudo), mas os casos 12 e 13 precisam saber qual foi a última.
const criadasNoB = [];

/**
 * Quem está ESCUTANDO nesta porta, em qualquer endereço — a linha crua do `ss`, ou `null`.
 *
 * Sem filtro de endereço de propósito: um servidor em `0.0.0.0` e um em `127.0.0.1` brigam
 * pela mesma porta, e o que interessa aqui é a briga, não o endereço.
 */
function quemEscuta(porta) {
  try {
    const linha = execFileSync('ss', ['-H', '-lptn', `sport = :${porta}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\n').map((l) => l.trim()).filter(Boolean)[0];
    return linha || null;
  } catch {
    // `ss` ausente ou recusado: não dá para PROVAR que a porta está livre. Devolver `null`
    // aqui seria dizer "livre" sem ter olhado, que é justamente o pecado que este conserto
    // veio corrigir — então o chamador trata a incerteza como ocupada.
    return 'não deu para consultar o ss — porta indeterminada';
  }
}

/**
 * Sobe um `node server.js` e espera o `/health`. Morto pelo PID exato no finally (#24):
 * `pkill node` derrubaria a produção, que é node também e mora na 7879.
 *
 * 🔴 ABORTA se a porta já tiver dono, e isso NÃO é zelo — é o conserto de um defeito medido.
 * O laço abaixo pergunta `/health` na porta, não ao filho. Com a porta ocupada, o filho morre
 * de EADDRINUSE alguns milissegundos DEPOIS da primeira volta, e nessa primeira volta quem
 * responde 200 é o INTRUSO: `subirServidor` devolvia `pronto: true` e o caso seguia
 * conversando com um servidor que não era o dele. Foi assim que o caso 9e, em 05/09, mandou
 * um DELETE de aba para a produção e matou a janela `main:@1` do usuário — e o smoke ainda
 * assim saiu verde. Checar a porta ANTES do spawn é o que faz o `/health` voltar a ser prova
 * de que o NOSSO servidor subiu.
 */
async function subirServidor(nome, porta, extra = {}) {
  const dono = quemEscuta(porta);
  if (dono) {
    throw new Error(`a porta ${porta} (${nome}) já tem dono — ${dono}. `
      + 'Não subo em cima: o /health responderia pelo intruso e o caso falaria com ele.');
  }
  const ambiente = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(porta),
    COCKPIT_CERT_DIR: '/dev/null',   // sem isto o gate HTTP colhe 301 sem explicação (#19)
    COCKPIT_TMUX_SOCKET: SOCKET,
    COCKPIT_TMUX_SESSAO: 'teste',
    COCKPIT_JOBS_DIR: path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`), // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
    ...extra,
  };
  if (extra.COCKPIT_TOKEN === undefined) delete ambiente.COCKPIT_TOKEN;
  // `null` = APAGAR do ambiente do filho. Env var de processo já nascido não se troca, então
  // cada servidor nasce com o ambiente que ele precisa — é por isso que S1, S2 e S5 são
  // processos distintos em portas distintas, e não um só reconfigurado.
  for (const [k, valor] of Object.entries(extra)) if (valor === null) delete ambiente[k];
  const filho = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: ambiente, stdio: ['ignore', 'ignore', 'pipe'],
  });
  servidores.push({ nome, filho });
  // O `stderr` era `pipe` e ninguém lia: o filho morria CALADO e sobrava um `pronto: false`
  // sem motivo. Lido, ele vira a primeira linha do relatório quando algo dá errado.
  let erroDoFilho = '';
  filho.stderr.on('data', (b) => { erroDoFilho += b; });
  for (let i = 0; i < 60; i += 1) {
    if (filho.exitCode !== null) {
      const porque = erroDoFilho.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
      return { filho, pronto: false, porque: porque || `saiu com ${filho.exitCode}, sem dizer nada` };
    }
    if (await pedir(porta, 'GET', '/health').then((r) => r.status === 200, () => false)) {
      return { filho, pronto: true };
    }
    await espera(200);
  }
  return { filho, pronto: false, porque: `não respondeu /health em 12 s na porta ${porta}` };
}

function pedir(porta, metodo, rota, { corpo, token } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (corpo) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port: porta, path: rota, method: metodo, headers }, (res) => {
      let dados = '';
      res.on('data', (d) => { dados += d; });
      res.on('end', () => {
        let json = {};
        try { json = dados ? JSON.parse(dados) : {}; } catch { json = { cru: dados }; }
        resolve({ status: res.statusCode, corpo: json });
      });
    });
    req.on('error', reject);
    if (corpo) req.write(JSON.stringify(corpo));
    req.end();
  });
}

// ─── Os casos ────────────────────────────────────────────────────────────────

const CASOS = [];
const caso = (id, bloco, titulo, fn) => CASOS.push({ id, bloco, titulo, fn });

// Rodar um subconjunto. Existe para o vermelho da Fase 4 ser determinístico: os casos do
// bloco B dependem de `claude`, login e projeto, e sairiam com código 2 antes de chegar às
// rotas — o vermelho ficaria invisível.
const SO_ESTES = (process.env.SMOKE_CASOS || '').split(',').map((x) => x.trim()).filter(Boolean);

// O S1 é UM só, compartilhado pelos casos que falam HTTP com socket próprio. Nasce sem
// COCKPIT_BIN_CLAUDE (o padrão /usr/bin/claude, que é o que o bloco B exerce) e sem
// COCKPIT_TOKEN — o servidor só exige token quando a var existe, então o smoke nunca
// precisa de segredo e nunca lê o ~/.secrets.
let s1 = null;
async function garantirS1() {
  if (!s1) s1 = await subirServidor('S1', 7898, { COCKPIT_BIN_CLAUDE: null });
  return s1;
}

// ── BLOCO A — as travas. Rodam com COCKPIT_BIN_CLAUDE=/bin/sleep, sem `claude` nenhum.
//    É aqui que mora o risco de destruir a sessão do usuário.

caso('1', 'A', 'R1 — matar a ÚLTIMA janela da sessão é recusado com 409', async () => {
  const dono = soAncora();
  const codigo = await codigoDe(abas.matar(chaveDe(dono)));
  ok(codigo === 409, `matar a única janela recusa com 409 (${codigo})`);
  ok(janelasDe('teste').length === 1, 'e a sessão continua viva, com a janela dela');
});

caso('2', 'A', 'R11 — dois DELETE simultâneos não furam a guarda da última janela', async () => {
  const dono = soAncora();
  const extra = novaJanela('toctou');
  // A âncora vai no SEGUNDO pedido de propósito: a fila destrutiva atende na ordem de
  // registro, então quem morre é a `extra` e o carimbo de posse sobrevive ao caso. A
  // asserção é a mesma — um mata, o outro recusa —, e o smoke não perde a prova da posse.
  const p1 = abas.matar(chaveDe(extra));
  const p2 = abas.matar(chaveDe(dono));
  const [r1, r2] = await Promise.allSettled([p1, p2]);
  const codigos = [r1, r2].map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason.codigo));
  ok(codigos.filter((c) => c === 'ok').length === 1 && codigos.includes(409),
    `um mata e o outro recusa com 409 (${codigos.join(', ')})`);
  ok(janelasDe('teste').length === 1, 'e a sessão SOBREVIVE, com uma janela');
});

caso('3', 'A', 'janela fechada por fora → 404, e nenhuma outra morre', async () => {
  soAncora();
  const some = novaJanela('vai-sumir');
  const fica = novaJanela('fica');
  // A chave sai da pane, e a pane some junto com a janela: colher DEPOIS do kill-window
  // deixaria o caso sem chave nenhuma para provar o 404.
  const chaveDoQueSome = chaveDe(some);
  t(['kill-window', '-t', some]);
  const codigo = await codigoDe(abas.matar(chaveDoQueSome));
  ok(codigo === 404, `chave de aba que já sumiu é 404 (${codigo})`);
  ok(janelasDe('teste').includes(fica), 'e a janela vizinha continua lá');
  soAncora();
});

caso('4', 'A', 'chave de OUTRA sessão do mesmo socket → 404 (o filtro da #41)', async () => {
  soAncora();
  novaJanela('companhia');   // a sessão-alvo precisa de 2 janelas: senão o 409 chegaria antes
  t(['new-session', '-d', '-s', 'outra', '-n', 'x', '-c', '/tmp', 'sleep 600'], { tolerante: true });
  const daOutra = janelasDe('outra')[0];
  const codigo = await codigoDe(abas.matar(chaveDe(daOutra)));
  ok(codigo === 404, `janela de outra sessão é inalcançável: 404 (${codigo})`);
  ok(janelasDe('outra').includes(daOutra), 'e ela continua viva — job do orquestrador fica fora do alcance');
  t(['kill-session', '-t', 'outra'], { tolerante: true });
  soAncora();
});

caso('5', 'A', 'chave malformada → 400, antes de qualquer comando de tmux', async () => {
  soAncora();
  for (const ruim of ['aba-x', 'aba-', '', 'aba-1x', '../etc', 'aba-p', 'aba-px', 'aba-p1x']) {
    const codigo = await codigoDe(abas.matar(ruim));
    ok(codigo === 400, `chave ${JSON.stringify(ruim)} recusa com 400 (${codigo})`);
  }
});

caso('6', 'A', 'criar() devolve chave aba-pN SEM \\n e a janela aparece em listar() na hora', async () => {
  soAncora();
  const nova = await abas.criar({ cwd: '/tmp', nome: 'projeto-smoke' });
  // `aba-p<pane_id>`: o `-P -F` do `criar()` colhe `#{pane_id}`. Se ele colhesse o
  // `#{window_id}`, a chave indexaria `aba-7` enquanto o `listar()` produz `aba-p71` — a
  // aba nova ficaria presa em `nascendo` e o 201 devolveria chave que a tela nunca acha.
  ok(/^aba-p\d+$/.test(nova.chave), `a chave é aba-pN, sem \\n nem espaço (${JSON.stringify(nova.chave)})`);
  const lista = await abas.listar();
  ok(lista.some((a) => a.chave === nova.chave), 'e a aba já aparece em listar(), sem esperar tique nenhum');
  soAncora();
});

caso('7', 'A', 'a janela nasce com o NOME DO PROJETO, não com o do comando', async () => {
  soAncora();
  const nova = await abas.criar({ cwd: '/tmp', nome: 'projeto-smoke' });
  const nomes = t(['list-windows', '-t', 'teste:', '-F', '#{window_id}\t#{window_name}'])
    .split('\n').map((l) => l.split('\t')).filter(([id]) => id);
  const alvo = nomes.find(([id]) => chaveDe(id) === nova.chave);
  ok(alvo && alvo[1] === 'projeto-smoke', `a janela se chama "projeto-smoke" (${alvo && alvo[1]})`);
  soAncora();
});

caso('8', 'A', 'R6 — criar NÃO troca a janela ativa da sessão', async () => {
  soAncora();
  novaJanela('vizinha');
  const ativaAntes = t(['display-message', '-p', '-t', 'teste:', '#{window_id}']).trim();
  await abas.criar({ cwd: '/tmp', nome: 'projeto-smoke' });
  const ativaDepois = t(['display-message', '-p', '-t', 'teste:', '#{window_id}']).trim();
  ok(ativaAntes === ativaDepois,
    `a janela ativa continua a mesma: ${ativaAntes} → ${ativaDepois} (é o -d fazendo o trabalho)`);
  soAncora();
});

caso('9', 'A', 'as recusas carregam CÓDIGO tipado — o gate lê o codigo, nunca a mensagem', async () => {
  soAncora();
  const soUma = await abas.matar(chaveDe(ancora())).then(() => null, (e) => e);
  ok(soUma && soUma.codigo === 409 && typeof soUma.message === 'string',
    'o erro traz `codigo` numérico e a mensagem sobra só para gente ler');
  const malformada = await abas.matar('aba-x').then(() => null, (e) => e);
  ok(malformada && malformada.codigo === 400, 'e cada recusa tem o SEU código, não um genérico');
});

caso('9b', 'A', '`nascendo` e `falhou` de forma CONTROLADA (sem mexer no relógio)', async () => {
  soAncora();
  novaJanela('companhia');
  // /bin/true entra e sai: a janela nasce, nenhum CLI jamais escreve arquivo de sessão, e
  // `nascendo: true` fica ESTÁVEL — em vez de uma corrida contra os 1,6 s do claude real.
  const binAntes = process.env.COCKPIT_BIN_CLAUDE;
  process.env.COCKPIT_BIN_CLAUDE = '/bin/true';
  process.env.COCKPIT_CARENCIA_ABA_MS = '200';
  try {
    const nova = await abas.criar({ cwd: '/tmp', nome: 'nascendo-smoke' });
    const olhar = async () => (await abas.listar()).find((a) => a.chave === nova.chave);
    const dentro = await olhar();
    ok(dentro && dentro.nascendo === true && dentro.falhou === false,
      'dentro da carência a aba diz `nascendo`');
    await espera(250);
    const estourou = await olhar();
    ok(estourou && estourou.nascendo === false && estourou.falhou === true,
      'passada a primeira carência ela diz `falhou` — não some calada');
    ok(/não subiu/.test(abas.motivoDeRecusa(estourou) || ''),
      `e o motivo de recusa conta o que houve (${abas.motivoDeRecusa(estourou)})`);
    await espera(250);
    const saiu = await olhar();
    ok(saiu && saiu.nascendo === false && saiu.falhou === false,
      'passada a segunda, a entrada sai do Map e a aba vira aba comum sem claude');
  } finally {
    process.env.COCKPIT_BIN_CLAUDE = binAntes;
    delete process.env.COCKPIT_CARENCIA_ABA_MS;
    soAncora();
  }
});

caso('9c', 'A', 'R3 — as duas rotas novas respondem 401 sem o header', async () => {
  const segredo = `smoke-${process.pid}-${process.hrtime.bigint().toString(36)}`;
  const s2 = await subirServidor('S2', 7897, { COCKPIT_TOKEN: segredo });
  if (!s2.pronto) return ok(false, `S2 (7897) não subiu — sem ele não dá para provar o 401 · ${s2.porque}`);
  const semToken = await pedir(7897, 'POST', '/api/abas', { corpo: { projeto: 'x' } });
  ok(semToken.status === 401, `POST /api/abas sem token → 401 (${semToken.status})`);
  const apagar = await pedir(7897, 'DELETE', '/api/abas/aba-1');
  ok(apagar.status === 401, `DELETE /api/abas/aba-1 sem token → 401 (${apagar.status})`);
  return true;
});

// ── Ainda BLOCO A: a tradução `erro.codigo` → HTTP. Não precisa de `claude` nenhum, e sem
//    ela uma rota que traduzisse tudo para 404 passaria quase toda a bateria.

caso('9d', 'A', '409 por HTTP — a última janela, pela rota', async () => {
  const dono = soAncora();
  const s = await garantirS1();
  if (!s.pronto) return ok(false, `S1 (7898) não subiu — sem ele o 409 por HTTP não é exercitado · ${s.porque}`);
  const r = await pedir(7898, 'DELETE', `/api/abas/${chaveDe(dono)}`);
  ok(r.status === 409, `DELETE da última janela → 409 (${r.status}) ${JSON.stringify(r.corpo)}`);
  ok(janelasDe('teste').includes(dono), 'e a janela continua lá');
  return true;
});

caso('9f', 'A', '404 por HTTP — chave que não existe, pela rota', async () => {
  soAncora();
  const s = await garantirS1();
  if (!s.pronto) return ok(false, `S1 (7898) não subiu — sem ele o 404 por HTTP não é exercitado · ${s.porque}`);
  const r = await pedir(7898, 'DELETE', '/api/abas/aba-p999999');
  // O `!== 'rota desconhecida'` NÃO é zelo: 404 de rota que não existe e 404 de aba que não
  // existe são o mesmo número, e sem esta linha o caso passaria verde antes de a rota
  // sequer ser escrita — que é exatamente o buraco que ele veio tapar.
  ok(r.status === 404 && r.corpo.erro !== 'rota desconhecida',
    `DELETE de chave inexistente → 404 DA ABA, não da rota (${r.status}) ${JSON.stringify(r.corpo)}`);
  return true;
});

caso('9e', 'A', '500 por HTTP — erro SEM codigo não vira estado do mundo', async () => {
  // PATH inexistente faz `execFile('tmux', …)` falhar com ENOENT, que NÃO casa o SEM_SESSAO.
  // O node é chamado pelo caminho absoluto (`process.execPath`): com PATH=/nonexistent o
  // shell não acharia nem o próprio node, e o teste provaria falha de boot em vez de
  // tradução de erro.
  const s5 = await subirServidor('S5', 7895, { PATH: '/nonexistent', COCKPIT_BIN_CLAUDE: null });
  if (!s5.pronto) return ok(false, `S5 (7895) não subiu — sem ele o 500 não é exercitado · ${s5.porque}`);
  const r = await pedir(7895, 'DELETE', '/api/abas/aba-1');
  ok(r.status === 500, `tmux que nem existe → 500, não 404 (${r.status}) ${JSON.stringify(r.corpo)}`);
  return true;
});

// ── BLOCO B — o nascimento e a API. Precisam do `claude` DE VERDADE (binário + login) e de
//    um projeto em ~/projetos. É só aqui que o código 2 pode aparecer.

caso('11', 'B', 'R5 ponta a ponta — a aba criada passa a temClaude em até 30 s', async () => {
  soAncora();
  novaJanela('companhia');
  const nova = await abas.criar({ cwd: PROJETO.cwd, nome: PROJETO.nome });
  criadasNoB.push(nova.chave);
  const limite = Date.now() + 30_000;
  let aba = null;
  while (Date.now() < limite) {
    aba = (await abas.listar()).find((a) => a.chave === nova.chave);
    if (aba && aba.temClaude) break;
    await espera(500);
  }
  ok(Boolean(aba && aba.temClaude),
    'o claude do caminho absoluto subiu NAQUELE ambiente — não só a janela abriu');
  return true;
});

caso('12', 'B', '`nascendo` some quando o CLI sobe', async () => {
  const chave = criadasNoB[criadasNoB.length - 1];
  if (!chave) return ok(false, 'o caso 11 não deixou aba criada para conferir');
  const aba = (await abas.listar()).find((a) => a.chave === chave);
  ok(Boolean(aba) && aba.nascendo === false && aba.falhou === false,
    'com o claude no ar, os dois campos voltam a false e a entrada sai do Map');
  return true;
});

caso('13', 'B', 'R13 no mundo real — o envio LIQUIDA antes da morte', async () => {
  const chave = criadasNoB[criadasNoB.length - 1];
  if (!chave) return ok(false, 'o caso 11 não deixou aba criada para conferir');
  const ordem = [];
  const envio = abas.enviar(chave, 'oi do smoke').then(() => ordem.push('envio'), () => ordem.push('envio'));
  const morte = abas.matar(chave).then(() => ordem.push('morte'), () => ordem.push('morte'));
  await Promise.allSettled([envio, morte]);
  ok(ordem[0] === 'envio', `o enviar() liquida antes do matar() (${ordem.join(' → ')})`);
  criadasNoB.pop();
  return true;
});

caso('14', 'B', 'o caminho feliz das ROTAS, por HTTP', async () => {
  soAncora();
  novaJanela('companhia');
  const s = await garantirS1();
  if (!s.pronto) return ok(false, `S1 (7898) não subiu · ${s.porque}`);
  const criada = await pedir(7898, 'POST', '/api/abas', { corpo: { projeto: PROJETO.nome } });
  ok(criada.status === 201, `POST /api/abas {projeto} → 201 (${criada.status}) ${JSON.stringify(criada.corpo)}`);
  ok(/^aba-p\d+$/.test(String(criada.corpo.chave || '')),
    `e a chave volta no formato das rotas (${JSON.stringify(criada.corpo.chave)})`);
  if (!criada.corpo.chave) return ok(false, 'sem chave não dá para provar o DELETE');
  const morta = await pedir(7898, 'DELETE', `/api/abas/${criada.corpo.chave}`);
  ok(morta.status === 200, `DELETE /api/abas/<chave> → 200 (${morta.status}) ${JSON.stringify(morta.corpo)}`);
  return true;
});

caso('14b', 'B', 'a fronteira da #22 — o `cwd` do cliente é IGNORADO, não obedecido', async () => {
  soAncora();
  novaJanela('companhia');
  const s = await garantirS1();
  if (!s.pronto) return ok(false, `S1 (7898) não subiu · ${s.porque}`);
  // Um diretório que EXISTE e não é o do projeto: se a rota obedecesse o corpo, a janela
  // nasceria aqui. (A spec cita `~/.secrets` como exemplo; `/tmp` prova a mesma coisa sem pôr
  // o caminho do cofre num arquivo de teste versionado.)
  const criada = await pedir(7898, 'POST', '/api/abas', {
    corpo: { projeto: PROJETO.nome, cwd: '/tmp' },
  });
  ok(criada.status === 201, `POST com projeto válido + cwd → 201 (${criada.status})`);
  if (!criada.corpo.chave) return ok(false, 'sem chave não dá para conferir o caminho da janela');
  // `%`, não `@`: a chave é de PANE, e `display-message -t @<n>` num `%` seria alvo errado.
  const alvo = `%${String(criada.corpo.chave).replace(/^aba-p/, '')}`;
  const caminho = t(['display-message', '-p', '-t', alvo, '#{pane_current_path}']).trim();
  ok(caminho === PROJETO.cwd,
    `a janela nasceu no caminho do PROJETO, não no que veio no corpo (${caminho})`);
  await pedir(7898, 'DELETE', `/api/abas/${criada.corpo.chave}`);
  return true;
});

// ─── Corrida ─────────────────────────────────────────────────────────────────

// Asserção 10, por fora dos casos: o socket PADRÃO não pode ter perdido janela nenhuma.
// Comparação textual exata daria falso vermelho — o usuário pode abrir uma aba no meio do
// smoke. O invariável é de SUBCONJUNTO: nenhum id do começo sumiu no fim.
const conjuntoPadrao = () => new Set(
  padraoLeitura(['list-windows', '-a', '-F', '#{session_name}:#{window_id}'])
    .split('\n').map((l) => l.trim()).filter(Boolean),
);
const PADRAO_ANTES = conjuntoPadrao();

const pendentes = [];

async function rodar() {
  for (const c of CASOS) {
    if (SO_ESTES.length && !SO_ESTES.includes(c.id)) continue;
    if (c.bloco === 'B' && !PROJETO.pronto) {
      pendentes.push(c.id);
      console.log(`\n  · caso ${c.id} — PENDENTE (${PROJETO.porque}) — ${c.titulo}`);
      continue;
    }
    // O bloco B roda com o `claude` de verdade; o A, com o binário de mentira. Os dois são
    // lidos em tempo de CHAMADA, então trocar aqui basta — não precisa de `require` novo.
    if (c.bloco === 'B') delete process.env.COCKPIT_BIN_CLAUDE;
    else process.env.COCKPIT_BIN_CLAUDE = '/bin/sleep';
    console.log(`\n  · caso ${c.id} — ${c.titulo}`);
    try {
      await c.fn();
    } catch (e) {
      ok(false, `caso ${c.id} estourou: ${e.message}`);
    }
  }
}

/**
 * Limpeza FAIL-CLOSED: só derruba o que ele mesmo criou.
 *
 * O carimbo prova que a sessão é dele; só a ENUMERAÇÃO prova que não há mais ninguém no
 * socket. Sobrou sessão de terceiro → `kill-session` só nas suas e o socket fica de pé.
 */
function limpar() {
  for (const { nome, filho } of servidores) {
    if (filho.exitCode === null) {
      try { process.kill(filho.pid); } catch { /* já morreu */ }
      console.log(`  · ${nome} (pid ${filho.pid}) derrubado pelo pid exato`);
    }
  }
  const vivas = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
    .split('\n').map((l) => l.trim()).filter(Boolean);
  const intrusas = vivas.filter((s) => !SESSOES_MINHAS.has(s));
  const temCarimbo = Boolean(ancora());
  if (intrusas.length) {
    console.error(`  🔴 o socket ${SOCKET} tem sessão que NÃO é minha (${intrusas.join(', ')}) — `
      + 'não dou kill-server. Derrubando só as minhas.');
    for (const s of vivas.filter((x) => SESSOES_MINHAS.has(x))) t(['kill-session', '-t', s], { tolerante: true });
    return;
  }
  if (!temCarimbo && vivas.length) {
    console.error(`  🔴 a janela âncora (${CARIMBO}) sumiu — não provo a posse deste socket. Não derrubo nada.`);
    return;
  }
  t(['kill-server'], { tolerante: true });
}

(async () => {
  let saida = 0;
  try {
    await rodar();
  } finally {
    limpar();
    const PADRAO_DEPOIS = conjuntoPadrao();
    const sumiram = [...PADRAO_ANTES].filter((x) => !PADRAO_DEPOIS.has(x));
    ok(sumiram.length === 0,
      `asserção 10: nenhuma janela do socket PADRÃO sumiu${sumiram.length ? ` — SUMIU: ${sumiram.join(', ')}` : ''}`);
    // 1 = defeito · 2 = ambiente indisponível · 0 = verde. O 2 NÃO fecha o card: o bloco B
    // é o núcleo dele (criação com `claude` de verdade, as rotas por HTTP, a corrida
    // `enviar` × `matar`), e o relatório tem que dizer isso com todas as letras.
    saida = falhas ? 1 : (pendentes.length ? 2 : 0);
    if (pendentes.length) {
      console.log(`\n  ⚠ bloco B PENDENTE (${PROJETO.porque}) — casos ${pendentes.join(', ')} `
        + 'vão para a lista de smoke manual do relatório.');
    }
    console.log(`\n${falhas ? '❌ SMOKE VERMELHO' : (pendentes.length ? '🟡 SMOKE VERDE COM PENDÊNCIAS' : '✅ SMOKE VERDE')}`
      + ` — ${feitos - falhas}/${feitos} asserções\n`);
  }
  process.exit(saida);
})().catch((e) => {
  console.error('\n❌ o smoke quebrou:', e.message, '\n');
  limpar();
  process.exit(1);
});
