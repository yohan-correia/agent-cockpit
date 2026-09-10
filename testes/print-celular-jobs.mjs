#!/usr/bin/env node
// Print de CELULAR (390×844) do grupo de jobs — a ferramenta dos dois prints do plano
// "absorver o painel de jobs".
//
// Por que existe, e por que não é o `smoke-navegador-externo`: aquele wrapper trava em
// 1600×1000, e print de celular em viewport de desktop não vale como prova (regra de
// 2026-08-25). Este roda o MESMO puppeteer dos `smoke-celular-*`, no mesmo container, em
// 390×844.
//
// Os dois usos, e eles esperam o OPOSTO um do outro:
//
//   --espero desacoplado   a rota responde 200 com `painel: false`  ⇒ a tela diz
//                          "não deu para ler os jobs"        (A15, Fase 0)
//   --espero jobs          a rota responde 200 com `painel: true`   ⇒ a tela desenha
//                          e `jobs.length > 0`                       linhas de job (A14, Fase 3)
//
// 🔴 A rota é conferida ANTES do obturador, e é isso que separa prova de foto bonita: a
// MESMA mensagem "não deu para ler os jobs" aparece quando o TOKEN falta
// (`public/app.js:125-127` lança em 401 e `:5717-5719` manda todo erro para
// `semNoticiaDosJobs()`). Um print sem autenticação provaria "o token não foi passado", não
// "a dependência caiu". Por isso 401/500/timeout ⇒ exit 2 e NENHUM PNG: cenário não montado
// não vira prova.
//
// Uso:
//   node testes/print-celular-jobs.mjs --porta 7896 --saida /tmp/x.png --espero jobs
//   node testes/print-celular-jobs.mjs --base https://<host>:7879 --saida /tmp/y.png \
//        --espero desacoplado --token-file <seu-arquivo-de-token>
//
// Códigos de saída: 0 = PNG gravado · 1 = cenário reprovado · 2 = erro de uso ou ambiente.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const MODOS = new Set(['desacoplado', 'jobs']);

const AJUDA = `print-celular-jobs — print 390×844 do grupo de jobs

  --porta N          monta a base http://127.0.0.1:N (servidor de teste)
  --base URL         a base inteira; sobrepõe --porta (produção, HTTPS, nome do tailnet)
  --saida CAMINHO    o .png a gravar. Recusa sobrescrever.
  --espero MODO      desacoplado | jobs — o que a rota E a tela têm de dizer
  --token-file ARQ   arquivo com COCKPIT_TOKEN=<valor>. O valor NUNCA vira argv.
  --inseguro         aceita certificado que não valida (tailnet visto de dentro do container)
  --ajuda            isto
`;

// ─── Argumentos ─────────────────────────────────────────────────────────────

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
if (!MODOS.has(o.espero)) { console.error(`🔴 --espero tem de ser ${[...MODOS].join(' ou ')}`); process.exit(2); }

const saida = path.resolve(o.saida);
// Recusa sobrescrever pelo mesmo motivo dos `smoke-celular-*`: um PNG velho com o nome de
// sempre é pior que PNG nenhum — alguém abre e acredita.
if (fs.existsSync(saida)) { console.error(`🔴 ${saida} já existe — apague ou troque o nome`); process.exit(2); }

// ─── O token, sem passar por argv ───────────────────────────────────────────
//
// 🔴 Lido do arquivo aqui dentro e escrito num arquivo temporário 0600 que o container monta
// como somente-leitura. `-e TOKEN=…` no `docker run` deixaria o segredo visível em `ps` para
// qualquer processo da máquina enquanto o print roda.

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

// ─── 1) A ROTA, antes de qualquer navegador ─────────────────────────────────

async function conferirRota() {
  const url = `${base}/api/jobs?tudo=1`;
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), 10000);
  let resposta;
  try {
    resposta = await fetch(url, {
      signal: controle.signal,
      redirect: 'manual',   // 🔴 a porta de produção redireciona http→https; seguir calado esconderia o erro
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch (e) {
    return { ok: false, motivo: `a rota não respondeu: ${e.name === 'AbortError' ? 'timeout de 10s' : e.message}` };
  } finally {
    clearTimeout(relogio);
  }

  if (resposta.status !== 200) {
    const dica = resposta.status === 401 ? ' — falta o token (--token-file)'
      : (resposta.status >= 300 && resposta.status < 400) ? ` — redirecionou para ${resposta.headers.get('location') || '?'}` : '';
    return { ok: false, motivo: `a rota respondeu ${resposta.status}, esperava 200${dica}` };
  }

  let dados;
  try { dados = await resposta.json(); } catch (e) { return { ok: false, motivo: `a rota não devolveu JSON: ${e.message}` }; }

  if (o.espero === 'desacoplado') {
    if (dados.painel !== false) {
      return { ok: false, motivo: `esperava painel:false, veio painel:${JSON.stringify(dados.painel)} — o painel-externo ainda está de pé?` };
    }
    return { ok: true, nota: 'rota: 200 com painel:false — a dependência está fora, como o cenário pede' };
  }

  if (dados.painel !== true) return { ok: false, motivo: `esperava painel:true, veio painel:${JSON.stringify(dados.painel)}` };
  if (!Array.isArray(dados.jobs) || dados.jobs.length === 0) return { ok: false, motivo: 'esperava jobs.length > 0, veio lista vazia' };
  return { ok: true, nota: `rota: 200 com painel:true e ${dados.jobs.length} job(s)` };
}

// ─── 2) O roteiro que roda DENTRO do container ──────────────────────────────

function montarRoteiro() {
  return `'use strict';
const fs = require('node:fs');
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const ESPERO = process.env.ESPERO;
const INSEGURO = process.env.INSEGURO === '1';
const VIEWPORT = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const TEXTO_SEM_PAINEL = 'não deu para ler os jobs';

let token = '';
try { token = fs.readFileSync('/w/token.txt', 'utf8').trim(); } catch { /* sem token: rota pública */ }

const problemas = [];
const feitos = [];
// Guarda ANTES do obturador (mesmo idioma dos smoke-celular-*): estado reprovado não vira PNG.
const exigir = (cond, msg) => {
  (cond ? feitos : problemas).push(msg);
  if (!cond) throw new Error('guarda reprovou antes do obturador: ' + msg);
};

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'].concat(INSEGURO ? ['--ignore-certificate-errors'] : []),
  });
  try {
    const pagina = await navegador.newPage();
    await pagina.setViewport(VIEWPORT);
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    // ANTES do goto: evaluateOnNewDocument só alcança documentos que ainda vão nascer. O
    // token entra pelo localStorage e não pela URL — assim ele não fica na barra de endereço
    // do print (public/app.js:91-106).
    if (token) {
      await pagina.evaluateOnNewDocument((t) => {
        try { localStorage.setItem('cockpit-token', t); } catch { /* modo privado */ }
      }, token);
    }

    const erros = [];
    pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
    pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });

    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    // A faixa/lista de jobs bate a cada 15 s, mas a primeira leitura é na abertura; 3 s dão
    // folga para ela chegar sem esticar a parada de produção.
    await new Promise((r) => setTimeout(r, 3000));

    const estado = await pagina.evaluate((alvo) => {
      const corpo = document.body.innerText || '';
      const grupo = document.getElementById('grupo-jobs');
      return {
        temGrupo: Boolean(grupo),
        linhasJob: grupo ? grupo.querySelectorAll('.conversa-linha, .job-linha').length : 0,
        temMensagem: corpo.includes(alvo),
      };
    }, TEXTO_SEM_PAINEL);

    if (ESPERO === 'desacoplado') {
      // 🔴 A mensagem, não um grupo vazio: grupo vazio quer dizer que o cenário não foi
      // montado (spec §10.2 / A15).
      exigir(estado.temMensagem, 'a tela mostra "' + TEXTO_SEM_PAINEL + '"');
    } else {
      exigir(estado.temGrupo, '#grupo-jobs existe na tela');
      exigir(estado.linhasJob > 0, 'o grupo tem linha de job (' + estado.linhasJob + ')');
      exigir(!estado.temMensagem, 'a tela NÃO mostra "' + TEXTO_SEM_PAINEL + '"');
    }
    // Erro de console não reprova o print — a Fase 0 fotografa justamente uma dependência
    // fora do ar, e o cliente registra isso no console de propósito. Fica anotado.
    if (erros.length) feitos.push('console (anotado, não reprova): ' + erros.slice(0, 3).join(' | '));

    // O grupo dentro da vista quando ele existe: o print tem de conter o que mudou.
    if (estado.temGrupo) {
      await pagina.evaluate(() => document.getElementById('grupo-jobs').scrollIntoView({ block: 'start' }));
      await new Promise((r) => setTimeout(r, 400));
    }
    await pagina.screenshot({ path: '/out/print.png' });
    feitos.push('PNG gravado');
  } finally {
    await navegador.close();
  }
})().then(() => {
  console.log('@@PRINT-JOBS@@' + JSON.stringify({ feitos, problemas }));
}).catch((e) => {
  console.error('ROTEIRO QUEBROU:', e.message);
  console.log('@@PRINT-JOBS@@' + JSON.stringify({ feitos, problemas: problemas.concat(['roteiro estourou: ' + e.message]) }));
  process.exitCode = 1;
});
`;
}

// ─── 3) Corrida ─────────────────────────────────────────────────────────────

function rodarContainer(scratch, outDir) {
  return new Promise((resolve) => {
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=${base}`,
      '-e', `ESPERO=${o.espero}`,
      '-e', `INSEGURO=${o.inseguro ? '1' : '0'}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${outDir}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let bruto = '';
    docker.stdout.on('data', (d) => { bruto += d; });
    docker.stderr.on('data', (d) => { bruto += d; });
    docker.on('close', (codigo) => {
      const MARCADOR = '@@PRINT-JOBS@@';
      const abre = bruto.indexOf(MARCADOR);
      let relatorio = null;
      if (abre >= 0) {
        try { relatorio = JSON.parse(bruto.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
      }
      // O que não é o marcador vai para a tela: é onde o erro do puppeteer aparece.
      process.stdout.write(abre >= 0 ? bruto.slice(0, abre) : bruto);
      resolve(relatorio || { feitos: [], problemas: [`o roteiro não devolveu JSON (código ${codigo})`] });
    });
  });
}

let scratch = null;
let outDir = null;
try {
  execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
} catch {
  console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
  process.exit(2);
}

const conferencia = await conferirRota();
if (!conferencia.ok) {
  // 🔴 Nenhum PNG: o cenário não foi montado, e uma foto daqui mentiria sobre o motivo.
  console.error(`🔴 cenário não montado — ${conferencia.motivo}`);
  process.exit(2);
}
console.log(`  · ${conferencia.nota}`);

try {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-jobs-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-jobs-out-'));
  fs.writeFileSync(path.join(scratch, 'pane.js'), montarRoteiro(), { mode: 0o600 });
  if (token) fs.writeFileSync(path.join(scratch, 'token.txt'), token, { mode: 0o600 });
  // O container roda como outro usuário: /out precisa ser gravável por ele.
  fs.chmodSync(outDir, 0o777);

  const relatorio = await rodarContainer(scratch, outDir);
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
