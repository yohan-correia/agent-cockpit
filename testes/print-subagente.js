#!/usr/bin/env node
'use strict';
// PRINT DO CARTÃO VIVO DO SUB-AGENTE (card ver-os-subagentes-da-aba, spec 2026-10-16 §7 item 5).
// Mudou pixel, tem print: 390x844 (claro e escuro). DEPOIS (a worktree: cartão com "rodando ·
// Ns"/"terminou em 1min 23s", expansão com passos e resposta final, rótulo que rola até o
// agente em background) e ANTES (RAIZ_CODIGO = git archive da develop: o mesmo cenário com o
// "✓" falso — a notificação de fim de tarefa ainda não existe, D86/#105). Antes do obturador o
// roteiro EXIGE o que mudou na vista e reprova (sem PNG) em vez de fotografar uma tela que
// subiu mas não tem o recurso.
//
// Mundo próprio, como o `print-segundo-plano.js`: socket tmux só dele (`-f /dev/null`), HOME de
// mentira, `/proc` falso, pasta de jobs vazia, UMA aba Claude (busy, `turn_duration` com
// `pendingBackgroundAgentCount: 1`, lida — para a lista dizer "livre", não "te esperando").
// NUNCA aponte para a instância de produção.
//
// Navegador no HOST: os DOIS caminhos vêm por env, sem padrão —
//   PUPPETEER_CORE=<pasta do puppeteer-core>  CHROME_BIN=<executável do chrome>
//
// Uso:
//   ESQUEMA=claro|escuro SAIDA=/tmp/saida PUPPETEER_CORE=… CHROME_BIN=… node testes/print-subagente.js
//   ANTES=1 RAIZ_CODIGO=<git archive da develop> ESQUEMA=… SAIDA=… (mesmos dois) node testes/print-subagente.js
//   NEGATIVO=1 RAIZ_CODIGO=<git archive da develop> SAIDA=… (mesmos dois) node testes/print-subagente.js
//   CARTAO=1 [ANTES=1|NEGATIVO=1] RAIZ_CODIGO=… ESQUEMA=… SAIDA=… PUPPETEER_CORE=… CHROME_BIN=… node testes/print-subagente.js
//   card `subagente-cartao-legivel` (D93): cartão aberto com a lista recolhida, aberta, o pedido formatado e a
//   recarga de 5 s provada com passo novo.
//
// Códigos de saída: 0 = PNGs gravados · 1 = cenário reprovado (sem o recurso na vista) · 2 = ambiente.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const PORTA = 7967;
const SAIDA = process.env.SAIDA || '';
const ANTES = process.env.ANTES === '1';
const NEGATIVO = process.env.NEGATIVO === '1';
const CARTAO = process.env.CARTAO === '1';
const ESQUEMA = process.env.ESQUEMA === 'escuro' ? 'escuro' : 'claro';
const RAIZ_CODIGO = process.env.RAIZ_CODIGO || path.join(__dirname, '..');
const PUPPETEER = process.env.PUPPETEER_CORE || '';
const CHROME = process.env.CHROME_BIN || '';
const SOCKET = `cockpit-smoke-subagente-print-${process.pid}`;
const SESSAO = 'main';
const JANELA = 'print-subagente';
const SESSAO_ID = 'print-subagente';
const CARIMBO = `ancora-subagente-print-${process.pid}`;
const MINHAS_SESSOES = new Set(['ancora', SESSAO]);
const VIEWPORT = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const PRE = ANTES ? 'antes' : (NEGATIVO ? 'negativo' : 'depois');
let ARQ_FUNDO = ''; // caminho do .jsonl do agente de fundo (CARTAO), preenchido na fixture.

// ─── Fail-closed antes de tocar em qualquer coisa ────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

// `-f /dev/null` em TODO comando: sem ele o ~/.tmux.conf do dono carrega e o continuum-restore
// recria as sessões dele dentro do socket "isolado".
function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
}

if (t(['ls'], { tolerante: true }).trim()) {
  console.error(`🔴 o socket ${SOCKET} JÁ EXISTE — não é meu. Abortando.`);
  process.exit(1);
}

if (!SAIDA) { console.error('🟡 SAIDA é obrigatória (pasta dos PNGs).'); process.exit(2); }
if (!PUPPETEER || !CHROME) {
  console.error('🟡 ambiente indisponível: PUPPETEER_CORE e CHROME_BIN são obrigatórios (sem padrão).');
  process.exit(2);
}
let puppeteer;
try { puppeteer = require(PUPPETEER); } catch (e) {
  console.error(`🟡 ambiente indisponível: não consegui carregar o puppeteer-core (${String(e.message).split('\n')[0]}).`);
  process.exit(2);
}
if (!fs.existsSync(CHROME)) { console.error('🟡 ambiente indisponível: CHROME_BIN não existe.'); process.exit(2); }
if (!fs.existsSync(path.join(RAIZ_CODIGO, 'server.js'))) {
  console.error('🟡 RAIZ_CODIGO não tem o servidor.');
  process.exit(2);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── A fixture: /proc, sessions e .jsonl, todos de mentira ───────────────────

const raizProc = (scratch) => path.join(scratch, 'proc');

/** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}` no padrão "exec direto". */
function plantarAgenteFalso(scratch, pid, starttime) {
  const dir = path.join(raizProc(scratch), String(pid));
  fs.mkdirSync(dir, { recursive: true });
  const campos = new Array(52).fill('0');
  campos[0] = String(pid);
  campos[1] = '(claude)';
  campos[2] = 'S';
  campos[3] = '1';
  campos[4] = String(pid);
  campos[5] = String(pid);
  campos[6] = '34816';
  campos[7] = String(pid);
  campos[21] = String(starttime);
  fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), '/usr/bin/claude\0');
  fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task', String(pid), 'children'), '');
}

function escreverSessao(home, { pid, janela, pane, sessaoId, cwd, starttime, status, statusUpdatedAt }) {
  const raiz = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(raiz, { recursive: true });
  fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
    kind: 'interactive', sessionId: sessaoId, cwd, status, updatedAt: Date.now(), pid, procStart: starttime,
    tmux: `${SESSAO}:${janela}.${pane}`, statusUpdatedAt,
  }));
}

function caminhoDoJsonl(home, cwd, sessaoId) {
  return path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessaoId}.jsonl`);
}

// O formato real medido (mesmas linhas dos gates de subagente/segundo-plano).
const linha = (obj) => `${JSON.stringify(obj)}\n`;
const userFala = (ms, texto) => linha({ type: 'user', timestamp: new Date(ms).toISOString(), message: { content: texto } });
const assistenteTexto = (ms, texto) => linha({
  type: 'assistant', timestamp: new Date(ms).toISOString(), message: { content: [{ type: 'text', text: texto }] },
});
const assistenteTextoFim = (ms, texto) => linha({
  type: 'assistant', timestamp: new Date(ms).toISOString(),
  message: { content: [{ type: 'text', text: texto }], stop_reason: 'end_turn' },
});
const assistenteFerramenta = (ms, id, nome, input) => linha({
  type: 'assistant', timestamp: new Date(ms).toISOString(),
  message: { content: [{ type: 'tool_use', id, name: nome, input }] },
});
const toolResultSincrono = (ms, toolUseId, agentId, totalDurationMs) => linha({
  type: 'user', timestamp: new Date(ms).toISOString(),
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Agent completed' }] },
  toolUseResult: { status: 'completed', agentId, totalDurationMs },
});
const toolResultAssincrono = (ms, toolUseId, agentId) => linha({
  type: 'user', timestamp: new Date(ms).toISOString(),
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Async agent launched successfully.' }] },
  toolUseResult: { status: 'async_launched', isAsync: true, agentId },
});
const toolResultPasso = (ms, toolUseId, texto) => linha({
  type: 'user', timestamp: new Date(ms).toISOString(),
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: texto }] },
});
function turnoFim({ pend, timestamp, sessaoId }) {
  const obj = {
    type: 'system', subtype: 'turn_duration', durationMs: 2140, messageCount: 4,
    isSidechain: false, uuid: `td-${sessaoId}`, sessionId: sessaoId, timestamp: new Date(timestamp).toISOString(),
  };
  if (Number.isFinite(pend) && pend > 0) obj.pendingBackgroundAgentCount = pend;
  return linha(obj);
}

function http1(caminho) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: caminho, timeout: 2000 }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { texto += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(texto); } catch { /* não-JSON */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
  });
}
const saude = async () => (await http1('/health')).status === 200;

// ─── O roteiro do navegador ───────────────────────────────────────────────────

async function roteiro(base) {
  const problemas = [];
  const gerados = [];
  const navegador = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  const erros = [];
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
  pagina.on('pageerror', (e) => erros.push(`PAGEERROR: ${String(e).slice(0, 200)}`));
  const problema = (texto) => { problemas.push(`${PRE}: ${texto}`); };

  const abrirLinha = (titulo) => pagina.evaluate((alvo) => {
    const l = Array.from(document.querySelectorAll('#abas .conversa-linha'))
      .find((x) => { const n = x.querySelector('.conversa-titulo'); return n && n.textContent.includes(alvo); });
    const botao = l && l.querySelector('.conversa');
    if (botao) botao.click();
    return Boolean(botao);
  }, titulo);

  try {
    await pagina.setViewport(VIEWPORT);
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: ESQUEMA === 'escuro' ? 'dark' : 'light' }]);
    await pagina.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch (e) { /* vale nesta página */ } });
    await pagina.goto(`${base}/`, { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await espera(800);

    if (!await abrirLinha(JANELA)) { problema(`não achei "${JANELA}" na lista`); return { gerados, problemas }; }
    await espera(1500);

    // ─── Ramo CARTAO (card subagente-cartao-legivel, D93): pedido legível + lista recolhível ──────
    if (CARTAO) {
      if (ANTES) {
        // ANTES (BASE congelada, pós-D86/pré-D93): o cartão Explore ainda mostra o <pre> JSON cru.
        await pagina.evaluate(() => {
          const el = Array.from(document.querySelectorAll('.ferramenta')).find((d) => d.querySelector('.fer-nome')?.textContent === 'Explore');
          el?.querySelector('summary')?.click();
        });
        try {
          await pagina.waitForFunction(() => {
            const el = Array.from(document.querySelectorAll('.ferramenta')).find((d) => d.querySelector('.fer-nome')?.textContent === 'Explore');
            const conta = el?.querySelector('.sub-agente .grupo-conta');
            return Boolean(conta) && conta.textContent.trim() === '6 passos';
          }, { timeout: 5000 });
        } catch {
          problema('ANTES (CARTAO): o cartão Explore não chegou a "6 passos"');
          return { gerados, problemas };
        }
        const temPreJson = await pagina.evaluate(() => {
          const el = Array.from(document.querySelectorAll('.ferramenta')).find((d) => d.querySelector('.fer-nome')?.textContent === 'Explore');
          return Boolean(el) && Array.from(el.querySelectorAll('pre')).some((p) => p.textContent.includes('"prompt"'));
        });
        if (!temPreJson) { problema('ANTES (CARTAO): não achei o <pre> com "prompt" (JSON cru)'); return { gerados, problemas }; }
        await pagina.evaluate(() => {
          const el = Array.from(document.querySelectorAll('.ferramenta')).find((d) => d.querySelector('.fer-nome')?.textContent === 'Explore');
          el?.scrollIntoView({ block: 'start' });
        });
        await espera(400);
        const arq10 = path.join(SAIDA, '10-antes-cartao.png');
        await pagina.screenshot({ path: arq10 });
        gerados.push(arq10);
        await pagina.evaluate(() => {
          const el = Array.from(document.querySelectorAll('.ferramenta')).find((d) => d.querySelector('.fer-nome')?.textContent === 'Explore');
          const pre = Array.from(el.querySelectorAll('pre')).find((p) => p.textContent.includes('"prompt"'));
          pre?.scrollIntoView({ block: 'start' });
        });
        await espera(400);
        const arq11 = path.join(SAIDA, '11-antes-pedido.png');
        await pagina.screenshot({ path: arq11 });
        gerados.push(arq11);
        if (erros.length) problema(`${erros.length} erro(s) de console: ${erros.slice(0, 3).join(' | ')}`);
        return { gerados, problemas };
      }

      // DEPOIS e NEGATIVO: as mesmas exigências; o NEGATIVO roda contra a develop e TEM de reprovar.
      await pagina.evaluate(() => {
        document.querySelector('.ferramenta[data-agente="terminou"] summary')?.click();
      });
      try {
        await pagina.waitForFunction(() => {
          const el = document.querySelector('.ferramenta[data-agente="terminou"]');
          return Boolean(el) && Boolean(el.querySelector('.sub-resumo')) && Boolean(el.querySelector('.sub-resposta'));
        }, { timeout: 5000 });
      } catch {
        problema('CARTAO: o cartão terminado não trouxe .sub-resumo e .sub-resposta');
        return { gerados, problemas };
      }

      const faltou = await pagina.evaluate(() => {
        const el = document.querySelector('.ferramenta[data-agente="terminou"]');
        const resumo = el.querySelector('.sub-resumo');
        const passos = el.querySelector('.sub-passos');
        const pedido = el.querySelector('.sub-pedido');
        const corpo = pedido?.querySelector('.sub-pedido-corpo');
        const faltas = [];
        if (!resumo || resumo.getAttribute('aria-expanded') !== 'false') faltas.push('sub-resumo aria-expanded=false');
        if (!passos || !passos.hidden) faltas.push('sub-passos hidden');
        if (!pedido || pedido.querySelector('.sub-pedido-titulo')?.textContent !== 'Mapear os testes da fita') faltas.push('sub-pedido-titulo');
        if (!pedido || pedido.querySelector('.sub-pedido-extras')?.textContent !== 'model: sonnet') faltas.push('sub-pedido-extras');
        if (!corpo || corpo.querySelectorAll('h3').length < 2) faltas.push('sub-pedido-corpo h3>=2');
        if (!corpo || corpo.querySelectorAll('li').length < 5) faltas.push('sub-pedido-corpo li>=5');
        if (!corpo || corpo.querySelectorAll('.bloco-codigo').length !== 1) faltas.push('sub-pedido-corpo .bloco-codigo==1');
        const presSoltos = el ? Array.from(el.querySelectorAll('pre')).filter((p) => !p.closest('.bloco-codigo')) : [];
        if (presSoltos.length) faltas.push('pre fora de .bloco-codigo');
        const texto = el ? (el.textContent || '') : '';
        if (texto.includes('"prompt"')) faltas.push('texto com "prompt"');
        if (texto.includes('\\n')) faltas.push('texto com \\n literal');
        const subEl = el.querySelector('.sub-agente');
        if (!subEl || subEl.nextElementSibling !== pedido) faltas.push('sub-agente irmão anterior do sub-pedido');
        if (pedido && pedido.querySelector('.sub-agente')) faltas.push('sub-pedido contém sub-agente');
        if (!pedido || pedido.dataset.cortado !== '1') faltas.push('sub-pedido data-cortado');
        if (!pedido || !pedido.querySelector('.sub-pedido-mais')) faltas.push('sub-pedido-mais');
        return faltas;
      });
      if (faltou.length) { problema(`CARTAO: faltou — ${faltou.join(', ')}`); return { gerados, problemas }; }

      await pagina.evaluate(() => {
        document.querySelector('.ferramenta[data-agente="terminou"]')?.scrollIntoView({ block: 'start' });
      });
      await espera(400);
      const arq10 = path.join(SAIDA, '10-recolhida.png');
      await pagina.screenshot({ path: arq10 });
      gerados.push(arq10);

      await pagina.evaluate(() => {
        document.querySelector('.ferramenta[data-agente="terminou"] .sub-resumo')?.click();
      });
      const aberto = await pagina.evaluate(() => {
        const el = document.querySelector('.ferramenta[data-agente="terminou"]');
        const resumo = el.querySelector('.sub-resumo');
        const passos = Array.from(el.querySelectorAll('.sub-passo')).filter((p) => p.offsetParent !== null).length;
        return resumo.getAttribute('aria-expanded') === 'true' && passos === 6;
      });
      if (!aberto) { problema('CARTAO: o toque no resumo não abriu os 6 passos'); return { gerados, problemas }; }
      await pagina.evaluate(() => {
        document.querySelector('.ferramenta[data-agente="terminou"]')?.scrollIntoView({ block: 'start' });
      });
      await espera(400);
      const arq11 = path.join(SAIDA, '11-aberta.png');
      await pagina.screenshot({ path: arq11 });
      gerados.push(arq11);

      await pagina.evaluate(() => {
        document.querySelector('.ferramenta[data-agente="terminou"] .sub-pedido')?.scrollIntoView({ block: 'start' });
      });
      await espera(400);
      const arq12 = path.join(SAIDA, '12-pedido.png');
      await pagina.screenshot({ path: arq12 });
      gerados.push(arq12);

      await pagina.evaluate(() => {
        document.querySelector('.ferramenta[data-agente="terminou"] .sub-pedido-mais')?.click();
      });
      const soltou = await pagina.evaluate(() => {
        const pedido = document.querySelector('.ferramenta[data-agente="terminou"] .sub-pedido');
        return Boolean(pedido) && pedido.dataset.recolhido === undefined && !pedido.querySelector('.sub-pedido-mais');
      });
      if (!soltou) { problema('CARTAO: o toque em "mostrar o pedido inteiro" não soltou o pedido'); return { gerados, problemas }; }
      await pagina.evaluate(() => {
        document.querySelector('.ferramenta[data-agente="terminou"] .sub-pedido')?.scrollIntoView({ block: 'start' });
      });
      await espera(400);
      const arq13 = path.join(SAIDA, '13-pedido-inteiro.png');
      await pagina.screenshot({ path: arq13 });
      gerados.push(arq13);

      // Recarga provada de verdade (painel r1, Codex): acrescenta passo real no .jsonl do agente de fundo.
      await pagina.evaluate(() => {
        document.querySelector('.ferramenta[data-agente="rodando"] summary')?.click();
      });
      try {
        await pagina.waitForFunction(() => Boolean(document.querySelector('.ferramenta[data-agente="rodando"] .sub-resumo')), { timeout: 5000 });
      } catch {
        problema('CARTAO: o cartão rodando não trouxe .sub-resumo');
        return { gerados, problemas };
      }
      const fundoOk = await pagina.evaluate(() => {
        const el = document.querySelector('.ferramenta[data-agente="rodando"]');
        const resumo = el.querySelector('.sub-resumo');
        const passos = el.querySelector('.sub-passos');
        const pedido = el.querySelector('.sub-pedido');
        return resumo.getAttribute('aria-expanded') === 'false' && Boolean(passos) && passos.hidden
          && pedido?.querySelector('.sub-pedido-extras')?.textContent === 'em background'
          && !pedido.querySelector('.sub-pedido-mais');
      });
      if (!fundoOk) { problema('CARTAO: o cartão de fundo não bateu (lista recolhida, extras "em background", sem botão de corte)'); return { gerados, problemas }; }
      await pagina.evaluate(() => {
        document.querySelector('.ferramenta[data-agente="rodando"] .sub-resumo')?.click();
      });
      fs.appendFileSync(ARQ_FUNDO, [
        toolResultPasso(Date.now(), 'bp3', 'ok'),
        assistenteFerramenta(Date.now(), 'bp4', 'Bash', { command: 'npm run lint' }),
      ].join(''));
      try {
        await pagina.waitForFunction(() => {
          const conta = document.querySelector('.ferramenta[data-agente="rodando"] .grupo-conta');
          return Boolean(conta) && conta.textContent.trim() === '4 passos';
        }, { timeout: 9000 });
      } catch {
        problema('CARTAO: a recarga não trouxe "4 passos" no cartão rodando');
        return { gerados, problemas };
      }
      const recarregouAberta = await pagina.evaluate(() => {
        const el = document.querySelector('.ferramenta[data-agente="rodando"]');
        const resumo = el.querySelector('.sub-resumo');
        const passos = Array.from(el.querySelectorAll('.sub-passo')).filter((p) => p.offsetParent !== null).length;
        return resumo.getAttribute('aria-expanded') === 'true' && passos === 4;
      });
      if (!recarregouAberta) { problema('CARTAO: a recarga fechou a lista ou não mostrou os 4 passos'); return { gerados, problemas }; }
      await pagina.evaluate(() => {
        document.querySelector('.ferramenta[data-agente="rodando"]')?.scrollIntoView({ block: 'center' });
      });
      await espera(400);
      const arq14 = path.join(SAIDA, '14-recarga.png');
      await pagina.screenshot({ path: arq14 });
      gerados.push(arq14);

      // Foco não rola a tela (painel r1, Codex 🔴): preventScroll + a recarga não puxa o scroll de volta.
      // `.mensagens` tem `scroll-behavior: smooth` — zerar o scrollTop anima; esperar a animação assentar (não um
      // tempo fixo: a duração do scroll suave varia com a distância) antes de medir.
      await pagina.evaluate(() => {
        document.querySelector('.ferramenta[data-agente="rodando"] .sub-resumo')?.focus({ preventScroll: true });
        const m = document.querySelector('.painel .mensagens');
        if (m) m.scrollTop = 0;
      });
      await pagina.waitForFunction(() => {
        const m = document.querySelector('.painel .mensagens');
        return Boolean(m) && m.scrollTop <= 1;
      }, { timeout: 2000 }).catch(() => {});
      const scrollAntes = await pagina.evaluate(() => {
        const m = document.querySelector('.painel .mensagens');
        return m ? m.scrollTop : null;
      });
      // O RESUMO inteiro fora da área visível do rolador (painel de execução, Codex): cartão "parcialmente na vista"
      // passaria, e com o resumo à vista um `focus()` sem `preventScroll` não rolaria nada — a prova não provaria.
      const saiuDaVista = await pagina.evaluate(() => {
        const resumo = document.querySelector('.ferramenta[data-agente="rodando"] .sub-resumo');
        const m = document.querySelector('.painel .mensagens');
        if (!resumo || !m) return null;
        const r = resumo.getBoundingClientRect();
        const caixa = m.getBoundingClientRect();
        return r.bottom <= caixa.top || r.top >= caixa.bottom;
      });
      if (!saiuDaVista) { problema('CARTAO: depois de zerar o scroll, o resumo do cartão rodando ainda estava (mesmo em parte) na vista'); return { gerados, problemas }; }
      fs.appendFileSync(ARQ_FUNDO, [
        toolResultPasso(Date.now(), 'bp4', 'ok'),
        assistenteFerramenta(Date.now(), 'bp5', 'Bash', { command: 'npm test' }),
      ].join(''));
      try {
        await pagina.waitForFunction(() => {
          const conta = document.querySelector('.ferramenta[data-agente="rodando"] .grupo-conta');
          return Boolean(conta) && conta.textContent.trim() === '5 passos';
        }, { timeout: 9000 });
      } catch {
        problema('CARTAO: a 2ª recarga não trouxe "5 passos" no cartão rodando');
        return { gerados, problemas };
      }
      const focoEScroll = await pagina.evaluate((scrollAnotado) => {
        const el = document.querySelector('.ferramenta[data-agente="rodando"]');
        const foco = document.activeElement;
        const focoDentro = Boolean(el) && foco.classList.contains('sub-resumo') && el.contains(foco);
        const m = document.querySelector('.painel .mensagens');
        const scrollOk = m && Math.abs(m.scrollTop - scrollAnotado) <= 2;
        return focoDentro && scrollOk;
      }, scrollAntes);
      if (!focoEScroll) { problema('CARTAO: a recarga com o resumo focado puxou a rolagem de volta (ou perdeu o foco)'); return { gerados, problemas }; }

      if (erros.length) problema(`${erros.length} erro(s) de console: ${erros.slice(0, 3).join(' | ')}`);
      return { gerados, problemas };
    }

    // ─── Tela 1 (ou única tela do ANTES): a fita com o cartão rodando e o terminado ──────
    if (ANTES) {
      // O ANTES não tem `.fer-agente`/`data-agente` (a feature nem existia): exige só o
      // cartão `Agent` presente, sem mais nada — documenta o "✓" falso (D86/#105).
      try {
        await pagina.waitForFunction(
          () => Array.from(document.querySelectorAll('.ferramenta .fer-nome')).some((n) => n.textContent === 'Agent'),
          { timeout: 5000 },
        );
      } catch {
        problema('não achei nenhum cartão "Agent" na fita (ANTES)');
        return { gerados, problemas };
      }
      await pagina.evaluate(() => {
        const el = Array.from(document.querySelectorAll('.ferramenta')).find((d) => d.querySelector('.fer-nome')?.textContent === 'Agent');
        if (el) el.scrollIntoView({ block: 'center' });
      });
      await espera(400);
      const arq = path.join(SAIDA, '00-antes.png');
      await pagina.screenshot({ path: arq });
      gerados.push(arq);
      if (erros.length) problema(`${erros.length} erro(s) de console: ${erros.slice(0, 3).join(' | ')}`);
      return { gerados, problemas };
    }

    try {
      await pagina.waitForFunction(() => {
        const rodando = document.querySelector('.ferramenta[data-agente="rodando"] .fer-agente');
        const terminou = document.querySelector('.ferramenta[data-agente="terminou"] .fer-agente');
        return Boolean(rodando && terminou)
          && rodando.textContent.startsWith('rodando')
          && terminou.textContent.includes('terminou em 1min 23s');
      }, { timeout: 5000 });
    } catch {
      problema('não achei os dois cartões exigidos (rodando com "rodando…" e terminado com "terminou em 1min 23s")');
      return { gerados, problemas };
    }

    await pagina.evaluate(() => {
      document.querySelector('.ferramenta[data-agente="terminou"]')?.scrollIntoView({ block: 'start' });
    });
    await espera(400);
    const ambosNaVista = await pagina.evaluate(() => {
      const vp = window.innerHeight;
      const r = document.querySelector('.ferramenta[data-agente="rodando"]').getBoundingClientRect();
      const tm = document.querySelector('.ferramenta[data-agente="terminou"]').getBoundingClientRect();
      return r.top >= 0 && r.bottom <= vp && tm.top >= 0 && tm.bottom <= vp;
    });
    if (!ambosNaVista) problema('depois de rolar, os dois cartões não cabem juntos na vista');
    if (problemas.length) return { gerados, problemas };
    const arq01 = path.join(SAIDA, '01-fita.png');
    await pagina.screenshot({ path: arq01 });
    gerados.push(arq01);

    // ─── Tela 2: expandir o cartão terminado (passos + resposta final) ──────────────────
    await pagina.evaluate(() => {
      document.querySelector('.ferramenta[data-agente="terminou"] summary').click();
    });
    try {
      await pagina.waitForFunction(() => {
        const conta = document.querySelector('.sub-agente .grupo-conta');
        return Boolean(conta) && conta.textContent.trim() === '6 passos' && Boolean(document.querySelector('.sub-resposta'));
      }, { timeout: 5000 });
    } catch {
      problema('a expansão não trouxe "6 passos" e a resposta final');
      return { gerados, problemas };
    }
    // D93: com L1, a lista nasce recolhida — o resumo agora é um botão que precisa do toque para abrir.
    await pagina.evaluate(() => {
      document.querySelector('.ferramenta[data-agente="terminou"] .sub-resumo')?.click();
    });
    const passosVisiveis = await pagina.evaluate(() =>
      Array.from(document.querySelectorAll('.ferramenta[data-agente="terminou"] .sub-passo')).filter((p) => p.offsetParent !== null).length);
    if (passosVisiveis !== 6) { problema(`tela 2: depois do toque no resumo, ${passosVisiveis} passo(s) visíveis (esperado 6)`); return { gerados, problemas }; }
    await pagina.evaluate(() => {
      document.querySelector('.ferramenta[data-agente="terminou"]')?.scrollIntoView({ block: 'center' });
    });
    await espera(400);
    const arq02 = path.join(SAIDA, '02-expandido.png');
    await pagina.screenshot({ path: arq02 });
    gerados.push(arq02);

    // ─── Tela 3: rolar para o topo, tocar no rótulo, provar que o toque rolou ───────────
    await pagina.evaluate(() => { const m = document.querySelector('.painel .mensagens'); if (m) m.scrollTop = 0; });
    await espera(200);
    const antesDoToque = await pagina.evaluate(() => {
      const el = document.querySelector('.ferramenta[data-agente="rodando"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });
    if (antesDoToque === null) { problema('sem cartão rodando para testar o rótulo'); return { gerados, problemas }; }
    if (antesDoToque) problema('rolado para o topo, o cartão rodando já estava na vista — o toque não teria como provar que rolou');
    if (problemas.length) return { gerados, problemas };

    await pagina.evaluate(() => { document.querySelector('.chat-segundo-plano')?.click(); });
    await espera(400);
    const depoisDoToque = await pagina.evaluate(() => {
      const el = document.querySelector('.ferramenta[data-agente="rodando"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { dentro: r.top >= 0 && r.bottom <= window.innerHeight, destaque: el.className.includes('destaque') };
    });
    if (!depoisDoToque) problema('o cartão rodando desapareceu depois do toque no rótulo');
    else {
      if (!depoisDoToque.dentro) problema('depois do toque no rótulo, o cartão rodando não ficou na vista');
      if (!depoisDoToque.destaque) problema('depois do toque no rótulo, o cartão rodando não ganhou a classe "destaque"');
    }
    if (problemas.length) return { gerados, problemas };
    const arq03 = path.join(SAIDA, '03-rotulo.png');
    await pagina.screenshot({ path: arq03 });
    gerados.push(arq03);
  } catch (e) {
    problema(`o roteiro estourou — ${String(e && e.message).slice(0, 300)}`);
  } finally {
    if (erros.length) problema(`${erros.length} erro(s) de console: ${erros.slice(0, 3).join(' | ')}`);
    await pagina.close().catch(() => {});
    await navegador.close().catch(() => {});
  }
  return { gerados, problemas };
}

// ─── Corrida ──────────────────────────────────────────────────────────────────

(async () => {
  let servidor = null;
  let scratch = null;

  function limpar() {
    if (servidor && servidor.exitCode === null) {
      try { process.kill(servidor.pid); } catch { /* já morreu */ }
      console.log(`  · servidor (pid ${servidor.pid}) derrubado pelo pid exato`);
    }
    // Duas respostas, não uma (D35): o carimbo prova que EU criei, a enumeração prova que não
    // há mais ninguém no socket. Matar exige as duas.
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    const intrusas = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
      .split('\n').map((n) => n.trim()).filter(Boolean)
      .filter((n) => !MINHAS_SESSOES.has(n));
    if (temCarimbo && !intrusas.length) {
      t(['kill-server'], { tolerante: true });
    } else if (temCarimbo) {
      for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
      console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
    } else {
      console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }

  try {
    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Não sobrescrevo print antigo às cegas.`);
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'subagente-print-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'jobs'), { recursive: true });

    t(['new-session', '-d', '-x', '200', '-y', '50', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-x', '200', '-y', '50', '-s', SESSAO, '-n', JANELA, '-c', os.tmpdir(), 'sleep', '600']);

    const panes = {};
    for (const l of t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']).split('\n')) {
      if (!l.trim()) continue;
      const [nome, janelaId, paneId, panePid] = l.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }
    if (!panes[JANELA]) throw new Error(`a pane "${JANELA}" não apareceu no list-panes`);

    const inicio = (pid) => 1000000 + pid;
    const agora = Date.now();

    // A aba: Claude, `busy`, fala do dono + Agent síncrono (terminado) + Agent em background
    // (ainda rodando, lançado há ~2 min) + resposta do assistente + turn_duration com
    // pendingBackgroundAgentCount: 1.
    const cwd = '/home/smoke/projetos/sub-agente-print';
    plantarAgenteFalso(scratch, panes[JANELA].panePid, inicio(panes[JANELA].panePid));
    escreverSessao(home, {
      pid: panes[JANELA].panePid, janela: panes[JANELA].janelaId, pane: panes[JANELA].paneId,
      sessaoId: SESSAO_ID, cwd, starttime: inicio(panes[JANELA].panePid),
      status: 'busy', statusUpdatedAt: agora - 90000,
    });
    // card `subagente-cartao-legivel` (D93): só com CARTAO=1 o prompt vira um pedido real (markdown, lista, cerca
    // de código), para provar o bloco pedido no navegador. Sem CARTAO, a fixture não muda (modo padrão da D86).
    const PROMPT_CARTAO = [
      'Mapeia os testes que tocam a renderização da fita de ferramentas.',
      '',
      '## Antes de tudo, leia',
      '- `DECISOES.md` (D86) e `ARMADILHAS.md` (#105)',
      '- `public/app.js`, função `desenharPassos`',
      '',
      '## O que entregar',
      '1. A lista de testes, com `arquivo:linha`',
      '2. O que cada um prova',
      '3. Os buracos: o que **ninguém** testa',
      '',
      'Comando útil:',
      '```bash',
      'rg -n "sub-agente" testes/',
      '```',
      '',
      'Não edite nada. Responda em português, direto.',
    ].join('\n');
    const entradaTuS = CARTAO
      ? { subagent_type: 'Explore', description: 'Mapear os testes da fita', model: 'sonnet', prompt: PROMPT_CARTAO }
      : { subagent_type: 'Explore', description: 'Mapear os testes da fita', prompt: 'Mapeia os testes que tocam a renderização da fita de ferramentas.' };
    const arqConv = caminhoDoJsonl(home, cwd, SESSAO_ID);
    fs.mkdirSync(path.dirname(arqConv), { recursive: true });
    fs.writeFileSync(arqConv, [
      userFala(agora - 300000, 'pode mapear os testes da fita num sub-agente e, em paralelo, rodar a suíte inteira em background?'),
      assistenteTexto(agora - 295000, 'Claro — deixa eu lançar os dois.'),
      assistenteFerramenta(agora - 290000, 'tu-s', 'Agent', entradaTuS),
      toolResultSincrono(agora - 207000, 'tu-s', 'as1', 83000), // 83 s depois do lançamento: o cartão, o grupo e o arquivo do sub-agente contam o mesmo tempo
      assistenteFerramenta(agora - 125000, 'tu-b', 'Agent', { subagent_type: 'general-purpose', description: 'Rodar a suíte inteira', prompt: 'Roda a suíte inteira e reporta o que falhar.', run_in_background: true }),
      toolResultAssincrono(agora - 120000, 'tu-b', 'ab1'),
      assistenteTexto(agora - 115000, 'Deixei a suíte inteira rodando em background, pode seguir falando comigo enquanto isso.'),
      turnoFim({ pend: 1, timestamp: agora, sessaoId: SESSAO_ID }),
    ].join(''));

    const pastaSub = path.join(arqConv.replace(/\.jsonl$/, ''), 'subagents');
    fs.mkdirSync(pastaSub, { recursive: true });
    ARQ_FUNDO = path.join(pastaSub, 'agent-ab1.jsonl');

    // agent-as1: o síncrono, terminado — 6 passos Bash/Read/Grep, resposta final com markdown.
    fs.writeFileSync(path.join(pastaSub, 'agent-as1.meta.json'), JSON.stringify({ toolUseId: 'tu-s' }));
    const a1 = agora - 290000;
    fs.writeFileSync(path.join(pastaSub, 'agent-as1.jsonl'), [
      assistenteFerramenta(a1 + 6000, 'sp1', 'Bash', { command: 'rg -l "subagente" testes' }),
      toolResultPasso(a1 + 12000, 'sp1', 'testes/gate-subagente.js\ntestes/gate-ui.js'),
      assistenteFerramenta(a1 + 18000, 'sp2', 'Read', { file_path: '/home/smoke/projetos/sub-agente-print/testes/gate-subagente.js' }),
      toolResultPasso(a1 + 24000, 'sp2', 'ok'),
      assistenteFerramenta(a1 + 30000, 'sp3', 'Grep', { pattern: 'fer-agente', path: 'public' }),
      toolResultPasso(a1 + 36000, 'sp3', 'public/app.js:2599'),
      assistenteFerramenta(a1 + 42000, 'sp4', 'Bash', { command: 'wc -l testes/gate-subagente.js' }),
      toolResultPasso(a1 + 48000, 'sp4', '717 testes/gate-subagente.js'),
      assistenteFerramenta(a1 + 54000, 'sp5', 'Read', { file_path: '/home/smoke/projetos/sub-agente-print/public/app.js' }),
      toolResultPasso(a1 + 60000, 'sp5', 'ok'),
      assistenteFerramenta(a1 + 66000, 'sp6', 'Bash', { command: 'echo pronto' }),
      toolResultPasso(a1 + 72000, 'sp6', 'pronto'),
      assistenteTextoFim(a1 + 78000, '**pronto**: mapeei os testes que tocam a fita de ferramentas.'),
    ].join(''));

    // agent-ab1: o de background, ainda rodando — 3 passos, o último SEM resultado.
    fs.writeFileSync(path.join(pastaSub, 'agent-ab1.meta.json'), JSON.stringify({ toolUseId: 'tu-b' }));
    const b1 = agora - 120000;
    fs.writeFileSync(path.join(pastaSub, 'agent-ab1.jsonl'), [
      assistenteFerramenta(b1 + 1000, 'bp1', 'Bash', { command: 'npm run check' }),
      toolResultPasso(b1 + 2000, 'bp1', 'rc=0'),
      assistenteFerramenta(b1 + 3000, 'bp2', 'Read', { file_path: '/home/smoke/projetos/sub-agente-print/package.json' }),
      toolResultPasso(b1 + 4000, 'bp2', 'ok'),
      assistenteFerramenta(b1 + 5000, 'bp3', 'Bash', { command: 'npm test' }),
    ].join(''));

    // A LIDA — antes de subir o servidor, com COCKPIT_LIDAS_DIR já no process.env: sem isso
    // a aba sai "te esperando · 1 agente em background", não "livre".
    process.env.COCKPIT_LIDAS_DIR = path.join(scratch, 'lidas');
    const lidas = require(path.join(RAIZ_CODIGO, 'lib', 'lidas.js'));
    await lidas.marcar(SESSAO_ID, agora - 100000); // >= a hora da última fala (agora - 115000)

    // Ambiente do servidor por LISTA FECHADA (#78/#82).
    const ambiente = { ...process.env };
    for (const k of Object.keys(ambiente)) if (/^(COCKPIT_|CODEX_|CLAUDE|ANTHROPIC_|OPENAI_)/.test(k)) delete ambiente[k];
    delete ambiente.PORT;
    Object.assign(ambiente, {
      HOST: '127.0.0.1',
      PORT: String(PORTA),
      HOME: home,
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TOKEN: '',
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: SESSAO,
      COCKPIT_PROC_RAIZ: raizProc(scratch),
      COCKPIT_BIN_CLAUDE: '/bin/true',
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
      COCKPIT_JOBS_DIR: path.join(scratch, 'jobs'),
      COCKPIT_MONITOR_DIR: path.join(scratch, 'monitor'),
      COCKPIT_MONITOR_MS: '0',
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
      COCKPIT_DU_BIN: path.join(scratch, 'sem-du'),
      COCKPIT_DOCKER_BIN: path.join(scratch, 'sem-docker'),
    });
    servidor = spawn(process.execPath, [path.join(RAIZ_CODIGO, 'server.js')], { env: ambiente, cwd: RAIZ_CODIGO, stdio: ['ignore', 'ignore', 'pipe'] });

    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (servidor.exitCode !== null) break;
      pronto = await saude();
      if (!pronto) await espera(200);
    }
    if (!pronto) {
      console.error(`🔴 o servidor (${PORTA}) não subiu`);
      limpar();
      return process.exit(1);
    }
    console.log(`  · servidor no ar em http://127.0.0.1:${PORTA} (pid ${servidor.pid}), socket ${SOCKET}, ${PRE}, ${ESQUEMA}`);

    const { gerados, problemas } = await roteiro(`http://127.0.0.1:${PORTA}`);
    for (const g of gerados) console.log(`  ✅ ${g}`);
    for (const p of problemas) console.error(`  ❌ ${p}`);
    // Reprovou depois de um tiro já gravado: o PNG parcial sai do disco — cenário reprovado
    // não deixa prova pela metade (achado do painel do segundo-plano).
    if (problemas.length) for (const g of gerados) fs.rmSync(g, { force: true });
    limpar();
    const esperados = CARTAO ? (ANTES ? 2 : 5) : (ANTES ? 1 : 3);
    return process.exit(problemas.length || gerados.length < esperados ? 1 : 0);
  } catch (e) {
    console.error('🔴 estourou:', e && e.message ? e.message : e);
    limpar();
    return process.exit(1);
  }
})();
