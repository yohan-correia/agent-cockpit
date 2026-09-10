#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — celular, o grupo JOBS na lista lateral (card `painel-de-jobs-dentro-do-app`,
// desenho C, spec 2026-09-08).
//
// Prova de tela em 390×844 (regra do usuário de 25/08: provar no aparelho que motivou a mudança;
// o wrapper `smoke-navegador-externo` trava em 1600×1000). Antes/depois, com os MESMOS quatro
// jobs (mesmo id/título/projeto/estado) dos dois lados — só o CANAL muda: o `develop` ("antes")
// ainda lê o painel externo por HTTP (`COCKPIT_PAINEL_JOBS`, mock nesta pasta); esta worktree
// ("depois") lê a pasta do disco (`COCKPIT_JOBS_DIR`, ver `montarJobsNoDisco`). Sem os MESMOS
// dados dos dois lados o par deixa de comparar a MUDANÇA e passa a comparar dois dados
// diferentes (o erro de 24/08 com outra roupa).
//
// Molde: `testes/smoke-celular-primeira-leva.js` (as quatro panes reais num tmux carimbado, o
// /proc de mentira, o HOME fabricado) e `testes/smoke-conversa-transicoes.js` (dois `server.js`
// em portas distintas, um deles a árvore inteira do `develop` via `git archive`).
//
// Diferente dos dois moldes: aqui NÃO há MODO=/BASE= de entrada — este script É o entrypoint
// único. Ele mesmo escolhe as portas, sobe os DOIS `server.js` (o do `develop` e o desta
// worktree), cada um com sua própria fonte de jobs, roda o percurso duas vezes e derruba tudo
// no `finally`.
//
// Uso: SAIDA=<pasta NOVA, sem PNG dentro> node testes/smoke-celular-jobs.js
//
// Códigos de saída: 0 = os dois modos passaram · 1 = falha de produto/assert em algum dos dois
// · 2 = erro de USO ou de AMBIENTE (falta SAIDA, pasta já tem PNG, porta ocupada, imagem
// docker ausente, `git archive` falhou, servidor não subiu).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execSync, spawn } = require('node:child_process');

// ─── Contrato de uso — validado ANTES de tocar em qualquer coisa ─────────────

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os quatro PNGs vão cair>');
  process.exit(2);
}
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const RAIZ = path.join(__dirname, '..');

// Portas: dois `server.js` (antes/depois) + o mock do painel + uma de folga. Nunca 7899 (#24)
// nem 7879 (produção) — a faixa inteira já fica fora dos dois.
const PORTA_ANTES = 7891;
const PORTA_DEPOIS = 7892;
const PORTA_FOLGA = 7894;

const PNGS_DEPOIS = ['depois-lista', 'depois-recolhido', 'depois-primeira-dobra'];

// ─── Fail-closed do socket, mesmo padrão dos outros smokes de celular ────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-jobs-${process.pid}`;
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

// ─── As duas abas da fixture — uma casa com o job "running", a outra não ────
//
// `abasDoProjeto()` (`lib/abas.js:705`) casa por NOME: o `project` do job contra o basename
// normalizado do `cwd` da aba. `painelalvo` casa; `semaba` não casa com nenhuma das duas —
// os jobs "encerrados"/"bloqueado"/"falhou" não precisam de aba viva para aparecer na lista.

const CWD_ALVO = '/home/smoke/projetos/painelalvo';
const CWD_FORA = '/home/smoke/projetos/painelfora';
const SESSID_ALVO = 'sess-painelalvo';
const SESSID_FORA = 'sess-painelfora';

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
const linhaAssistente = (iso, texto) => `${JSON.stringify({
  type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: texto }] },
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

// ─── A fixture em DISCO, para o `server.js` "depois" ─────────────────────────
//
// Uma fixture só, para os DOIS lados. Até a absorção do painel mergear, o "antes" (a árvore
// do `develop`) lia os jobs de um serviço externo por HTTP e precisava de um mock; hoje as duas
// árvores leem a mesma pasta de disco, e o mock virou código morto que ATRAPALHA — a variável
// antiga passaria a ser ignorada, o "antes" ficaria sem pasta nenhuma, e o smoke reprovaria a
// ausência do grupo como se fosse defeito da branch.
//
// O que sobrou de "antes/depois" ainda vale: as duas árvores desenham a MESMA tela a partir do
// MESMO dado, e é isso que pega regressão entre a `develop` e a branch de trabalho.
//
// O formato das pastas é o que `lib/jobs.js:lerJob` espera.
function escreverJobNoDisco(pastaJobs, id, { type, project, title, criadoEm, statusMeta, linhaStatus, comEtapa }) {
  const dir = path.join(pastaJobs, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id, type, project, title,
    created_at: new Date(criadoEm).toISOString(),
    worktree: '', branch: '', origin: 'capitao', merged_at: null, approved_at: null,
    status: statusMeta, pid: process.pid, tmux_session: null,
  }));
  fs.writeFileSync(path.join(dir, 'status.log'), `${linhaStatus}\n`);
  if (comEtapa) {
    // Uma linha de NDJSON que `etapaAtual()` sabe ler (`lib/jobs.js`) — é o que faz a linha
    // "rodando" da lista ter uma etapa em vez de ficar muda.
    fs.writeFileSync(path.join(dir, 'claude.log'), `${JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x/lib/exemplo.js' } }] },
    })}\n`);
  }
}

function montarJobsNoDisco(pastaJobs) {
  const agora = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  escreverJobNoDisco(pastaJobs, 'job-rodando', {
    type: 'ataca', project: 'painelalvo', title: 'painel-alvo', criadoEm: agora - 5 * 60000,
    statusMeta: 'running', linhaStatus: `${iso(agora - 5 * 60000)} working: rodando`, comEtapa: true,
  });
  escreverJobNoDisco(pastaJobs, 'job-bloqueado', {
    type: 'ataca', project: 'semaba', title: 'painel-bloqueado', criadoEm: agora - 4 * 3600000,
    statusMeta: 'blocked',
    linhaStatus: `${iso(agora - 2 * 3600000)} blocked: teardown recusado: worktree com alteração pendente`,
  });
  escreverJobNoDisco(pastaJobs, 'job-pronto', {
    type: 'ship', project: 'semaba', title: 'painel-pronto', criadoEm: agora - 6 * 3600000,
    statusMeta: 'done', linhaStatus: `${iso(agora - 5 * 3600000)} done: concluído`,
  });
  escreverJobNoDisco(pastaJobs, 'job-falhou', {
    type: 'ataca', project: 'semaba', title: 'painel-falhou', criadoEm: agora - 3 * 3600000,
    statusMeta: 'failed', linhaStatus: `${iso(agora - 2 * 3600000)} failed: executor saiu com código 1`,
  });
  // 🔴 O quinto job existe para dar DENTE ao assert de baixo ("o de 25 h não aparece"). Sem
  // ele na pasta, aquele assert passa vazio: prova que a fixture não o tinha, não que a
  // janela o cortou.
  //
  // E quem o corta é a JANELA dos encerrados (`JANELA_ENCERRADOS_MS`, no server.js), não o
  // arquivamento (`horasArquiva()`, na lib) — são duas réguas de 24 h diferentes, e é fácil
  // trocá-las: `done` de fato nunca ARQUIVA, mas a janela o corta do mesmo jeito, e por isso
  // o `total === 4` continua valendo com cinco jobs no disco.
  escreverJobNoDisco(pastaJobs, 'job-fora-da-janela', {
    type: 'ship', project: 'semaba', title: 'painel-antigo', criadoEm: agora - 30 * 3600000,
    statusMeta: 'done', linhaStatus: `${iso(agora - 25 * 3600000)} done: concluído`,
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

// ─── O roteiro do navegador — roda DENTRO do container, uma vez por MODO ─────

function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const MODO = process.env.MODO;
const VIEWPORT = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const problemas = [];
const feitos = [];
const ok = (cond, msg) => { (cond ? feitos : problemas).push(msg); return cond; };
// Guarda ANTES do obturador (achado do painel de execução): um PNG de estado reprovado no
// disco, com o nome de sempre, é pior que PNG nenhum — alguém abre e acredita.
const exigir = (cond, msg) => {
  if (!ok(cond, msg)) throw new Error('guarda reprovou antes do obturador: ' + msg);
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

    if (MODO === 'antes') {
      // O que este assert mede: "o 'antes' é MESMO o código de antes". Ele nasceu exigindo a
      // AUSÊNCIA de #grupo-jobs, quando o desenho C ainda era a novidade da branch. O desenho
      // C mergeou, e desde então #grupo-jobs É o estado da develop: o assert envelheceu e o
      // smoke passou a reprovar o próprio "antes". Invertido em 2026-09-10, junto da absorção
      // do painel: continua medindo a mesma coisa, do lado certo.
      //
      // 🔴 E temGrupo sozinho é fraco: grupoDeJobs() (public/app.js:5903) desenha o grupo
      // TAMBÉM quando não há notícia dos jobs, justamente para pintar a linha de aviso. Um
      // "antes" com erro de token, de rota ou de fixture teria #grupo-jobs na tela e passaria.
      // São três dentes, não um: o grupo existe, tem LINHA de job, e não é a linha de aviso.
      await new Promise((r) => setTimeout(r, 1500));
      const estado = await pagina.evaluate(() => ({
        temGrupo: Boolean(document.getElementById('grupo-jobs')),
        linhas: document.querySelectorAll('#abas .conversa-linha').length,
        linhasDeJob: document.querySelectorAll('#grupo-jobs .conversa-linha').length,
        texto: (document.getElementById('grupo-jobs') || {}).textContent || '',
      }));
      exigir(estado.temGrupo, 'antes: #grupo-jobs existe (a develop já tem o desenho C)');
      exigir(estado.linhasDeJob >= 1, 'antes: e tem linha de JOB, não só o cabeçalho (' + estado.linhasDeJob + ')');
      exigir(!estado.texto.includes('não deu para'), 'antes: e NÃO é a linha de aviso — o cenário foi montado, a página não só abriu');
      exigir(estado.linhas >= 2, 'antes: as duas abas da fixture aparecem na lista (' + estado.linhas + ')');
      exigir(erros.length === 0, 'antes: sem erro de console (' + (erros.slice(0, 3).join(' | ') || 'nenhum') + ')');
      await pagina.screenshot({ path: '/out/antes-lista.png' });
    } else {
      await pagina.waitForSelector('#grupo-jobs', { timeout: 15000 });
      // ── depois-primeira-dobra: a foto do estado NATURAL da tela, sem rolar nada — prova
      // que as conversas continuam donas do topo e o grupo JOBS entra depois delas, como
      // mais um grupo da MESMA lista (desenho C), não como diálogo à parte.
      await new Promise((r) => setTimeout(r, 500));
      const primeira = await pagina.evaluate(() => ({
        temGrupo: Boolean(document.getElementById('grupo-jobs')),
        linhasAbas: document.querySelectorAll('#abas .conversa-grupo[data-cwd] .conversa-linha').length,
      }));
      exigir(primeira.temGrupo, 'depois: #grupo-jobs existe');
      exigir(primeira.linhasAbas >= 2, 'depois: as duas abas da fixture continuam na lista (' + primeira.linhasAbas + ')');
      await pagina.screenshot({ path: '/out/depois-primeira-dobra.png' });

      // ── depois-lista: rola o grupo inteiro para dentro da vista — as quatro linhas (uma
      // por estado que a tela desenha diferente) e o motivo do bloqueado, legíveis.
      await pagina.evaluate(() => document.getElementById('grupo-jobs').scrollIntoView({ block: 'start' }));
      await new Promise((r) => setTimeout(r, 300));

      const detalhes = await pagina.evaluate(() => {
        const linhas = Array.from(document.querySelectorAll('#grupo-jobs .conversa-linha'));
        const porEstado = (estado) => linhas.find((l) => l.dataset.estado === estado);
        const bloqueada = porEstado('bloqueado');
        const motivoEl = bloqueada && bloqueada.querySelectorAll('.conversa-estado')[1];
        const rodando = porEstado('trabalhando');
        const botaoRodando = rodando && rodando.querySelector('.conversa');
        return {
          total: linhas.length,
          temTrabalhando: Boolean(porEstado('trabalhando')),
          temBloqueado: Boolean(porEstado('bloqueado')),
          temPronta: Boolean(porEstado('pronta')),
          temInterrompida: Boolean(porEstado('interrompida')),
          contemAntigo: /painel-antigo/.test(document.getElementById('grupo-jobs').textContent),
          motivo: motivoEl ? motivoEl.textContent : null,
          rodandoEhBotao: Boolean(botaoRodando && botaoRodando.tagName === 'BUTTON'),
        };
      });
      exigir(detalhes.total === 4, 'depois: 4 linhas de job na tela (running/blocked/done/failed) — ' + detalhes.total);
      exigir(detalhes.temTrabalhando, 'depois: a linha "trabalhando" (rodando) está na tela');
      exigir(detalhes.temBloqueado, 'depois: a linha "bloqueado" está na tela');
      exigir(detalhes.temPronta, 'depois: a linha "pronta" (done na janela) está na tela');
      exigir(detalhes.temInterrompida, 'depois: a linha "interrompida" (failed) está na tela');
      exigir(!detalhes.contemAntigo, 'depois: o job de 25h (fora da janela de 24h) NÃO aparece');
      exigir(Boolean(detalhes.motivo && /teardown recusado/.test(detalhes.motivo)),
        'depois: o motivo do bloqueado está no DOM, legível (' + detalhes.motivo + ')');
      exigir(detalhes.rodandoEhBotao, 'depois: a linha "rodando" é clicável (casa com a aba painelalvo)');

      exigir(erros.length === 0, 'depois: sem erro de console (' + (erros.slice(0, 3).join(' | ') || 'nenhum') + ')');
      await pagina.screenshot({ path: '/out/depois-lista.png' });

      // ── depois-recolhido: linhas escondidas, cabeçalho e "N travados" de pé.
      await pagina.evaluate(() => document.querySelector('#grupo-jobs .projeto-alternar').click());
      await new Promise((r) => setTimeout(r, 300));
      const recolhido = await pagina.evaluate(() => {
        const conteudo = document.querySelector('#grupo-jobs .projeto-conteudo');
        const aviso = document.querySelector('#grupo-jobs .projeto-aviso');
        return {
          hidden: Boolean(conteudo && conteudo.hidden),
          avisoTexto: aviso ? aviso.textContent : null,
          avisoHidden: aviso ? aviso.hidden : true,
        };
      });
      exigir(recolhido.hidden, 'depois: o conteúdo do grupo está escondido (recolhido)');
      exigir(Boolean(recolhido.avisoTexto && /travado/.test(recolhido.avisoTexto) && !recolhido.avisoHidden),
        'depois: o aviso "N travados" aparece recolhido (' + recolhido.avisoTexto + ')');
      await pagina.screenshot({ path: '/out/depois-recolhido.png' });
    }

    console.log('@@MEDIDAS-JOBS@@' + JSON.stringify({ feitos, problemas }));
  } finally {
    await navegador.close();
  }
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e.message);
  console.log('@@MEDIDAS-JOBS@@' + JSON.stringify({ feitos: [], problemas: ['roteiro estourou: ' + e.message] }));
  process.exitCode = 1;
});
`;
}

// ─── Rodar um MODO dentro do container, contra a BASE dada ───────────────────

function rodarModo({ modo, base, scratch }) {
  return new Promise((resolve) => {
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=${base}`,
      '-e', `MODO=${modo}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    docker.on('close', (codigo) => {
      console.log(saidaDocker);
      const MARCADOR = '@@MEDIDAS-JOBS@@';
      const abre = saidaDocker.indexOf(MARCADOR);
      let relatorio = null;
      if (abre >= 0) {
        try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
      }
      resolve(relatorio || { feitos: [], problemas: [`o roteiro (${modo}) não devolveu JSON (código ${codigo})`] });
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
    // Fail-closed de verdade: se a janela-âncora sumiu, isto é FALHA — não um aviso que o
    // smoke ignora. Sem incrementar `falhas`, um smoke que perdeu a posse do socket podia
    // sair 0 deixando um servidor tmux vivo, contaminando a execução seguinte (a #24 por
    // outro caminho).
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    if (temCarimbo) {
      t(['kill-server'], { tolerante: true });
    } else if (scratch) {
      // Só é falha se a fixture chegou a existir (socket criado) — abortos antes da fixture
      // não têm carimbo para achar.
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

    // ── 1) a árvore inteira do `develop` (o "antes") — `server.js` sozinho não sobe ────
    antesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-antes-jobs-'));
    const shaDevelop = execSync('git rev-parse develop', { cwd: RAIZ, encoding: 'utf8' }).trim();
    execSync(`git archive develop | tar -x -C ${antesDir}`, { cwd: RAIZ });
    console.log(`  · árvore do "antes" = develop@${shaDevelop}, extraída em ${antesDir}`);

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-celular-jobs-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });

    // ── 2) as duas panes, num socket próprio ──────────────────────────────────
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', 'painelalvo', '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-window', '-t', SESSAO, '-n', 'painelfora', '-c', os.tmpdir(), 'sleep', '600']);

    const saidaPanes = t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']);
    const panes = {};
    for (const linha of saidaPanes.split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }
    for (const nome of ['painelalvo', 'painelfora']) {
      if (!panes[nome]) throw new Error(`a pane "${nome}" não apareceu no list-panes`);
    }

    // ── 3) só então: /proc falso + sessions/<pid>.json + a conversa, com os números REAIS ──
    const T_ALVO = conversaPequena(caminhoDoJsonl(home, CWD_ALVO, SESSID_ALVO), Date.now() - 20 * 60000);
    const T_FORA = conversaPequena(caminhoDoJsonl(home, CWD_FORA, SESSID_FORA), Date.now() - 20 * 60000);

    plantarAgenteFalso(scratch, panes.painelalvo.panePid, { starttime: 1000001 });
    escreverSessao(home, {
      pid: panes.painelalvo.panePid, janela: panes.painelalvo.janelaId, pane: panes.painelalvo.paneId,
      sessaoId: SESSID_ALVO, cwd: CWD_ALVO, starttime: 1000001, status: 'idle',
    });
    plantarAgenteFalso(scratch, panes.painelfora.panePid, { starttime: 1000002 });
    escreverSessao(home, {
      pid: panes.painelfora.panePid, janela: panes.painelfora.janelaId, pane: panes.painelfora.paneId,
      sessaoId: SESSID_FORA, cwd: CWD_FORA, starttime: 1000002, status: 'idle',
    });
    void T_ALVO; void T_FORA;

    // ── 4) o painel dos dois lados: o "antes" (develop) só fala HTTP com o mock; o "depois"
    //    (esta worktree) lê `COCKPIT_JOBS_DIR` do disco — dados equivalentes, canal diferente
    //    (ver o comentário de `montarJobsNoDisco`, acima).
    pastaJobs = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-jobs-depois-'));
    montarJobsNoDisco(pastaJobs);

    // ── 5) sobe os DOIS server.js, na MESMA fixture de abas/proc — só o painel de jobs muda ──
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
      // A MESMA pasta de disco do "depois". Era um mock HTTP (`COCKPIT_PAINEL_JOBS`) enquanto a
      // develop ainda lia os jobs de um serviço externo; a absorção mergeou, e desde então as
      // duas árvores leem do mesmo lugar. Deixar o mock aqui não é inofensivo: a variável
      // passaria a ser ignorada, o "antes" ficaria SEM pasta de jobs, e o smoke reprovaria a
      // ausência do grupo como se fosse defeito da branch.
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

    // ── 6) o roteiro, dentro do container — os DOIS modos, mesmo mock ─────────────
    fs.writeFileSync(path.join(scratch, 'pane.js'), montarRoteiro());

    const relatorioAntes = await rodarModo({ modo: 'antes', base: `http://127.0.0.1:${PORTA_ANTES}`, scratch });
    const relatorioDepois = await rodarModo({ modo: 'depois', base: `http://127.0.0.1:${PORTA_DEPOIS}`, scratch });

    for (const f of relatorioAntes.feitos) console.log(`  ✅ [antes] ${f}`);
    for (const f of relatorioAntes.problemas) console.error(`  ❌ [antes] ${f}`);
    for (const f of relatorioDepois.feitos) console.log(`  ✅ [depois] ${f}`);
    for (const f of relatorioDepois.problemas) console.error(`  ❌ [depois] ${f}`);

    ok(relatorioAntes.problemas.length === 0, 'MODO=antes: nenhum problema');
    ok(relatorioDepois.problemas.length === 0, 'MODO=depois: nenhum problema');

    for (const nome of ['antes-lista', ...PNGS_DEPOIS]) {
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
    console.error(`\n🔴 ${falhas} problema(s) — os quatro PNGs (se existirem) NÃO valem como prova.`);
    process.exit(1);
  }
  console.log(`\n✅ ${feitos} verificações, os dois modos passaram. PNGs em ${SAIDA}`);
  console.log('FALTA AINDA, e não é automático: abrir os quatro PNGs e OLHAR (regra de 25/08).');
})();
