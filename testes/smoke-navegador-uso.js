#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — "Para onde vão meus tokens", 390x844.
//
// Desde a fase 2b (04/09) a tela vive DENTRO do app, como <dialog id="dialogo-uso"> — o
// caminho passou a ser goto('/') → clicar #btn-config → clicar #btn-uso → esperar
// #dialogo-uso[open]. A URL /uso.html não existe mais (apagada de propósito, P2).
//
// Molde: testes/smoke-navegador-arquivos.js (docker + puppeteer-core, --network host, viewport
// de celular, marcador na saída, códigos 0/1/2/3). Porta 7894 (livre — 7899 é dos jobs, #24;
// 7879 é produção). Tema escuro forçado.
//
// MODO=fixture|real é OBRIGATÓRIO (spec §3.9, ponto 3 do painel — juntar os dois papéis faria
// o aceite depender do humor do dia real do usuário):
//
//   MODO=fixture   HOME de mentira, 2 projetos, com TODOS os asserts de conteúdo (S1-S13).
//                  É o que entra no critério de aceite — roda igual em qualquer máquina.
//   MODO=real      HOME de verdade (leitura pura), só as travas universais (console, CSS,
//                  requisições, 390px). Produz o print com os números do usuário. Sem dado
//                  real hoje ⇒ código 3 — NÃO satisfaz o aceite (§3.9); é diagnóstico.
//
// Em AMBOS os modos, COCKPIT_USO_DIR aponta para um tmp descartável — nem em MODO=real o
// cache de produção (~/.cockpit/uso) é tocado.
//
// Códigos: 0 = passou · 1 = falha de produto/assert · 2 = uso/ambiente (falta MODO, SAIDA,
// imagem docker ausente, servidor não subiu) · 3 = MODO=real sem dado no disco (diagnóstico,
// NÃO aprova o aceite — §3.9).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const MODO = process.env.MODO;
if (MODO !== 'fixture' && MODO !== 'real') {
  console.error('🔴 defina MODO=fixture ou MODO=real');
  process.exit(2);
}
const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs e o medidas.json vão cair>');
  process.exit(2);
}
// Number(env) || default: a faixa 7891-7893 e reservada a jobs paralelos, e a 7894 e
// ambigua quando dois smokes rodam juntos. O default nao muda para ninguem.
const PORTA = Number(process.env.PORTA) || 7894;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const TOKEN = 'gate-uso-smoke-token';

let falhas = 0;
let feitos = 0;
const ok = (c, texto) => { feitos += 1; if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${texto}`); return c; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── o fixture (MODO=fixture) ────────────────────────────────────────────
//
// 2 projetos. O 1º ("projeto-a") tem 3 origens: 1 aba + 2 worktrees de job — uma das
// worktrees com <sessao>/subagents/agent-x.jsonl (S7/S8). O 2º ("projeto-b") tem 1 origem
// só, para provar a ordenação [maior, menor] (S1) sem ambiguidade. Mais um par empatado
// ("aaa-empate"/"zzz-empate") só visível na janela de 7 dias, para S10 (desempate alfabético
// estável). Um rótulo com HTML embutido em `title` prova S11 (textContent, nunca innerHTML).
//
// Os totais são escolhidos à mão, e cada assert do MODO=fixture é uma IGUALDADE contra eles,
// não uma aproximação.
function montarFixture(raiz) {
  const home = path.join(raiz, 'home');
  const projetos = path.join(home, '.claude', 'projects');
  const jobs = path.join(home, '.cockpit', 'jobs');
  fs.mkdirSync(projetos, { recursive: true });
  fs.mkdirSync(jobs, { recursive: true });

  const cru = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
  const preProjeto = `${cru(path.join(home, 'projetos'))}-`;
  const preWorktree = `${cru(path.join(home, '.cockpit', 'worktrees'))}-`;

  const hoje = new Date().toISOString().slice(0, 10);
  const seteDiasFmt = (offsetDias) => new Date(Date.now() - offsetDias * 86400000).toISOString();

  const linha = ({ ts, modelo = 'claude-opus-5', input = 0, output = 0, cw = 0, cr = 0, isSidechain = false }) => `${JSON.stringify({
    type: 'assistant', timestamp: ts, isSidechain,
    message: { model: modelo, usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cw, cache_read_input_tokens: cr }, content: [{ type: 'text', text: 'oi' }] },
  })}\n`;

  // ── projeto-a: aba + 2 worktrees (uma com subagente) ──
  const pastaAba = path.join(projetos, `${preProjeto}projeto-a`);
  fs.mkdirSync(pastaAba, { recursive: true });
  // origem 1 (aba): entrada 1000, cacheLeitura 9000 -> total 10000
  fs.writeFileSync(path.join(pastaAba, 'a.jsonl'), linha({ ts: `${hoje}T09:00:00.000Z`, input: 1000, cr: 9000 }));

  const idJob1 = 'joba';
  const pastaJob1 = path.join(projetos, `${preWorktree}${idJob1}`);
  fs.mkdirSync(pastaJob1, { recursive: true });
  fs.mkdirSync(path.join(jobs, idJob1), { recursive: true });
  fs.writeFileSync(path.join(jobs, idJob1, 'meta.json'), JSON.stringify({ project: 'projeto-a', type: 'ataca', title: 'card um <img src=x onerror=alert(1)>' }));
  // origem 2 (job 1): entrada 2000, cacheLeitura 3000 -> total 5000. O `<img ...>` no título
  // é o marcador de S11: se algum dia isto virar innerHTML, o navegador executa o onerror.
  fs.writeFileSync(path.join(pastaJob1, 'a.jsonl'), linha({ ts: `${hoje}T09:05:00.000Z`, input: 2000, cr: 3000 }));

  const idJob2 = 'jobb';
  const pastaJob2 = path.join(projetos, `${preWorktree}${idJob2}`);
  const subagentsDir = path.join(pastaJob2, 'sessao-pai', 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.mkdirSync(path.join(jobs, idJob2), { recursive: true });
  fs.writeFileSync(path.join(jobs, idJob2, 'meta.json'), JSON.stringify({ project: 'projeto-a', type: 'ataca', title: 'card dois' }));
  // origem 3 (job 2): pai 1000+2000=3000, subagente 500+500=1000 -> total 4000 (S8)
  fs.writeFileSync(path.join(pastaJob2, 'sessao-pai.jsonl'), linha({ ts: `${hoje}T09:10:00.000Z`, input: 1000, cr: 2000 }));
  fs.writeFileSync(path.join(subagentsDir, 'agent-x.jsonl'), linha({ ts: `${hoje}T09:11:00.000Z`, input: 500, cr: 500, isSidechain: true }));

  // projeto-a HOJE = 10000 + 5000 + 4000 = 19000

  // ── projeto-b: 1 aba só, total 1000 ──
  //
  // O MODELO aqui é `claude-haiku-4-5`, e não o `claude-opus-5` de todo o resto: é o segundo
  // modelo que faz "Por modelo" (S16) valer alguma coisa — uma seção com uma linha só não
  // prova ordenação nenhuma. Os TOTAIS não mudam com isso (modelo não entra em soma), então
  // S1-S10 continuam cobrando exatamente os mesmos números.
  const pastaAbaB = path.join(projetos, `${preProjeto}projeto-b`);
  fs.mkdirSync(pastaAbaB, { recursive: true });
  fs.writeFileSync(path.join(pastaAbaB, 'a.jsonl'), linha({ ts: `${hoje}T09:00:00.000Z`, modelo: 'claude-haiku-4-5', input: 100, cr: 900 }));

  // TOTAL HOJE = 19000 + 1000 = 20000. projeto-a = 95,0% · projeto-b = 5,0% (S2/S3).

  // ── mais volume 3 dias atrás, só para o projeto-a: aparece em 7 dias, não em hoje (S9) ──
  fs.writeFileSync(path.join(pastaAba, 'b.jsonl'), linha({ ts: `${seteDiasFmt(3)}`, input: 500, cr: 0 }));
  // TOTAL 7 DIAS = 20000 + 500 = 20500.

  // ── par empatado, só dentro da janela de 7 dias (S10) ──
  for (const nome of ['aaa-empate', 'zzz-empate']) {
    const p = path.join(projetos, `${preProjeto}${nome}`);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'a.jsonl'), linha({ ts: seteDiasFmt(2), input: 50, cr: 0 }));
  }
  // TOTAL 7 DIAS COM O EMPATE = 20500 + 50 + 50 = 20600.

  // Os três dias que aparecem na janela de 7 dias, no formato que `dataBR()` escreve na tela
  // (DD/MM) e já em ordem crescente de data. Existem para o assert de "Por dia" comparar por
  // IGUALDADE em vez de tentar ordenar strings DD/MM — comparar "1230" com "0101" reprovaria
  // o smoke na virada do ano, e um gate que quebra sozinho um dia por ano é pior que nenhum.
  const paraBR = (offsetDias) => {
    const [, mes, dia] = new Date(Date.now() - offsetDias * 86400000).toISOString().slice(0, 10).split('-');
    return `${dia}/${mes}`;
  };
  return {
    home,
    totais: {
      hoje: { geral: 20000, projetoA: 19000, projetoB: 1000, pctA: 95.0, pctB: 5.0 },
      seteDias: { geral: 20600, projetoA: 19500 },
      diasEsperados: [paraBR(3), paraBR(2), paraBR(0)],
    },
  };
}

// ─── sobe o server.js ─────────────────────────────────────────────────────

async function subirServidor({ home, certDir, usoDir }) {
  const ambiente = { ...process.env };
  delete ambiente.COCKPIT_TOKEN;
  Object.assign(ambiente, {
    HOST: '127.0.0.1', PORT: String(PORTA), HOME: home,
    COCKPIT_CERT_DIR: certDir, COCKPIT_USO_DIR: usoDir, COCKPIT_TOKEN: TOKEN,
    COCKPIT_JOBS_DIR: path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`), // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
  });
  const processo = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: ambiente, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let erros = '';
  processo.stderr.on('data', (d) => { erros += d; });
  const saiu = new Promise((r) => processo.on('exit', r));

  const saude = () => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: '/health', timeout: 1000, agent: false }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
  let pronto = false;
  for (let i = 0; i < 60 && !pronto; i += 1) {
    if (processo.exitCode !== null) break;
    // eslint-disable-next-line no-await-in-loop
    pronto = await saude();
    // eslint-disable-next-line no-await-in-loop
    if (!pronto) await espera(200);
  }
  const matar = async () => {
    if (processo.exitCode === null) {
      try { process.kill(processo.pid); } catch { /* já morreu */ }
      await Promise.race([saiu, espera(5000)]);
      if (processo.exitCode === null) { try { process.kill(processo.pid, 'SIGKILL'); } catch { /* já morreu */ } await saiu; }
    }
    await espera(150);
  };
  if (!pronto) {
    await matar();
    const e = new Error(`o servidor na ${PORTA} não respondeu /health em 12 s\n${erros.split('\n').slice(-30).join('\n')}`);
    throw e;
  }
  return { processo, matar };
}

// ─── o roteiro do navegador — roda DENTRO do container ───────────────────

function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');
const fs = require('fs');

const BASE = process.env.BASE;
const TOKEN = process.env.TOKEN;
const MODO = process.env.MODO;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const medidas = {};
  const problemas = [];
  const erros = [];
  const requisicoes = [];
  const pagina = await navegador.newPage();
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
  pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
  pagina.on('response', (r) => { if (r.status() >= 400) requisicoes.push(r.status() + ' ' + r.url()); });

  // O passo pode devolver 'alvo': a PAGINA que deve ser fotografada e medida. Sem isso o
  // print saia sempre da pagina principal — e o 99-sem-token virou um PNG mostrando a tela
  // COM dados, o oposto do que o nome dele promete. O assert media a aba certa e o print
  // mostrava a errada: prova que engana vale menos que prova nenhuma.
  // (Sem crases: o roteiro inteiro e uma template string.)
  async function foto(nome, passo) {
    try {
      const veredito = await passo();
      if (veredito && veredito.ok === false) { problemas.push(nome + ': ' + veredito.porque); return; }
      const alvo = (veredito && veredito.alvo) || pagina;
      await espera(300);
      const larguraDoc = await alvo.evaluate(() => document.documentElement.scrollWidth);
      if (larguraDoc > 390) problemas.push(nome + ': largura do documento ' + larguraDoc + ' > 390');
      await alvo.screenshot({ path: '/out/' + nome + '.png' });
      Object.assign(medidas, (veredito && veredito.dados) || {});
    } catch (e) {
      problemas.push(nome + ': o roteiro estourou — ' + String(e && e.message).slice(0, 300));
    }
  }

  // UMA constante, usada por toda aba que este roteiro abrir. Dois literais iguais em
  // lugares diferentes e a armadilha #40 esperando: um dia alguem muda a regua do celular
  // num so, e o S12 passa a medir noutro aparelho sem ninguem notar.
  const CELULAR = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

  try {
    await pagina.setViewport(CELULAR);
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await pagina.evaluateOnNewDocument((token) => {
      try { localStorage.setItem('cockpit-token', token); } catch (e) { /* modo privado */ }
    }, TOKEN);

    if (MODO === 'fixture') {
      // ── 01: Hoje ──
      await foto('01-uso-hoje', async () => {
        // O hook (evaluateOnNewDocument, lá em cima) já gravou o token ANTES deste goto —
        // é o app que abre primeiro agora, não a tela de tokens direto.
        await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
        await pagina.waitForSelector('#abas', { timeout: 15000 });
        await pagina.click('#btn-config');
        await pagina.waitForSelector('#dialogo-config[open]', { timeout: 5000 });
        await pagina.click('#btn-uso');
        await pagina.waitForSelector('#dialogo-uso[open]', { timeout: 5000 });
        await pagina.waitForSelector('#uso-lista .uso-item', { timeout: 15000 });
        const geral = await pagina.evaluate(() => ({
          folhasComRegras: Array.from(document.styleSheets).filter((f) => { try { return f.cssRules && f.cssRules.length > 0; } catch { return true; } }).length,
        }));
        if (!geral.folhasComRegras) return { ok: false, porque: 'NENHUMA folha de estilo com regras' };
        const d = await pagina.evaluate(() => {
          const itens = Array.from(document.querySelectorAll('#uso-lista .uso-item'));
          const nomes = itens.map((it) => it.querySelector('.uso-item-nome').textContent);
          const larguras = itens.map((it) => parseFloat(it.querySelector('.uso-item-barra i').style.width) || 0);
          const resumo = document.getElementById('uso-resumo').textContent;
          // S6 — cache SEPARADO de entrada/saída: os 3 rótulos precisam existir como nós
          // DISTINTOS dentro de .uso-item-numeros, não concatenados num texto só.
          const numeros1 = itens[0] ? Array.from(itens[0].querySelectorAll('.uso-item-numeros span')).map((s) => s.textContent) : [];
          // S14/S15/S16 — o que este card acrescentou. Tudo lido do DOM DE VERDADE, servido
          // pelo server.js, e nao de um relatorio fabricado.
          const linhaModelos1 = itens[0] ? (itens[0].querySelector('.uso-item-modelos') || {}).textContent : '';
          const textoCusto = (document.getElementById('uso-custo') || {}).textContent || '';
          const secaoModelo = document.getElementById('uso-por-modelo');
          const linhasModelo = secaoModelo ? Array.from(secaoModelo.querySelectorAll('.uso-linha')) : [];
          const modelosNomes = linhasModelo.map((l) => l.querySelector('.uso-linha-nome').textContent);
          const modelosTokens = linhasModelo.map((l) => l.querySelector('.uso-linha-valor b').textContent);
          const porDiaHoje = (document.getElementById('uso-por-dia') || {}).textContent || '';
          return {
            nomes, larguras, resumo, numeros1, linhaModelos1, textoCusto,
            modelosNomes, modelosTokens, porDiaHoje,
            htmlBrutoNoDom: document.body.innerHTML.includes('<img src=x'),
          };
        });
        return { ok: true, dados: { nomesHoje: d.nomes, largurasHoje: d.larguras, resumoHoje: d.resumo, numeros1: d.numeros1, htmlBrutoNoDom: d.htmlBrutoNoDom, linhaModelos1: d.linhaModelos1, textoCusto: d.textoCusto, modelosNomes: d.modelosNomes, modelosTokens: d.modelosTokens, porDiaHoje: d.porDiaHoje } };
      });

      // ── 02: expandido ──
      await foto('02-uso-expandido', async () => {
        await pagina.evaluate(() => {
          const primeiro = document.querySelector('.uso-item details.uso-origens');
          if (primeiro) primeiro.open = true;
        });
        const d = await pagina.evaluate(() => {
          const origens = Array.from(document.querySelectorAll('#uso-lista .uso-item')[0].querySelectorAll('.uso-origem'));
          return {
            qtdOrigens: origens.length,
            rotulosOrigens: origens.map((o) => o.querySelector('.uso-origem-nome').textContent),
          };
        });
        return { ok: true, dados: d };
      });

      // ── 03: 7 dias ──
      await foto('03-uso-7dias', async () => {
        await pagina.click('#btn-periodo-7');
        await espera(500);
        const d = await pagina.evaluate(() => ({
          pressed7: document.getElementById('btn-periodo-7').getAttribute('aria-pressed'),
          pressed1: document.getElementById('btn-periodo-1').getAttribute('aria-pressed'),
          resumo7: document.getElementById('uso-resumo').textContent,
          nomes7: Array.from(document.querySelectorAll('#uso-lista .uso-item-nome')).map((n) => n.textContent),
          // S17 — a secao "Por dia" so existe com dias > 1. Em 7 dias o fixture tem gasto
          // hoje, ha 2 e ha 3 dias: tres linhas, em ordem crescente de data.
          diasNomes7: Array.from(document.querySelectorAll('#uso-por-dia .uso-linha-nome')).map((n) => n.textContent),
        }));
        if (d.pressed7 !== 'true' || d.pressed1 !== 'false') return { ok: false, porque: 'aria-pressed não trocou ao clicar em 7 dias: ' + JSON.stringify(d) };
        return { ok: true, dados: d };
      });

      // ── S12 (REESCRITO na fase 2b, 04/09): sem token, quem pede a chave é o APP ──
      //
      // Dentro do app quem pede token é o #dialogo-token (app.js:125, pedirToken()) — a tela
      // de tokens nem chega a abrir sem o cockpit primeiro. O teste deixou de provar a frase
      // "abra o cockpit primeiro" (que só existia na uso.js standalone) e passou a provar
      // que o #dialogo-token abre sozinho quando a rota volta 401.
      //
      // ABA NOVA, e nao a pagina de sempre. O evaluateOnNewDocument la de cima roda a CADA
      // navegacao, antes de qualquer script da pagina: um removeItem seguido de goto na
      // mesma aba tinha o token REINSERIDO pelo hook antes do app ler o localStorage. Aba
      // sem o hook nao tem esse problema, e ainda deixa a pagina original intacta para o
      // que vier depois.
      // (Sem crases neste comentario: o roteiro inteiro e uma template string.)
      let abaLimpa = null;
      await foto('99-app-pede-token', async () => {
        const limpa = await navegador.newPage();
        abaLimpa = limpa;
        {
          await limpa.setViewport(CELULAR);
          // Aba nova NAO basta: localStorage e por ORIGEM, compartilhado por todas as abas
          // do mesmo navegador — o token que a pagina original gravou continua la. Entao
          // sao duas cargas: a primeira so para ter acesso ao localStorage da origem, o
          // clear, e a segunda que e a que de fato se mede. O hook de token nao roda nesta
          // aba, entao nada o reinsere entre as duas.
          await limpa.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
          await limpa.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
          await limpa.reload({ waitUntil: 'networkidle2', timeout: 30000 });
          await espera(500);
          const estado = await limpa.evaluate(() => ({
            dialogoTokenAberto: Boolean(document.getElementById('dialogo-token') && document.getElementById('dialogo-token').open),
            // Prova que a aba esta mesmo sem token — sem isto, um dia em que o hook
            // voltasse a rodar daria 'nao pediu token' e ninguem saberia por que.
            temToken: Boolean(localStorage.getItem('cockpit-token')),
          }));
          medidas.semTokenTinhaToken = estado.temToken;
          medidas.appPedeToken = !estado.temToken && estado.dialogoTokenAberto;
        }
        // alvo: o print sai DESTA aba, a que foi medida. Fechar so depois do screenshot.
        return { ok: true, alvo: limpa };
      });
      if (abaLimpa) await abaLimpa.close().catch(() => {});

      // ── caso novo, obrigatório (P3-b, o achado crítico) ──────────────────────
      //
      // Primeiro acesso por link — SEM o hook, o token chega só pela query string, como o
      // usuário abre o cockpit num aparelho novo de verdade. E exatamente o cenario que o
      // token capturado uma vez soh no carregamento do uso.js quebrava: o script rodava
      // antes do app.js gravar o token no localStorage, e a tela de tokens ficava presa em
      // "abra o cockpit primeiro" para sempre, mesmo com o token ja guardado.
      // (Sem crases neste comentario: o roteiro inteiro e uma template string.)
      let abaPrimeiroAcesso = null;
      await foto('06-uso-primeiro-acesso', async () => {
        const nova = await navegador.newPage();
        abaPrimeiroAcesso = nova;
        await nova.setViewport(CELULAR);
        await nova.goto(BASE + '/?token=' + encodeURIComponent(TOKEN), { waitUntil: 'networkidle2', timeout: 30000 });
        await nova.waitForSelector('#abas', { timeout: 15000 });
        await nova.click('#btn-config');
        await nova.waitForSelector('#dialogo-config[open]', { timeout: 5000 });
        await nova.click('#btn-uso');
        await nova.waitForSelector('#dialogo-uso[open]', { timeout: 5000 });
        try {
          await nova.waitForSelector('#uso-lista .uso-item', { timeout: 10000 });
        } catch {
          const texto = await nova.evaluate(() => (document.getElementById('uso-lista') || {}).textContent || '');
          return { ok: false, porque: 'a tela de tokens não carregou no primeiro acesso por link (texto: ' + texto.slice(0, 120) + ')' };
        }
        const textoLista = await nova.evaluate(() => document.getElementById('uso-lista').textContent);
        medidas.primeiroAcessoTemAbraOCockpit = /abra o cockpit primeiro/.test(textoLista);
        return { ok: true, alvo: nova };
      });
      if (abaPrimeiroAcesso) await abaPrimeiroAcesso.close().catch(() => {});
    } else {
      // ── MODO=real ──
      await foto('04-uso-real', async () => {
        await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
        await pagina.waitForSelector('#abas', { timeout: 15000 });
        await pagina.click('#btn-config');
        await pagina.waitForSelector('#dialogo-config[open]', { timeout: 5000 });
        await pagina.click('#btn-uso');
        await pagina.waitForSelector('#dialogo-uso[open]', { timeout: 5000 });
        try {
          await pagina.waitForSelector('#uso-lista .uso-item', { timeout: 8000 });
        } catch {
          medidas.semDadoReal = true;
          return { ok: true, dados: { semDadoReal: true } };
        }
        const d = await pagina.evaluate(() => ({
          qtdProjetos: document.querySelectorAll('#uso-lista .uso-item').length,
          resumo: document.getElementById('uso-resumo').textContent,
          custoReal: (document.getElementById('uso-custo') || {}).textContent || '',
          porModeloReal: document.querySelectorAll('#uso-por-modelo .uso-linha').length,
          porDiaHojeReal: (document.getElementById('uso-por-dia') || {}).textContent || '',
        }));
        return { ok: true, dados: d };
      });

      // ── 05: 7 dias, com dado real — o unico print onde "Por dia" aparece de verdade.
      // Sem ele nao ha como conferir com os olhos que a secao existe e que sumiu em Hoje.
      await foto('05-uso-real-7dias', async () => {
        await pagina.click('#btn-periodo-7');
        await espera(1500);
        const d = await pagina.evaluate(() => ({
          resumo7Real: document.getElementById('uso-resumo').textContent,
          porDia7Real: document.querySelectorAll('#uso-por-dia .uso-linha').length,
        }));
        return { ok: true, dados: d };
      });
    }

    if (erros.length) problemas.push(erros.length + ' erro(s) de console: ' + erros.slice(0, 3).join(' | '));
    if (requisicoes.length) problemas.push(requisicoes.length + ' requisição(ões) >=400: ' + requisicoes.slice(0, 3).join(' | '));
  } catch (e) {
    problemas.push('o roteiro estourou — ' + String(e && e.message).slice(0, 300));
  } finally {
    await pagina.close().catch(() => {});
    await navegador.close();
  }
  console.log('@@MEDIDAS-USO@@' + JSON.stringify({ medidas, problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e);
  process.exit(1);
});
`;
}

// ─── corrida ────────────────────────────────────────────────────────────

(async () => {
  let saida = 1;
  let servidor = null;
  let raiz = null;

  try {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
      return process.exit(2);
    }
    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. O smoke recusa sobrescrever.`);
      return process.exit(2);
    }

    let base = os.tmpdir();
    if (base.startsWith('/home')) base = '/tmp';
    raiz = fs.mkdtempSync(path.join(base, `smoke-uso-${MODO}-`));
    const certDir = path.join(raiz, 'cert-vazio');
    fs.mkdirSync(certDir, { recursive: true });
    const usoDir = path.join(raiz, 'cache-descartavel');   // nos DOIS modos — nunca o de produção

    let homeParaServidor;
    let totaisFixture = null;
    if (MODO === 'fixture') {
      const montado = montarFixture(raiz);
      homeParaServidor = montado.home;
      totaisFixture = montado.totais;
      console.log(`  · fixture em ${raiz}`);
    } else {
      homeParaServidor = os.homedir();   // HOME de VERDADE — leitura pura, nada escrito lá
      console.log('  · MODO=real: lendo o ~/.claude/projects de verdade (só leitura)');
    }

    try {
      servidor = await subirServidor({ home: homeParaServidor, certDir, usoDir });
    } catch (e) {
      console.error(`🟡 ambiente: ${e.message}`);
      return process.exit(2);
    }
    console.log(`  · servidor no ar em http://127.0.0.1:${PORTA} (pid ${servidor.processo.pid})`);

    fs.writeFileSync(path.join(raiz, 'roteiro.js'), montarRoteiro());
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-e', `TOKEN=${TOKEN}`,
      '-e', `MODO=${MODO}`,
      '-v', `${raiz}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/roteiro.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigo = await new Promise((r) => docker.on('close', r));
    console.log(saidaDocker);

    const MARCADOR = '@@MEDIDAS-USO@@';
    let relatorio = null;
    const abre = saidaDocker.indexOf(MARCADOR);
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }
    const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigo})`];
    const medidas = relatorio ? relatorio.medidas : {};

    if (MODO === 'real' && medidas.semDadoReal) {
      console.error('🟡 MODO=real: sem dado real hoje — rode em outro dia (código 3, não aprova o aceite)');
      return process.exit(3);
    }

    ok(problemas.length === 0, problemas.length ? `o percurso reprovou: ${problemas.join(' · ')}` : 'CSS, console, requisições e os passos passaram');

    if (MODO === 'fixture' && problemas.length === 0) {
      // `totaisFixture` deixou de ser só decorativo: `diasEsperados` é lido pelo S17b abaixo.
      // Os totais em número continuam comentados dentro de `montarFixture`.
      // S1 — as 2 linhas de projeto, na ordem [maior, menor], com o nome exato
      ok(JSON.stringify(medidas.nomesHoje) === JSON.stringify(['projeto-a', 'projeto-b']),
        `S1: ordem [projeto-a, projeto-b] (veio ${JSON.stringify(medidas.nomesHoje)})`);
      // S2/S3 — o resumo do topo contém o total exato: curto(20000) === "20,0k" (uso.js:
      // abs >= 1e3 vira "N,Dk"; só passa de "M" a partir de 1e6).
      ok(/total 20,0k/.test(medidas.resumoHoje || ''),
        `S2: o resumo cita "total 20,0k" — o total exato do fixture (veio "${medidas.resumoHoje}")`);
      // S4 — a barra do 1º é maior que a do 2º, soma <= 100%
      const [l1, l2] = medidas.largurasHoje || [];
      ok(typeof l1 === 'number' && typeof l2 === 'number' && l1 > l2 && (l1 + l2) <= 100.5,
        `S4: barra do 1º (${l1}) > barra do 2º (${l2}), soma <= 100% (soma=${l1 + l2})`);
      // S5 — o texto do período é "Hoje · DD/MM (UTC)"
      ok(/^Hoje · \d{2}\/\d{2} \(UTC\)/.test(medidas.resumoHoje || ''),
        `S5: período no formato "Hoje · DD/MM (UTC)" (veio "${medidas.resumoHoje}")`);
      // S6 — cache aparece SEPARADO de entrada/saída: 3 nós de texto distintos, cada um
      // começando pelo rótulo certo — não uma string só com os três números concatenados.
      const n1 = medidas.numeros1 || [];
      ok(n1.length === 3 && /^cache/.test(n1[0]) && /^entrada/.test(n1[1]) && /^sa[íi]da/.test(n1[2]),
        `S6: cache/entrada/saída em 3 nós separados (veio ${JSON.stringify(n1)})`);
      // S7 — abrir o <details> revela as 3 origens, ordenadas por total
      ok(medidas.qtdOrigens === 3, `S7: 3 origens dentro do projeto-a (veio ${medidas.qtdOrigens})`);
      // S8 — a origem com subagente soma pai + subagente = 4000, e é a 3ª em total (5000, 4000, 10000
      // ordenados desc = [10000(aba), 5000(job1), 4000(job2-subagente)])
      ok(Array.isArray(medidas.rotulosOrigens) && medidas.rotulosOrigens.length === 3,
        `S8: 3 rótulos de origem lidos (veio ${JSON.stringify(medidas.rotulosOrigens)})`);
      // S9 — trocar para 7 dias troca o fetch e o total muda para o do fixture de 7 dias:
      // curto(20600) === "20,6k" (20000 + 500 do dia -3 + 50 + 50 do par empatado).
      ok(/total 20,6k/.test(medidas.resumo7 || ''),
        `S9: o resumo de 7 dias cita "total 20,6k" (veio "${medidas.resumo7}")`);
      // S10 — desempate alfabético estável entre aaa-empate/zzz-empate na janela de 7 dias
      const nomes7 = medidas.nomes7 || [];
      const iA = nomes7.indexOf('aaa-empate');
      const iZ = nomes7.indexOf('zzz-empate');
      ok(iA >= 0 && iZ >= 0 && iA < iZ, `S10: aaa-empate vem antes de zzz-empate (posições ${iA}, ${iZ})`);
      // S11 — o <img onerror> do título do job NUNCA vira HTML executável
      ok(medidas.htmlBrutoNoDom === false, 'S11: o marcador <img src=x> NUNCA aparece como HTML no DOM (textContent, não innerHTML)');
      // S12 — sem token, a tela diz "abra o cockpit primeiro"
      ok(medidas.semTokenTinhaToken === false, 'checagem de sanidade: a aba de S12 realmente não tinha token');
      ok(medidas.appPedeToken === true, 'S12: sem token, quem pede a chave é o APP (#dialogo-token) — a tela de tokens nem chega a abrir');
      // Caso novo, obrigatório (P3-b): primeiro acesso por link, sem hook — a tela de tokens
      // tem que carregar de verdade, nunca ficar presa em "abra o cockpit primeiro".
      ok(medidas.primeiroAcessoTemAbraOCockpit === false,
        'S18 (P3-b): primeiro acesso por link (?token=, sem hook) carrega a tela de tokens de verdade');
      // S13 — checado dentro do roteiro (largura do documento <= 390 em toda foto()); se
      // algum problema tivesse aparecido, já estaria em `problemas` acima.
      ok(true, 'S13: largura <= 390 em todos os PNGs — conferido a cada foto() dentro do roteiro');

      // ── card `tokens-mais-detalhe` ──────────────────────────────────────
      // S14 — a linha de modelos do 1º projeto passa a ter NOME SEGUIDO DE NÚMERO. É falsa
      // na versão anterior (lá é só `nome · nome`) e falsa também se `porModelo` sumir sem o
      // cliente ser atualizado — o `|| []` faria a linha virar string vazia EM SILÊNCIO, e
      // nenhum assert de antes olhava esta linha.
      ok(/claude-opus-5 \d/.test(medidas.linhaModelos1 || ''),
        `S14: a linha de modelos do projeto-a tem nome + número (veio "${medidas.linhaModelos1}")`);
      // S15 — a linha de estimativa e o valor em dólar estão no DOM. Sem ela o número mente:
      // o usuário paga assinatura, não por token.
      const custoTxt = medidas.textoCusto || '';
      ok(/estimativa/i.test(custoTxt) && /assinatura/i.test(custoTxt) && /US\$/.test(custoTxt),
        `S15: #uso-custo traz a estimativa, a palavra "assinatura" e um valor em US$ (veio "${custoTxt.slice(0, 140)}")`);
      ok(!/US\$\s*NaN/.test(custoTxt), `S15b: nenhum "US$ NaN" na tela (veio "${custoTxt.slice(0, 80)}")`);
      // S16 — "Por modelo" tem uma linha por modelo do fixture, na ordem por tokens, e os
      // valores exibidos são os do fixture: 19,0k (opus) + 1,0k (haiku) = os 20,0k do topo.
      ok(JSON.stringify(medidas.modelosNomes) === JSON.stringify(['claude-opus-5', 'claude-haiku-4-5']),
        `S16: "Por modelo" na ordem por tokens (veio ${JSON.stringify(medidas.modelosNomes)})`);
      ok(JSON.stringify(medidas.modelosTokens) === JSON.stringify(['19,0k', '1,0k']),
        `S16b: os tokens exibidos somam o total do topo — 19,0k + 1,0k = 20,0k (veio ${JSON.stringify(medidas.modelosTokens)})`);
      // S17 — "Por dia" some em Hoje e aparece em 7 dias, em ordem crescente de data.
      ok((medidas.porDiaHoje || '') === '',
        `S17: em "Hoje", #uso-por-dia fica VAZIO (veio "${medidas.porDiaHoje}")`);
      // Igualdade contra a lista que o fixture sabe de cor, já em ordem crescente. Comparar
      // por igualdade prova ordem E conteúdo de uma vez, e não depende de ordenar strings
      // "DD/MM" — que reprovaria sozinho na virada do ano ("1230" > "0101").
      const dias7 = medidas.diasNomes7 || [];
      ok(JSON.stringify(dias7) === JSON.stringify(totaisFixture.diasEsperados),
        `S17b: em 7 dias, os 3 dias do fixture em ordem crescente (esperado ${JSON.stringify(totaisFixture.diasEsperados)}, veio ${JSON.stringify(dias7)})`);

      fs.writeFileSync(path.join(SAIDA, 'medidas.json'), JSON.stringify(medidas, null, 2));
    }

    if (MODO === 'real' && problemas.length === 0) {
      // No disco de verdade nao se sabe QUANTOS modelos nem QUANTOS dias vao aparecer — entao
      // aqui os asserts sao os universais: a estimativa esta la, o numero nao e NaN, "Por
      // modelo" tem pelo menos uma linha e "Por dia" obedece a regra dias>1.
      const custoReal = medidas.custoReal || '';
      ok(/estimativa/i.test(custoReal) && /US\$/.test(custoReal) && !/US\$\s*NaN/.test(custoReal),
        `real: a estimativa e um valor em US$ (sem NaN) na tela (veio "${custoReal.slice(0, 120)}")`);
      ok(medidas.porModeloReal >= 1, `real: "Por modelo" tem ${medidas.porModeloReal} linha(s)`);
      ok((medidas.porDiaHojeReal || '') === '', 'real: em "Hoje", "Por dia" fica vazio');
      ok(medidas.porDia7Real >= 1, `real: em 7 dias, "Por dia" tem ${medidas.porDia7Real} linha(s)`);
      fs.writeFileSync(path.join(SAIDA, 'medidas.json'), JSON.stringify(medidas, null, 2));
    }

    for (const nome of (MODO === 'fixture' ? ['01-uso-hoje', '02-uso-expandido', '03-uso-7dias'] : ['04-uso-real', '05-uso-real-7dias'])) {
      const arquivo = path.join(SAIDA, `${nome}.png`);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }

    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('\n🔴 o smoke estourou:', e && e.message);
    saida = 1;
  } finally {
    if (servidor) await servidor.matar();
    if (raiz) fs.rmSync(raiz, { recursive: true, force: true });
    console.log(`\n${falhas || saida ? '❌ SMOKE DE USO VERMELHO' : '✅ SMOKE DE USO VERDE'}`
      + ` (MODO=${MODO}) — ${feitos - falhas}/${feitos} · PNGs em ${SAIDA}\n`);
  }
  process.exit(saida);
})();
