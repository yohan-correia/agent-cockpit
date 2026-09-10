#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — a prova de "zero mudança visual" da Fase 2 do split view.
//
// Esqueleto copiado de `testes/smoke-celular-primeira-leva.js` (fixture de /proc falso +
// sessions/<pid>.json + tmux num socket próprio, docker run --network host com puppeteer-core),
// com a LÓGICA INVERTIDA: aquele script prova que 16 medidas MUDARAM entre antes e depois; este
// prova que ficaram TODAS IGUAIS — é a garantia de não-regressão da Fase 2 (design original, §2.5b). Ele NÃO serve para provar a Fase 3 (lá a
// pergunta muda: 1 painel vs N).
//
// MODO=antes|depois é OBRIGATÓRIO (falta → código 2).
//   antes  → grava medidas-390.json e medidas-1600.json em SAIDA, SEM exigir valor nenhum.
//   depois → exige ANTES=<pasta do antes> e que TODAS as chaves de cada arquivo sejam
//            IDÊNTICAS às do "antes" no MESMO viewport.
//
// Roda os DOIS tamanhos numa execução só (R53 da spec): 390×844 (o celular, que não pode
// regredir) e 1600×1000 (o desktop com UMA conversa aberta — a Fase 4 compara 1 painel com N,
// que é outra pergunta; aqui a promessa é "nem esse cenário mudou um pixel").
//
// Seletores são todos de CLASSE (`.chat-topo`, `.medidor`...), nunca de id: o CSS já casa por
// classe hoje (§1.4 da spec) e depois da Fase 2 os ids de painel deixam de existir — um
// seletor por classe funciona nos dois lados da mudança, que é o que permite ao "antes" (uma
// worktree de `develop`, ainda com os ids) e ao "depois" (esta worktree) rodar o MESMO script.
//
// Porta do servidor embutido: 7893 por padrão, PORT= para trocar (a Fase 2 usa 7894 para a
// worktree do baseline, ver o plano). NUNCA 7879 (produção) nem 7899 (jobs).
//
// Códigos de saída: 0 = tudo igual (ou tudo gravado, no antes) · 1 = defeito/divergência ·
// 2 = erro de uso ou de ambiente.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

// ─── Contrato de uso ──────────────────────────────────────────────────────

const MODO = process.env.MODO;
if (MODO !== 'antes' && MODO !== 'depois') {
  console.error('🔴 defina MODO=antes ou MODO=depois');
  process.exit(2);
}
const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os medidas-*.json (e o PNG) vão cair>');
  process.exit(2);
}
const ANTES = process.env.ANTES;
if (MODO === 'depois' && !ANTES) {
  console.error('🔴 MODO=depois exige ANTES=<pasta do "antes" já rodado>, para comparar');
  process.exit(2);
}

const PORTA = Number(process.env.PORT) || 7893;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';

// As ÚNICAS diferenças autorizadas entre o antes e o depois, cada uma com o porquê escrito e o
// valor NOVO fixado — não é "tolerância", é um assert diferente: em vez de "igual ao antes",
// vira "igual ao que decidimos". Lista vazia é o estado normal deste smoke; entrada aqui é
// exceção que alguém teve de justificar, e ela reprova se o valor novo mudar de novo.
const MUDANCAS_ESPERADAS = {
  '844x390.placeholderCaixa': {
    agora: 'Escreva para o agente',
    porque: 'o celular DEITADO já estava com o texto CORTADO AO MEIO em develop (ver '
      + 'BASE2/celular-844x390.png): a caixa tem 346px e o texto longo pede ~380. A régua velha '
      + 'perguntava a largura da JANELA (844px > 760) e respondia "desktop"; a nova pergunta a '
      + 'largura da CAIXA e acerta. É conserto de um defeito que já existe em produção, não '
      + 'regressão desta entrega',
  },
};

const VIEWPORTS = [
  // 360 é o celular PEQUENO (Galaxy S8/S9 e a maioria dos Android baratos), e ele entrou em
  // 09/09 a pedido dos DOIS avaliadores do painel de execução: o placeholder passou a depender
  // da largura medida da caixa, e afirmar "zero pixel novo no celular" medindo só 390px é
  // afirmar sobre um aparelho e concluir sobre todos. É o aparelho que mais perto chega do
  // limiar de baixo (CAIXA_MINIMA), então é ele quem prova que o limiar não invadiu o celular.
  { nome: '360', largura: 360, altura: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { nome: '390', largura: 390, altura: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  // O celular DEITADO. Entrou em 09/09 porque o painel de execução notou a faixa entre
  // CAIXA_LARGA (460) e o breakpoint de 760px: nela a régua nova responde "cabe o texto longo"
  // enquanto a régua antiga (matchMedia de 760px) respondia "estreito". Celular em landscape
  // cai bem no meio dessa faixa, e "zero pixel novo no celular" tem que valer deitado também.
  { nome: '844x390', largura: 844, altura: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { nome: '1600', largura: 1600, altura: 1000, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
];

// ─── Fail-closed do socket, mesmo padrão de smoke-celular-primeira-leva.js ───

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-split-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
  // As sessões que ESTE script cria. A limpeza fail-closed compara o socket com este
  // conjunto antes de derrubar qualquer coisa (D35).
  const MINHAS_SESSOES = new Set(['ancora', SESSAO]);

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

// ─── A ÚNICA aba da fixture ────────────────────────────────────────────────
//
// Uma só, de propósito: a pergunta desta fase é "o cabeçalho de UMA conversa mudou de
// pixel?" — não "quantos painéis cabem". Com usage no `.jsonl` (acende o medidor) e um job
// mock no projeto dela (acende a faixa e a etapa), o cabeçalho nasce no estado MAIS CHEIO
// que existe hoje — é aí que uma regressão de layout apareceria primeiro.

const CWD_PROJETO = '/home/smoke/projetos/splitcheck';
const SESSID = 'sess-splitcheck';

function raizProc(scratch) {
  return path.join(scratch, 'proc');
}

/** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}` no padrão "exec direto". */
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
const linhaAssistente = (iso, texto, extraMessage = {}) => `${JSON.stringify({
  type: 'assistant',
  timestamp: iso,
  message: { content: [{ type: 'text', text: texto }], ...extraMessage },
})}\n`;

/** Conversa com `usage` na cauda — é o que acende o medidor com trilho e porcentagem. */
function conversaComMedidor(caminho) {
  const linhas = [];
  const base = Date.now() - 3600000;
  for (let i = 0; i < 12; i += 1) {
    const quando = base + i * 60000;
    const iso = new Date(quando).toISOString();
    if (i % 2 === 0) linhas.push(linhaHumano(iso, `mensagem ${i}`));
    else if (i === 11) {
      linhas.push(linhaAssistente(iso, `mensagem ${i}`, {
        model: 'claude-opus-5',
        usage: { input_tokens: 92000, cache_read_input_tokens: 17002, output_tokens: 812 },
      }));
    } else linhas.push(linhaAssistente(iso, `mensagem ${i}`));
  }
  escreverConversa(caminho, linhas);
}

/**
 * Um job `running` em pastas de verdade — é o que o `server.js` lê (`COCKPIT_JOBS_DIR`,
 * `lib/jobs.js`). Havia aqui, ao lado, um mock HTTP de `/api/jobs`: até a absorção do painel
 * (2026-09-10) o "antes" desta comparação rodava um `server.js` que buscava os jobs num
 * serviço externo por `COCKPIT_PAINEL_JOBS`, e o script subia os dois canais porque não sabia
 * qual dos dois ia lê-lo. Essa variável não existe mais; o disco é o único canal.
 */
function montarJobNoDisco(pastaJobs) {
  const dir = path.join(pastaJobs, 'job-split-smoke');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id: 'job-split-smoke', type: 'ataca', project: 'splitcheck', title: 'splitcheck',
    created_at: new Date(Date.now() - 60000).toISOString(),
    worktree: '', branch: '', origin: 'capitao', merged_at: null, approved_at: null,
    status: 'running', pid: process.pid, tmux_session: null,
  }));
  fs.writeFileSync(path.join(dir, 'status.log'), `${new Date().toISOString()} working: checando o cabeçalho da fase 2\n`);
  fs.writeFileSync(path.join(dir, 'claude.log'), `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x/public/estilo.css' } }] },
  })}\n`);
}

function saude() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: '/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ─── O roteiro do navegador — roda DENTRO do container ───────────────────────

function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const VIEWPORTS = JSON.parse(process.env.VIEWPORTS_JSON);

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const porViewport = {};
  const problemas = [];

  for (const vp of VIEWPORTS) {
    const pagina = await navegador.newPage();
    const erros = [];
    const requisicoes = [];
    pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
    pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
    pagina.on('response', (r) => { if (r.status() >= 400) requisicoes.push(r.status() + ' ' + r.url()); });
    try {
      await pagina.setViewport({
        width: vp.largura, height: vp.altura, isMobile: vp.isMobile,
        hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor,
      });
      await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
      await pagina.waitForSelector('#abas', { timeout: 15000 });
      await espera(500);

      const clicou = await pagina.evaluate(() => {
        const linhas = Array.from(document.querySelectorAll('#abas .conversa-linha'));
        const alvo = linhas.find((l) => {
          const t2 = l.querySelector('.conversa-titulo');
          return t2 && t2.textContent.includes('splitcheck');
        });
        const botao = alvo && alvo.querySelector('.conversa');
        if (botao) botao.click();
        return Boolean(botao);
      });
      if (!clicou) { problemas.push(vp.nome + ': não achei a linha de splitcheck na lista'); await pagina.close().catch(() => {}); continue; }

      await pagina.waitForSelector('.chat-topo:not([hidden])', { timeout: 10000 }).catch(() => {});
      await espera(500);
      try {
        await pagina.waitForFunction(() => {
          const f = document.querySelector('.faixa-jobs');
          return f && !f.hidden;
        }, { timeout: 20000 });
      } catch {
        problemas.push(vp.nome + ': a .faixa-jobs não apareceu em 20s');
      }
      await espera(300);

      const geral = await pagina.evaluate(() => {
        const folhas = Array.from(document.styleSheets).filter((f) => {
          try { return f.cssRules && f.cssRules.length > 0; } catch { return true; }
        }).length;
        return {
          folhasComRegras: folhas,
          imagensQuebradas: Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).length,
        };
      });
      if (!geral.folhasComRegras) problemas.push(vp.nome + ': NENHUMA folha de estilo com regras');
      if (geral.imagensQuebradas) problemas.push(vp.nome + ': ' + geral.imagensQuebradas + ' imagem(ns) quebrada(s)');
      if (erros.length) problemas.push(vp.nome + ': ' + erros.length + ' erro(s) de console: ' + erros.slice(0, 3).join(' | '));
      if (requisicoes.length) problemas.push(vp.nome + ': ' + requisicoes.length + ' requisição(ões) >=400: ' + requisicoes.slice(0, 3).join(' | '));

      const medidas = await pagina.evaluate(() => {
        const rect = (el) => el.getBoundingClientRect();
        const centro = (el) => rect(el).top + rect(el).height / 2;
        const visivel = (el) => Boolean(el) && !el.hidden && rect(el).width > 0 && rect(el).height > 0;

        // Alguns destes ids ainda não têm classe irmã no "antes" (develop, pré-refactor) —
        // só ganham o className igual ao id na Fase 2 desta mudança (§5.5 da spec). O
        // seletor com vírgula casa os dois mundos: classe (depois) OU id (antes).
        const voltar = document.querySelector('.voltar');
        const identidade = document.querySelector('.chat-identidade');
        const medidor = document.querySelector('.medidor');
        const faixaJobs = document.querySelector('.faixa-jobs');
        const btnParar = document.querySelector('.btn-parar, #btn-parar');
        const recarregar = document.querySelector('.btn-recarregar-conversa, #btn-recarregar-conversa');
        const matar = document.querySelector('.btn-matar-aba, #btn-matar-aba');
        const caminho = document.querySelector('.chat-caminho, #chat-caminho');
        const faixaEtapa = document.querySelector('.faixa-etapa');
        const faixaTitulos = document.querySelector('.faixa-titulos');
        const mensagens = document.querySelector('.mensagens');
        const fecharPainel = document.querySelector('.fechar-painel');
        const abrirAoLado = document.querySelector('.abrir-ao-lado');
        // Caixa de envio por painel (09/09, D42): a .envio deixou de ser faixa do .chat e
        // virou faixa do .painel. A promessa é ZERO PIXEL NOVO no celular — lá o Map de
        // paineis nunca passa de 1, então uma caixa por painel é UMA caixa, no mesmo lugar.
        // Estas quatro medidas são o que prova isso. A classe .envio já existia ANTES da
        // mudança (o index.html tinha class="envio" id="envio"), então o MESMO seletor casa
        // nos dois mundos e o baseline de develop mede exatamente a mesma coisa.
        // Sem crase neste bloco de propósito: o roteiro inteiro viaja dentro de um template
        // literal (ver o docker run abaixo), e uma crase aqui fecha a string no meio.
        const envio = document.querySelector('.envio');
        const caixaTexto = document.querySelector('.entrada, #entrada');

        function linhasVisuais(elementos) {
          const rs = elementos
            .filter((el) => el && rect(el).width > 0 && rect(el).height > 0)
            .map(rect)
            .sort((a, b) => a.top - b.top);
          let linhas = 0;
          let fimAtual = -Infinity;
          for (const r of rs) {
            if (r.top >= fimAtual - 1) { linhas += 1; fimAtual = r.bottom; } else { fimAtual = Math.max(fimAtual, r.bottom); }
          }
          return linhas;
        }

        const linhasDoTopo = linhasVisuais([voltar, identidade, medidor, btnParar, recarregar, matar]);

        const alvosLinha2 = [medidor, faixaJobs, btnParar].filter((el) => el && rect(el).width > 0 && rect(el).height > 0);
        let linha2Itens = 0;
        if (alvosLinha2.length) {
          const ref = rect(alvosLinha2[0]);
          linha2Itens = alvosLinha2.filter((el) => { const r = rect(el); return r.top < ref.bottom && ref.top < r.bottom; }).length;
        }

        const etapaInline = Boolean(faixaEtapa && faixaTitulos && !faixaEtapa.hidden && faixaEtapa.textContent
          && Math.abs(centro(faixaEtapa) - centro(faixaTitulos)) <= 4);

        return {
          linhasDoTopo,
          recarregarVisivel: visivel(recarregar),
          medidorVisivel: visivel(medidor),
          linha2Itens,
          etapaInline,
          caminhoTexto: caminho ? caminho.textContent : null,
          caminhoCortado: caminho ? caminho.scrollWidth > caminho.clientWidth + 1 : false,
          scrollWidth: mensagens ? mensagens.scrollWidth : document.documentElement.scrollWidth,
          fecharPainelVisivel: visivel(fecharPainel),
          abrirAoLadoVisivel: visivel(abrirAoLado),
          envioVisivel: visivel(envio),
          envioTop: envio ? Math.round(rect(envio).top) : null,
          envioAltura: envio ? Math.round(rect(envio).height) : null,
          entradaLargura: caixaTexto ? Math.round(rect(caixaTexto).width) : null,
          // O TEXTO do placeholder, e não só a caixa. Sem esta medida, a regressão de 09/09
          // passou 35/35 verdes: a caixa estava no mesmo pixel, do mesmo tamanho, e o texto
          // dentro dela era o de desktop, quebrado em duas linhas e cortado ao meio. Medida
          // que só olha a moldura não vê o conteúdo errado.
          placeholderCaixa: caixaTexto ? caixaTexto.placeholder : null,
        };
      });

      await pagina.screenshot({ path: '/out/celular-' + vp.nome + '.png' }).catch(() => {});
      porViewport[vp.nome] = medidas;
    } catch (e) {
      problemas.push(vp.nome + ': o roteiro estourou — ' + String(e && e.message).slice(0, 300));
    } finally {
      await pagina.close().catch(() => {});
    }
  }

  await navegador.close();
  console.log('@@MEDIDAS-SPLIT@@' + JSON.stringify({ porViewport, problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e);
  process.exit(1);
});
`;
}

// ─── Corrida ──────────────────────────────────────────────────────────────

(async () => {
  let saida = 1;
  let s3 = null;
  let scratch = null;
  let pastaJobs = null;

  function limpar() {
    let falhouLimpeza = false;
    if (s3 && s3.exitCode === null) {
      try { process.kill(s3.pid); } catch { /* já morreu */ }
      console.log(`  · S3 (pid ${s3.pid}) derrubado pelo pid exato`);
    }
    // A D35 pede DUAS respostas, não uma: o carimbo prova que EU criei aquilo, e a
    // enumeração prova que não há mais ninguém no socket. São perguntas diferentes, e matar
    // exige as duas — o achado do painel de execução de 08/09 era que só a primeira estava
    // aqui (e no molde que copiei).
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    const sessoesAgora = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
      .split('\n').map((n) => n.trim()).filter(Boolean);
    const intrusas = sessoesAgora.filter((n) => !MINHAS_SESSOES.has(n));
    if (temCarimbo && !intrusas.length) {
      t(['kill-server'], { tolerante: true });
    } else if (temCarimbo) {
      // Sobrou quem eu não criei: mata só as minhas e deixa o socket de pé, reclamando.
      for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
      falhouLimpeza = true;
      console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
    } else {
      falhouLimpeza = true;
      falhas += 1;
      console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
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
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-split-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });

    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', 'splitcheck', '-c', os.tmpdir(), 'sleep', '600']);

    const saidaPanes = t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']);
    const panes = {};
    for (const linha of saidaPanes.split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }
    if (!panes.splitcheck) throw new Error('a pane "splitcheck" não apareceu no list-panes');

    conversaComMedidor(caminhoDoJsonl(home, CWD_PROJETO, SESSID));
    plantarAgenteFalso(scratch, panes.splitcheck.panePid, { starttime: 2000001 });
    escreverSessao(home, {
      pid: panes.splitcheck.panePid, janela: panes.splitcheck.janelaId, pane: panes.splitcheck.paneId,
      sessaoId: SESSID, cwd: CWD_PROJETO, starttime: 2000001, status: 'idle',
    });

    console.log(`  · fixture pronta: splitcheck=${panes.splitcheck.panePid}`);

    pastaJobs = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-jobs-split-'));
    montarJobNoDisco(pastaJobs);

    const ambiente = { ...process.env };
    delete ambiente.COCKPIT_TOKEN;
    Object.assign(ambiente, {
      HOST: '127.0.0.1',
      PORT: String(PORTA),
      HOME: home,
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: SESSAO,
      COCKPIT_PROC_RAIZ: raizProc(scratch),
      COCKPIT_BIN_CLAUDE: '/bin/true',
      COCKPIT_JOBS_DIR: pastaJobs,
    });
    s3 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: ambiente, stdio: ['ignore', 'ignore', 'pipe'],
    });

    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (s3.exitCode !== null) break;
      pronto = await saude();
      if (!pronto) await espera(200);
    }
    if (!pronto) {
      ok(false, `S3 (${PORTA}) não subiu`);
      limpar();
      return process.exit(1);
    }
    console.log(`  · S3 no ar em http://127.0.0.1:${PORTA} (pid ${s3.pid}), socket ${SOCKET}`);

    const roteiro = montarRoteiro();
    fs.writeFileSync(path.join(scratch, 'pane.js'), roteiro);

    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-e', `VIEWPORTS_JSON=${JSON.stringify(VIEWPORTS)}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigo = await new Promise((r) => docker.on('close', r));
    console.log(saidaDocker);

    let relatorio = null;
    const MARCADOR = '@@MEDIDAS-SPLIT@@';
    const abre = saidaDocker.indexOf(MARCADOR);
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }

    const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigo})`];
    const porViewport = relatorio ? relatorio.porViewport : {};

    ok(problemas.length === 0, problemas.length
      ? `o percurso reprovou: ${problemas.join(' · ')}`
      : 'os dois viewports abriram a conversa e mediram o cabeçalho sem erro de CSS/console/requisição');

    for (const vp of VIEWPORTS) {
      const medidas = porViewport[vp.nome];
      if (!ok(Boolean(medidas), `viewport ${vp.nome}: medidas coletadas`)) continue;
      const arquivoMedidas = path.join(SAIDA, `medidas-${vp.nome}.json`);
      fs.writeFileSync(arquivoMedidas, JSON.stringify(medidas, null, 2));

      if (MODO === 'antes') {
        ok(true, `MODO=antes: ${arquivoMedidas} gravado, sem exigir valor`);
      } else {
        const caminhoAntes = path.join(ANTES, `medidas-${vp.nome}.json`);
        if (!ok(fs.existsSync(caminhoAntes), `viewport ${vp.nome}: ${caminhoAntes} existe`)) continue;
        const antes = JSON.parse(fs.readFileSync(caminhoAntes, 'utf8'));
        const chaves = new Set([...Object.keys(antes), ...Object.keys(medidas)]);
        for (const chave of chaves) {
          const esperada = MUDANCAS_ESPERADAS[`${vp.nome}.${chave}`];
          if (esperada) {
            ok(JSON.stringify(medidas[chave]) === JSON.stringify(esperada.agora),
              `viewport ${vp.nome}: ${chave} MUDOU DE PROPÓSITO — ${esperada.porque} (antes ${JSON.stringify(antes[chave])}, agora ${JSON.stringify(medidas[chave])})`);
            continue;
          }
          ok(JSON.stringify(antes[chave]) === JSON.stringify(medidas[chave]),
            `viewport ${vp.nome}: ${chave} igual ao antes (antes ${JSON.stringify(antes[chave])}, agora ${JSON.stringify(medidas[chave])})`);
        }
      }
    }

    for (const vp of VIEWPORTS) {
      const png = path.join(SAIDA, `celular-${vp.nome}.png`);
      ok(fs.existsSync(png) && fs.statSync(png).size > 1000, `${png} gerado`);
    }

    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('\n🔴 o smoke estourou:', e && e.message);
    saida = 1;
  } finally {
    const limpezaOk = limpar();
    if (!limpezaOk) saida = saida || 1;
    console.log(`\n${falhas || saida ? '❌ SMOKE DO SPLIT VERMELHO' : '✅ SMOKE DO SPLIT VERDE'}`
      + ` — ${feitos - falhas}/${feitos} · medidas-*.json e PNGs em ${SAIDA}\n`);
  }
  process.exit(saida);
})();
