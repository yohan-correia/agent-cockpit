#!/usr/bin/env node
'use strict';
// PRINT DO CARD `codex-no-relatorio-de-tokens` — celular 390×844, ANTES/DEPOIS.
//
// Regra da casa (25/08): mudou tela, tem print, e o print tem que conter o que mudou. Tela
// vazia, tela de erro e tela sem o recurso NÃO são prova. Aqui há DUAS telas que mudam com
// este card, e por isso DOIS pares antes/depois no mesmo PNG:
//
//   (a) o diálogo "Para onde vão meus tokens" (#dialogo-uso) — ganha a seção `#uso-codex`
//       e troca a frase de `:485`;
//   (b) o painel "Consumo do plano" (#dialogo-plano) — ganha o bloco `[data-consumo=codex]`
//       quando não há aba de Codex viva (Fase 3).
//
//   ANTES=1 → o código de antes desta entrega: só o relatório do Claude, "Só do Claude" na
//             tela, e o painel do plano sem bloco de Codex nenhum (é a AUSÊNCIA que a Fase 3
//             apaga de propósito — sem esta foto o par não existiria mais depois dela).
//   ANTES=0 → esta branch: a seção do Codex desenhada, com tokens, e o painel do plano com o
//             "quanto resta" do Codex e o rótulo de origem.
//
// Molde: testes/smoke-navegador-uso.js (docker + puppeteer-core, --network host, sem tmux nem
// CLI real — não precisa). De testes/print-escrever-na-pergunta.js entram só três coisas: a
// guarda contra COCKPIT_TMUX_SOCKET herdado, o SAIDA/ANTES obrigatórios, e o viewport de
// celular ({width:390, height:844, isMobile:true, hasTouch:true, deviceScaleFactor:2}). O
// "molde exato" traria tmux + CLI real + AskUserQuestion (que este card não usa) e NÃO traria
// o HOME de mentira — o spawn de print-escrever-na-pergunta.js não define HOME.
//
// Isolamento (#48/#78): HOME de mkdtemp, COCKPIT_USO_DIR, COCKPIT_USO_CODEX_DIR,
// COCKPIT_CODEX_RAIZ, COCKPIT_JOBS_DIR e COCKPIT_LIDAS_DIR próprios — nunca ~/.claude,
// ~/.codex nem ~/.cockpit de produção. Porta 7893 (7894 é do smoke irmão; 7899 é dos jobs;
// 7879 é PRODUÇÃO — nunca). Idioma forçado em pt-BR no localStorage antes do app subir.
//
// Como rodar os dois lados:
//   SAIDA=~/.cockpit/smoke-shots/2026-09-22-codex-nos-tokens/antes  ANTES=1 node testes/print-codex-nos-tokens.js
//   SAIDA=~/.cockpit/smoke-shots/2026-09-22-codex-nos-tokens/depois ANTES=0 node testes/print-codex-nos-tokens.js
//
// Códigos de saída: 0 = verde · 1 = defeito · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta dos PNGs> (use ~/.cockpit/smoke-shots/..., nunca /tmp)');
  process.exit(2);
}
const ANTES = process.env.ANTES === '1';
const PORTA = 7893;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';

let falhas = 0;
let feitos = 0;
const ok = (c, t) => { feitos += 1; if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── a guarda contra COCKPIT_TMUX_SOCKET herdado (molde de print-escrever-na-pergunta.js) ──
const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}". Abortando.`);
  process.exit(1);
}

try {
  execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
} catch {
  console.error(`⚠️  a imagem docker ${IMAGEM} não existe.`);
  process.exit(2);
}

fs.mkdirSync(SAIDA, { recursive: true });
if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
  console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. O print recusa sobrescrever.`);
  process.exit(2);
}

let baseTmp = os.tmpdir();
if (baseTmp.startsWith('/home')) baseTmp = '/tmp';
const TMP = fs.mkdtempSync(path.join(baseTmp, 'print-codex-tokens-'));

// ─── o fixture do lado Claude — projeto "loja-exemplo", molde de gate-uso.js/smoke-navegador-uso.js ──
const HOME = path.join(TMP, 'home');
const cru = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const preProjeto = `${cru(path.join(HOME, 'projetos'))}-`;
const projetos = path.join(HOME, '.claude', 'projects');
fs.mkdirSync(projetos, { recursive: true });

const pastaLoja = path.join(projetos, `${preProjeto}loja-exemplo`);
fs.mkdirSync(pastaLoja, { recursive: true });
const hoje = new Date().toISOString().slice(0, 10);
const linhaClaude = ({ ts, input = 0, output = 0, cr = 0 }) => `${JSON.stringify({
  type: 'assistant',
  timestamp: ts,
  isSidechain: false,
  message: {
    model: 'claude-opus-5',
    usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: cr },
    content: [{ type: 'text', text: 'oi' }],
  },
})}\n`;
fs.writeFileSync(path.join(pastaLoja, 'a.jsonl'),
  linhaClaude({ ts: `${hoje}T09:00:00.000Z`, input: 1200, output: 800, cr: 4000 }));

// ─── isolamento — nunca a produção ──────────────────────────────────────────
const CERT_DIR = path.join(TMP, 'cert-vazio');
fs.mkdirSync(CERT_DIR, { recursive: true });
const USO_DIR = path.join(TMP, 'cache-uso');
const USO_CODEX_DIR = path.join(TMP, 'cache-uso-codex');
// As fixtures são GERADAS aqui, num tmp, com o `home` deste print — não se aponta para as
// commitadas em `testes/fixtures/rollout-codex/2026/`. Dois defeitos saíam de apontar
// (achados do painel de execução):
//
//  1. o `cwd` das commitadas tem o home de quem rodou o `gera.js` chumbado dentro, e este
//     print sobe o servidor com `HOME` de `mkdtemp` — `projetoDe()` não casava nada e a
//     seção do Codex saía inteira como `(fora de projeto)`. O número ficava certo e o
//     RÓTULO mentia, com o gate verde: ele cobrava "um número ≠ zero", não o eixo;
//  2. as commitadas têm data de quando foram geradas. O relatório "Hoje" e a janela de
//     limite VENCEM — o comando documentado deixaria de reproduzir o print dias depois.
//
// Gerando na hora, o `home` e as datas nascem deste processo. Na Fase 0 (`ANTES=1`) a
// geração é PULADA de propósito: sem rollout nenhum, o lado Codex fica vazio — que é
// exatamente o "antes" (`varrerRollouts()` degrada para lista vazia num diretório ausente).
const CODEX_RAIZ = path.join(TMP, 'rollouts-codex');
if (!ANTES) {
  const { gerar } = require('./fixtures/rollout-codex/gera');
  gerar(CODEX_RAIZ, { home: HOME });
}
const JOBS_DIR = path.join(TMP, 'sem-jobs'); // nunca criada: painel de jobs desligado
const LIDAS_DIR = path.join(TMP, 'lidas');
fs.mkdirSync(LIDAS_DIR, { recursive: true });

async function subirServidor() {
  const ambiente = { ...process.env };
  delete ambiente.COCKPIT_TOKEN;
  delete ambiente.COCKPIT_TMUX_SOCKET;
  Object.assign(ambiente, {
    HOST: '127.0.0.1',
    PORT: String(PORTA),
    HOME,
    COCKPIT_CERT_DIR: CERT_DIR,
    COCKPIT_USO_DIR: USO_DIR,
    COCKPIT_USO_CODEX_DIR: USO_CODEX_DIR,
    COCKPIT_CODEX_RAIZ: CODEX_RAIZ,
    COCKPIT_JOBS_DIR: JOBS_DIR,
    COCKPIT_LIDAS_DIR: LIDAS_DIR,
    COCKPIT_VIGIA_MS: '0',
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
    throw new Error(`o servidor na ${PORTA} não respondeu /health em 12 s\n${erros.split('\n').slice(-30).join('\n')}`);
  }
  return { processo, matar };
}

// ─── o roteiro do navegador — roda DENTRO do container ───────────────────
function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');
const BASE = process.env.BASE;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const problemas = [];
  const medidas = {};
  const erros = [];
  const requisicoes = [];
  const pagina = await navegador.newPage();
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
  pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
  pagina.on('response', (r) => { if (r.status() >= 400) requisicoes.push(r.status() + ' ' + r.url()); });

  try {
    // Viewport de celular — o único trecho copiado ao pé da letra de print-escrever-na-pergunta.js.
    await pagina.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await pagina.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Idioma forçado em pt-BR: sem isto o Chromium cai em en-US (navigator.language).
    await pagina.evaluate(() => localStorage.setItem('cockpit-idioma', 'pt-BR'));
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await espera(500);

    // ── (a) "Para onde vão meus tokens" ──
    await pagina.click('#btn-config');
    await pagina.waitForSelector('#dialogo-config[open]', { timeout: 5000 });
    await pagina.click('#btn-uso');
    await pagina.waitForSelector('#dialogo-uso[open]', { timeout: 5000 });
    await pagina.waitForSelector('#uso-lista .uso-item', { timeout: 15000 });
    await espera(600); // o fetch paralelo do Codex (quando existir) precisa de tempo para desenhar
    medidas.avisoUso = await pagina.evaluate(() => (document.querySelector('#dialogo-uso small') || {}).textContent || '');
    medidas.temSecaoCodex = await pagina.evaluate(() => Boolean(document.getElementById('uso-codex')));
    medidas.textoSecaoCodex = await pagina.evaluate(() => (document.getElementById('uso-codex') || {}).textContent || '');
    await pagina.evaluate(() => { const el = document.getElementById('app-uso'); if (el) el.scrollTop = 0; });
    await pagina.screenshot({ path: '/out/01-relatorio-uso.png' });
    await pagina.click('#btn-fechar-uso');
    await espera(300);

    // ── (b) "Consumo do plano" ──
    await pagina.click('#btn-plano');
    await pagina.waitForSelector('#dialogo-plano[open]', { timeout: 5000 });
    await espera(1500); // carregarLimite(false) é assíncrono, e no cenário 'depois' varre o disco
    medidas.temBlocoCodexPlano = await pagina.evaluate(() => Boolean(document.querySelector('[data-consumo="codex"]')));
    medidas.textoPlanoLista = await pagina.evaluate(() => (document.getElementById('uso-plano-lista') || {}).textContent || '');
    await pagina.screenshot({ path: '/out/02-consumo-do-plano.png' });

    if (erros.length) problemas.push(erros.length + ' erro(s) de console: ' + erros.slice(0, 3).join(' | '));
    if (requisicoes.length) problemas.push(requisicoes.length + ' requisição(ões) >=400: ' + requisicoes.slice(0, 3).join(' | '));
  } catch (e) {
    problemas.push('o roteiro estourou — ' + String(e && e.message).slice(0, 300));
  } finally {
    await pagina.close().catch(() => {});
    await navegador.close();
  }
  console.log('@@MEDIDAS-CODEX-TOKENS@@' + JSON.stringify({ problemas, medidas }));
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
  try {
    try {
      servidor = await subirServidor();
    } catch (e) {
      console.error(`🟡 ambiente: ${e.message}`);
      return process.exit(2);
    }
    console.log(`  · servidor no ar em http://127.0.0.1:${PORTA} (pid ${servidor.processo.pid})`);
    console.log(`  · HOME de mentira: ${HOME}`);
    console.log(`  · COCKPIT_CODEX_RAIZ: ${CODEX_RAIZ}${fs.existsSync(CODEX_RAIZ) ? '' : ' (ainda não existe — Fase 1 a cria)'}`);

    fs.writeFileSync(path.join(TMP, 'roteiro.js'), montarRoteiro());
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-v', `${TMP}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/roteiro.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigo = await new Promise((r) => docker.on('close', r));
    console.log(saidaDocker);

    const MARCADOR = '@@MEDIDAS-CODEX-TOKENS@@';
    let relatorio = null;
    const abre = saidaDocker.indexOf(MARCADOR);
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }
    const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigo})`];
    const medidas = relatorio ? relatorio.medidas : {};
    console.log(`  · medidas: ${JSON.stringify(medidas)}`);

    ok(problemas.length === 0, problemas.length ? `o percurso reprovou: ${problemas.join(' · ')}` : 'CSS, console, requisições e os passos passaram');

    if (problemas.length === 0) {
      if (ANTES) {
        // ── o "antes": o código de hoje (2924d86), sem nada deste card ──
        ok(/Só do Claude/.test(medidas.avisoUso || ''),
          `ANTES: o aviso da tela ainda diz "Só do Claude…" (veio "${medidas.avisoUso}")`);
        ok(medidas.temSecaoCodex === false,
          'ANTES: a seção #uso-codex ainda não existe');
        ok(medidas.temBlocoCodexPlano === false,
          'ANTES: o painel "Consumo do plano" não tem bloco nenhum do Codex — é a ausência que a Fase 3 apaga');
      } else {
        // ── o "depois": esta branch, com as fixtures do Codex no disco ──
        ok(!/Só do Claude/.test(medidas.avisoUso || ''),
          `DEPOIS: a frase antiga "Só do Claude" não sobrevive na tela (veio "${medidas.avisoUso}")`);
        ok(/Claude e Codex aparecem separados/.test(medidas.avisoUso || ''),
          `DEPOIS: a nota nova explica a separação (veio "${medidas.avisoUso}")`);
        ok(medidas.temSecaoCodex === true,
          'DEPOIS: a seção #uso-codex existe');
        ok(/\d/.test(medidas.textoSecaoCodex || ''),
          `DEPOIS: a seção do Codex mostra algum número (veio "${(medidas.textoSecaoCodex || '').slice(0, 200)}")`);
        ok(medidas.temBlocoCodexPlano === true,
          'DEPOIS: o painel "Consumo do plano" tem o bloco do Codex — o "quanto resta" sem aba aberta');
      }
    }

    for (const nome of ['01-relatorio-uso', '02-consumo-do-plano']) {
      const arquivo = path.join(SAIDA, `${nome}.png`);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }

    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('\n🔴 o print estourou:', e && e.message);
    saida = 1;
  } finally {
    if (servidor) await servidor.matar();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`\n${falhas || saida ? '❌ PRINT VERMELHO' : '✅ PRINT VERDE'}`
      + ` (ANTES=${ANTES ? 1 : 0}) — ${feitos - falhas}/${feitos} · PNGs em ${SAIDA}\n`);
  }
  process.exit(saida);
})();
