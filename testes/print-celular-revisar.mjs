#!/usr/bin/env node
// Print de CELULAR (390×844) da tela "Pra revisar" — molde de `print-celular-jobs.mjs`
// (plano docs/superpowers/plans/2026-10-04-tela-pra-revisar-plano.md, Fase D).
//
// Uma cena por invocação — `--cena` escolhe qual:
//   lateral          a lateral com o ícone + contador do botão "Pra revisar" na vista
//   lista            a lista de cards, com jobs reais
//   lista-atencao    a mesma lista, no filtro "Atenção"
//   lista-detalhe    a lista com uma sublinha "retomou:/inclui:" DENTRO do viewport (rola até ela)
//   job-relacionado  toca a sublinha e exige a tela do job RELACIONADO (não a do card de cima)
//   job-smoke        a tela de UM job (--job-id), com veredito e passos de smoke na vista
//   painel-job       depois de "Abrir conversa do job": o painel do job aberto
//   job              a tela de UM job (--job-id) só com o veredito exigido — job sem roteiro
//   lista-merge      a lista com os três selos de merge (limpo, conflito, só-roadmap) DENTRO do viewport
//   job-merge        a tela de um job com conflito: a seção "Merge na develop" com os arquivos na vista
//                    (as duas cenas pedem o cenário de `testes/cenario-revisar-merge.js`)
//   atencao-decisao  o filtro "Atenção" com o chip "pede decisão" na vista; com --ausente ID confere
//                    também que esse id NÃO está na lista (card já fechado no meta)
//   job-decisao      a tela de UM job (--job-id) com o veredito "Pede decisão" na vista
//                    (as duas cenas pedem o cenário de `testes/cenario-revisar-falso-pronto.js`)
//
// A rota é conferida ANTES do obturador (mesma disciplina do print-celular-jobs.mjs): 401,
// `habilitado:false` ou lista vazia encerram com exit 2 e NENHUM PNG — cenário não montado
// não vira prova.
//
// Uso:
//   node testes/print-celular-revisar.mjs --porta 7894 --saida /tmp/x.png --cena lateral
//   node testes/print-celular-revisar.mjs --porta 7894 --saida /tmp/y.png --cena job-smoke \
//        --job-id 20260930-164255-loja-exemplo-ataca-concilia-o-entradas-revis-o-central--93b1
//   … --tema claro | --tema escuro   (opcional; default = o tema de fábrica do app)
//
// Códigos de saída: 0 = PNG gravado · 1 = cenário reprovado · 2 = erro de uso/ambiente.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '';
const CHROME_BIN = process.env.CHROME_BIN || '';
const NO_HOST = Boolean(PUPPETEER_CORE && CHROME_BIN);
const CENAS = new Set(['lateral', 'lista', 'lista-atencao', 'lista-detalhe', 'job-relacionado', 'job-smoke', 'painel-job', 'job', 'lista-merge', 'job-merge', 'atencao-decisao', 'job-decisao']);
const TEMAS = new Set(['claro', 'escuro']);

const AJUDA = `print-celular-revisar — print 390×844 da tela "Pra revisar"

  --porta N          monta a base http://127.0.0.1:N (servidor de teste)
  --base URL         a base inteira; sobrepõe --porta
  --saida CAMINHO    o .png a gravar. Recusa sobrescrever.
  --cena NOME        lateral | lista | lista-atencao | lista-detalhe | job-relacionado | job-smoke | painel-job | job | lista-merge | job-merge | atencao-decisao | job-decisao
  --job-id ID        obrigatório para job-smoke/painel-job/job — o id do card a abrir
  --tema claro|escuro  opcional — força o tema antes do boot (localStorage cockpit-tema)
  --token-file ARQ   arquivo com COCKPIT_TOKEN=<valor>. O valor NUNCA vira argv.
  --inseguro         aceita certificado que não valida
  --ausente ID       (atencao-decisao) id que NÃO pode estar na lista
  --ajuda            isto
`;

function lerArgumentos(argv) {
  const opcoes = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ajuda' || arg === '-h') return { ajuda: true };
    if (arg === '--inseguro') { opcoes.inseguro = true; continue; }
    if (!arg.startsWith('--')) return { erro: `argumento solto: ${arg}` };
    const valor = argv[i + 1];
    if (valor === undefined || valor.startsWith('--')) return { erro: `${arg} exige valor` };
    opcoes[arg.slice(2).replace(/-/g, '_')] = valor;
    i += 1;
  }
  return opcoes;
}

const o = lerArgumentos(process.argv.slice(2));
if (o.ajuda) { process.stdout.write(AJUDA); process.exit(0); }
if (o.erro) { console.error(`🔴 ${o.erro}\n\n${AJUDA}`); process.exit(2); }

const base = o.base || (o.porta ? `http://127.0.0.1:${o.porta}` : '');
if (!base) { console.error('🔴 falta --porta ou --base'); process.exit(2); }
if (!o.saida) { console.error('🔴 falta --saida'); process.exit(2); }
if (!CENAS.has(o.cena)) { console.error(`🔴 --cena tem de ser uma de: ${[...CENAS].join(' | ')}`); process.exit(2); }
if ((o.cena === 'job-smoke' || o.cena === 'painel-job' || o.cena === 'job') && !o.job_id) {
  console.error(`🔴 --cena ${o.cena} exige --job-id`); process.exit(2);
}
if (o.tema && !TEMAS.has(o.tema)) { console.error('🔴 --tema tem de ser claro ou escuro'); process.exit(2); }

const saida = path.resolve(o.saida);
if (fs.existsSync(saida)) { console.error(`🔴 ${saida} já existe — apague ou troque o nome`); process.exit(2); }

// ─── O token, sem passar por argv (mesmo cuidado do print-celular-jobs.mjs) ─────────────────

let token = '';
if (o.token_file) {
  const arquivo = o.token_file.replace(/^~(?=\/|$)/, os.homedir());
  let bruto;
  try { bruto = fs.readFileSync(arquivo, 'utf8'); } catch (e) {
    console.error(`🔴 não deu para ler --token-file: ${e.code || e.message}`);
    process.exit(2);
  }
  const achado = bruto.match(/^COCKPIT_TOKEN=(.*)$/m);
  if (!achado) { console.error('🔴 --token-file não tem uma linha COCKPIT_TOKEN='); process.exit(2); }
  token = achado[1].trim();
  if (!token) { console.error('🔴 COCKPIT_TOKEN está vazio'); process.exit(2); }
}

// ─── 1) A ROTA, antes de qualquer navegador ──────────────────────────────────────────────

async function conferirRota() {
  const url = `${base}/api/jobs?revisar=1`;
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), 10000);
  let resposta;
  try {
    resposta = await fetch(url, {
      signal: controle.signal,
      redirect: 'manual',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch (e) {
    return { ok: false, motivo: `a rota não respondeu: ${e.name === 'AbortError' ? 'timeout de 10s' : e.message}` };
  } finally {
    clearTimeout(relogio);
  }
  if (resposta.status !== 200) {
    const dica = resposta.status === 401 ? ' — falta o token (--token-file)' : '';
    return { ok: false, motivo: `a rota respondeu ${resposta.status}, esperava 200${dica}` };
  }
  let dados;
  try { dados = await resposta.json(); } catch (e) { return { ok: false, motivo: `a rota não devolveu JSON: ${e.message}` }; }
  if (dados.habilitado !== true) return { ok: false, motivo: `esperava habilitado:true, veio ${JSON.stringify(dados.habilitado)}` };
  if (!Array.isArray(dados.jobs) || dados.jobs.length === 0) return { ok: false, motivo: 'esperava jobs.length > 0, veio lista vazia' };
  if ((o.cena === 'job-smoke' || o.cena === 'painel-job' || o.cena === 'job') && !dados.jobs.some((j) => j.id === o.job_id)) {
    return { ok: false, motivo: `--job-id ${o.job_id} não está em jobs[] da rota — confira o id` };
  }
  // O que o roteiro vai exigir, lido da ROTA (referência independente do DOM).
  const relacoes = (j) => [...(j.retomou || []), ...(j.inclui || [])];
  const pai = dados.jobs.find((j) => relacoes(j).length > 0);
  const sub = pai ? relacoes(pai)[0] : null;
  const rel = sub ? { paiId: pai.id, paiTitulo: pai.titulo, relId: sub.id, relTitulo: sub.titulo } : null;
  if ((o.cena === 'lista-detalhe' || o.cena === 'job-relacionado') && !rel) {
    return { ok: false, motivo: 'cenário não montado: nenhum job com relação (retomou/inclui) na rota' };
  }
  const porEstado = (e) => dados.jobs.find((j) => j.merge && j.merge.estado === e) || null;
  if (o.cena === 'lista-merge' && !(porEstado('limpo') && porEstado('conflito') && porEstado('so-roadmap'))) {
    return { ok: false, motivo: 'cenário não montado: faltam os três estados de merge na rota' };
  }
  const jobConflito = porEstado('conflito');
  if (o.cena === 'job-merge' && !jobConflito) {
    return { ok: false, motivo: 'cenário não montado: nenhum job com merge em conflito na rota' };
  }
  const conflito = jobConflito ? { id: jobConflito.id, n: jobConflito.merge.arquivos.length } : null;
  const decisao = dados.jobs.find((j) => (j.etiquetas || []).includes('pede-decisao')) || null;
  const TOM_NAO_OK = new Set(['sem-base', 'nao-sei', 'pede-revisao', 'parou-no-limite', 'pede-decisao', 'relatorio-ilegivel']);
  const esperaAtencao = (dados.atencao || []).length
    + dados.jobs.filter((j) => (j.etiquetas || []).some((e) => TOM_NAO_OK.has(e))).length;
  return {
    ok: true, rel, conflito, decisaoId: decisao ? decisao.id : '', esperaAtencao,
    nota: `rota: 200 com habilitado:true e ${dados.jobs.length} job(s), ${(dados.atencao || []).length} em atencao[]`,
  };
}

// ─── 2) O roteiro que roda DENTRO do container ───────────────────────────────────────────

function montarRoteiro() {
  return `'use strict';
const fs = require('node:fs');
const puppeteer = require(process.env.PUPPETEER_PATH || '/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const CENA = process.env.CENA;
const JOB_ID = process.env.JOB_ID || '';
const PAI_ID = process.env.PAI_ID || '';
const PAI_TITULO = process.env.PAI_TITULO || '';
const REL_ID = process.env.REL_ID || '';
const REL_TITULO = process.env.REL_TITULO || '';
const ESPERA_ATENCAO = Number(process.env.ESPERA_ATENCAO || 0);
const CONFLITO_ID = process.env.CONFLITO_ID || '';
const N_ARQUIVOS = Number(process.env.N_ARQUIVOS || 0);
const DECISAO_ID = process.env.DECISAO_ID || '';
const AUSENTE_ID = process.env.AUSENTE_ID || '';
const TEMA = process.env.TEMA || '';
const INSEGURO = process.env.INSEGURO === '1';
const OUT = process.env.OUT_DIR || '/out';
const VIEWPORT = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const MAPA_TEMA = { claro: 'catppuccin-latte', escuro: 'abyss' };

let token = '';
try { token = fs.readFileSync((process.env.W_DIR || '/w') + '/token.txt', 'utf8').trim(); } catch { /* sem token: rota pública */ }

const problemas = [];
const feitos = [];
const exigir = (cond, msg) => {
  (cond ? feitos : problemas).push(msg);
  if (!cond) throw new Error('guarda reprovou antes do obturador: ' + msg);
};

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'].concat(INSEGURO ? ['--ignore-certificate-errors'] : []),
  });
  try {
    const pagina = await navegador.newPage();
    await pagina.setViewport(VIEWPORT);
    await pagina.evaluateOnNewDocument((t, tema) => {
      try { if (t) localStorage.setItem('cockpit-token', t); } catch { /* modo privado */ }
      try { if (tema) localStorage.setItem('cockpit-tema', tema); } catch { /* modo privado */ }
      // pt-BR explícito: o container não tem o idioma do dono por padrão, e o mockup
      // aprovado (referência visual) está em português.
      try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch { /* modo privado */ }
    }, token, MAPA_TEMA[TEMA] || '');

    const erros = [];
    pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
    pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });

    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await pagina.waitForSelector('#btn-revisar', { timeout: 15000 });
    // O contador busca no BOOT, sem await no caminho da lista de abas — dá um respiro pra
    // ele chegar antes do obturador.
    await new Promise((r) => setTimeout(r, 1200));

    if (CENA === 'lateral') {
      const temSelo = await pagina.evaluate(() => {
        const selo = document.getElementById('revisar-conta');
        return Boolean(selo) && !selo.hidden && selo.textContent.trim() !== '' && selo.textContent.trim() !== '0';
      });
      exigir(temSelo, 'o contador do #btn-revisar está visível e > 0');
      await pagina.screenshot({ path: OUT + '/print.png' });
      feitos.push('PNG gravado');
    } else {
      await pagina.click('#btn-revisar');
      await pagina.waitForSelector('#dialogo-revisar[open]', { timeout: 5000 });
      // O <dialog> entra com fade de 160 ms (estilo.css, T2): sem esperar a opacidade chegar a 1, o
      // obturador pega o app de fundo vazando pelo diálogo (visto nos PNGs de 16/10).
      await pagina.waitForFunction(() => getComputedStyle(document.getElementById('dialogo-revisar')).opacity === '1', { timeout: 5000 });
      await pagina.waitForSelector('.rv-card', { timeout: 10000 });

      if (CENA === 'lista') {
        exigir((await pagina.$$('.rv-card')).length > 0, 'a lista abriu com cards de verdade');
        await pagina.screenshot({ path: OUT + '/print.png' });
        feitos.push('PNG gravado');
      } else if (CENA === 'lista-atencao') {
        const clicou = await pagina.evaluate(() => {
          const botoes = [...document.querySelectorAll('.rv-filtro')];
          const atencao = botoes.find((b) => b.textContent.includes('Atenção'));
          if (!atencao) return false;
          atencao.click();
          return true;
        });
        exigir(clicou, 'o filtro "Atenção" existe e foi clicado');
        await new Promise((r) => setTimeout(r, 200));
        exigir((await pagina.$$('.rv-card')).length >= (ESPERA_ATENCAO > 0 ? 1 : 0), 'a lista redesenhou no filtro Atenção com ' + ESPERA_ATENCAO + ' item(ns) esperado(s) pela rota');
        await pagina.screenshot({ path: OUT + '/print.png' });
        feitos.push('PNG gravado');
      } else if (CENA === 'atencao-decisao') {
        if (AUSENTE_ID) {
          exigir((await pagina.$('.rv-card[data-id="' + AUSENTE_ID + '"]')) === null,
            'o job ' + AUSENTE_ID + ' (ciclo fechado) NÃO está na lista');
        }
        const clicouAtencao = await pagina.evaluate(() => {
          const botoes = [...document.querySelectorAll('.rv-filtro')];
          const atencao = botoes.find((b) => b.textContent.includes('Atenção'));
          if (!atencao) return false;
          atencao.click();
          return true;
        });
        exigir(clicouAtencao, 'o filtro "Atenção" existe e foi clicado');
        await new Promise((r) => setTimeout(r, 200));
        const n = (await pagina.$$('.rv-card')).length;
        exigir(n === ESPERA_ATENCAO, 'o filtro Atenção tem exatamente ' + ESPERA_ATENCAO + ' card(s) (veio ' + n + ')');
        exigir(Boolean(DECISAO_ID), 'a rota tem um job com a etiqueta pede-decisao');
        const chip = await pagina.evaluate((id) => {
          const c = document.querySelector('.rv-card[data-id="' + id + '"]');
          if (!c) return null;
          const el = [...c.querySelectorAll('.rv-chip')].find((x) => x.textContent.trim() === 'pede decisão');
          if (!el) return null;
          const f = el.getBoundingClientRect();
          return { top: f.top, bottom: f.bottom, altura: window.innerHeight };
        }, DECISAO_ID);
        exigir(chip !== null, 'o chip "pede decisão" existe dentro do card ' + DECISAO_ID);
        exigir(chip.top >= 0 && chip.bottom <= chip.altura, 'o chip "pede decisão" está dentro do viewport 390×844');
        await pagina.screenshot({ path: OUT + '/print.png' });
        feitos.push('PNG gravado');
      } else if (CENA === 'job-decisao') {
        exigir(Boolean(DECISAO_ID), 'a rota tem um job com a etiqueta pede-decisao');
        const clicouCard = await pagina.evaluate((id) => {
          const c = document.querySelector('.rv-card[data-id="' + id + '"]');
          if (!c) return false;
          c.click();
          return true;
        }, DECISAO_ID);
        exigir(clicouCard, 'o card do job com pede-decisao existe e foi clicado (' + DECISAO_ID + ')');
        await pagina.waitForSelector('.rv-veredito', { timeout: 10000 });
        const v = await pagina.evaluate(() => {
          const el = document.querySelector('.rv-veredito');
          if (!el) return null;
          const f = el.getBoundingClientRect();
          return { titulo: el.querySelector('strong').textContent, tom: el.dataset.tom, top: f.top, bottom: f.bottom, altura: window.innerHeight };
        });
        exigir(v !== null, 'o veredito está na vista');
        exigir(v.titulo === 'Pede decisão', 'o veredito mostra "Pede decisão" (veio "' + (v && v.titulo) + '")');
        exigir(v.tom === 'aviso', 'o tom do veredito é aviso (veio "' + (v && v.tom) + '")');
        exigir(v.top >= 0 && v.bottom <= v.altura, 'o veredito está dentro do viewport 390×844');
        await pagina.screenshot({ path: OUT + '/print.png' });
        feitos.push('PNG gravado');
      } else if (CENA === 'lista-merge') {
        for (const e of ['limpo', 'conflito', 'so-roadmap']) {
          const r = await pagina.evaluate((estado) => {
            const s = document.querySelector('#dialogo-revisar .rv-chip[data-merge="' + estado + '"]');
            if (!s) return null;
            const f = s.getBoundingClientRect();
            return { top: f.top, bottom: f.bottom, altura: window.innerHeight };
          }, e);
          exigir(r !== null, 'o selo de merge "' + e + '" existe na lista');
          exigir(r.top >= 0 && r.bottom <= r.altura, 'o selo ' + e + ' está dentro do viewport 390×844');
        }
        await pagina.screenshot({ path: OUT + '/print.png' });
        feitos.push('PNG gravado');
      } else if (CENA === 'job-merge') {
        const clicou = await pagina.evaluate((id) => {
          const c = document.querySelector('.rv-card[data-id="' + id + '"]');
          if (!c) return false;
          c.click();
          return true;
        }, CONFLITO_ID);
        exigir(clicou, 'o card do job em conflito existe e foi clicado (' + CONFLITO_ID + ')');
        await pagina.waitForSelector('.rv-merge[data-merge="conflito"]', { timeout: 10000 });
        const r = await pagina.evaluate(() => {
          const itens = [...document.querySelectorAll('#dialogo-revisar .rv-merge .rv-merge-arquivos li')];
          if (!itens.length) return { n: 0 };
          const f = itens[itens.length - 1].getBoundingClientRect();
          return { n: itens.length, top: f.top, bottom: f.bottom, altura: window.innerHeight };
        });
        exigir(r.n === N_ARQUIVOS, 'a seção de merge lista ' + N_ARQUIVOS + ' arquivo(s) (veio ' + r.n + ')');
        exigir(r.top >= 0 && r.bottom <= r.altura, 'o último arquivo em conflito está dentro do viewport 390×844');
        await pagina.screenshot({ path: OUT + '/print.png' });
        feitos.push('PNG gravado');
      } else if (CENA === 'lista-detalhe') {
        // Presença no DOM não basta: a sublinha tem de estar DENTRO do viewport 390x844. Rola até ela se preciso.
        const r = await pagina.evaluate((relId) => {
          const s = document.querySelector('.rv-sub[data-id="' + relId + '"]');
          if (!s) return null;
          const f = s.getBoundingClientRect();
          if (f.top < 0 || f.bottom > window.innerHeight) s.scrollIntoView({ block: 'center' });
          const n = s.getBoundingClientRect();
          return { top: n.top, bottom: n.bottom, altura: window.innerHeight };
        }, REL_ID);
        exigir(r !== null, 'a sublinha .rv-sub do relacionado ' + REL_ID + ' existe na lista');
        exigir(r.top >= 0 && r.bottom <= r.altura, 'a sublinha ' + REL_ID + ' está dentro do viewport 390×844');
        await new Promise((res) => setTimeout(res, 200));
        await pagina.screenshot({ path: OUT + '/print.png' });
        feitos.push('PNG gravado');
      } else if (CENA === 'job-relacionado') {
        const clicou = await pagina.evaluate((relId) => {
          const s = document.querySelector('.rv-sub[data-id="' + relId + '"]');
          if (!s) return false;
          s.click();
          return true;
        }, REL_ID);
        exigir(clicou, 'a sublinha do relacionado ' + REL_ID + ' existe e foi tocada (na sublinha, não no card)');
        await pagina.waitForSelector('.rv-hero h2', { timeout: 10000 });
        const h2 = await pagina.$eval('.rv-hero h2', (e) => e.textContent);
        exigir(h2 === REL_TITULO, 'abriu o relacionado (título "' + REL_TITULO + '", veio "' + h2 + '")');
        exigir(h2 !== PAI_TITULO, 'não abriu a de cima');
        await pagina.screenshot({ path: OUT + '/print.png' });
        feitos.push('PNG gravado');
      } else if (CENA === 'job-smoke' || CENA === 'painel-job' || CENA === 'job') {
        const achouCard = await pagina.evaluate((id) => {
          const c = document.querySelector('.rv-card[data-id="' + id + '"]');
          if (!c) return false;
          c.click();
          return true;
        }, JOB_ID);
        exigir(achouCard, 'o card do --job-id existe na lista e foi clicado (' + JOB_ID + ')');
        await pagina.waitForSelector('.rv-veredito, .rv-resumo', { timeout: 10000 });

        if (CENA === 'job') {
          exigir((await pagina.$('.rv-veredito')) !== null, 'o veredito está na vista');
          await pagina.screenshot({ path: OUT + '/print.png' });
          feitos.push('PNG gravado (veredito: ' + (await pagina.$eval('.rv-veredito', (v) => v.dataset.tom + ' · ' + v.querySelector('strong').textContent)) + ')');
        } else if (CENA === 'job-smoke') {
          exigir((await pagina.$('.rv-veredito')) !== null, 'o veredito está na vista');
          exigir((await pagina.$('.rv-passos')) !== null, 'os passos de smoke estão na vista');
          await pagina.screenshot({ path: OUT + '/print.png' });
          feitos.push('PNG gravado');
        } else {
          const clicouAbrir = await pagina.evaluate(() => {
            const btn = document.querySelector('.rv-rodape .btn');
            if (!btn) return false;
            btn.click();
            return true;
          });
          exigir(clicouAbrir, 'o botão "Abrir conversa do job" existe e foi clicado');
          await pagina.waitForSelector('#app[data-vista="chat"]', { timeout: 10000 });
          await new Promise((r) => setTimeout(r, 500));
          exigir((await pagina.evaluate(() => document.getElementById('dialogo-revisar').open)) === false,
            'o diálogo fechou depois de abrir a conversa');
          await pagina.screenshot({ path: OUT + '/print.png' });
          feitos.push('PNG gravado');
        }
      }
    }

    if (erros.length) feitos.push('console (anotado, não reprova): ' + erros.slice(0, 3).join(' | '));
  } finally {
    await navegador.close();
  }
})().then(() => {
  console.log('@@PRINT-REVISAR@@' + JSON.stringify({ feitos, problemas }));
}).catch((e) => {
  console.error('ROTEIRO QUEBROU:', e.message);
  console.log('@@PRINT-REVISAR@@' + JSON.stringify({ feitos, problemas: problemas.concat(['roteiro estourou: ' + e.message]) }));
  process.exitCode = 1;
});
`;
}

// ─── 3) Corrida ─────────────────────────────────────────────────────────────

// O parser do marcador, comum às duas corridas (container e host).
function lerRelatorio(bruto, codigo) {
  const MARCADOR = '@@PRINT-REVISAR@@';
  const abre = bruto.indexOf(MARCADOR);
  let relatorio = null;
  if (abre >= 0) {
    try { relatorio = JSON.parse(bruto.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
  }
  process.stdout.write(abre >= 0 ? bruto.slice(0, abre) : bruto);
  return relatorio || { feitos: [], problemas: [`o roteiro não devolveu JSON (código ${codigo})`] };
}

function rodarContainer(scratch, outDir) {
  return new Promise((resolve) => {
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=${base}`,
      '-e', `CENA=${o.cena}`,
      '-e', `JOB_ID=${o.job_id || ''}`,
      '-e', `PAI_ID=${conferencia.rel?.paiId || ''}`,
      '-e', `PAI_TITULO=${conferencia.rel?.paiTitulo || ''}`,
      '-e', `REL_ID=${conferencia.rel?.relId || ''}`,
      '-e', `REL_TITULO=${conferencia.rel?.relTitulo || ''}`,
      '-e', `ESPERA_ATENCAO=${conferencia.esperaAtencao || 0}`,
      '-e', `CONFLITO_ID=${conferencia.conflito?.id || ''}`,
      '-e', `N_ARQUIVOS=${conferencia.conflito?.n || ''}`,
      '-e', `DECISAO_ID=${conferencia.decisaoId || ''}`,
      '-e', `AUSENTE_ID=${o.ausente || ''}`,
      '-e', `TEMA=${o.tema || ''}`,
      '-e', `INSEGURO=${o.inseguro ? '1' : '0'}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${outDir}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let bruto = '';
    docker.stdout.on('data', (d) => { bruto += d; });
    docker.stderr.on('data', (d) => { bruto += d; });
    docker.on('close', (codigo) => resolve(lerRelatorio(bruto, codigo)));
  });
}

// Navegador no HOST (D79-D83): a imagem docker não existe mais — mesmo roteiro, mesmo
// marcador, rodando como processo filho com PUPPETEER_CORE/CHROME_BIN por env.
function rodarNoHost(scratch, outDir) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [path.join(scratch, 'pane.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BASE: base,
        CENA: o.cena,
        JOB_ID: o.job_id || '',
        PAI_ID: conferencia.rel?.paiId || '',
        PAI_TITULO: conferencia.rel?.paiTitulo || '',
        REL_ID: conferencia.rel?.relId || '',
        REL_TITULO: conferencia.rel?.relTitulo || '',
        ESPERA_ATENCAO: String(conferencia.esperaAtencao || 0),
        CONFLITO_ID: conferencia.conflito?.id || '',
        N_ARQUIVOS: String(conferencia.conflito?.n || ''),
        DECISAO_ID: conferencia.decisaoId || '',
        AUSENTE_ID: o.ausente || '',
        TEMA: o.tema || '',
        INSEGURO: o.inseguro ? '1' : '0',
        PUPPETEER_PATH: PUPPETEER_CORE,
        CHROME_PATH: CHROME_BIN,
        W_DIR: scratch,
        OUT_DIR: outDir,
      },
    });

    let bruto = '';
    filho.stdout.on('data', (d) => { bruto += d; });
    filho.stderr.on('data', (d) => { bruto += d; });
    filho.on('close', (codigo) => resolve(lerRelatorio(bruto, codigo)));
  });
}

let scratch = null;
let outDir = null;
if (!NO_HOST) {
  try {
    execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
  } catch {
    console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
    process.exit(2);
  }
}

const conferencia = await conferirRota();
if (!conferencia.ok) {
  console.error(`🔴 cenário não montado — ${conferencia.motivo}`);
  process.exit(2);
}
console.log(`  · ${conferencia.nota}`);

try {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-revisar-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-revisar-out-'));
  fs.writeFileSync(path.join(scratch, 'pane.js'), montarRoteiro(), { mode: 0o600 });
  if (token) fs.writeFileSync(path.join(scratch, 'token.txt'), token, { mode: 0o600 });
  fs.chmodSync(outDir, 0o777);

  const relatorio = NO_HOST ? await rodarNoHost(scratch, outDir) : await rodarContainer(scratch, outDir);
  for (const f of relatorio.feitos) console.log(`  ✅ ${f}`);
  for (const p of relatorio.problemas) console.error(`  ❌ ${p}`);

  const bruto = path.join(outDir, 'print.png');
  if (relatorio.problemas.length || !fs.existsSync(bruto)) {
    console.error('🔴 print REPROVADO — nenhum PNG gravado no destino');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(saida), { recursive: true });
  fs.copyFileSync(bruto, saida);
  console.log(`✅ print gravado: ${saida}`);
} finally {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
}
