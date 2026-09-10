#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — celular, primeira leva do design (card `tela-do-celular-primeira-leva`).
//
// Prova de tela dos QUATRO achados (spec 2026-09-02, §3.4.2), com antes/depois: Achado A (a
// nota do corte vaza), Achado B (o aviso de carregamento é vermelho), Achado C (o cabeçalho
// não cabe em 390px) e Achado D (três bordas competindo na lista).
//
// Molde: `testes/smoke-navegador-atalhos.js` (spawn do `server.js`, socket tmux carimbado,
// `docker run --network host`, saída 0/1/2). O que muda daquele molde: aqui a fita PRECISA de
// bolhas reais, então o smoke monta um `HOME` de mentira inteiro (sessions + .jsonl) sobre
// QUATRO panes de verdade num socket próprio — nunca o tmux `main` do usuário (§5.2 R5).
//
// MODO=antes|depois é OBRIGATÓRIO (falta → código 2). `depois` exige `ANTES=` também — um
// mesmo assert não pode exigir `bordasVivas === 2` e `=== 1` ao mesmo tempo.
//
// Porta: 7891 (o S3 desta entrega). NUNCA 7899 (#24 — é a porta dos gates dos jobs do orquestrador)
// nem 7879 (produção).
//
// Códigos de saída: 0 = tudo passou · 1 = qualquer falha de produto/assert · 2 = erro de USO
// (falta MODO, falta ANTES no depois, `$SAIDA` com PNG dentro) ou de AMBIENTE (imagem docker
// ausente, servidor não subiu).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

// ─── Contrato de uso — validado ANTES de tocar em qualquer coisa ─────────────

const MODO = process.env.MODO;
if (MODO !== 'antes' && MODO !== 'depois') {
  console.error('🔴 defina MODO=antes ou MODO=depois');
  process.exit(2);
}
const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs e o medidas.json vão cair>');
  process.exit(2);
}
const ANTES = process.env.ANTES;
if (MODO === 'depois' && !ANTES) {
  console.error('🔴 MODO=depois exige ANTES=<pasta do "antes" já rodado>, para comparar');
  process.exit(2);
}

const PORTA = 7891;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';

const PNGS = ['01-lista', '02-conversa-topo', '03-corte-nota', '04-aviso-estado'];

// ─── Fail-closed do socket, mesmo padrão de smoke-navegador-atalhos.js ───────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-celular-${process.pid}`;
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

// ─── As quatro abas da fixture ────────────────────────────────────────────
//
// Escolhidas para provar a HIERARQUIA (ponto 6 do painel da spec, §7): uma linha marcada
// sozinha não prova comparação nenhuma.
//
//   projeto-b       quieta            (lida, sem pergunta)               peso 400 + --texto-2
//   projeto-c  te esperando      (localStorage atrás da última msg)  borda some; negrito fica
//   projeto-a    perguntando       (status: "waiting" no sessions/.)  borda sobrevive — a única
//   bsd          sem agente        (pane sem CLI no /proc falso)      Achado B + S4

const CWD_PROJETO_B = '/home/smoke/projetos/projeto-b';
const CWD_PROJETO_C = '/home/smoke/projetos/projeto-c';
const CWD_PROJETO_A = '/home/smoke/projetos/projeto-a';

const SESSID_PROJETO_B = 'sess-projeto-b';
const SESSID_PROJETO_C = 'sess-projeto-c';
const SESSID_PROJETO_A = 'sess-projeto-a';

// ─── Fixture: /proc de mentira ────────────────────────────────────────────
//
// Molde: `testes/gate-codex.js:63-94` (arvoreProc). Um pane "exec claude" — o pane_pid É o
// agente, sem shell intermediário — dispensa a árvore de dois níveis: `pgrp === tpgid ===
// panePid`, e o `argv[0]` casa direto o `padraoCmd` de `lib/agentes.js`.

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
  campos[4] = String(pid);              // campo 5 (pgrp) = o próprio pid — pattern "exec"
  campos[5] = String(pid);              // campo 6 (sessão)
  campos[6] = '34816';                  // campo 7 (tty_nr), dummy
  campos[7] = String(pid);              // campo 8 (tpgid) = pgrp — está em foreground
  campos[21] = String(starttime);       // campo 22 (starttime)
  fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`);
  fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task', String(pid), 'children'), '');
}

/** `~/.claude/sessions/<pid>.json`, casado com o `starttime` plantado no /proc falso. */
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

/** `~/.claude/projects/<cwd-com-hifens>/<sessaoId>.jsonl` — o caminho que `lib/abas.js` monta. */
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

/** Uma conversa pequena (4 linhas), última mensagem no `T` dado. Devolve `T` em ms. */
function conversaPequena(caminho, baseMs) {
  const linhas = [];
  let quando = baseMs - 3 * 60000;
  linhas.push(linhaHumano(new Date(quando).toISOString(), 'oi, tudo bem por aí?')); quando += 60000;
  linhas.push(linhaAssistente(new Date(quando).toISOString(), 'tudo certo — o que você precisa?')); quando += 60000;
  linhas.push(linhaHumano(new Date(quando).toISOString(), 'só confirmando que a aba está viva')); quando += 60000;
  linhas.push(linhaAssistente(new Date(quando).toISOString(), 'confirmado, sigo por aqui.'));
  escreverConversa(caminho, linhas);
  return quando;
}

// A receita do Achado A + do corte: 200 linhas, ~300 bytes cada (~60 KB) — acima do BLOCO de
// 64 KB de `lib/externo.js` (ver o comentário na spec, §3.4.2 ponto 5 da rodada 5). Com o
// arquivo maior que um bloco, a leitura para trás para ANTES do byte 0 com `msgs >= 80`, e
// `cortado` sai `true`. `ALVO_MENSAGENS` é 80 (`lib/externo.js:209`); 200 linhas garantem
// folga grande.
function conversaGrande(caminho) {
  const linhas = [];
  const base = Date.now() - 2 * 3600000; // 2h atrás
  const enchimento = 'texto de enchimento do smoke da tela do celular, para passar dos 64 KB '.repeat(3);
  let ultimoIso = '';
  for (let i = 0; i < 200; i += 1) {
    const quando = base + i * 60000;
    const iso = new Date(quando).toISOString();
    ultimoIso = iso;
    const texto = `mensagem número ${i} — ${enchimento}`.slice(0, 300);
    if (i % 2 === 0) {
      linhas.push(linhaHumano(iso, texto));
    } else if (i === 199) {
      // A última linha (assistant): carrega o `usage` que acende o medidor (lib/contexto.js).
      // Sem `message.usage` aqui, `linhasDoTopo` ficaria 1 mesmo no "depois" — o par `02`
      // provaria o contrário do que deveria (achado da rodada 2 do painel da spec).
      linhas.push(linhaAssistente(iso, texto, {
        model: 'claude-opus-5',
        usage: { input_tokens: 92000, cache_read_input_tokens: 17002, output_tokens: 812 },
      }));
    } else {
      linhas.push(linhaAssistente(iso, texto));
    }
  }
  escreverConversa(caminho, linhas);
  return Date.parse(ultimoIso);
}

// ─── O job — a quinta peça, para provar a linha 2 CHEIA ──────────────────────
//
// `lib/jobs.js` lê a pasta de `COCKPIT_JOBS_DIR` do disco (meta.json + status.log +
// claude.log), não mais um `/api/jobs` de painel externo — a rota em `server.js` filtra
// `origin === 'capitao'` e `state === 'running'`. O campo `abas` da resposta final é
// CALCULADO pelo servidor (`abas.abasDoProjeto(j.project, abertas)`) a partir do `project` e
// da lista de abas JÁ ABERTA — a fixture não precisa (e não deve) inventar chave de aba nenhuma.
function montarJobNoDisco(pastaJobs) {
  const dir = path.join(pastaJobs, 'job-smoke-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id: 'job-smoke-1', type: 'ataca', project: 'projeto-c', title: 'projeto-c',
    created_at: new Date(Date.now() - 90000).toISOString(),
    worktree: '', branch: '', origin: 'capitao', merged_at: null, approved_at: null,
    status: 'running', pid: process.pid, tmux_session: null,
  }));
  fs.writeFileSync(path.join(dir, 'status.log'),
    `${new Date().toISOString()} working: bloco de celular, segunda linha do cabeçalho\n`);
  // A etapa que `etapaAtual()` (`lib/jobs.js`) lê da cauda do log — é o que faz a faixa
  // mostrar "editando estilo.css" em vez de ficar muda.
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
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE;
const FIXTURE_HOME = process.env.FIXTURE_HOME;
const PROJETO_C_SESSAO_ARQUIVO = process.env.PROJETO_C_SESSAO_ARQUIVO;
const PROJETO_C_SESSAO_BUSY = process.env.PROJETO_C_SESSAO_BUSY;
const LIDAS = JSON.parse(process.env.LIDAS_JSON);

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const medidas = {};
  const problemas = [];

  const VIEWPORT = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

  /** Clica na primeira linha da lista cujo título contém \`nome\`. */
  const abrirALinha = (nome) => (pagina) => pagina.evaluate((n) => {
    const linhas = Array.from(document.querySelectorAll('#abas .conversa-grupo[data-cwd] .conversa-linha'));
    const alvo = linhas.find((l) => {
      const t = l.querySelector('.conversa-titulo');
      return t && t.textContent.includes(n);
    });
    const botao = alvo && alvo.querySelector('.conversa');
    if (botao) botao.click();
    return Boolean(botao);
  }, nome);

  /** Roteiro genérico: abre página, roda \`acao\`, mede invariantes + \`medir\`, e só então tira o print. */
  async function roteiro(nome, { acao, medir }) {
    const pagina = await navegador.newPage();
    const erros = [];
    const requisicoes = [];
    pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
    pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
    pagina.on('response', (r) => { if (r.status() >= 400) requisicoes.push(r.status() + ' ' + r.url()); });
    try {
      await pagina.setViewport(VIEWPORT);
      // O Chromium headless nasce em \`prefers-color-scheme: light\`, e o CSS tem um bloco
      // \`@media (prefers-color-scheme: light)\` que trocaria a paleta inteira — o PNG sairia
      // no tema claro, que não é o que o usuário usa no celular. Tema escuro, explícito.
      await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
      await pagina.waitForSelector('#abas', { timeout: 15000 });
      await espera(600);
      if (acao) {
        const veredito = await acao(pagina);
        if (veredito && veredito.ok === false) {
          problemas.push(nome + ': ' + veredito.porque);
          await pagina.close().catch(() => {});
          return;
        }
      }
      const geral = await pagina.evaluate(() => {
        const folhas = Array.from(document.styleSheets).filter((f) => {
          try { return f.cssRules && f.cssRules.length > 0; } catch { return true; }
        }).length;
        return {
          folhasComRegras: folhas,
          imagensQuebradas: Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).length,
        };
      });
      if (!geral.folhasComRegras) problemas.push(nome + ': NENHUMA folha de estilo com regras');
      if (geral.imagensQuebradas) problemas.push(nome + ': ' + geral.imagensQuebradas + ' imagem(ns) quebrada(s)');
      if (erros.length) problemas.push(nome + ': ' + erros.length + ' erro(s) de console: ' + erros.slice(0, 3).join(' | '));
      if (requisicoes.length) problemas.push(nome + ': ' + requisicoes.length + ' requisição(ões) >=400: ' + requisicoes.slice(0, 3).join(' | '));

      const resultado = await pagina.evaluate(medir);
      if (resultado.ok === false) {
        problemas.push(nome + ': ' + resultado.porque);
        await pagina.close().catch(() => {});
        return;
      }
      await pagina.screenshot({ path: '/out/' + nome + '.png' });
      Object.assign(medidas, resultado.dados || {});
    } catch (e) {
      problemas.push(nome + ': o roteiro estourou — ' + String(e && e.message).slice(0, 300));
    } finally {
      await pagina.close().catch(() => {});
    }
  }

  // ── 01-lista ────────────────────────────────────────────────────────────
  await roteiro('01-lista', {
    acao: async (pagina) => {
      const m1 = await pagina.evaluate(() => !!document.getElementById('abas'));
      if (!m1) return { ok: false, porque: '#abas não existe no DOM' };
      await pagina.evaluate((lidas) => {
        localStorage.setItem('cockpit-lidas', JSON.stringify(lidas));
      }, LIDAS);
      await pagina.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await pagina.waitForSelector('#abas', { timeout: 15000 });
      await espera(600);
      const linhas = await pagina.evaluate(() => document.querySelectorAll('#abas .conversa-grupo[data-cwd] .conversa-linha').length);
      if (linhas < 4) return { ok: false, porque: 'só ' + linhas + ' linha(s) na lista, esperava 4' };
      return { ok: true };
    },
    medir: () => {
      const acharLinha = (nome) => Array.from(document.querySelectorAll('#abas .conversa-grupo[data-cwd] .conversa-linha'))
        .find((l) => { const t = l.querySelector('.conversa-titulo'); return t && t.textContent.includes(nome); });
      const tituloDe = (nome) => { const l = acharLinha(nome); return l && l.querySelector('.conversa-titulo'); };
      const pesoDe = (nome) => { const t = tituloDe(nome); return t ? getComputedStyle(t).fontWeight : null; };
      const corDe = (nome) => { const t = tituloDe(nome); return t ? getComputedStyle(t).color : null; };
      const bordaDe = (nome) => {
        const l = acharLinha(nome); const el = l && l.querySelector('.conversa');
        if (!el) return null;
        const cs = getComputedStyle(el);
        return cs.borderLeftWidth === '2px' && cs.borderLeftColor !== 'rgba(0, 0, 0, 0)' ? cs.borderLeftColor : null;
      };
      const bordas = Array.from(document.querySelectorAll('#abas .conversa-grupo[data-cwd] .conversa')).filter((el) => {
        const cs = getComputedStyle(el);
        return cs.borderLeftWidth === '2px' && cs.borderLeftColor !== 'rgba(0, 0, 0, 0)';
      });
      return {
        ok: true,
        dados: {
          bordasVivas: bordas.length,
          pesoQuieta: pesoDe('projeto-b'),
          corQuieta: corDe('projeto-b'),
          pesoEsperando: pesoDe('projeto-c'),
          pesoSemAgente: pesoDe('bsd'),
          bordaPerguntando: bordaDe('projeto-a'),
        },
      };
    },
  });

  // Mutação do fixture ENTRE fotos: a mesma aba (projeto-c) precisa ser "esperando" na
  // LISTA (rodando:false) e ter .painel .btn-parar visível quando ABERTA (rodando:true) — dois
  // instantes diferentes do MESMO arquivo de sessão, exatamente como o CLI de verdade muda
  // \`status\` ao vivo. Escrito aqui (dentro do container, com o fixture montado em
  // FIXTURE_HOME) para não precisar de uma segunda chamada docker.
  if (PROJETO_C_SESSAO_ARQUIVO && PROJETO_C_SESSAO_BUSY) {
    fs.writeFileSync(PROJETO_C_SESSAO_ARQUIVO, PROJETO_C_SESSAO_BUSY);
  }

  // ── 02-conversa-topo ────────────────────────────────────────────────────
  await roteiro('02-conversa-topo', {
    acao: async (pagina) => {
      const clicou = await abrirALinha('projeto-c')(pagina);
      if (!clicou) return { ok: false, porque: 'não achei a linha de projeto-c na lista' };
      await pagina.waitForSelector('.painel .chat-topo:not([hidden])', { timeout: 10000 }).catch(() => {});
      await espera(500);
      try {
        await pagina.waitForFunction(() => {
          const f = document.querySelector('.painel .faixa-jobs');
          return f && !f.hidden;
        }, { timeout: 20000 });
      } catch {
        return { ok: false, porque: 'a .painel .faixa-jobs não apareceu em 20s' };
      }
      const bolhas = await pagina.evaluate(() => document.querySelectorAll('.painel .fita .bolha-eu, .painel .fita .fala').length);
      if (bolhas < 2) return { ok: false, porque: 'só ' + bolhas + ' bolha(s) com texto na fita' };
      return { ok: true };
    },
    medir: () => {
      const rect = (el) => el.getBoundingClientRect();
      const voltar = document.querySelector('.painel .btn-voltar');
      const titulo = document.querySelector('.painel .chat-titulo');
      const matar = document.querySelector('.painel .btn-matar-aba');
      const medidor = document.querySelector('.painel .medidor');
      const faixaJobs = document.querySelector('.painel .faixa-jobs');
      const btnParar = document.querySelector('.painel .btn-parar');
      const identidade = document.querySelector('.chat-identidade');
      const caminho = document.querySelector('.painel .chat-caminho');
      const recarregar = document.querySelector('.painel .btn-recarregar-conversa');
      const faixaEtapa = document.querySelector('.painel .faixa-etapa');
      const faixaTitulos = document.querySelector('.painel .faixa-titulos');
      const chatTopo = document.querySelector('.painel .chat-topo');
      if (!voltar || !titulo || !matar || !identidade) {
        return { ok: false, porque: 'faltam elementos base do .painel .chat-topo' };
      }

      const centro = (el) => rect(el).top + rect(el).height / 2;

      // Quantas linhas VISUAIS os itens do "cromo" ocupam (não a .faixa-jobs, que já tem
      // linha própria HOJE por flex-basis:100% — isso é ortogonal ao Achado C). Não é "mesmo
      // top nem mesmo centro": sob align-items:center, um botão de 40px de alvo de dedo e o
      // h1 de ~19px têm topos E centros levemente diferentes mesmo na MESMA linha (o h1 é o
      // primeiro filho, no TOPO da .chat-identidade, que por sua vez É centralizada como um
      // todo — o filho não herda essa centralização). A régua que sobra e que não erra por
      // causa de altura desigual é a de SOBREPOSIÇÃO vertical: dois itens estão na mesma
      // linha se as faixas [top, bottom] deles se tocam; clustering por ordem de top.
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

      // Quantos de {medidor, faixa-jobs, parar} compartilham a faixa vertical do PRIMEIRO
      // deles (o medidor) — hoje (antes) a faixa já tem linha própria e não se sobrepõe ao
      // medidor: conta 2 (medidor + parar). Depois da Fase 2 os três dividem a mesma linha:
      // conta 3. Sobreposição de [top,bottom], não igualdade de top — mesmo motivo de cima.
      const alvosLinha2 = [medidor, faixaJobs, btnParar].filter((el) => el && rect(el).width > 0 && rect(el).height > 0);
      let linha2Itens = 0;
      if (alvosLinha2.length) {
        const ref = rect(alvosLinha2[0]);
        linha2Itens = alvosLinha2.filter((el) => { const r = rect(el); return r.top < ref.bottom && ref.top < r.bottom; }).length;
      }

      const etapaInline = Boolean(faixaEtapa && faixaTitulos && !faixaEtapa.hidden && faixaEtapa.textContent
        && Math.abs(centro(faixaEtapa) - centro(faixaTitulos)) <= 4);

      return {
        ok: true,
        dados: {
          linhasDoTopo,
          linha2Itens,
          linha2Overflow: chatTopo.scrollWidth > chatTopo.clientWidth + 1,
          etapaInline,
          caminhoCortado: caminho.scrollWidth > caminho.clientWidth + 1,
          caminhoTexto: caminho.textContent,
          caminhoTitle: caminho.title,
          recarregarVisivel: recarregar ? rect(recarregar).width > 0 : false,
        },
      };
    },
  });

  // ── 03-corte-nota ───────────────────────────────────────────────────────
  await roteiro('03-corte-nota', {
    acao: async (pagina) => {
      const clicou = await abrirALinha('projeto-c')(pagina);
      if (!clicou) return { ok: false, porque: 'não achei a linha de projeto-c na lista' };
      await pagina.waitForSelector('.painel .chat-topo:not([hidden])', { timeout: 10000 }).catch(() => {});
      await espera(1500);
      const temNota = await pagina.evaluate(() => Boolean(document.querySelector('.painel .fita .corte-nota')));
      if (!temNota) {
        return { ok: false, porque: 'o fixture não disparou o corte — .corte-nota não está na fita' };
      }
      // A conversa abre GRUDADA NO FIM, e o "sincronizado" pode chegar DEPOIS deste ponto (o
      // arquivo é grande: ~180 mensagens lidas para trás) — quando ele chega, despejarFita()
      // rola de volta para o fim, desfazendo um scrollTop=0 de uma tacada só. Reforça a
      // posição várias vezes, para vencer esse "sincronizado" tardio.
      for (let i = 0; i < 8; i += 1) {
        await pagina.evaluate(() => { document.querySelector('.painel .mensagens').scrollTop = 0; });
        await espera(200);
      }
      return { ok: true };
    },
    medir: () => {
      const nota = document.querySelector('.painel .fita .corte-nota');
      const fita = document.querySelector('.painel .fita');
      const mensagens = document.querySelector('.painel .mensagens');
      if (!nota || !fita) return { ok: false, porque: '.corte-nota ou .painel .fita sumiram entre o assert e a medida' };
      const notaVaza = nota.getBoundingClientRect().right > fita.getBoundingClientRect().right + 1;
      // Não é document.documentElement.scrollWidth: body com overflow:hidden propaga para o
      // viewport, e .painel .mensagens com overflow-y:auto sem overflow-x declarado COMPUTA
      // overflow-x:auto (regra do CSS Overflow — visible ao lado de não-visible vira auto).
      // O .painel .mensagens vira o container que CONTÉM o vazamento antes dele alcançar o
      // documento: medido, a página fica em ~390px mesmo com a nota vazando de verdade. Quem
      // rola de lado é .painel .mensagens, e é o scrollWidth dele que mostra o vazamento.
      return { ok: true, dados: { notaVaza, scrollWidth: mensagens.scrollWidth } };
    },
  });

  // ── 04-aviso-estado ─────────────────────────────────────────────────────
  await roteiro('04-aviso-estado', {
    acao: async (pagina) => {
      const clicou = await abrirALinha('bsd')(pagina);
      if (!clicou) return { ok: false, porque: 'não achei a linha de bsd na lista' };
      await pagina.waitForSelector('.painel .chat-topo:not([hidden])', { timeout: 10000 }).catch(() => {});
      await espera(600);
      const tituloOk = await pagina.evaluate(() => (document.querySelector('.painel .chat-titulo') || {}).textContent);
      if (!tituloOk || !/bsd/.test(tituloOk)) {
        return { ok: false, porque: 'o .painel .chat-titulo não mostra "bsd" (' + tituloOk + ')' };
      }
      return { ok: true };
    },
    medir: () => {
      const aviso = document.querySelector('.painel .aviso-agente');
      const bolhas = document.querySelectorAll('.painel .fita .bolha-erro').length;
      return {
        ok: true,
        dados: {
          avisoVisivel: aviso ? !aviso.hidden : false,
          avisoTexto: aviso ? aviso.textContent : '',
          // Só com o aviso VISÍVEL: escondido, o computed color é o mesmo (--texto-2) antes e
          // depois, e a chave deixaria de provar que o aviso passou a existir no cabeçalho.
          corDoAviso: aviso && !aviso.hidden ? getComputedStyle(aviso).color : '',
          bolhasNaFita: bolhas,
        },
      };
    },
  });

  await navegador.close();
  // Marcador próprio, e não a primeira/última '{' da saída: ruído do Chromium no stderr
  // (misturado ao stdout pelo host, que junta os dois streams num só) tem chaves de sobra, e
  // contar em cima delas é o tipo de extração que quebra por acidente.
  console.log('@@MEDIDAS-CELULAR@@' + JSON.stringify({ medidas, problemas }));
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
    // Fail-closed de verdade (ponto 3 do painel do plano, corrigindo o molde de origem): se a
    // janela-âncora sumiu, isto é FALHA — não um aviso que o smoke ignora. Sem incrementar
    // `falhas`, um smoke que perdeu a posse do socket podia sair 0 deixando um servidor tmux
    // vivo, contaminando a execução seguinte (a #24 por outro caminho).
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    if (temCarimbo) {
      t(['kill-server'], { tolerante: true });
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
      limpar();
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-celular-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });

    // ── 1) as QUATRO panes, num socket próprio ──────────────────────────────
    //
    // O carimbo mora numa SESSÃO PRÓPRIA (`ancora`), não na `SESSAO` que `listar()` lê
    // (`COCKPIT_TMUX_SESSAO`): `lib/abas.js` filtra por `sessaoTmux === SESSAO_DAS_ABAS`, e
    // uma âncora dentro da própria `SESSAO` apareceria como uma QUINTA aba na lista — visto
    // no primeiro print (a janela "dono-…" ao lado das quatro de verdade).
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', 'projeto-b', '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-window', '-t', SESSAO, '-n', 'projeto-c', '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-window', '-t', SESSAO, '-n', 'projeto-a', '-c', os.tmpdir(), 'sleep', '600']);
    const dirBsd = path.join(scratch, 'pane-bsd');
    fs.mkdirSync(dirBsd, { recursive: true });
    t(['new-window', '-t', SESSAO, '-n', 'bsd', '-c', dirBsd, 'sleep', '600']);

    // ── 2) ler pane_id/pane_pid REAIS ───────────────────────────────────────
    const saidaPanes = t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']);
    const panes = {};
    for (const linha of saidaPanes.split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }
    for (const nome of ['projeto-b', 'projeto-c', 'projeto-a', 'bsd']) {
      if (!panes[nome]) throw new Error(`a pane "${nome}" não apareceu no list-panes`);
    }

    // ── 3) só então: /proc falso + sessions/<pid>.json, com os números REAIS ─
    const T_PROJETO_B = conversaPequena(
      caminhoDoJsonl(home, CWD_PROJETO_B, SESSID_PROJETO_B), Date.now() - 20 * 60000,
    );
    const T_PROJETO_C = conversaGrande(caminhoDoJsonl(home, CWD_PROJETO_C, SESSID_PROJETO_C));
    const T_PROJETO_A = conversaPequena(
      caminhoDoJsonl(home, CWD_PROJETO_A, SESSID_PROJETO_A), Date.now() - 15 * 60000,
    );

    plantarAgenteFalso(scratch, panes.projeto-b.panePid, { starttime: 1000001 });
    escreverSessao(home, {
      pid: panes.projeto-b.panePid, janela: panes.projeto-b.janelaId, pane: panes.projeto-b.paneId,
      sessaoId: SESSID_PROJETO_B, cwd: CWD_PROJETO_B, starttime: 1000001, status: 'idle',
    });

    plantarAgenteFalso(scratch, panes.projeto-c.panePid, { starttime: 1000002 });
    const arenaSessaoArquivo = path.join(home, '.claude', 'sessions', `${panes.projeto-c.panePid}.json`);
    escreverSessao(home, {
      pid: panes.projeto-c.panePid, janela: panes.projeto-c.janelaId, pane: panes.projeto-c.paneId,
      sessaoId: SESSID_PROJETO_C, cwd: CWD_PROJETO_C, starttime: 1000002, status: 'idle',
    });
    // A versão "ocupada" que o roteiro grava DEPOIS da foto 01 — mesma sessão, `status: busy`,
    // para o .painel .btn-parar aparecer quando a conversa é ABERTA (§ ver comentário no roteiro).
    const arenaSessaoBusy = JSON.stringify({
      kind: 'interactive', sessionId: SESSID_PROJETO_C, cwd: CWD_PROJETO_C, status: 'busy',
      updatedAt: Date.now(), pid: panes.projeto-c.panePid, procStart: 1000002,
      tmux: `${SESSAO}:${panes.projeto-c.janelaId}.${panes.projeto-c.paneId}`,
    });

    plantarAgenteFalso(scratch, panes.projeto-a.panePid, { starttime: 1000003 });
    escreverSessao(home, {
      pid: panes.projeto-a.panePid, janela: panes.projeto-a.janelaId, pane: panes.projeto-a.paneId,
      sessaoId: SESSID_PROJETO_A, cwd: CWD_PROJETO_A, starttime: 1000003, status: 'waiting',
    });

    // bsd: NENHUMA entrada no /proc falso e NENHUMA sessão — `detectarAgente` lê
    // `${procRaiz()}/<panePid>/stat`, não acha nada, devolve `null` sem exceção. É assim que
    // ela vira "aba sem agente" — pane de verdade, só sem CLI na árvore /proc de mentira.

    console.log(`  · fixture pronta: projeto-b=${panes.projeto-b.panePid} projeto-c=${panes.projeto-c.panePid}`
      + ` projeto-a=${panes.projeto-a.panePid} bsd=${panes.bsd.panePid}`);

    // ── 4) o localStorage — sem ele NENHUMA aba nasce quieta ────────────────
    const LIDAS = {
      [SESSID_PROJETO_B]: T_PROJETO_B,
      [SESSID_PROJETO_A]: T_PROJETO_A,
      [SESSID_PROJETO_C]: T_PROJETO_C - 60000,   // atrás da última mensagem → "te esperando"
    };

    // ── 5) o job, em pastas de verdade ───────────────────────────────────────
    pastaJobs = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-jobs-primeira-leva-'));
    montarJobNoDisco(pastaJobs);

    // ── 6) sobe o S3 apontando para o mundo de mentira ──────────────────────
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

    // ── 7) o roteiro, dentro do container ────────────────────────────────────
    const roteiro = montarRoteiro();
    fs.writeFileSync(path.join(scratch, 'pane.js'), roteiro);

    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-e', `FIXTURE_HOME=/fixture-home`,
      '-e', `PROJETO_C_SESSAO_ARQUIVO=/fixture-home/.claude/sessions/${panes.projeto-c.panePid}.json`,
      '-e', `PROJETO_C_SESSAO_BUSY=${arenaSessaoBusy}`,
      '-e', `LIDAS_JSON=${JSON.stringify(LIDAS)}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${home}:/fixture-home:rw`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigo = await new Promise((r) => docker.on('close', r));
    console.log(saidaDocker);

    let relatorio = null;
    const MARCADOR = '@@MEDIDAS-CELULAR@@';
    const abre = saidaDocker.indexOf(MARCADOR);
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }

    const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigo})`];
    const medidas = relatorio ? relatorio.medidas : {};

    ok(problemas.length === 0, problemas.length
      ? `o percurso reprovou: ${problemas.join(' · ')}`
      : 'os quatro passos passaram: CSS, console, requisições e os asserts de DOM de cada um');

    for (const nome of PNGS) {
      const arquivo = path.join(SAIDA, `${nome}.png`);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }

    if (problemas.length === 0) {
      medidas.cwdDaFixture = CWD_PROJETO_C;
      fs.writeFileSync(path.join(SAIDA, 'medidas.json'), JSON.stringify(medidas, null, 2));

      // ── 8) as exigências do MODO ───────────────────────────────────────────
      if (MODO === 'antes') {
        const alvo = {
          bordasVivas: 2, notaVaza: true, linhasDoTopo: 1, caminhoCortado: true,
          avisoVisivel: false, recarregarVisivel: true, bolhasNaFita: 1,
          linha2Itens: 2, linha2Overflow: false, etapaInline: false,
          pesoQuieta: '550', pesoEsperando: '700', pesoSemAgente: '450',
          caminhoTexto: '~/projetos/projeto-c',
        };
        for (const [chave, valor] of Object.entries(alvo)) {
          ok(JSON.stringify(medidas[chave]) === JSON.stringify(valor),
            `MODO=antes: ${chave} === ${JSON.stringify(valor)} (veio ${JSON.stringify(medidas[chave])})`);
        }
        ok(medidas.scrollWidth > 400, `MODO=antes: scrollWidth > 400 (veio ${medidas.scrollWidth})`);
        ok(/^rgba?\(/.test(String(medidas.corQuieta || '')), `MODO=antes: corQuieta é cor resolvida (${medidas.corQuieta})`);
      } else {
        const antes = JSON.parse(fs.readFileSync(path.join(ANTES, 'medidas.json'), 'utf8'));
        const alvo = {
          bordasVivas: 1, notaVaza: false, linhasDoTopo: 2, caminhoCortado: false,
          avisoVisivel: true, bolhasNaFita: 0, recarregarVisivel: false, pesoQuieta: '400',
          pesoSemAgente: '400', linha2Itens: 3, etapaInline: true, linha2Overflow: false,
          pesoEsperando: '700', caminhoTexto: '~/projetos/projeto-c',
        };
        for (const [chave, valor] of Object.entries(alvo)) {
          ok(JSON.stringify(medidas[chave]) === JSON.stringify(valor),
            `MODO=depois: ${chave} === ${JSON.stringify(valor)} (veio ${JSON.stringify(medidas[chave])})`);
        }
        ok(medidas.scrollWidth <= 400, `MODO=depois: scrollWidth <= 400 (veio ${medidas.scrollWidth})`);
        ok(/sem agente rodando/.test(String(medidas.avisoTexto || '')),
          `MODO=depois: avisoTexto fala em "sem agente rodando" (${medidas.avisoTexto})`);
        for (const chave of ['corQuieta', 'corDoAviso']) {
          ok(/^rgba?\(/.test(String(medidas[chave] || '')), `MODO=depois: ${chave} é cor resolvida (${medidas[chave]})`);
        }
        ok(medidas.corQuieta === medidas.corDoAviso,
          `MODO=depois: corQuieta e corDoAviso são a MESMA cor — as duas são --texto-2 (${medidas.corQuieta} / ${medidas.corDoAviso})`);
        ok(medidas.caminhoTitle === medidas.cwdDaFixture,
          `MODO=depois: caminhoTitle é o cwd CHEIO (${medidas.caminhoTitle})`);

        const MUDAM = ['bordasVivas', 'notaVaza', 'scrollWidth', 'linhasDoTopo', 'caminhoCortado',
          'avisoVisivel', 'bolhasNaFita', 'recarregarVisivel', 'pesoQuieta', 'corQuieta', 'avisoTexto',
          'corDoAviso', 'pesoSemAgente', 'linha2Itens', 'etapaInline', 'caminhoTitle'];
        const FIXAS = ['pesoEsperando', 'caminhoTexto', 'bordaPerguntando', 'linha2Overflow'];
        for (const chave of MUDAM) {
          ok(JSON.stringify(antes[chave]) !== JSON.stringify(medidas[chave]),
            `MODO=depois: ${chave} MUDOU em relação ao antes (era ${JSON.stringify(antes[chave])})`);
        }
        for (const chave of FIXAS) {
          ok(JSON.stringify(antes[chave]) === JSON.stringify(medidas[chave]),
            `MODO=depois: ${chave} NÃO mudou — não-regressão (antes ${JSON.stringify(antes[chave])}, agora ${JSON.stringify(medidas[chave])})`);
        }
      }
    }

    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('\n🔴 o smoke estourou:', e && e.message);
    saida = 1;
  } finally {
    const limpezaOk = limpar();
    if (!limpezaOk) saida = saida || 1;
    console.log(`\n${falhas || saida ? '❌ SMOKE DE CELULAR VERMELHO' : '✅ SMOKE DE CELULAR VERDE'}`
      + ` — ${feitos - falhas}/${feitos} · PNGs e medidas.json em ${SAIDA}\n`);
  }
  process.exit(saida);
})();
