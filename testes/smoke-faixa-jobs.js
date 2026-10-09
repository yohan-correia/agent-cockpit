#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — a FAIXA DE JOBS no cabeçalho da conversa (card
// `jobs-do-projeto-dentro-da-conversa`, D56, spec 2026-09-15).
//
// Uma pergunta só: **a conversa de um projeto COM job rodando mostra a faixa, a de um projeto
// SEM job não mostra, e o clique na faixa leva à vista de agentes** — nos DOIS viewports
// (390×844 e 1600×1000).
//
// Nasceu por CÓPIA-E-PODA do `testes/smoke-celular-jobs.js` (§6.1 da spec). O aparato dele é
// o que custa caro e já está certo: panes reais num socket tmux carimbado, `/proc` de
// mentira, HOME fabricado, dois `server.js` (a árvore da `develop` = "antes", esta worktree =
// "depois") e o Chromium no container. O que muda é a FIXTURE e o PERCURSO.
//
// 🔴 POR QUE NÃO REUSAR aquele script (medido, cinco impedimentos):
//   1. no desktop ele NUNCA abre conversa (`if (!DESKTOP)`, :404 e :616) — e a faixa vive no
//      `.chat-topo` de um painel ABERTO. O PNG de 1600×1000 cairia na tela de lista;
//   2. a fixture tem UM job `running` casando com aba viva; a prova pede DOIS;
//   3. a aba nasce `status: 'idle'` ⇒ o `.btn-parar` fica `hidden`;
//   4. o `.jsonl` não tem `message.usage` ⇒ o `.medidor` fica `hidden`;
//   5. `pngsEsperados` valida lista EXATA e recusa pasta com PNG.
// Os itens 3 e 4 são o ponto: sem medidor e sem Parar na tela, os três itens da linha 2 do
// celular NUNCA disputam espaço, e o PNG passaria verde sem exercitar a ARMADILHA #43 —
// prova que não pode falhar não é prova. E acrescentar um `running` à fixture dele mexeria
// nos asserts de contagem da barra (a D51), deixando vermelho um smoke de outra pergunta.
//
// ── O que a fixture monta, e por quê cada peça ──────────────────────────────
//   · DOIS jobs `running` de `painelalvo`  → a conta pluraliza e `linhaDaEtapa` roda no ramo
//                                            de vários; é o print que o dono pediu
//   · UM job `running` de `semaba`         → dente do controle: há job no mundo, não NESTE projeto
//   · aba `painelalvo` com `status: 'busy'`→ 🔴 `.btn-parar` VISÍVEL
//   · `.jsonl` de `painelalvo` com `usage` → 🔴 `.medidor` VISÍVEL
//   · aba `painelfora`                     → o painel de CONTROLE (projeto sem job)
//   · `cockpit-idioma = 'pt-BR'` no storage→ 🔴 o Chromium da imagem sai em `en`
//                                            (`smoke-celular-jobs.js:458`) e `i18n.js:8-10`
//                                            cai no `navigator.language`. Sem fixar, a faixa
//                                            escreve "2 running jobs" e o critério em
//                                            português reprovaria código CERTO.
//
// Uso: SAIDA=<pasta NOVA, sem PNG dentro> [VIEWPORT=LxA] node testes/smoke-faixa-jobs.js
//
// Códigos de saída: 0 = os dois modos passaram · 1 = falha de produto/assert · 2 = erro de
// USO ou de AMBIENTE (falta SAIDA, pasta com PNG, porta ocupada, imagem docker ausente).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execSync, spawn } = require('node:child_process');

// ─── Contrato de uso — validado ANTES de tocar em qualquer coisa ─────────────

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os seis PNGs vão cair>');
  process.exit(2);
}
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
// Cenário de LISTA CURTA (duas abas, um projeto cada): o caso em que sobra espaço na
// lateral e o `sticky` não tem o que grudar. Ver o comentário no bloco de enchimento.
// Este smoke pergunta sobre o CABEÇALHO, não sobre a lista: duas abas bastam e o percurso
// fica rápido. `LISTA_LONGA=1` traz as seis abas de enchimento do script original, para o
// caso de alguém querer ver a faixa com a lateral cheia.
const LISTA_LONGA = process.env.LISTA_LONGA === '1';
const RAIZ = path.join(__dirname, '..');
// Mesmo cálculo do roteiro (dentro do container): sem isto o script no HOST não sabe se o
// cenário é celular para decidir se `depois-conversa-aberta`/`antes-conversa-aberta` entram
// na lista de conferência dos PNGs (§2.4 da spec — só existe no celular).
const [VP_LARGURA_HOST] = String(process.env.VIEWPORT || '').split('x').map(Number);
const EH_CELULAR_HOST = !(Number.isFinite(VP_LARGURA_HOST) && VP_LARGURA_HOST > 760);

// Portas: dois `server.js` (antes/depois) + o mock do painel + uma de folga. Nunca 7899 (#24)
// nem 7879 (produção) — a faixa inteira já fica fora dos dois.
// Portas PRÓPRIAS (§6.2 do plano): nunca 7891-7894 (o smoke da D51 pode estar no ar ao mesmo
// tempo — jobs irmãos rodam em paralelo), nunca 7899 (armadilha #24, a porta dos jobs) nem
// 7879 (produção).
const PORTA_ANTES = 7871;
const PORTA_DEPOIS = 7872;
const PORTA_FOLGA = 7874;

// A lista de verificação — CONDICIONAL por MODO e por VIEWPORT (§6.2 do plano). Uma lista
// literal única derrubaria um run correto: o guard copiado é fail-closed contra lista EXATA.
// TODO PNG novo entra aqui, senão um `screenshot()` que não gerou arquivo passa verde — o
// modo de falha que a regra de 25/08 existe para pegar.
//
//   <modo>-com-job       os dois modos, os dois viewports
//   <modo>-sem-job       os dois modos, os dois viewports
//   depois-com-um-job    SÓ celular, SÓ depois — quanto cabe de verdade em 390px com 1 job
//   depois-clique-faixa  SÓ depois — no "antes" a faixa não existe (árvore da develop)
function pngsDoModo(modo, ehCelular) {
  const lista = [`${modo}-com-job`, `${modo}-sem-job`];
  if (modo !== 'depois') return lista;
  if (ehCelular) lista.push('depois-com-um-job');
  lista.push('depois-clique-faixa');
  return lista;
}

// ─── Fail-closed do socket, mesmo padrão dos outros smokes de celular ────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-faixa-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;

function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
}

if (t(['ls'], { tolerante: true }).trim()) {
  console.error(`🔴 o socket ${SOCKET} JÁ EXISTE — não é meu. Abortando.`);
  process.exit(1);
}

let falhas = 0;
let feitos = 0;
const ok = (c, texto) => { feitos += 1; if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${texto}`); return c; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function portaOcupada(porta) {
  const saida = execFileSync('ss', ['-H', '-lptn'], { encoding: 'utf8' });
  return saida.split('\n').some((l) => l.includes(`:${porta} `) || l.includes(`:${porta}\t`));
}

// ─── As duas abas da fixture — uma casa com o job "running", a outra não ────
//
// `abasDoProjeto()` (`lib/abas.js:705`) casa por NOME: o `project` do job contra o basename
// normalizado do `cwd` da aba. `painelalvo` casa; `semaba` não casa com nenhuma das duas —
// os jobs "encerrados"/"bloqueado"/"falhou" não precisam de aba viva para aparecer na lista.

const CWD_ALVO = '/home/smoke/projetos/painelalvo';
const CWD_FORA = '/home/smoke/projetos/painelfora';
const SESSID_ALVO = 'sess-painelalvo';
const SESSID_FORA = 'sess-painelfora';

function raizProc(scratch) {
  return path.join(scratch, 'proc');
}

/** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}` — molde `gate-codex.js:63-94`. */
function plantarAgenteFalso(scratch, pid, { comm = 'claude', argv = ['/usr/bin/claude'], starttime }) {
  const dir = path.join(raizProc(scratch), String(pid));
  fs.mkdirSync(dir, { recursive: true });
  const campos = new Array(52).fill('0');
  campos[0] = String(pid);
  campos[1] = `(${comm})`;
  campos[2] = 'S';
  campos[3] = '1';
  campos[4] = String(pid);
  campos[5] = String(pid);
  campos[6] = '34816';
  campos[7] = String(pid);
  campos[21] = String(starttime);
  fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`);
  fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task', String(pid), 'children'), '');
}

function escreverSessao(home, { pid, janela, pane, sessaoId, cwd, starttime, status }) {
  const raiz = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(raiz, { recursive: true });
  fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
    kind: 'interactive',
    sessionId: sessaoId,
    cwd,
    status,
    updatedAt: Date.now(),
    pid,
    procStart: starttime,
    tmux: `${SESSAO}:${janela}.${pane}`,
  }));
}

function caminhoDoJsonl(home, cwd, sessaoId) {
  const pasta = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', pasta, `${sessaoId}.jsonl`);
}

function escreverConversa(caminho, linhas) {
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, linhas.join(''));
}

const linhaHumano = (iso, texto) => `${JSON.stringify({ type: 'user', timestamp: iso, message: { content: texto } })}\n`;
// 🔴 `usage` OPCIONAL, e é o que acende o MEDIDOR. `lib/contexto.js` caça o último `usage`
// numa cauda do `.jsonl`; sem ele a tela fica sem medidor (degrada para `null` em vez de
// chutar), e o cabeçalho do celular passa a ter DOIS itens na linha 2 em vez de três — o
// cenário fácil, que não exercita a armadilha #43.
const linhaAssistente = (iso, texto, usage) => `${JSON.stringify({
  type: 'assistant', timestamp: iso,
  message: { content: [{ type: 'text', text: texto }], model: 'claude-opus-5', ...(usage ? { usage } : {}) },
})}\n`;

/** Uma conversa pequena (4 linhas), última mensagem no `T` dado. Devolve `T` em ms.
 *  `comUsage` carimba o `message.usage` na ÚLTIMA linha `assistant` — é o que faz o medidor
 *  aparecer no cabeçalho (§6.2 da spec). */
function conversaPequena(caminho, baseMs, { comUsage = false } = {}) {
  const linhas = [];
  let quando = baseMs - 3 * 60000;
  linhas.push(linhaHumano(new Date(quando).toISOString(), 'oi, tudo bem por aí?')); quando += 60000;
  linhas.push(linhaAssistente(new Date(quando).toISOString(), 'tudo certo — o que você precisa?')); quando += 60000;
  linhas.push(linhaHumano(new Date(quando).toISOString(), 'só confirmando que a aba está viva')); quando += 60000;
  linhas.push(linhaAssistente(new Date(quando).toISOString(), 'confirmado, sigo por aqui.', comUsage ? {
    input_tokens: 1200, output_tokens: 800,
    cache_read_input_tokens: 84000, cache_creation_input_tokens: 12000,
  } : null));
  escreverConversa(caminho, linhas);
  return quando;
}

// ─── A fixture em DISCO, para o `server.js` "depois" ─────────────────────────
//
// Uma fixture só, para os DOIS lados. Até a absorção do painel mergear, o "antes" (a árvore
// do `develop`) lia os jobs de um serviço externo por HTTP e precisava de um mock; hoje as duas
// árvores leem a mesma pasta de disco, e o mock virou código morto que ATRAPALHA — a variável
// antiga passaria a ser ignorada, o "antes" ficaria sem pasta nenhuma, e o smoke reprovaria a
// ausência do grupo como se fosse defeito da branch.
//
// O que sobrou de "antes/depois" ainda vale: as duas árvores desenham a MESMA tela a partir do
// MESMO dado, e é isso que pega regressão entre a `develop` e a branch de trabalho.
//
// O formato das pastas é o que `lib/jobs.js:lerJob` espera.
function escreverJobNoDisco(pastaJobs, id, { type, project, title, criadoEm, statusMeta, linhaStatus, etapaArquivo }) {
  const dir = path.join(pastaJobs, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id, type, project, title,
    created_at: new Date(criadoEm).toISOString(),
    worktree: '', branch: '', origin: 'capitao', merged_at: null, approved_at: null,
    status: statusMeta, pid: process.pid, tmux_session: null,
  }));
  fs.writeFileSync(path.join(dir, 'status.log'), `${linhaStatus}\n`);
  if (etapaArquivo) {
    // Duas linhas de NDJSON, não uma: a primeira é uma FALA (bloco de texto) — sem ela, o
    // clique no job (depois-clique-job) só provaria "o painel abriu", não a §8 do plano
    // ("a fita do job tem falas de verdade"). A segunda é a mesma de sempre, e é o que faz a
    // linha "rodando" da lista ter uma etapa em vez de ficar muda (`etapaAtual()`,
    // `lib/jobs.js`).
    const linhasDoLog = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'revendo o arquivo antes de editar — smoke da faixa de jobs' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: etapaArquivo } }] } },
    ];
    fs.writeFileSync(path.join(dir, 'claude.log'), linhasDoLog.map((l) => `${JSON.stringify(l)}\n`).join(''));
  }
}

function montarJobsNoDisco(pastaJobs) {
  const agora = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  // 🔴 DOIS `running` de `painelalvo`, não um: é o print que o dono pediu ("2 jobs rodando"),
  // e é o único cenário que exercita `linhaDaEtapa` no ramo de VÁRIOS (onde cada etapa precisa
  // dizer de quem é). `abasDoProjeto()` (`lib/abas.js:744`) casa `project` contra o basename
  // normalizado do `cwd` da aba — `painelalvo` casa, `semaba` não casa com nenhuma.
  escreverJobNoDisco(pastaJobs, 'job-alvo-1', {
    type: 'ataca', project: 'painelalvo', title: 'faixa volta ao cabecalho', criadoEm: agora - 5 * 60000,
    statusMeta: 'running', linhaStatus: `${iso(agora - 5 * 60000)} working: rodando`,
    etapaArquivo: '/x/public/exemplo.js',
  });
  escreverJobNoDisco(pastaJobs, 'job-alvo-2', {
    type: 'ship', project: 'painelalvo', title: 'gates do medidor', criadoEm: agora - 12 * 60000,
    statusMeta: 'running', linhaStatus: `${iso(agora - 12 * 60000)} working: rodando`,
    etapaArquivo: '/x/testes/gate-ui.js',
  });

  // O DENTE do controle (§6.2): existe job rodando no mundo — o que `painelfora` não pode
  // mostrar é job rodando DELE. Sem esta linha, a faixa ausente em `painelfora` provaria
  // apenas que a fixture estava vazia, não que o filtro por projeto funciona.
  escreverJobNoDisco(pastaJobs, 'job-de-outro', {
    type: 'ataca', project: 'semaba', title: 'job de outro projeto', criadoEm: agora - 30 * 60000,
    statusMeta: 'running', linhaStatus: `${iso(agora - 30 * 60000)} working: rodando`,
    etapaArquivo: '/y/outro.js',
  });
}

/** `/health` respondeu 200? É o único jeito honesto de saber que o `server.js` subiu — o
 *  `spawn` volta na hora e o processo ainda está lendo a fixture. */
function saude(porta) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: porta, path: '/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ─── O roteiro do navegador — roda DENTRO do container, uma vez por MODO ─────

function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const MODO = process.env.MODO;
// VIEWPORT vem do AMBIENTE: o MESMO roteiro roda em 390×844 (celular) e em 1600×1000
// (desktop). Acima de 760px \`isMobile\`/\`hasTouch\` desligam JUNTOS — com eles ligados o
// Chromium reporta \`hover: none\`/\`pointer: coarse\` mesmo numa tela de desktop (#66).
const [VP_LARGURA, VP_ALTURA] = String(process.env.VIEWPORT || '').split('x').map(Number);
const LARGURA_VIEWPORT = Number.isFinite(VP_LARGURA) && VP_LARGURA > 0 ? VP_LARGURA : 390;
const ALTURA_VIEWPORT = Number.isFinite(VP_ALTURA) && VP_ALTURA > 0 ? VP_ALTURA : 844;
const EH_CELULAR = LARGURA_VIEWPORT <= 760;
const VIEWPORT = {
  width: LARGURA_VIEWPORT, height: ALTURA_VIEWPORT,
  isMobile: EH_CELULAR, hasTouch: EH_CELULAR, deviceScaleFactor: EH_CELULAR ? 2 : 1,
};
console.log('VIEWPORT efetivo: ' + JSON.stringify(VIEWPORT) + ' MODO=' + MODO);

const problemas = [];
const feitos = [];
const ok = (cond, msg) => { (cond ? feitos : problemas).push(msg); return cond; };
// Guarda ANTES do obturador: um PNG de estado reprovado no disco, com o nome de sempre, é
// pior que PNG nenhum — alguém abre e acredita.
const exigir = (cond, msg) => {
  if (!ok(cond, msg)) throw new Error('guarda reprovou antes do obturador: ' + msg);
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ── As réguas que o olho não mede sozinho ───────────────────────────────────
//
// \`linhasVisuais\` é a régua de SOBREPOSIÇÃO vertical, emprestada de
// \`smoke-celular-primeira-leva.js:444\`: sob \`align-items: center\`, um botão de 40px de alvo
// de dedo e um h1 de ~19px têm topos E centros diferentes na MESMA linha. O que não erra é
// perguntar se as faixas [top, bottom] se tocam.
const REGUAS = () => {
  const rect = (el) => el.getBoundingClientRect();
  function linhasVisuais(elementos) {
    const rs = elementos
      .filter((el) => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
      .map(rect)
      .sort((a, b) => a.top - b.top);
    let linhas = 0;
    let fimAtual = -Infinity;
    for (const r of rs) {
      if (r.top >= fimAtual - 1) { linhas += 1; fimAtual = r.bottom; } else { fimAtual = Math.max(fimAtual, r.bottom); }
    }
    return linhas;
  }
  const painel = document.querySelector('.painel');
  if (!painel) return { semPainel: true };
  const faixa = painel.querySelector('.faixa-jobs');
  const medidor = painel.querySelector('.medidor');
  const parar = painel.querySelector('.btn-parar');
  const topo = painel.querySelector('.chat-topo');
  const visivel = (el) => Boolean(el) && !el.hidden && el.getBoundingClientRect().width > 0;
  return {
    semPainel: false,
    temFaixaNoDom: Boolean(faixa),
    faixaVisivel: visivel(faixa),
    faixaTexto: faixa ? faixa.textContent : '',
    conta: faixa ? (faixa.querySelector('.faixa-conta') || {}).textContent || '' : '',
    titulos: faixa ? (faixa.querySelector('.faixa-titulos') || {}).textContent || '' : '',
    etapa: faixa ? (faixa.querySelector('.faixa-etapa') || {}).textContent || '' : '',
    medidorVisivel: visivel(medidor),
    pararVisivel: visivel(parar),
    // 🔴 A ARMADILHA #43 mora aqui: com base \`auto\` a faixa vira a TERCEIRA linha e o Parar
    // a quarta. O F6 do gate lê a DECLARAÇÃO; só esta régua lê a QUEBRA.
    linhasDoTopo: linhasVisuais([
      painel.querySelector('.voltar'), painel.querySelector('.chat-identidade'),
      painel.querySelector('.fechar-aba'), medidor, faixa, parar,
      painel.querySelector('.btn-recarregar-conversa'),
    ]),
    topoVaza: topo ? topo.scrollWidth > topo.clientWidth + 1 : false,
    vistaDoApp: document.getElementById('app').dataset.vista || '',
    temGrupoJobs: Boolean(document.getElementById('grupo-jobs')),
  };
};

/** Clica na linha da lista cujo texto casa — devolve false se não achou. */
const CLICAR_CONVERSA = (nome) => {
  const linhas = [...document.querySelectorAll('#abas .conversa-linha')];
  const alvo = linhas.find((l) => (l.textContent || '').includes(nome));
  if (!alvo) return false;
  const botao = alvo.querySelector('.conversa') || alvo;
  botao.click();
  return true;
};

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const pagina = await navegador.newPage();
    await pagina.setViewport(VIEWPORT);
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

    const erros = [];
    pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
    pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });

    // 🔴 FIXAR O IDIOMA ANTES DE CARREGAR. O Chromium desta imagem sai em \`en\`
    // (\`smoke-celular-jobs.js:458\` já registrava isso) e \`i18n.js:8-10\` cai no
    // \`navigator.language\` quando não há preferência salva. Sem isto a faixa escreve
    // "2 running jobs" e o critério em português reprovaria código CERTO — e, pior, o PNG
    // que o dono vai olhar sairia no idioma errado.
    await pagina.evaluateOnNewDocument(() => {
      try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch (e) { /* sem storage */ }
    });

    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    // A primeira leitura de api/jobs chega no boot; 1,5s cobre com folga.
    await espera(1500);

    const idioma = await pagina.evaluate(() => {
      try { return localStorage.getItem('cockpit-idioma'); } catch (e) { return null; }
    });
    exigir(idioma === 'pt-BR', MODO + ': o idioma está fixado em pt-BR (' + idioma + ')');

    // ── 1) a conversa do projeto COM job ──────────────────────────────────────
    const abriuAlvo = await pagina.evaluate(CLICAR_CONVERSA, 'painelalvo');
    exigir(abriuAlvo, MODO + ': consegui abrir a conversa de painelalvo');
    await pagina.waitForSelector('.painel .chat-topo', { timeout: 15000 });
    await espera(1200);

    const comJob = await pagina.evaluate(REGUAS);
    exigir(!comJob.semPainel, MODO + ': o painel de painelalvo está na tela');

    if (MODO === 'depois') {
      // 🔴 Os DOIS primeiros são o produto; os DOIS últimos são o que faz o PNG valer como
      // prova da #43. Sem medidor e sem Parar visíveis, os três nunca disputam a linha 2.
      exigir(comJob.faixaVisivel, 'depois: a faixa aparece no painel do projeto COM job');
      exigir(/2 jobs rodando/.test(comJob.conta),
        'depois: a conta pluraliza — "2 jobs rodando" (' + comJob.conta + ')');
      exigir(/faixa volta ao cabecalho/.test(comJob.titulos) && /gates do medidor/.test(comJob.titulos),
        'depois: os DOIS nomes de job estão na faixa (' + comJob.titulos + ')');
      // 🔴 O NOME DO ARQUIVO, não só "tem texto". É isto que o dono pediu ver
      // ("editando exemplo.js · 5 min atras") — um assert de \`length > 0\` passaria com
      // "sem sinal" nos dois, que é o estado de job que ainda não agiu.
      exigir(/exemplo\.js/.test(comJob.etapa) && /gate-ui\.js/.test(comJob.etapa),
        'depois: 🔴 a etapa diz O QUE cada job faz, com o arquivo (' + comJob.etapa + ')');
      exigir(comJob.medidorVisivel, 'depois: 🔴 o MEDIDOR está visível — a linha 2 tem três itens de verdade');
      exigir(comJob.pararVisivel, 'depois: 🔴 o PARAR está visível — idem');
    } else {
      // O "antes" é a árvore da develop: a faixa não existe nem no DOM. É isso que faz o par
      // comparar a MUDANÇA, e não duas telas diferentes.
      exigir(!comJob.temFaixaNoDom, 'antes: a develop NÃO tem .faixa-jobs no DOM (é o que o dono reclamou)');
      exigir(comJob.medidorVisivel && comJob.pararVisivel,
        'antes: medidor e Parar visíveis — a MESMA fixture dos dois lados, só o código muda');
    }

    // 🔴 A ARMADILHA #43, medida em PIXEL e nos dois modos: no celular o cabeçalho tem DUAS
    // linhas. Virar três significa que a faixa quebrou sozinha e empurrou o Parar.
    if (EH_CELULAR) {
      exigir(comJob.linhasDoTopo <= 2,
        MODO + ': 🔴 o cabeçalho do celular cabe em 2 linhas (#43) — medido ' + comJob.linhasDoTopo);
    }
    exigir(!comJob.topoVaza, MODO + ': nada do cabeçalho vaza para fora da tela');
    await pagina.screenshot({ path: '/out/' + MODO + '-com-job.png' });

    // ── 2) só no CELULAR e só no depois: o caso comum, UM job ──────────────────
    // Em 390px a conta é \`flex: none\` e come boa parte da linha; com 1 job sobra espaço para
    // o nome e a etapa. É a foto que mostra quanto REALMENTE cabe no aparelho do dono.
    if (EH_CELULAR && MODO === 'depois') {
      await pagina.evaluate(() => {
        const original = globalThis.fetch;
        globalThis.fetch = async (url, opcoes) => {
          const r = await original(url, opcoes);
          if (!String(url).includes('api/jobs')) return r;
          const dados = await r.clone().json();
          const jobs = (dados.jobs || []).filter((j) => j.id !== 'job-alvo-2');
          return new Response(JSON.stringify({ ...dados, jobs }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
      });
      // 🔴 \`atualizarFaixaJobs()\` DIRETO, não o ↻ da lista. O ↻ chama \`recarregarAVista()\`
      // (\`app.js:5476\`), que na vista de CONVERSAS recarrega as abas e NÃO relê os jobs — a
      // faixa continuaria com os dois. \`app.js\` é script clássico, então toda \`function\` de
      // topo é propriedade de \`window\`: dá para chamar de fora. E \`api()\` lê o \`fetch\`
      // GLOBAL no momento da chamada (\`app.js:124\`), então o interceptador acima vale.
      await pagina.evaluate(() => atualizarFaixaJobs());
      await espera(800);
      const umJob = await pagina.evaluate(REGUAS);
      exigir(/1 job rodando/.test(umJob.conta),
        'depois: com UM job a conta fica no singular (' + umJob.conta + ')');
      exigir(umJob.linhasDoTopo <= 2, 'depois: e o cabeçalho continua em 2 linhas (' + umJob.linhasDoTopo + ')');
      await pagina.screenshot({ path: '/out/depois-com-um-job.png' });
      // Devolve o \`fetch\` de verdade antes de seguir — o passo 4 depende dos DOIS jobs.
      await pagina.reload({ waitUntil: 'networkidle2', timeout: 30000 });
      await pagina.waitForSelector('#abas', { timeout: 15000 });
      await espera(1500);
    }

    // ── 3) o CONTROLE: a conversa do projeto SEM job ──────────────────────────
    if (EH_CELULAR) {
      // No celular a lista só volta pelo ← (a lateral é a tela inteira).
      await pagina.evaluate(() => {
        const voltar = document.querySelector('.painel .voltar');
        if (voltar) voltar.click();
      });
      await espera(600);
    }
    const abriuFora = await pagina.evaluate(CLICAR_CONVERSA, 'painelfora');
    exigir(abriuFora, MODO + ': consegui abrir a conversa de painelfora (o controle)');
    await espera(1200);
    const semJob = await pagina.evaluate(REGUAS);
    exigir(!semJob.semPainel, MODO + ': o painel de painelfora está na tela');
    if (MODO === 'depois') {
      // AUSENTE, não vazia: faixa vazia afirmaria "zero jobs" onde o certo é não dizer nada.
      exigir(!semJob.faixaVisivel, 'depois: a faixa some no projeto SEM job (ausente, não vazia)');
      exigir(semJob.conta === '' && semJob.titulos === '' && semJob.etapa === '',
        'depois: e os três nós ficam vazios (conta="' + semJob.conta + '")');
    }
    await pagina.screenshot({ path: '/out/' + MODO + '-sem-job.png' });

    // ── 4) o CLIQUE — só no depois (no antes a faixa não existe) ───────────────
    if (MODO === 'depois') {
      if (EH_CELULAR) {
        await pagina.evaluate(() => {
          const voltar = document.querySelector('.painel .voltar');
          if (voltar) voltar.click();
        });
        await espera(600);
      }
      const voltouAoAlvo = await pagina.evaluate(CLICAR_CONVERSA, 'painelalvo');
      exigir(voltouAoAlvo, 'depois: de volta em painelalvo para clicar na faixa');
      await espera(1200);

      const antesDoClique = await pagina.evaluate(REGUAS);
      exigir(antesDoClique.faixaVisivel, 'depois: pré-condição — a faixa está na tela para ser clicada');
      exigir(!antesDoClique.temGrupoJobs, 'depois: pré-condição — #grupo-jobs ainda não existe (vista de conversas)');

      await pagina.evaluate(() => document.querySelector('.painel .faixa-jobs').click());
      await espera(900);
      const depoisDoClique = await pagina.evaluate(REGUAS);
      exigir(depoisDoClique.temGrupoJobs,
        'depois: 🔴 o clique na faixa abre #grupo-jobs — foi para a VISTA DE AGENTES');
      if (EH_CELULAR) {
        // Sem isto a lateral continuaria fora da tela e o clique não mostraria nada — o ponto
        // que o card mandava CONFERIR.
        exigir(depoisDoClique.vistaDoApp !== 'chat',
          'depois: 🔴 e no celular a lista aparece — data-vista saiu de "chat" (' + depoisDoClique.vistaDoApp + ')');
      }
      await pagina.screenshot({ path: '/out/depois-clique-faixa.png' });
    }

    exigir(erros.length === 0,
      MODO + ': sem erro de console no percurso inteiro (' + (erros.slice(0, 3).join(' | ') || 'nenhum') + ')');
  } finally {
    await navegador.close();
  }

  console.log('@@MEDIDAS-FAIXA@@' + JSON.stringify({ feitos, problemas }));
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e.message);
  console.log('@@MEDIDAS-FAIXA@@' + JSON.stringify({ feitos: [], problemas: ['roteiro estourou: ' + e.message] }));
  process.exitCode = 1;
});
`;
}

// ─── Rodar um MODO dentro do container, contra a BASE dada ───────────────────

function rodarModo({ modo, base, scratch }) {
  return new Promise((resolve) => {
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=${base}`,
      '-e', `MODO=${modo}`,
      // Sem este `-e`, `process.env.VIEWPORT` é `undefined` DENTRO do container — o roteiro
      // cairia no default de celular e um `depois-desktop` sairia em 390×844 com nome de
      // desktop (achado do painel; a variável do HOST não atravessa o `docker run` sozinha).
      '-e', `VIEWPORT=${process.env.VIEWPORT || ''}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    docker.on('close', (codigo) => {
      console.log(saidaDocker);
      const MARCADOR = '@@MEDIDAS-FAIXA@@';
      const abre = saidaDocker.indexOf(MARCADOR);
      let relatorio = null;
      if (abre >= 0) {
        try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
      }
      resolve(relatorio || { feitos: [], problemas: [`o roteiro (${modo}) não devolveu JSON (código ${codigo})`] });
    });
  });
}

// ─── Corrida ──────────────────────────────────────────────────────────────

(async () => {
  let servidorAntes = null;
  let servidorDepois = null;
  let scratch = null;
  let antesDir = null;
  let pastaJobs = null;

  function limpar() {
    let falhouLimpeza = false;
    for (const [nome, s] of [['antes', servidorAntes], ['depois', servidorDepois]]) {
      if (s && s.exitCode === null) {
        try { process.kill(s.pid); } catch { /* já morreu */ }
        console.log(`  · servidor ${nome} (pid ${s.pid}) derrubado pelo pid exato`);
      }
    }
    // Fail-closed de verdade: se a janela-âncora sumiu, isto é FALHA — não um aviso que o
    // smoke ignora. Sem incrementar `falhas`, um smoke que perdeu a posse do socket podia
    // sair 0 deixando um servidor tmux vivo, contaminando a execução seguinte (a #24 por
    // outro caminho).
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    if (temCarimbo) {
      t(['kill-server'], { tolerante: true });
    } else if (scratch) {
      // Só é falha se a fixture chegou a existir (socket criado) — abortos antes da fixture
      // não têm carimbo para achar.
      falhouLimpeza = true;
      falhas += 1;
      console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    if (antesDir) fs.rmSync(antesDir, { recursive: true, force: true });
    if (pastaJobs) fs.rmSync(pastaJobs, { recursive: true, force: true });
    return !falhouLimpeza;
  }

  try {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
      limpar();
      return process.exit(2);
    }

    fs.mkdirSync(SAIDA, { recursive: true });
    const jaTemPng = fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'));
    if (jaTemPng) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. O smoke recusa sobrescrever.`);
      limpar();
      return process.exit(2);
    }

    for (const porta of [PORTA_ANTES, PORTA_DEPOIS, PORTA_FOLGA]) {
      if (portaOcupada(porta)) {
        console.error(`🔴 a porta ${porta} já está em uso — aborta antes de subir qualquer coisa.`);
        limpar();
        return process.exit(2);
      }
    }

    // ── 1) a árvore inteira do `develop` (o "antes") — `server.js` sozinho não sobe ────
    antesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-antes-faixa-'));
    const shaDevelop = execSync('git rev-parse develop', { cwd: RAIZ, encoding: 'utf8' }).trim();
    execSync(`git archive develop | tar -x -C ${antesDir}`, { cwd: RAIZ });
    console.log(`  · árvore do "antes" = develop@${shaDevelop}, extraída em ${antesDir}`);

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-faixa-jobs-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });

    // ── 2) as panes: duas COM agente + seis de ENCHIMENTO, num socket próprio ──────────
    // Oito abas em CINCO projetos, não duas (Fase 4 do plano, achado do painel): a queixa
    // que originou o card é "com 3 projetos abertos a caixa já nasce abaixo da dobra"
    // (spec §1.2) — com duas abas a lista nem enche a tela, e o desktop não prova que a
    // caixa fica visível com a lista de conversas LONGA, que é o ponto inteiro da entrega.
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', 'painelalvo', '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-window', '-t', SESSAO, '-n', 'painelfora', '-c', os.tmpdir(), 'sleep', '600']);

    // Por PADRÃO, DUAS abas e mais nada — ao contrário do `smoke-celular-jobs.js`, que enche
    // a lateral de propósito. A pergunta daqui é sobre o CABEÇALHO de um painel aberto; lista
    // longa só faria o percurso demorar e o clique ter mais linhas para desambiguar.
    //
    // `LISTA_LONGA=1` traz de volta as seis abas de enchimento em três projetos novos (2 abas
    // cada). SEM `plantarAgenteFalso`/`escreverSessao` de propósito: aba sem agente ainda é
    // aba na lista (`estilo.css:601`) — o que se quer ali é ALTURA, não mais um agente
    // fingido. Comentário aqui para a próxima pessoa não "consertar" a falta do agente. O
    // `cwd` PRECISA existir de verdade: é o `-c` do `tmux new-window`, e quem dá identidade a
    // uma aba SEM sessão é o `pane_current_path` REAL (`lib/abas.js:553`), não uma string
    // fabricada como a de `CWD_ALVO`/`CWD_FORA`.
    for (const nomeProjeto of (LISTA_LONGA ? ['projeto-c', 'projeto-d', 'projeto-e'] : [])) {
      const dirProjeto = path.join(scratch, 'projetos', nomeProjeto);
      fs.mkdirSync(dirProjeto, { recursive: true });
      for (let i = 1; i <= 2; i += 1) {
        t(['new-window', '-t', SESSAO, '-n', `${nomeProjeto}-${i}`, '-c', dirProjeto, 'sleep', '600']);
      }
    }

    const saidaPanes = t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']);
    const panes = {};
    for (const linha of saidaPanes.split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }
    for (const nome of ['painelalvo', 'painelfora']) {
      if (!panes[nome]) throw new Error(`a pane "${nome}" não apareceu no list-panes`);
    }

    // ── 3) só então: /proc falso + sessions/<pid>.json + a conversa, com os números REAIS ──
    // 🔴 `comUsage` só na aba ALVO: é ela que aparece nos PNGs com a faixa, e é nela que os
    // três itens da linha 2 precisam existir ao mesmo tempo.
    const T_ALVO = conversaPequena(caminhoDoJsonl(home, CWD_ALVO, SESSID_ALVO), Date.now() - 20 * 60000, { comUsage: true });
    const T_FORA = conversaPequena(caminhoDoJsonl(home, CWD_FORA, SESSID_FORA), Date.now() - 20 * 60000, { comUsage: true });

    plantarAgenteFalso(scratch, panes.painelalvo.panePid, { starttime: 1000001 });
    escreverSessao(home, {
      pid: panes.painelalvo.panePid, janela: panes.painelalvo.janelaId, pane: panes.painelalvo.paneId,
      // 🔴 `busy`, não `idle` (§6.2 da spec): `lib/abas.js:567` traduz `status === 'busy'` em
      // `rodando`, e é o que revela o `.btn-parar` no cabeçalho. Com `idle` o Parar fica
      // `hidden` e a linha 2 do celular nunca tem três itens — o PNG passaria verde sem
      // exercitar a armadilha #43, que é exatamente o que este smoke existe para pegar.
      sessaoId: SESSID_ALVO, cwd: CWD_ALVO, starttime: 1000001, status: 'busy',
    });
    plantarAgenteFalso(scratch, panes.painelfora.panePid, { starttime: 1000002 });
    escreverSessao(home, {
      pid: panes.painelfora.panePid, janela: panes.painelfora.janelaId, pane: panes.painelfora.paneId,
      sessaoId: SESSID_FORA, cwd: CWD_FORA, starttime: 1000002, status: 'busy',
    });
    void T_ALVO; void T_FORA;

    // ── 4) o painel dos dois lados: o "antes" (develop) só fala HTTP com o mock; o "depois"
    //    (esta worktree) lê `COCKPIT_JOBS_DIR` do disco — dados equivalentes, canal diferente
    //    (ver o comentário de `montarJobsNoDisco`, acima).
    pastaJobs = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-jobs-faixa-'));
    montarJobsNoDisco(pastaJobs);

    // ── 5) sobe os DOIS server.js, na MESMA fixture de abas/proc — só o painel de jobs muda ──
    const ambienteBase = { ...process.env };
    delete ambienteBase.COCKPIT_TOKEN;
    // 🔴 Fail-closed contra a armadilha #62 ("trava de isolamento que só protege enquanto o
    // SHELL estiver limpo") — achado do painel de execução. `lib/lidas.js:17` é
    // `COCKPIT_LIDAS_DIR || homedir()/.cockpit`: o `HOME` falso abaixo já manda o carimbo de
    // "lido" para dentro da fixture (medido — com a variável vazia, escreve em
    // `<scratch>/home/.cockpit`), MAS uma variável herdada do shell VENCE o `HOME` e o smoke
    // passaria a escrever no `lidas.json` de verdade ao abrir a conversa. Herdar ambiente é
    // conveniência; apagar o que dá endereço de escrita é a parte que não pode ser esquecida.
    delete ambienteBase.COCKPIT_LIDAS_DIR;
    Object.assign(ambienteBase, {
      HOST: '127.0.0.1',
      HOME: home,
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: SESSAO,
      COCKPIT_PROC_RAIZ: raizProc(scratch),
      COCKPIT_BIN_CLAUDE: '/bin/true',
    });

    servidorAntes = spawn(process.execPath, [path.join(antesDir, 'server.js')], {
      cwd: antesDir,
      // A MESMA pasta de disco do "depois". Era um mock HTTP (`COCKPIT_PAINEL_JOBS`) enquanto a
      // develop ainda lia os jobs de um serviço externo; a absorção mergeou, e desde então as
      // duas árvores leem do mesmo lugar. Deixar o mock aqui não é inofensivo: a variável
      // passaria a ser ignorada, o "antes" ficaria SEM pasta de jobs, e o smoke reprovaria a
      // ausência do grupo como se fosse defeito da branch.
      env: { ...ambienteBase, PORT: String(PORTA_ANTES), COCKPIT_JOBS_DIR: pastaJobs },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    servidorDepois = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
      cwd: RAIZ,
      env: { ...ambienteBase, PORT: String(PORTA_DEPOIS), COCKPIT_JOBS_DIR: pastaJobs },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    for (const [nome, s, porta] of [['antes', servidorAntes, PORTA_ANTES], ['depois', servidorDepois, PORTA_DEPOIS]]) {
      let pronto = false;
      for (let i = 0; i < 60 && !pronto; i += 1) {
        if (s.exitCode !== null) break;
        pronto = await saude(porta);
        if (!pronto) await espera(200);
      }
      if (!ok(pronto, `servidor ${nome} (${porta}) subiu`)) {
        limpar();
        return process.exit(1);
      }
      console.log(`  · servidor ${nome} no ar em http://127.0.0.1:${porta} (pid ${s.pid})`);
    }

    // ── 6) o roteiro, dentro do container — os DOIS modos, mesmo mock ─────────────
    fs.writeFileSync(path.join(scratch, 'pane.js'), montarRoteiro());

    const relatorioAntes = await rodarModo({ modo: 'antes', base: `http://127.0.0.1:${PORTA_ANTES}`, scratch });
    const relatorioDepois = await rodarModo({ modo: 'depois', base: `http://127.0.0.1:${PORTA_DEPOIS}`, scratch });

    for (const f of relatorioAntes.feitos) console.log(`  ✅ [antes] ${f}`);
    for (const f of relatorioAntes.problemas) console.error(`  ❌ [antes] ${f}`);
    for (const f of relatorioDepois.feitos) console.log(`  ✅ [depois] ${f}`);
    for (const f of relatorioDepois.problemas) console.error(`  ❌ [depois] ${f}`);

    ok(relatorioAntes.problemas.length === 0, 'MODO=antes: nenhum problema');
    ok(relatorioDepois.problemas.length === 0, 'MODO=depois: nenhum problema');

    const pngsEsperados = [...pngsDoModo('antes', EH_CELULAR_HOST), ...pngsDoModo('depois', EH_CELULAR_HOST)];
    for (const nome of pngsEsperados) {
      const arquivo = path.join(SAIDA, `${nome}.png`);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }
  } catch (e) {
    console.error('🔴 o smoke estourou:', e && e.message);
    falhas += 1;
  } finally {
    limpar();
  }

  if (falhas > 0) {
    console.error(`\n🔴 ${falhas} problema(s) — os seis PNGs (se existirem) NÃO valem como prova.`);
    process.exit(1);
  }
  console.log(`\n✅ ${feitos} verificações, os dois modos passaram. PNGs em ${SAIDA}`);
  console.log('FALTA AINDA, e não é automático: abrir os seis PNGs e OLHAR (regra de 25/08).');
})();
