#!/usr/bin/env node
'use strict';
// PROVA DE TELA — o medidor de contexto no painel de um JOB (card `contexto-da-sessao-do-job`,
// spec `2026-09-22-contexto-da-sessao-do-job-design.md`, Fase 4 do plano).
//
// 390×844 (regra de 25/08: provar no aparelho que motivou a mudança). Molde:
// `testes/smoke-celular-job-passos.js` — dois `server.js` na mesma fixture, o do `develop` (via
// `git archive`) para o ANTES e o desta worktree para o DEPOIS, nas portas 7891/7892.
//
// ── As DUAS alavancas de ambiente, e por que cada uma existe ──────────────────────────────
//
//   COCKPIT_JOBS_DIR — obrigatória e EXPLÍCITA. `dirJobs()` é
//   `process.env.COCKPIT_JOBS_DIR || <HOME>/.cockpit/jobs` (lib/limite.js:129), e
//   `~/.cockpit/jobs` NÃO EXISTE nesta máquina: a produção aponta por variável (o
//   `30-caminhos.conf` do systemd manda para a pasta de jobs do orquestrador). Com HOME falso e sem esta var,
//   a lista vem VAZIA, não há painel de job para abrir, e o DEPOIS não existe.
//
//   HOME/.claude/settings.json com `"model": "claude-opus-5[1m]"` — sem ele
//   `janelaLongaConfigurada()` (lib/contexto.js) devolve `false`, o teto cai para 200k e o PNG
//   sairia mostrando 195% em vez de 39%. O print documentaria exatamente o defeito de teto que
//   o R4 da spec existe para evitar. Achado do painel de avaliadores, rodada 1 do plano.
//
// ── A fixture, e por que ela prova o que precisa ──────────────────────────────────────────
//
// `testes/fixtures/job-claude-com-usage.log` (VERSIONADA — nunca um `claude.log` de
// `<pasta-de-jobs>/<id>/`, que morre no teardown da worktree):
//
//   principal (claude-opus-5)  390.505 tokens   ← é ESTE que tem de aparecer
//   subagente (claude-sonnet-5) 450.000 tokens   ← e ele vem DEPOIS, e é MAIOR
//
// Os números são os medidos de verdade em 22/09. O subagente ser o último E o maior é de
// propósito: um medidor que pegasse o último evento sem separar mostraria 450k/45%, e o PNG
// denunciaria na hora. O print prova as duas coisas de uma vez — o medidor aparece, E mostra
// a sessão principal.
//
// Uso: SAIDA=<pasta NOVA, sem PNG dentro> node testes/print-contexto-job.js
//
// Saída: 0 = os dois lados passaram · 1 = falha de produto/assert · 2 = erro de USO ou de
// AMBIENTE (falta SAIDA, pasta já tem PNG, porta ocupada, imagem docker ausente).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs vão cair>');
  process.exit(2);
}
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const RAIZ = path.join(__dirname, '..');

// Nunca 7899 (jobs, #24) nem 7879 (produção).
const PORTA_ANTES = 7891;
const PORTA_DEPOIS = 7892;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function portaOcupada(porta) {
  const saida = execSync('ss -ltn 2>/dev/null || true', { encoding: 'utf8' });
  return saida.split('\n').some((l) => l.includes(`:${porta} `) || l.includes(`:${porta}\t`));
}

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

/** Um job `running` no disco, com o `claude.log` = a fixture versionada. */
function montarJobNoDisco(pastaJobs) {
  const agora = Date.now();
  const dir = path.join(pastaJobs, 'job-com-contexto');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id: 'job-com-contexto', type: 'ataca', project: 'cockpit-agentes',
    title: 'contexto da sessao do job', created_at: new Date(agora - 12 * 60000).toISOString(),
    worktree: '', branch: '', origin: 'capitao', merged_at: null, approved_at: null,
    status: 'running', pid: process.pid, tmux_session: null,
  }));
  fs.writeFileSync(path.join(dir, 'status.log'), `${new Date(agora - 60000).toISOString()} working: rodando\n`);
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'job-claude-com-usage.log'), path.join(dir, 'claude.log'));
}

// ─── O roteiro que roda DENTRO do container ─────────────────────────────────────────────────

function roteiro() {
  return `
// Caminho ABSOLUTO: o roteiro é montado em /w (volume read-only) e de lá o require relativo
// não acha o node_modules do container. Mesma linha de smoke-celular-job-passos.js:209.
const puppeteer = require('/app/node_modules/puppeteer-core');
const BASE = process.env.BASE;
const MODO = process.env.MODO;

const problemas = [];
const feitos = [];
const ok = (cond, msg) => { (cond ? feitos : problemas).push(msg); return cond; };

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const pagina = await navegador.newPage();
    await pagina.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

    const erros = [];
    pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
    pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });

    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });

    // A vista de agentes só existe no DEPOIS? Não — as duas árvores já a têm (a D51 é de
    // antes deste card). O try é para a develop que porventura não tenha a barra.
    try {
      await pagina.waitForSelector('#barra-agentes:not([hidden])', { timeout: 8000 });
      await pagina.click('#barra-agentes');
    } catch { /* já está na vista certa */ }
    await pagina.waitForSelector('#grupo-jobs', { timeout: 15000 });
    await espera(600);

    const clicou = await pagina.evaluate(() => {
      const linha = document.querySelector('#grupo-jobs .conversa-linha[data-estado="trabalhando"]');
      const botao = linha && linha.querySelector('.conversa');
      if (!botao) return false;
      botao.click();
      return true;
    });
    if (!ok(clicou, MODO + ': o job running é clicável')) throw new Error('não achei o job running na lista');

    await pagina.waitForSelector('.painel[data-tipo="job"]', { timeout: 15000 });
    // Folga generosa: no DEPOIS o medidor só aparece quando o evento \`contexto\` chega pelo
    // SSE, e ele sai depois do \`sincronizado\` (server.js, passo 4 da Fase 2 do plano).
    await espera(2500);

    const medidor = await pagina.evaluate(() => {
      const painel = document.querySelector('.painel[data-tipo="job"]');
      const el = painel && painel.querySelector('.medidor');
      if (!el) return { existe: false };
      return {
        existe: true,
        visivel: !el.hidden,
        pct: (painel.querySelector('.medidor-pct') || {}).textContent || '',
        titulo: el.getAttribute('title') || '',
      };
    });

    ok(medidor.existe, MODO + ': o elemento .medidor está no DOM do painel de job');
    if (MODO === 'antes') {
      ok(!medidor.visivel, 'antes: o medidor está ESCONDIDO — é a tela que o job sempre teve (pct=' + JSON.stringify(medidor.pct) + ')');
    } else {
      ok(medidor.visivel, 'depois: o medidor está VISÍVEL');
      // A prova que importa: o número é o do PRINCIPAL (390.505 de 1M ⇒ 39%), não o do
      // subagente (450.000), que na fixture vem DEPOIS e é MAIOR.
      ok(/^39%$/.test(medidor.pct.trim()), 'depois: a porcentagem é 39% — o PRINCIPAL (390.505/1M), não o subagente de 450.000 (veio ' + JSON.stringify(medidor.pct) + ')');
      ok(medidor.titulo.includes('390.505') || medidor.titulo.includes('390,505'),
        'depois: o title traz os 390.505 tokens do principal (veio ' + JSON.stringify(medidor.titulo) + ')');
      ok(!medidor.titulo.includes('450'), 'depois: e NÃO traz o 450.000 do subagente');
    }

    ok(erros.length === 0, MODO + ': sem erro de console (' + (erros.slice(0, 3).join(' | ') || 'nenhum') + ')');
    await pagina.screenshot({ path: '/out/' + MODO + '-job-medidor.png' });

    console.log('@@MEDIDAS-CONTEXTO-JOB@@' + JSON.stringify({ feitos, problemas, medidor }));
  } finally {
    await navegador.close();
  }
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e.message);
  console.log('@@MEDIDAS-CONTEXTO-JOB@@' + JSON.stringify({ feitos: [], problemas: ['roteiro estourou: ' + e.message] }));
  process.exitCode = 1;
});

function espera(ms) { return new Promise((r) => setTimeout(r, ms)); }
`;
}

function rodarModo({ modo, base, scratch }) {
  return new Promise((resolve) => {
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=${base}`,
      '-e', `MODO=${modo}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/roteiro.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    docker.on('close', (codigo) => {
      console.log(saidaDocker);
      const MARCADOR = '@@MEDIDAS-CONTEXTO-JOB@@';
      const abre = saidaDocker.indexOf(MARCADOR);
      let relatorio = null;
      if (abre >= 0) {
        try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
      }
      resolve(relatorio || { feitos: [], problemas: [`o roteiro (${modo}) não devolveu JSON (código ${codigo})`] });
    });
  });
}

// ─── Corrida ────────────────────────────────────────────────────────────────────────────────

(async () => {
  let antesDir = null;
  let scratch = null;
  let pastaJobs = null;
  let servidorAntes = null;
  let servidorDepois = null;

  const limpar = () => {
    for (const s of [servidorAntes, servidorDepois]) {
      if (s && s.exitCode === null) { try { process.kill(s.pid); } catch { /* já morreu */ } }
    }
    for (const d of [antesDir, scratch, pastaJobs]) {
      if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* some depois */ } }
    }
  };

  try {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
      return process.exit(2);
    }

    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Este script recusa sobrescrever.`);
      return process.exit(2);
    }
    for (const porta of [PORTA_ANTES, PORTA_DEPOIS]) {
      if (portaOcupada(porta)) {
        console.error(`🔴 a porta ${porta} já está em uso — aborta antes de subir qualquer coisa.`);
        return process.exit(2);
      }
    }

    // 1) a árvore do `develop` — o ANTES
    antesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-antes-ctx-job-'));
    const shaDevelop = execSync('git rev-parse develop', { cwd: RAIZ, encoding: 'utf8' }).trim();
    execSync(`git archive develop | tar -x -C ${antesDir}`, { cwd: RAIZ });
    console.log(`  · árvore do "antes" = develop@${shaDevelop}`);

    // 2) o HOME falso — com o `[1m]`, sem o qual o teto (e o PNG) mentem
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-ctx-job-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ model: 'claude-opus-5[1m]' }));
    fs.writeFileSync(path.join(scratch, 'roteiro.js'), roteiro());

    // 3) o job no disco
    pastaJobs = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-jobs-ctx-'));
    montarJobNoDisco(pastaJobs);

    // 4) os dois servidores, na MESMA fixture
    const ambienteBase = { ...process.env };
    delete ambienteBase.COCKPIT_TOKEN;
    Object.assign(ambienteBase, {
      HOST: '127.0.0.1',
      HOME: home,
      COCKPIT_CERT_DIR: '/dev/null',
      // Armadilhas #78/#62: a var VENCE o HOME falso, então ela é obrigatória de quem escreve.
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
      COCKPIT_BIN_CLAUDE: '/bin/true',
    });

    servidorAntes = spawn(process.execPath, [path.join(antesDir, 'server.js')], {
      cwd: antesDir,
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
      if (!pronto) {
        console.error(`🔴 o servidor ${nome} (${porta}) não subiu`);
        limpar();
        return process.exit(1);
      }
      console.log(`  · servidor ${nome} no ar em http://127.0.0.1:${porta} (pid ${s.pid})`);
    }

    // 5) os dois lados
    const relAntes = await rodarModo({ modo: 'antes', base: `http://127.0.0.1:${PORTA_ANTES}`, scratch });
    const relDepois = await rodarModo({ modo: 'depois', base: `http://127.0.0.1:${PORTA_DEPOIS}`, scratch });

    const feitos = [...relAntes.feitos, ...relDepois.feitos];
    const problemas = [...relAntes.problemas, ...relDepois.problemas];
    console.log('\n── Resultado ──');
    for (const f of feitos) console.log('  ✅ ' + f);
    for (const p of problemas) console.log('  ❌ ' + p);
    console.log(`\nPNGs em ${SAIDA}`);
    if (problemas.length) {
      console.log('\n❌ PROVA DE TELA REPROVADA');
      limpar();
      return process.exit(1);
    }
    console.log('\n✅ PROVA DE TELA OK — medidor escondido no ANTES, visível e com o PRINCIPAL no DEPOIS');
    limpar();
    return process.exit(0);
  } catch (e) {
    console.error('🔴 estourou:', e.message);
    limpar();
    return process.exit(1);
  }
})();
