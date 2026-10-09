#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — celular, o PAINEL de um job (card `ver-a-conversa-do-job`, Opção A,
// plano `2026-09-12-ver-a-conversa-do-job-plano.md`, Fase 5).
//
// Prova de tela em 390×844 (regra de 25/08: provar no aparelho que motivou a mudança). Molde:
// `testes/smoke-celular-jobs.js` — ele já sobe DOIS `server.js` (o do `develop`, via
// `git archive`, para o "antes"; o desta worktree para o "depois"), escolhe portas na faixa
// 7891-7894 (nunca 7899 — jobs, #24 — nem 7879 — produção), fabrica o HOME e derruba tudo no
// `finally`.
//
// Diferença: UMA alavanca só monta os dois lados — `COCKPIT_JOBS_DIR`, porque a lista e o log
// de um job saem do mesmo disco desde a absorção (§0 do plano). Não há mock HTTP nenhum.
//
// Uso: SAIDA=<pasta NOVA, sem PNG dentro> node testes/smoke-celular-job-passos.js
//
// Códigos de saída: 0 = os dois modos passaram · 1 = falha de produto/assert · 2 = erro de
// USO ou de AMBIENTE (falta SAIDA, pasta já tem PNG, porta ocupada, imagem docker ausente,
// `git archive` falhou, servidor não subiu).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execSync, spawn } = require('node:child_process');

// ─── Contrato de uso — validado ANTES de tocar em qualquer coisa ─────────────

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs vão cair>');
  process.exit(2);
}
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const RAIZ = path.join(__dirname, '..');

// Nunca 7899 (jobs, #24) nem 7879 (produção) — a faixa inteira fica fora dos dois.
const PORTA_ANTES = 7891;
const PORTA_DEPOIS = 7892;
const PORTA_FOLGA = 7894;

// ─── Fail-closed do socket, mesmo padrão dos outros smokes de celular ────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-job-passos-${process.pid}`;
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

// ─── A aba (a não-regressão precisa de uma conversa DE VERDADE) ─────────────
//
// `project: 'painelalvo'` casa com o `project` do job "running" (abaixo) — no "antes" isso
// faz o job virar clicável via `vivas` e abrir esta MESMA aba (a conversa ERRADA: §1.1 da
// spec, "hoje o clique no job ou mostra a conversa de outra pessoa"). No "depois" o `project`
// não importa mais para clicabilidade nenhuma — é só coincidência de nome mantida para o
// "antes" continuar contando a história certa.

const CWD_ALVO = '/home/smoke/projetos/painelalvo';
const SESSID_ALVO = 'sess-painelalvo';

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
    kind: 'interactive', sessionId: sessaoId, cwd, status, updatedAt: Date.now(),
    pid, procStart: starttime, tmux: `${SESSAO}:${janela}.${pane}`,
  }));
}

function caminhoDoJsonl(home, cwd, sessaoId) {
  const pasta = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', pasta, `${sessaoId}.jsonl`);
}

const linhaHumano = (iso, texto) => `${JSON.stringify({ type: 'user', timestamp: iso, message: { content: texto } })}\n`;
const linhaAssistenteTexto = (iso, texto) => `${JSON.stringify({
  type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: texto }] },
})}\n`;
const linhaAssistenteFerramenta = (iso, id, nome, entrada) => `${JSON.stringify({
  type: 'assistant', timestamp: iso, message: { content: [{ type: 'tool_use', id, name: nome, input: entrada }] },
})}\n`;
const linhaResultado = (iso, id, saida) => `${JSON.stringify({
  type: 'user', timestamp: iso, message: { content: [{ type: 'tool_result', tool_use_id: id, content: saida }] },
})}\n`;

/**
 * Uma conversa de VERDADE, com fala → ferramenta → fala — é o que prova (`depois-aba-normal`)
 * que a fita de uma ABA continua recolhendo a fala de raciocínio como sempre fez (§1.3 da
 * spec, G-J8 do gate-ui). Sem esta forma, o smoke provaria só que a página abre.
 */
function escreverConversaComFerramenta(caminho, baseMs) {
  let quando = baseMs - 4 * 60000;
  const linhas = [];
  linhas.push(linhaHumano(new Date(quando).toISOString(), 'confere se o arquivo de config está certo')); quando += 30000;
  linhas.push(linhaAssistenteTexto(new Date(quando).toISOString(), 'vou olhar o arquivo primeiro')); quando += 5000;
  linhas.push(linhaAssistenteFerramenta(new Date(quando).toISOString(), 'toolu_smoke_1', 'Read', { file_path: '/tmp/config.json' })); quando += 5000;
  linhas.push(linhaResultado(new Date(quando).toISOString(), 'toolu_smoke_1', '{ "ok": true }')); quando += 30000;
  linhas.push(linhaAssistenteTexto(new Date(quando).toISOString(), 'confirmado: o arquivo está certo.')); quando += 60000;
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, linhas.join(''));
  return quando;
}

// ─── Os três jobs, no disco — a única fonte, desde a absorção do painel ─────
//
// `job-conversa` tem o `claude.log` = a fixture SINTÉTICA da Fase 1 (`testes/fixtures/
// job-claude.log`): principal + rajada de subagente (`executor-plano`, `avalia-plano`). É o
// arquivo que faz `depois-job-aberto.png` mostrar as FALAS de verdade e a marca de subagente.

function escreverJobNoDisco(pastaJobs, id, { type, project, title, criadoEm, statusMeta, linhaStatus, log }) {
  const dir = path.join(pastaJobs, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id, type, project, title, created_at: new Date(criadoEm).toISOString(),
    worktree: '', branch: '', origin: 'capitao', merged_at: null, approved_at: null,
    status: statusMeta, pid: process.pid, tmux_session: null,
  }));
  fs.writeFileSync(path.join(dir, 'status.log'), `${linhaStatus}\n`);
  if (log) fs.writeFileSync(path.join(dir, 'claude.log'), log);
}

function montarJobsNoDisco(pastaJobs) {
  const agora = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'job-claude.log'), 'utf8');
  escreverJobNoDisco(pastaJobs, 'job-conversa', {
    type: 'ataca', project: 'painelalvo', title: 'ver a conversa do job',
    criadoEm: agora - 6 * 60000, statusMeta: 'running',
    linhaStatus: `${iso(agora - 60000)} working: rodando`, log: fixture,
  });
  escreverJobNoDisco(pastaJobs, 'job-pronto', {
    type: 'ship', project: 'semaba', title: 'entrega concluída',
    criadoEm: agora - 6 * 3600000, statusMeta: 'done',
    linhaStatus: `${iso(agora - 5 * 3600000)} done: concluído`,
  });
  escreverJobNoDisco(pastaJobs, 'job-bloqueado', {
    type: 'ataca', project: 'semaba', title: 'precisa de decisão',
    criadoEm: agora - 4 * 3600000, statusMeta: 'blocked',
    linhaStatus: `${iso(agora - 2 * 3600000)} blocked: teardown recusado: worktree com alteração pendente`,
  });
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

// ─── O roteiro do navegador — roda DENTRO do container, uma vez por MODO×VIEWPORT ───────────

function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const MODO = process.env.MODO;             // 'antes' | 'depois'
const LARGO = process.env.LARGO === '1';   // desktop 1600×1000, senão celular 390×844
const VIEWPORT = LARGO
  ? { width: 1600, height: 1000, isMobile: false, hasTouch: false, deviceScaleFactor: 1 }
  : { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PREFIXO = LARGO ? 'desktop-' : '';

const problemas = [];
const feitos = [];
const ok = (cond, msg) => { (cond ? feitos : problemas).push(msg); return cond; };
const exigir = (cond, msg) => { if (!ok(cond, msg)) throw new Error('guarda reprovou antes do obturador: ' + msg); };

// Só no MODO=depois: o MODO=antes roda contra a develop, que nunca teve barra nem vista —
// #grupo-jobs já vivia direto em #abas, sem clique nenhum. O :not([hidden]) é obrigatório
// na PRIMEIRA entrada: a barra só deixa de ser hidden quando a leitura de api/jobs chega, e
// aqui não há setTimeout de folga antes da espera por #grupo-jobs. Clique em nó hidden é
// corrida com a rede.
const verAgentes = async (p) => {
  await p.waitForSelector('#barra-agentes:not([hidden])');
  await p.click('#barra-agentes');
  await p.waitForSelector('#grupo-jobs');
};
const verConversas = async (p) => {
  await p.click('#barra-agentes');
  await p.waitForSelector('#lista-conversas');
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

    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    if (MODO === 'depois') await verAgentes(pagina);
    await pagina.waitForSelector('#grupo-jobs', { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 600));

    if (MODO === 'antes') {
      await pagina.screenshot({ path: '/out/' + PREFIXO + 'antes-lista.png' });
      // O defeito de hoje: o job "job-conversa" tem \`project: 'painelalvo'\`, que casa com a
      // aba viva — clicável, mas abre a conversa DA ABA, não o log do job (§1.1 da spec).
      const clicou = await pagina.evaluate(() => {
        const linha = Array.from(document.querySelectorAll('#grupo-jobs .conversa-linha'))
          .find((l) => l.textContent.includes('ver a conversa do job'));
        const botao = linha && linha.querySelector('.conversa');
        if (!botao || botao.tagName !== 'BUTTON') return false;
        botao.click();
        return true;
      });
      ok(clicou, 'antes: o job "job-conversa" É clicável (casa com a aba viva)');
      await new Promise((r) => setTimeout(r, 800));
      const depoisDoClique = await pagina.evaluate(() => ({
        vista: document.getElementById('app').dataset.vista,
        titulo: (document.querySelector('.chat-titulo') || {}).textContent || '',
        temEnvio: Boolean(document.querySelector('.painel .envio')) && !document.querySelector('.painel .envio').hidden,
      }));
      ok(depoisDoClique.vista === 'chat', 'antes: o clique abriu uma conversa (vista=chat)');
      // A prova do defeito: o título NÃO é o do job — é o da conversa da aba, ou o painel
      // continua com a caixa de escrita (uma aba de verdade, não um job).
      ok(depoisDoClique.temEnvio, 'antes: e a conversa aberta TEM caixa de escrita — não é o job, é a aba (a confusão que a entrega resolve)');
      exigir(erros.length === 0, 'antes: sem erro de console (' + (erros.slice(0, 3).join(' | ') || 'nenhum') + ')');
      await pagina.screenshot({ path: '/out/' + PREFIXO + 'antes-clique.png' });
    } else {
      await pagina.screenshot({ path: '/out/' + PREFIXO + 'depois-lista.png' });

      // depois-job-aberto: clica no job "running" — tem de abrir o PRÓPRIO log, com as
      // falas e a marca de subagente, SEM caixa de escrita.
      const clicouJob = await pagina.evaluate(() => {
        const linha = document.querySelector('#grupo-jobs .conversa-linha[data-estado="trabalhando"]');
        const botao = linha && linha.querySelector('.conversa');
        if (!botao) return false;
        botao.click();
        return true;
      });
      exigir(clicouJob, 'depois: o job "running" é clicável');
      await pagina.waitForSelector('.painel[data-tipo="job"]', { timeout: 15000 });
      await new Promise((r) => setTimeout(r, 900));
      const abertoJob = await pagina.evaluate(() => {
        const painel = document.querySelector('.painel[data-tipo="job"]');
        const fita = painel && painel.querySelector('.fita');
        return {
          tipo: painel && painel.dataset.tipo,
          falas: fita ? fita.querySelectorAll('.fala').length : 0,
          ferramentas: fita ? fita.querySelectorAll('.ferramenta, .grupo-ferramentas').length : 0,
          temMarca: fita ? fita.textContent.includes('executor-plano') : false,
          envioHidden: painel ? painel.querySelector('.envio').hidden : null,
          matarHidden: painel ? painel.querySelector('.btn-matar-aba').hidden : null,
        };
      });
      exigir(abertoJob.tipo === 'job', 'depois: o painel aberto é tipo "job"');
      exigir(abertoJob.falas > 0, 'depois: a fita do job tem FALAS de verdade (' + abertoJob.falas + ')');
      ok(abertoJob.ferramentas > 0, 'depois: e cartões/grupos de ferramenta (' + abertoJob.ferramentas + ')');
      ok(abertoJob.temMarca, 'depois: a marca de subagente ("executor-plano") está na tela');
      exigir(abertoJob.envioHidden === true, 'depois: a caixa de escrita está ESCONDIDA — não se fala com um job');
      exigir(abertoJob.matarHidden === true, 'depois: sem o ✕ de matar aba — não há aba nenhuma aqui');
      exigir(erros.length === 0, 'depois: sem erro de console até aqui (' + (erros.slice(0, 3).join(' | ') || 'nenhum') + ')');
      await pagina.screenshot({ path: '/out/' + PREFIXO + 'depois-job-aberto.png' });

      // depois-aba-normal: volta para a lista e abre a conversa de VERDADE — a fita continua
      // recolhendo fala seguida de ferramenta, como sempre fez (não-regressão, G-J8).
      await pagina.evaluate(() => document.querySelector('.voltar').click());
      await new Promise((r) => setTimeout(r, 400));
      await verConversas(pagina);
      const clicouAba = await pagina.evaluate(() => {
        const botao = document.querySelector('#lista-conversas .conversa-linha .conversa');
        if (!botao) return false;
        botao.click();
        return true;
      });
      exigir(clicouAba, 'depois: a aba de verdade é clicável');
      await pagina.waitForSelector('.painel[data-tipo="aba"]', { timeout: 15000 });
      await new Promise((r) => setTimeout(r, 900));
      const abaNormal = await pagina.evaluate(() => {
        const painel = document.querySelector('.painel[data-tipo="aba"]');
        const fita = painel && painel.querySelector('.fita');
        const notas = fita ? fita.querySelectorAll('.fala-nota').length : 0;
        const abertas = fita ? Array.from(fita.querySelectorAll('.fala')).filter((f) => f.open).length : 0;
        return {
          tipo: painel && painel.dataset.tipo,
          notas, abertas,
          envioHidden: painel ? painel.querySelector('.envio').hidden : null,
        };
      });
      exigir(abaNormal.tipo === 'aba', 'depois: este painel é tipo "aba"');
      exigir(abaNormal.notas >= 1, 'depois: a fala antes da ferramenta virou fala-nota (não regrediu) — ' + abaNormal.notas);
      exigir(abaNormal.abertas >= 1, 'depois: e a última fala continua ABERTA');
      exigir(abaNormal.envioHidden === false, 'depois: a caixa de escrita da ABA continua visível');
      exigir(erros.length === 0, 'depois: sem erro de console (' + (erros.slice(0, 3).join(' | ') || 'nenhum') + ')');
      await pagina.screenshot({ path: '/out/' + PREFIXO + 'depois-aba-normal.png' });

      if (LARGO) {
        // desktop-split-misto: job e aba LADO A LADO — split view de graça (D40).
        await pagina.evaluate(() => document.querySelector('.voltar').click());
        await new Promise((r) => setTimeout(r, 400));
        await verAgentes(pagina);
        const abriuAoLado = await pagina.evaluate(() => {
          const linha = document.querySelector('#grupo-jobs .conversa-linha[data-estado="trabalhando"]');
          const botao = linha && linha.querySelector('.conversa');
          if (!botao) return false;
          botao.click();
          return true;
        });
        exigir(abriuAoLado, 'desktop: reabriu o job para montar o split');
        await pagina.waitForSelector('.painel[data-tipo="job"]', { timeout: 15000 });
        await new Promise((r) => setTimeout(r, 500));
        await verConversas(pagina);
        const abaAoLado = await pagina.evaluate(() => {
          const botao = document.querySelector('#lista-conversas .conversa-linha .conversa');
          if (!botao) return false;
          botao.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
          return true;
        });
        exigir(abaAoLado, 'desktop: Ctrl+clique na aba (abrir ao lado)');
        await new Promise((r) => setTimeout(r, 900));
        const split = await pagina.evaluate(() => ({
          paineis: document.querySelectorAll('#paineis .painel').length,
          tipos: Array.from(document.querySelectorAll('#paineis .painel')).map((p) => p.dataset.tipo),
        }));
        exigir(split.paineis === 2, 'desktop: dois painéis na tela (' + split.paineis + ')');
        exigir(split.tipos.includes('job') && split.tipos.includes('aba'),
          'desktop: um é job e o outro é aba (' + split.tipos.join(',') + ')');
        await pagina.screenshot({ path: '/out/desktop-split-misto.png' });
      }
    }

    console.log('@@MEDIDAS-JOB-PASSOS@@' + JSON.stringify({ feitos, problemas }));
  } finally {
    await navegador.close();
  }
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e.message);
  console.log('@@MEDIDAS-JOB-PASSOS@@' + JSON.stringify({ feitos: [], problemas: ['roteiro estourou: ' + e.message] }));
  process.exitCode = 1;
});
`;
}

// ─── Rodar um MODO×VIEWPORT dentro do container, contra a BASE dada ─────────────────────────

function rodarModo({ modo, base, scratch, largo }) {
  return new Promise((resolve) => {
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=${base}`,
      '-e', `MODO=${modo}`,
      '-e', `LARGO=${largo ? '1' : '0'}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    docker.on('close', (codigo) => {
      console.log(saidaDocker);
      const MARCADOR = '@@MEDIDAS-JOB-PASSOS@@';
      const abre = saidaDocker.indexOf(MARCADOR);
      let relatorio = null;
      if (abre >= 0) {
        try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
      }
      resolve(relatorio || { feitos: [], problemas: [`o roteiro (${modo}${largo ? '/desktop' : ''}) não devolveu JSON (código ${codigo})`] });
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
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    if (temCarimbo) {
      t(['kill-server'], { tolerante: true });
    } else if (scratch) {
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

    // ── 1) a árvore inteira do `develop` (o "antes") ──────────────────────────
    antesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-antes-job-passos-'));
    const shaDevelop = execSync('git rev-parse develop', { cwd: RAIZ, encoding: 'utf8' }).trim();
    execSync(`git archive develop | tar -x -C ${antesDir}`, { cwd: RAIZ });
    console.log(`  · árvore do "antes" = develop@${shaDevelop}, extraída em ${antesDir}`);

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-job-passos-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });

    // ── 2) a aba, num socket próprio ──────────────────────────────────────────
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', 'painelalvo', '-c', os.tmpdir(), 'sleep', '600']);

    const saidaPanes = t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']);
    const panes = {};
    for (const linha of saidaPanes.split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }
    if (!panes.painelalvo) throw new Error('a pane "painelalvo" não apareceu no list-panes');

    // ── 3) /proc falso + sessions/<pid>.json + a conversa, com fala→ferramenta→fala ─────────
    escreverConversaComFerramenta(caminhoDoJsonl(home, CWD_ALVO, SESSID_ALVO), Date.now() - 20 * 60000);
    plantarAgenteFalso(scratch, panes.painelalvo.panePid, { starttime: 1000001 });
    escreverSessao(home, {
      pid: panes.painelalvo.panePid, janela: panes.painelalvo.janelaId, pane: panes.painelalvo.paneId,
      sessaoId: SESSID_ALVO, cwd: CWD_ALVO, starttime: 1000001, status: 'idle',
    });

    // ── 4) os três jobs no disco — a ÚNICA fonte, dos dois lados ──────────────
    pastaJobs = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-jobs-job-passos-'));
    montarJobsNoDisco(pastaJobs);

    // ── 5) sobe os DOIS server.js, na MESMA fixture ───────────────────────────
    const ambienteBase = { ...process.env };
    delete ambienteBase.COCKPIT_TOKEN;
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

    // ── 6) o roteiro, dentro do container — os dois MODOS, celular + desktop ─────────────────
    fs.writeFileSync(path.join(scratch, 'pane.js'), montarRoteiro());

    const relAntesCel = await rodarModo({ modo: 'antes', base: `http://127.0.0.1:${PORTA_ANTES}`, scratch, largo: false });
    const relDepoisCel = await rodarModo({ modo: 'depois', base: `http://127.0.0.1:${PORTA_DEPOIS}`, scratch, largo: false });
    const relDepoisDesktop = await rodarModo({ modo: 'depois', base: `http://127.0.0.1:${PORTA_DEPOIS}`, scratch, largo: true });

    for (const [rotulo, rel] of [['antes/celular', relAntesCel], ['depois/celular', relDepoisCel], ['depois/desktop', relDepoisDesktop]]) {
      for (const f of rel.feitos) console.log(`  ✅ [${rotulo}] ${f}`);
      for (const p of rel.problemas) console.error(`  ❌ [${rotulo}] ${p}`);
      ok(rel.problemas.length === 0, `${rotulo}: nenhum problema`);
    }

    const pngsEsperados = ['antes-lista', 'antes-clique', 'depois-lista', 'depois-job-aberto', 'depois-aba-normal',
      'desktop-depois-lista', 'desktop-depois-job-aberto', 'desktop-depois-aba-normal', 'desktop-split-misto'];
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
    console.error(`\n🔴 ${falhas} problema(s) — os PNGs (se existirem) NÃO valem como prova.`);
    process.exit(1);
  }
  console.log(`\n✅ ${feitos} verificações. PNGs em ${SAIDA}`);
  console.log('FALTA AINDA, e não é automático: abrir os PNGs e OLHAR (regra de 25/08).');
})();
