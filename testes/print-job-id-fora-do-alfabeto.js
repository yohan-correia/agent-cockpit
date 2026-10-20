#!/usr/bin/env node
// Prova de tela do card `job-com-underscore-ou-ponto-no-id`: o painel de um job cujo id tem `_`
// ou `.` abria com título "." e "não achei este job"; depois do conserto abre com o título e a
// conversa. Mesma fixture nos dois lados: a árvore do `develop` (git archive) é o ANTES, esta
// worktree é o DEPOIS — dois `server.js` como processos filhos, nas portas 7968/7969.
//
// Navegador no HOST (puppeteer-core + Chrome já instalados), sem docker e sem padrão: os dois
// caminhos vêm por ambiente e nunca entram em arquivo.
//
// Uso: SAIDA=<pasta NOVA, sem PNG dentro> PUPPETEER_CORE=<caminho> CHROME_BIN=<caminho> \
//        node testes/print-job-id-fora-do-alfabeto.js
//
// Saída: 0 = as exigências dos dois lados fecharam · 1 = falha de produto/assert ·
// 2 = erro de USO ou de AMBIENTE (falta variável, pasta com PNG, porta ocupada, sem navegador).
//
// PNG: ${SAIDA}/${lado}-${tema}-${job}.png — 2 lados x 2 temas x 2 jobs = 8 arquivos, 390x844 @3x.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA || '';
const PUPPETEER = process.env.PUPPETEER_CORE || '';
const CHROME = process.env.CHROME_BIN || '';
const RAIZ = path.join(__dirname, '..');

// Nunca 7899 (jobs, #24) nem 7879 (produção).
const PORTA_ANTES = 7968;
const PORTA_DEPOIS = 7969;

const ID_SUBLINHADO = '20261013-145932-projeto-a-ataca-dataset-com-campo_novo-a33f';
const ID_PONTO = '20261004-154220-projeto-b-ataca-painel-em-exemplo.app.br-c561';
const JOBS = [
  { nome: 'sublinhado', id: ID_SUBLINHADO, titulo: 'job com sublinhado', projeto: 'projeto-a' },
  { nome: 'ponto', id: ID_PONTO, titulo: 'job com ponto', projeto: 'projeto-b' },
];
const FALA = 'Lendo o plano antes de mexer em qualquer arquivo.';

if (!SAIDA) { console.error('🟡 SAIDA é obrigatória (pasta NOVA dos PNGs).'); process.exit(2); }
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

/** Os dois jobs `running` no disco, com o `claude.log` = a fixture versionada. */
function montarJobsNoDisco(pastaJobs) {
  const agora = Date.now();
  for (const j of JOBS) {
    const dir = path.join(pastaJobs, j.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      id: j.id, type: 'ataca', project: j.projeto,
      title: j.titulo, created_at: new Date(agora - 12 * 60000).toISOString(),
      worktree: '', branch: '', origin: 'capitao', merged_at: null, approved_at: null,
      status: 'running', pid: process.pid, tmux_session: null,
    }));
    fs.writeFileSync(path.join(dir, 'status.log'), `${new Date(agora - 60000).toISOString()} working: rodando\n`);
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'job-claude.log'), path.join(dir, 'claude.log'));
  }
}

/** Abre o painel do job num tema, lê o DOM, fotografa. Devolve as medidas. */
async function fotografar(navegador, { lado, base, tema, job }) {
  const pagina = await navegador.newPage();
  const erros = [];
  try {
    await pagina.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: tema }]);
    await pagina.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch { /* sem storage */ } });
    pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
    pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });

    await pagina.goto(base + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    try {
      await pagina.waitForSelector('#barra-agentes:not([hidden])', { timeout: 8000 });
      await pagina.click('#barra-agentes');
    } catch { /* já está na vista certa */ }
    await pagina.waitForSelector('#grupo-jobs', { timeout: 15000 });
    await espera(600);

    const clicou = await pagina.evaluate((titulo) => {
      const linhas = [...document.querySelectorAll('#grupo-jobs .conversa-linha')];
      const linha = linhas.find((l) => {
        const t = l.querySelector('.conversa-titulo');
        return t && t.textContent.includes(titulo);
      });
      const botao = linha && linha.querySelector('.conversa');
      if (!botao) return false;
      botao.click();
      return true;
    }, job.titulo);
    if (!clicou) throw new Error(`não achei a linha "${job.titulo}" na lista de jobs (${lado}/${tema})`);

    await pagina.waitForSelector('.painel[data-tipo="job"]', { timeout: 15000 });
    await espera(2500);

    const medidas = await pagina.evaluate((fala) => {
      const painel = document.querySelector('.painel[data-tipo="job"]');
      if (!painel) return { titulo: null, erro: false, fala: false };
      const t = painel.querySelector('.chat-titulo');
      const fita = painel.querySelector('.fita');
      return {
        titulo: t ? t.textContent.trim() : null,
        erro: [...painel.querySelectorAll('.bolha-erro')].some((b) => b.textContent.includes('não achei este job')),
        fala: Boolean(fita && fita.textContent.includes(fala)),
      };
    }, FALA);

    const arquivo = path.join(SAIDA, `${lado}-${tema}-${job.nome}.png`);
    await pagina.screenshot({ path: arquivo });
    return { ...medidas, erros, arquivo };
  } finally {
    await pagina.close().catch(() => {});
  }
}

(async () => {
  let antesDir = null;
  let scratch = null;
  let pastaJobs = null;
  let servidorAntes = null;
  let servidorDepois = null;
  let navegador = null;

  const limpar = () => {
    for (const s of [servidorAntes, servidorDepois]) {
      if (s && s.exitCode === null) { try { process.kill(s.pid); } catch { /* já morreu */ } }
    }
    for (const d of [antesDir, scratch, pastaJobs]) {
      if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* some depois */ } }
    }
  };

  try {
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
    antesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-antes-id-alfabeto-'));
    const shaDevelop = execSync('git rev-parse develop', { cwd: RAIZ, encoding: 'utf8' }).trim();
    execSync(`git archive develop | tar -x -C ${antesDir}`, { cwd: RAIZ });
    console.log(`  · árvore do "antes" = develop@${shaDevelop}`);

    // 2) o scratch: HOME falso e as pastas que o servidor escreveria
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-id-alfabeto-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

    // 3) os jobs no disco
    pastaJobs = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-jobs-id-alfabeto-'));
    montarJobsNoDisco(pastaJobs);

    // 4) os dois servidores, na MESMA fixture
    const ambienteBase = { ...process.env };
    delete ambienteBase.COCKPIT_TOKEN;
    Object.assign(ambienteBase, {
      HOST: '127.0.0.1',
      HOME: home,
      COCKPIT_CERT_DIR: '/dev/null',
      // Armadilhas #78/#62: a var VENCE o HOME falso, então ela é obrigatória de quem escreve.
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
      COCKPIT_MONITOR_MS: '0',
      COCKPIT_MONITOR_DIR: path.join(scratch, 'monitor'),
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
      COCKPIT_BIN_CLAUDE: '/bin/true',
      // Socket que não existe: `tmux -L` erra na hora; este script não sobe tmux nenhum.
      COCKPIT_TMUX_SOCKET: `cockpit-smoke-id-alfabeto-${process.pid}`,
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

    // 5) o navegador do host — não subir é AMBIENTE (exit 2), não falha de produto
    try {
      navegador = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    } catch (e) {
      console.error(`🟡 ambiente indisponível: o navegador não subiu (${e.message})`);
      limpar();
      return process.exit(2);
    }

    const feitos = [];
    const problemas = [];
    const exige = (cond, msg) => { (cond ? feitos : problemas).push(msg); };

    const lados = [['antes', PORTA_ANTES], ['depois', PORTA_DEPOIS]];
    for (const [lado, porta] of lados) {
      for (const tema of ['dark', 'light']) {
        for (const job of JOBS) {
          const r = await fotografar(navegador, { lado, base: `http://127.0.0.1:${porta}`, tema, job });
          const rot = `${lado}/${tema}/${job.nome}`;
          console.log(`  · ${rot}: título=${JSON.stringify(r.titulo)} erro=${r.erro} fala=${r.fala} -> ${r.arquivo}`);
          if (lado === 'antes') {
            exige(r.titulo === '.', `${rot}: o painel abre com o título "." (o bug) — veio ${JSON.stringify(r.titulo)}`);
            if (job.nome === 'sublinhado') exige(r.erro, `${rot}: e traz a bolha "não achei este job"`);
            else exige(!r.fala, `${rot}: e a conversa NÃO chega à fita`);
          } else {
            exige(r.titulo === job.titulo, `${rot}: o painel abre com o título do job — veio ${JSON.stringify(r.titulo)}`);
            exige(r.fala, `${rot}: e a fala do job está na fita`);
            exige(!r.erro, `${rot}: e nenhuma bolha "não achei este job"`);
            exige(r.erros.length === 0, `${rot}: sem erro de console (${r.erros.slice(0, 3).join(' | ') || 'nenhum'})`);
          }
        }
      }
    }

    console.log('\n── Resultado ──');
    for (const f of feitos) console.log('  ✅ ' + f);
    for (const p of problemas) console.log('  ❌ ' + p);
    console.log(`\nPNGs em ${SAIDA}`);
    await navegador.close().catch(() => {});
    navegador = null;
    if (problemas.length) {
      console.log('\n❌ PROVA DE TELA REPROVADA');
      limpar();
      return process.exit(1);
    }
    console.log('\n✅ PROVA DE TELA OK — "." e "não achei este job" no ANTES, título e conversa no DEPOIS');
    limpar();
    return process.exit(0);
  } catch (e) {
    console.error('🔴 estourou:', e.message);
    if (navegador) await navegador.close().catch(() => {});
    limpar();
    return process.exit(1);
  }
})();
