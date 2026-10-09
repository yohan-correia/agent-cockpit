#!/usr/bin/env node
'use strict';
// PROVA DE TELA — o monitor do servidor (card do monitor, D64; painel maior, D68): a faixa
// CPU · RAM · disco na lateral, o painel de 24 h (com a LACUNA de 2 h visível no gráfico), o aviso a
// 90 %, o selo que atravessa para a vista da conversa e, na D68, os eixos clicáveis (top 10 de disco,
// RAM e CPU). 390×844 (celular, painel em tela cheia) e 1280×800 (desktop), tema escuro e claro: 4
// combinações × 8 PNGs = 32 (o 5º é a faixa com a rede caída; o 6º é o disco, da cabeça da seção;
// o 6b, o bloco Docker; o 7º, a CPU).
//
// Molde: `testes/print-teto-por-modelo.js` (docker `cockpit-smoke:latest`, `--network host`,
// puppeteer-core em /app, chromium em /usr/bin/chromium, PNG em /out).
//
// A LATERAL CHEIA: um tmux isolado (`-L <socket> -f /dev/null`, sessão `main`) com 18 janelas
// `sleep` vira 18 linhas da lista chata (D63) — mais do que cabe nos 844 px. Com a lista vazia o
// print não mostra se a faixa cobre o fim da lista; com ela cheia, os passos 1 e 3 medem a geometria
// (o fim da `.lista-area` encosta no topo da faixa, a faixa no topo da barra, a barra dentro da
// tela e o `#abas` rola). Limpeza fail-closed do tmux no molde do print do teto (D35).
//
// A fixture é toda falsa e isolada (#78): HOME falso, `COCKPIT_MONITOR_DIR` com um
// `historico.json` de 24 h, `COCKPIT_PROC_RAIZ` com `stat`/`meminfo`/6 pids de mentira. O host
// liga um relógio de 1 s que REESCREVE o `stat` falso somando 100 ticks/s (70 user, 30 idle):
// sem isso o /proc estático dá Δ0 e a CPU volta para "—" na segunda leitura — os medidores do
// painel sairiam vazios com o veredito verde.
//
// Cada combinação roda o roteiro três vezes (`MODO`), trocando o `meminfo` no HOST entre elas
// (sem acoplamento host↔container): `normal` (faixa + painel) → `aviso` (RAM a 94 %: faixa
// vermelha + selo) → `volta` (RAM a 60 %: o aviso some — histerese, 84 < 85) → `eixos` (D68: toca em
// disco, RAM e CPU; "medir agora" com clique duplo; toca de novo e fecha).
//
// O disco é medido por um `du` e um `docker` FALSOS (`COCKPIT_DU_BIN`/`COCKPIT_DOCKER_BIN`, #78):
// saída que imita 07/10, o du dorme 3 s e cada chamada cai num log — é como o passo 8 prova que o
// clique duplo vira UMA medição. Nunca roda `du` nem `docker` de verdade.
//
// CONTROLE NEGATIVO: SÓ o modo `eixos` contra a árvore da develop (`git archive`) tem de REPROVAR
// com a mensagem exata `passo 7: seção do disco ausente` — a develop tem o medidor de disco mas não a
// seção do detalhe. O `eixos` não mede geometria, então a única falha possível lá é a da seção nova.
// (O controle da D64 — "faixa ausente" — ficou obsoleto: a develop já tem a faixa.)
//
// Uso: SAIDA=<pasta NOVA, sem PNG dentro> node testes/print-monitor.js
// Saída: 0 = tudo passou e o controle negativo reprovou · 1 = falha de produto/assert ·
// 2 = erro de USO ou de AMBIENTE (falta SAIDA, pasta com PNG, porta ocupada, imagem ausente).

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

// Nunca 7899 (jobs), 7879 (produção) nem 7897 (instância de teste do celular).
const PORTA_DEPOIS = Number(process.env.PORTA_DEPOIS || 7863);
const PORTA_ANTES = Number(process.env.PORTA_ANTES || 7864);
const TOKEN = 'print-monitor';

// ─── O tmux isolado da lateral cheia ────────────────────────────────────────────────────────
// `-f /dev/null`: este script roda com o HOME REAL, e o `~/.tmux.conf` do dono restaura as
// sessões salvas dentro de qualquer servidor novo (medido em 06/10: 17 clones).
const SOCKET = `cockpit-smoke-monitor-${process.pid}`;
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
const MINHAS_SESSOES = new Set(['ancora', 'main']);
const JANELAS = ['loja-demo', 'cockpit-agentes', 'api', 'kidapp', 'site-clinica-teste', 'jogo-ab',
  'sistema-vendas-2', 'calculo-iva', 'fila-tarefas', 'jogo-online', 'cortes-video', 'clinica',
  'um-projeto-de-nome-bem-comprido-que-termina-em-reticencias', 'game-srv', 'midia-exemplo-x',
  'cofre-exemplo-demo', 'painel-clinica', 'loja-de-artigos'];
function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
}

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

// ─── A fixture ──────────────────────────────────────────────────────────────────────────────

const PID_DOS_PROCESSOS = [
  { pid: 201, nome: 'node', args: ['node', '/x/ua-grafo-det.mjs', '--threads', '4'], rss: 330000, passo: 40, job: true },
  { pid: 202, nome: 'claude', args: ['claude', '-p', 'texto do prompt', '--token=segredo'], rss: 210000, passo: 25 },
  { pid: 203, nome: 'dockerd', args: ['dockerd', '-H', 'fd://'], rss: 170000, passo: 10 },
  { pid: 204, nome: 'python3', args: ['python3', '/srv/app/main.py'], rss: 120000, passo: 55, job: true },
  { pid: 205, nome: 'postgres', args: ['postgres', '-D', '/var/lib/pg'], rss: 90000, passo: 5 },
  { pid: 206, nome: 'sleep', args: ['sleep', '600'], rss: 500, passo: 0 },
  { pid: 207, nome: 'redis', args: ['redis'], rss: 80000, passo: 8 },
  { pid: 208, nome: 'nginx', args: ['nginx'], rss: 70000, passo: 7 },
  { pid: 209, nome: 'java', args: ['java'], rss: 60000, passo: 6 },
  { pid: 210, nome: 'ruby', args: ['ruby'], rss: 50000, passo: 4 },
  { pid: 211, nome: 'php', args: ['php'], rss: 40000, passo: 3 },
  { pid: 212, nome: 'perl', args: ['perl'], rss: 30000, passo: 2 },
  { pid: 213, nome: 'cron', args: ['cron'], rss: 20000, passo: 1 },
];

/** O `stat` de um pid com utime/stime/rss nas posições certas (campos 14, 15 e 24). */
function textoStatPid(pid, nome, utime, rss) {
  const campos = new Array(50).fill('0'); // índice 0 = campo 3
  campos[0] = 'S';
  campos[11] = String(utime);
  campos[21] = String(rss);
  return `${pid} (${nome}) ${campos.join(' ')}\n`;
}

const statTexto = (user, idle) => `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0\n`;
const memTexto = (pctUsado) => {
  const total = 16000000;
  return `MemTotal: ${total} kB\nMemFree: 1 kB\nMemAvailable: ${Math.round(total * (100 - pctUsado) / 100)} kB\n`;
};

/** 24 h de amostras de 60 s, com a lacuna de 2 h (−14 h a −12 h) sem NENHUMA amostra. */
function historicoDeFixture() {
  const agora = Math.floor(Date.now() / 1000);
  const amostras = [];
  for (let i = 1439; i >= 1; i -= 1) {
    const idade = i * 60;                       // segundos atrás
    if (idade >= 12 * 3600 && idade <= 14 * 3600) continue; // a lacuna
    const h = idade / 3600;                      // horas atrás
    const cpu = Math.round(15 + 80 * Math.exp(-(((h - 9) / 2.5) ** 2)));
    const ram = Math.round(h >= 8 ? 40 + (24 - h) / 16 * 40 : 80 - (8 - h) / 8 * 25);
    amostras.push([agora - idade, cpu, ram, 85]);
  }
  return JSON.stringify({ versao: 1, amostras, aviso: { cpu: false, ram: false, disco: false } });
}

// ─── O du e o docker FALSOS (D68, #78): o painel do disco dispara `du` e `docker system df` ───
// Mesma fábrica do `gate-monitor.js` (o print não importa o gate): um executável Node que anota
// `<nome> <último argumento>` no log, escreve um caminho de mentira no stderr, escreve a fixture e
// dorme `dormeMs` antes de sair com `codigo`. O du falso dorme 3 s para o "medindo…" ser observável.
function criarFalso(dir, nome, { saida = '', porAlvo = null, codigo = 0, dormeMs = 0, log }) {
  fs.mkdirSync(dir, { recursive: true });
  const arq = path.join(dir, nome);
  const cfg = JSON.stringify({ saida, porAlvo, codigo, dormeMs, log, nome });
  fs.writeFileSync(arq, `#!/usr/bin/env node
const fs = require('fs'); const c = ${cfg};
const alvo = process.argv[process.argv.length - 1];
fs.appendFileSync(c.log, c.nome + ' ' + alvo + '\\n');
process.stderr.write('du: cannot read directory /segredo/caminho-do-stderr: Permission denied\\n');
const texto = c.porAlvo ? (c.porAlvo[alvo] || '') : c.saida;
setTimeout(() => { process.stdout.write(texto); process.exitCode = c.codigo; }, c.dormeMs);
`, { mode: 0o755 });
  return arq;
}
const reg = (kib, caminho) => `${kib}\t${caminho}\0`;
// Os nomes e tamanhos medidos em 07/10 (KiB).
const PASTAS_HOME = [['midia', 162870312], ['.orquestrador', 69563336], ['dados', 38414964], ['backups', 28029492],
  ['projetos', 23661092], ['.cache', 17394872], ['.ollama', 12115104], ['.npm', 9053408], ['.local', 8243260],
  ['.vscode-server', 5667100], ['.hermes', 3313448], ['.claude', 3169728]];
const KIB_HOME = PASTAS_HOME.reduce((s, [, k]) => s + k, 0) + 100000;
const duHome = (home) => reg(KIB_HOME, home) + PASTAS_HOME.map(([n, k]) => reg(k, `${home}/${n}`)).join('');
// 12 itens na raiz: `/home` (o tamanho da home) e o 1º segmento do HOME falso (o item que CONTÉM a
// home — é ele que recebe "inclui ~"), mais 10 pastas de sistema.
const PASTAS_RAIZ = [['usr', 5730512], ['var', 2622816], ['etc', 10208], ['snap', 24], ['lost+found', 16],
  ['services', 8], ['opt', 8], ['srv', 4], ['root', 4], ['mnt', 4]];
const duRaiz = (home) => reg(KIB_HOME + 9000000, '/') + reg(KIB_HOME, '/home') + reg(3501932, `/${home.split('/')[1]}`)
  + PASTAS_RAIZ.map(([n, k]) => reg(k, `/${n}`)).join('');
const DOCKER_TEXTO = [
  { Type: 'Images', TotalCount: '35', Active: '12', Size: '89.82GB', Reclaimable: '45.26GB (50%)' },
  { Type: 'Containers', TotalCount: '14', Active: '9', Size: '823.9MB', Reclaimable: '823.9MB (100%)' },
  { Type: 'Local Volumes', TotalCount: '20', Active: '8', Size: '22.93GB', Reclaimable: '22.93GB (100%)' },
  { Type: 'Build Cache', TotalCount: '300', Active: '0', Size: '253.1GB', Reclaimable: '157.6GB' },
].map((o) => JSON.stringify(o)).join('\n') + '\n';

// ─── O roteiro que roda DENTRO do container ─────────────────────────────────────────────────
// (Sem crase nem `${` aqui dentro: é texto de um template literal.)

function roteiro() {
  return `
const puppeteer = require('/app/node_modules/puppeteer-core');
const BASE = process.env.BASE;
const MODO = process.env.MODO;
const VP = process.env.VP;
const TEMA = process.env.TEMA;
const NEGATIVO = process.env.NEGATIVO === '1';
const celular = VP === 'celular';

const problemas = [];
const feitos = [];
const ok = (cond, msg) => { (cond ? feitos : problemas).push(VP + '/' + TEMA + '/' + MODO + ': ' + msg); return cond; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const png = (n) => '/out/' + n + '-' + VP + '-' + TEMA + '.png';

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const medidas = {};
  try {
    const pagina = await navegador.newPage();
    await pagina.setViewport(celular
      ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { width: 1280, height: 800, deviceScaleFactor: 1 });
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: TEMA }]);
    const erros = [];
    pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
    pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
    // pt-BR explícito (molde de print-celular-revisar.mjs): num Chromium em en-US o i18n traduz
    // "inclui ~" e "medindo…" e o roteiro reprovaria uma implementação certa.
    await pagina.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch { /* modo privado */ } });
    await pagina.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });

    // chama atualizar() a cada 1 s até a condição (nunca número mágico de espera)
    const ate = async (condicao, segundos) => {
      for (let i = 0; i < segundos; i += 1) {
        await pagina.evaluate(() => (globalThis.cockpitMonitor && globalThis.cockpitMonitor.atualizar ? globalThis.cockpitMonitor.atualizar() : null));
        if (await pagina.evaluate(condicao)) return true;
        await espera(1000);
      }
      return false;
    };
    const lerFaixa = () => pagina.evaluate(() => ({
      pcts: Array.from(document.querySelectorAll('#monitor-faixa .monitor-pct')).map((n) => n.textContent),
      aviso: document.getElementById('monitor-faixa').getAttribute('data-aviso'),
      avisoTexto: document.getElementById('monitor-faixa-aviso').textContent,
      caixa: (() => { const r = document.getElementById('monitor-faixa').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    }));
    // Antes de cada foto: as transições FINITAS acabaram (o fade de 160 ms do <dialog>, o deslize
    // de 200 ms da .chat no celular). Foto no meio delas sai translúcida ou deslocada com o
    // veredito verde. Animação infinita (spinner) não conta — nunca acabaria.
    const quieta = () => pagina.waitForFunction(() => document.getAnimations()
      .filter((a) => a.effect && a.effect.getTiming().iterations !== Infinity).length === 0, { timeout: 5000 }).catch(() => {});
    // A lateral CHEIA (D63 + D64 juntas): a faixa não cobre o fim da lista e não empurra a barra.
    // Roda no passo 1 (faixa de uma linha) e no 3 (o aviso dá à faixa uma 2ª linha).
    const conferirLateral = async (passo) => {
      const cheia = await ate(() => document.querySelectorAll('#abas .conversa-linha').length >= 18, 25);
      const g = await pagina.evaluate(() => {
        const r = (sel) => { const x = document.querySelector(sel).getBoundingClientRect(); return { top: Math.round(x.top), bottom: Math.round(x.bottom), h: Math.round(x.height) }; };
        const abas = document.getElementById('abas');
        return {
          linhas: document.querySelectorAll('#abas .conversa-linha').length,
          area: r('.lista-area'), faixa: r('#monitor-faixa'), barra: r('.barra-vistas'),
          alturaTela: window.innerHeight, rola: abas.scrollHeight > abas.clientHeight,
        };
      });
      ok(cheia, passo + ': a lateral tem as 18 linhas do tmux isolado (veio ' + g.linhas + ')');
      ok(g.area.h > 0 && g.area.bottom <= g.faixa.top, passo + ': a lista termina no topo da faixa, sem sobrepor (lista ' + JSON.stringify(g.area) + ', faixa ' + JSON.stringify(g.faixa) + ')');
      ok(g.faixa.bottom <= g.barra.top && g.barra.h > 0, passo + ': a faixa termina no topo da barra de vistas (barra ' + JSON.stringify(g.barra) + ')');
      ok(g.barra.bottom <= g.alturaTela, passo + ': a barra de vistas fica dentro da tela (' + g.barra.bottom + ' <= ' + g.alturaTela + ')');
      ok(g.rola, passo + ': o #abas rola — a lista encolhe, não empurra a faixa para fora');
      return g;
    };

    if (MODO === 'normal') {
      // (1) a faixa
      try {
        await pagina.waitForSelector('#monitor-faixa:not([hidden])', { timeout: NEGATIVO ? 8000 : 20000 });
      } catch (e) {
        ok(false, 'passo 1: #monitor-faixa não existe/aparece (faixa ausente)');
        throw new Error('faixa ausente');
      }
      const tres = await ate(() => Array.from(document.querySelectorAll('#monitor-faixa .monitor-pct')).every((n) => /^\\d+ %$/.test(n.textContent))
        && document.querySelectorAll('#monitor-faixa .monitor-pct')[1].textContent === '60 %', 25); // RAM da fixture: o cache de 5 s da rota pode trazer o 94 % da corrida anterior
      medidas.faixa = await lerFaixa();
      ok(tres, 'passo 1: os 3 .monitor-pct casam /\\\\d+ %/ (veio ' + JSON.stringify(medidas.faixa.pcts) + ')');
      ok(medidas.faixa.caixa.w > 0 && medidas.faixa.caixa.h > 0, 'passo 1: a faixa tem caixa visível (' + JSON.stringify(medidas.faixa.caixa) + ')');
      medidas.lateral = await conferirLateral('passo 1');
      await pagina.screenshot({ path: png('01-faixa'), fullPage: true });

      // (2) o painel — D68: abre SEM eixo (a dica no lugar das listas), em tela cheia no celular
      await pagina.click('#monitor-faixa');
      await pagina.waitForSelector('#dialogo-monitor[open]', { timeout: 10000 });
      const grafico = await ate(() => Array.from(document.querySelectorAll('path.monitor-linha-grafico')).every((p) => ((p.getAttribute('d') || '').match(/L/g) || []).length >= 100), 30);
      await quieta(); // a caixa do <dialog> só vale depois do fade/transform de abertura
      medidas.painel = await pagina.evaluate(() => {
        const n = (re, s) => (s.match(re) || []).length;
        const d = (eixo) => (document.querySelector('path.monitor-linha-grafico[data-eixo="' + eixo + '"]') || { getAttribute: () => '' }).getAttribute('d') || '';
        const r = document.getElementById('dialogo-monitor').getBoundingClientRect();
        const dica = document.getElementById('monitor-dica');
        return {
          caminhos: document.querySelectorAll('path.monitor-linha-grafico').length,
          L: { cpu: n(/L/g, d('cpu')), ram: n(/L/g, d('ram')), disco: n(/L/g, d('disco')) },
          Mcpu: n(/M/g, d('cpu')),
          alturaSvg: Math.round(document.getElementById('monitor-grafico').getBoundingClientRect().height),
          subs: Array.from(document.querySelectorAll('.monitor-medidor-sub')).map((x) => x.textContent),
          pcts: Array.from(document.querySelectorAll('.monitor-medidor-pct')).map((x) => x.textContent),
          dicaVisivel: !dica.hidden && dica.getBoundingClientRect().height > 0,
          detalheEscondido: document.getElementById('monitor-detalhe').hidden,
          y: Array.from(document.querySelectorAll('.monitor-grafico-y span')).map((x) => x.textContent),
          caixa: { w: r.width, h: r.height, top: r.top },
        };
      });
      const m = medidas.painel;
      ok(grafico && m.caminhos === 3 && m.L.cpu >= 100 && m.L.ram >= 100 && m.L.disco >= 100, 'passo 2: 3 paths com >= 100 "L" (' + JSON.stringify(m.L) + ')');
      ok(m.Mcpu >= 2, 'passo 2: o path da CPU tem >= 2 "M" — a lacuna de 2 h (veio ' + m.Mcpu + ')');
      ok(m.alturaSvg > 100, 'passo 2: o svg tem altura renderizada > 100 px (' + m.alturaSvg + ')');
      ok(m.subs.every((s) => !/NaN/.test(s)), 'passo 2: nenhuma sub-linha dos medidores contém NaN (' + JSON.stringify(m.subs) + ')');
      ok(/\\d/.test(m.subs[1]) && /\\d/.test(m.subs[2]), 'passo 2: as sub-linhas de RAM e disco têm número (' + JSON.stringify(m.subs) + ')');
      ok(m.dicaVisivel && m.detalheEscondido, 'passo 2: sem eixo aberto — a dica visível e o #monitor-detalhe escondido (dica ' + m.dicaVisivel + ', detalhe escondido ' + m.detalheEscondido + ')');
      ok(m.y.length === 3 && m.y[0] === '100' && m.y[1] === '50' && m.y[2] === '0', 'passo 2: a escala do gráfico diz 100 / 50 / 0 (veio ' + JSON.stringify(m.y) + ')');
      if (celular) ok(Math.abs(m.caixa.w - 390) <= 1 && Math.abs(m.caixa.h - 844) <= 1 && m.caixa.top <= 1, 'passo 2: no celular o painel é a tela inteira 390x844 (veio ' + JSON.stringify(m.caixa) + ')');
      else ok(m.caixa.w >= 700 && m.caixa.w <= 760, 'passo 2: no desktop o painel tem de 700 a 760 px de largura (veio ' + m.caixa.w + ')');
      ok(await pagina.evaluate(() => getComputedStyle(document.getElementById('dialogo-monitor')).opacity === '1'), 'passo 2: o painel está opaco na foto (fade de abertura terminou)');
      await pagina.screenshot({ path: png('02-painel') });
      await pagina.click('#btn-fechar-monitor');
    }

    if (MODO === 'aviso') {
      // (3) a faixa vermelha
      await pagina.waitForSelector('#monitor-faixa:not([hidden])', { timeout: 20000 });
      // Espera o aviso LIGADO **e** o número já em 94 %: o "agora" da rota tem cache de 5 s e o aviso
      // vem do amostrador (2 s), então por um instante a faixa pode dizer "RAM em 60 % — limite 90 %".
      // O PNG tem de mostrar o estado coerente — e a espera é por condição, nunca por número mágico.
      const ligou = await ate(() => document.getElementById('monitor-faixa').getAttribute('data-aviso') === 'ligado'
        && /94 %/.test(document.getElementById('monitor-faixa-aviso').textContent), 25);
      medidas.aviso = await lerFaixa();
      ok(ligou, 'passo 3: #monitor-faixa[data-aviso="ligado"] com a RAM a 94 %');
      ok(/RAM/.test(medidas.aviso.avisoTexto), 'passo 3: o texto do aviso cita RAM (' + JSON.stringify(medidas.aviso.avisoTexto) + ')');
      medidas.lateralAviso = await conferirLateral('passo 3');
      await pagina.screenshot({ path: png('03-aviso'), fullPage: true });

      // (4) o selo: a faixa SAI de vista e o selo aparece
      if (celular) await pagina.evaluate(() => { document.getElementById('app').dataset.vista = 'chat'; });
      else await pagina.click('#btn-lateral');
      let seloVisivel = false;
      try {
        await pagina.waitForFunction(() => {
          const s = document.getElementById('monitor-aviso');
          const r = s.getBoundingClientRect();
          return getComputedStyle(s).display !== 'none' && r.width > 0 && r.height > 0;
        }, { timeout: 10000 });
        seloVisivel = true;
      } catch (e) { /* fica false */ }
      const lerSelo = () => pagina.evaluate(() => {
        const s = document.getElementById('monitor-aviso');
        const r = s.getBoundingClientRect();
        return { texto: s.textContent, display: getComputedStyle(s).display, w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top),
          esquerda: Math.round(r.left), direita: Math.round(r.right), innerWidth: window.innerWidth, animando: document.getAnimations().length };
      });
      // No meio do deslize da .chat a conversa transborda à direita, a viewport do celular alarga
      // e o selo sai cortado no PNG — por isso a medida no deslize E depois do quieta().
      medidas.seloNoDeslize = await lerSelo();
      await quieta();
      medidas.selo = await lerSelo();
      ok(seloVisivel && /RAM/.test(medidas.selo.texto), 'passo 4: o selo está visível e diz RAM (' + JSON.stringify(medidas.selo) + ')');
      const larguraTela = celular ? 390 : 1280; // a do setViewport: o innerWidth alarga junto com o transbordo
      ok(medidas.selo.esquerda >= 0 && medidas.selo.direita <= larguraTela, 'passo 4: o selo cabe na largura da tela (' + medidas.selo.esquerda + '..' + medidas.selo.direita + ' em ' + larguraTela + '; no deslize: ' + medidas.seloNoDeslize.esquerda + '..' + medidas.seloNoDeslize.direita + ')');
      await pagina.screenshot({ path: png('04-selo') });
      if (celular) await pagina.evaluate(() => { document.getElementById('app').dataset.vista = 'lista'; });
      else await pagina.click('#btn-lateral');
    }

    if (MODO === 'volta') {
      // (5) a RAM voltou a 60 %: o aviso sai (histerese, 84 < 85)
      await pagina.waitForSelector('#monitor-faixa:not([hidden])', { timeout: 20000 });
      const saiu = await ate(() => !document.getElementById('monitor-faixa').hasAttribute('data-aviso')
        && document.querySelectorAll('#monitor-faixa .monitor-pct')[1].textContent === '60 %', 25);
      medidas.volta = await lerFaixa();
      ok(saiu, 'passo 5: o data-aviso sumiu com a RAM de volta a 60 %');
      ok(await pagina.evaluate(() => document.getElementById('monitor-aviso').hidden), 'passo 5: o selo voltou a hidden');

      // (6) a rede caiu: a faixa não pode seguir mostrando o último número como se fosse ao vivo
      // (spec §5.2: data-estado="sem-dado", texto "—"; achado do painel de execução). O roteiro
      // derruba SÓ as leituras do monitor e força uma; os erros de console dessa queda são dele.
      const errosAntesDaQueda = erros.length;
      await pagina.setRequestInterception(true);
      pagina.on('request', (req) => (/api\\/monitor/.test(req.url()) ? req.abort() : req.continue()));
      await pagina.evaluate(() => globalThis.cockpitMonitor.atualizar());
      await quieta();
      medidas.semDado = await pagina.evaluate(() => ({
        estado: document.getElementById('monitor-faixa').getAttribute('data-estado'),
        pcts: Array.from(document.querySelectorAll('#monitor-faixa .monitor-pct')).map((n) => n.textContent),
      }));
      ok(medidas.semDado.estado === 'sem-dado', 'passo 6: a faixa ganha data-estado="sem-dado" com a rede caída (veio ' + medidas.semDado.estado + ')');
      ok(medidas.semDado.pcts.every((p) => p === '—'), 'passo 6: as 3 celas dizem "—", não o último número (veio ' + JSON.stringify(medidas.semDado.pcts) + ')');
      await pagina.screenshot({ path: png('05-sem-dado'), fullPage: true });
      erros.length = errosAntesDaQueda;
    }

    if (MODO === 'eixos') {
      await pagina.waitForSelector('#monitor-faixa:not([hidden])', { timeout: 20000 });
      await pagina.click('#monitor-faixa');
      await pagina.waitForSelector('#dialogo-monitor[open]', { timeout: 10000 });
      // Enquadramento: o corpo do painel é o que rola e o screenshot é da viewport (fullPage não
      // expande rolagem interna). A lista tem de aparecer na foto: top >= 0 e >= 150 px dela à vista.
      const enquadrar = async (sel, passo) => {
        await pagina.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'start', behavior: 'instant' }), sel);
        await quieta();
        const e = await pagina.evaluate((s) => ({ top: Math.round(document.querySelector(s).getBoundingClientRect().top), h: window.innerHeight }), sel);
        ok(e.top >= 0 && e.top <= e.h - 150, passo + ': ' + sel + ' está na foto (top ' + e.top + ', viewport ' + e.h + ')');
      };

      // (7) disco: as pastas e o Docker
      if (!(await pagina.$('#monitor-disco-home'))) { ok(false, 'passo 7: seção do disco ausente'); throw new Error('seção do disco ausente'); }
      await pagina.click('button.monitor-medidor[data-eixo="disco"]');
      const pronto7 = await ate(() => document.querySelectorAll('#monitor-disco-home .monitor-pasta').length === 10
        && document.querySelectorAll('#monitor-disco-raiz .monitor-pasta').length === 10
        && document.querySelectorAll('#monitor-disco-docker .monitor-pasta').length === 4
        && document.getElementById('monitor-disco-quando').dataset.em !== '', 40);
      medidas.disco = await pagina.evaluate(() => ({
        home: document.querySelectorAll('#monitor-disco-home .monitor-pasta').length,
        raiz: document.querySelectorAll('#monitor-disco-raiz .monitor-pasta').length,
        docker: document.querySelectorAll('#monitor-disco-docker .monitor-pasta').length,
        incluiHome: Array.from(document.querySelectorAll('#monitor-disco-raiz .monitor-pasta')).some((l) => l.textContent.indexOf('inclui ~') >= 0),
        quando: document.getElementById('monitor-disco-quando').textContent,
        visiveis: Array.from(document.querySelectorAll('[data-secao]')).filter((s) => !s.hidden).map((s) => s.dataset.secao),
        expandidos: Array.from(document.querySelectorAll('button.monitor-medidor')).filter((b) => b.getAttribute('aria-expanded') === 'true').map((b) => b.dataset.eixo),
        nan: /NaN/.test(document.getElementById('monitor-detalhe').textContent),
      }));
      const dk = medidas.disco;
      ok(pronto7 && dk.home === 10 && dk.raiz === 10 && dk.docker === 4, 'passo 7: 10 pastas na home, 10 na raiz, 4 no Docker (veio ' + dk.home + '/' + dk.raiz + '/' + dk.docker + ')');
      ok(dk.incluiHome, 'passo 7: uma linha da raiz diz "inclui ~"');
      ok(/^medido às \\d\\d:\\d\\d/.test(dk.quando), 'passo 7: a cabeça diz "medido às HH:MM" (veio ' + JSON.stringify(dk.quando) + ')');
      ok(dk.visiveis.length === 1 && dk.visiveis[0] === 'disco', 'passo 7: só a seção do disco visível (veio ' + JSON.stringify(dk.visiveis) + ')');
      ok(dk.expandidos.length === 1 && dk.expandidos[0] === 'disco', 'passo 7: aria-expanded true só no botão do disco (veio ' + JSON.stringify(dk.expandidos) + ')');
      ok(!dk.nan, 'passo 7: nenhum NaN no detalhe');
      // A foto do disco começa na CABEÇA da seção ("medido às" + "medir agora" + a nota): enquadrar
      // pela lista cortava justamente o botão e o horário (visto no PNG da 1ª corrida).
      await enquadrar('[data-secao="disco"]', 'passo 7');
      // O Fechar grudado tem de encostar no FUNDO do painel: com o corpo no meio da rolagem, nada do
      // conteúdo pode aparecer por baixo dele (a 1ª corrida mostrou a linha /snap sob o Fechar no desktop).
      const rodape = await pagina.evaluate(() => {
        const c = document.querySelector('#dialogo-monitor .dialogo-corpo').getBoundingClientRect();
        const a = document.querySelector('#dialogo-monitor .dialogo-acoes').getBoundingClientRect();
        return { corpo: Math.round(c.bottom), acoes: Math.round(a.bottom) };
      });
      ok(Math.abs(rodape.corpo - rodape.acoes) <= 1, 'passo 7: o Fechar grudado encosta no fundo do painel, sem conteúdo por baixo (' + JSON.stringify(rodape) + ')');
      await pagina.screenshot({ path: png('06-disco') });
      // E o bloco Docker numa foto própria: no celular ele fica abaixo da dobra. Rola o corpo até o fim
      // e exige o Docker inteiro ACIMA do Fechar grudado.
      await pagina.evaluate(() => { const c = document.querySelector('#dialogo-monitor .dialogo-corpo'); c.scrollTop = c.scrollHeight; });
      await quieta();
      const dockerNaFoto = await pagina.evaluate(() => {
        const d = document.getElementById('monitor-disco-docker').getBoundingClientRect();
        const a = document.querySelector('#dialogo-monitor .dialogo-acoes').getBoundingClientRect();
        return { top: Math.round(d.top), bottom: Math.round(d.bottom), acoes: Math.round(a.top) };
      });
      ok(dockerNaFoto.top >= 0 && dockerNaFoto.bottom <= dockerNaFoto.acoes, 'passo 7: o bloco Docker inteiro na foto, acima do Fechar (' + JSON.stringify(dockerNaFoto) + ')');
      await pagina.screenshot({ path: png('06b-docker') });

      // (8) "medir agora": o clique duplo vira UMA medição (a do servidor é o D8 do gate)
      const lerDu = () => require('fs').readFileSync('/w/falsos.log', 'utf8').split('\\n').filter((l) => l.indexOf('du ') === 0).length;
      await ate(() => !document.getElementById('btn-medir-disco').disabled, 30);
      const emAntes = await pagina.evaluate(() => { window.__emAntes = document.getElementById('monitor-disco-quando').dataset.em; return window.__emAntes; });
      const duAntes = lerDu();
      await pagina.click('#btn-medir-disco');
      await pagina.click('#btn-medir-disco');
      const travou = await pagina.evaluate(() => document.getElementById('btn-medir-disco').disabled);
      ok(travou, 'passo 8: o botão fica disabled logo depois do clique');
      const medindo = await ate(() => document.getElementById('btn-medir-disco').textContent === 'medindo…', 5);
      ok(medindo, 'passo 8: o botão diz "medindo…"');
      const terminou = await ate(() => document.getElementById('monitor-disco-quando').dataset.em !== window.__emAntes && !document.getElementById('btn-medir-disco').disabled, 30);
      ok(terminou, 'passo 8: o "medido às" mudou e o botão reabilitou (em antes ' + emAntes + ')');
      const duDepois = lerDu();
      ok(duDepois - duAntes === 2, 'passo 8: dois cliques → UMA medição = 2 chamadas de du (veio ' + (duDepois - duAntes) + ')');

      // (9) RAM e CPU: top 10 de processos, com o chip de job
      await pagina.click('button.monitor-medidor[data-eixo="ram"]');
      await ate(() => document.querySelectorAll('#monitor-top-ram .monitor-linha').length === 10, 25);
      const ram = await pagina.evaluate(() => ({
        linhas: document.querySelectorAll('#monitor-top-ram .monitor-linha').length,
        ua: /ua-grafo-det\\.mjs/.test(document.getElementById('monitor-top-ram').textContent),
      }));
      ok(ram.linhas === 10 && ram.ua, 'passo 9: RAM com 10 linhas e ua-grafo-det.mjs (veio ' + ram.linhas + ', ua ' + ram.ua + ')');
      await pagina.click('button.monitor-medidor[data-eixo="cpu"]');
      await ate(() => document.querySelectorAll('#monitor-top-cpu .monitor-linha').length === 10, 25);
      medidas.cpu = await pagina.evaluate(() => ({
        linhas: document.querySelectorAll('#monitor-top-cpu .monitor-linha').length,
        jobs: document.querySelectorAll('#monitor-top-cpu .monitor-job').length,
        discoEscondido: document.querySelector('[data-secao="disco"]').hidden,
        vaza: /\\/x\\/|segredo|\\/srv|\\/var/.test(document.getElementById('monitor-top-ram').textContent + document.getElementById('monitor-top-cpu').textContent),
      }));
      const cp = medidas.cpu;
      ok(cp.linhas === 10, 'passo 9: CPU com 10 linhas (veio ' + cp.linhas + ')');
      ok(cp.jobs >= 1, 'passo 9: ao menos um chip .monitor-job na CPU (veio ' + cp.jobs + ')');
      ok(cp.discoEscondido, 'passo 9: a seção do disco escondeu');
      ok(!cp.vaza, 'passo 9: nenhum caminho nem valor de flag vaza nas listas');
      await enquadrar('#monitor-top-cpu', 'passo 9');
      await pagina.screenshot({ path: png('07-cpu') });

      // (10) tocar na CPU de novo fecha: nenhuma seção, a dica volta
      await pagina.click('button.monitor-medidor[data-eixo="cpu"]');
      const fechou = await pagina.evaluate(() => ({
        detalhe: document.getElementById('monitor-detalhe').hidden,
        dica: !document.getElementById('monitor-dica').hidden,
      }));
      ok(fechou.detalhe && fechou.dica, 'passo 10: CPU de novo → #monitor-detalhe escondido e a dica de volta (veio ' + JSON.stringify(fechou) + ')');
      await pagina.click('#btn-fechar-monitor');
    }

    ok(erros.length === 0, 'sem erro de console (' + (erros.slice(0, 3).join(' | ') || 'nenhum') + ')');
    console.log('@@MEDIDAS-ROTEIRO@@' + JSON.stringify({ feitos, problemas, medidas }));
  } catch (e) {
    problemas.push('roteiro estourou: ' + e.message);
    console.log('@@MEDIDAS-ROTEIRO@@' + JSON.stringify({ feitos, problemas, medidas }));
    process.exitCode = 1;
  } finally {
    await navegador.close();
  }
})();
`;
}

function rodarModo({ modo, base, scratch, vp, tema, negativo = false }) {
  return new Promise((resolve) => {
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=${base}`, '-e', `MODO=${modo}`, '-e', `VP=${vp}`, '-e', `TEMA=${tema}`, '-e', `NEGATIVO=${negativo ? 1 : 0}`,
      '-v', `${scratch}:/w:ro`, '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/roteiro.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    docker.on('close', (codigo) => {
      const MARCADOR = '@@MEDIDAS-ROTEIRO@@';
      const abre = saidaDocker.indexOf(MARCADOR);
      let relatorio = null;
      if (abre >= 0) {
        try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
      }
      if (!relatorio) console.log(saidaDocker);
      resolve(relatorio || { feitos: [], problemas: [`o roteiro (${vp}/${tema}/${modo}) não devolveu JSON (código ${codigo})`], medidas: {} });
    });
  });
}

// ─── Corrida ────────────────────────────────────────────────────────────────────────────────

(async () => {
  let scratch = null;
  let antesDir = null;
  let relogioProc = null;
  let tmuxNoAr = false;
  const servidores = [];

  const limpar = () => {
    if (relogioProc) clearInterval(relogioProc);
    for (const s of servidores) {
      if (s && s.exitCode === null) { try { process.kill(s.pid); } catch { /* já morreu */ } }
    }
    if (tmuxNoAr) {
      // Fail-closed (D35): o carimbo prova que EU criei o socket; a enumeração prova que não
      // há mais ninguém nele. Derrubar o servidor tmux exige as duas respostas.
      const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
        .split('\n').some((n) => n.trim() === CARIMBO);
      const intrusas = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
        .split('\n').map((n) => n.trim()).filter((n) => n && !MINHAS_SESSOES.has(n));
      if (temCarimbo && !intrusas.length) {
        t(['kill-server'], { tolerante: true });
        if (!t(['ls'], { tolerante: true }).trim()) {
          fs.rmSync(path.join(os.tmpdir(), `tmux-${os.userInfo().uid}`, SOCKET), { force: true });
        }
      } else if (temCarimbo) {
        for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
        console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
      }
    }
    for (const d of [antesDir, scratch]) {
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
    for (const porta of [PORTA_DEPOIS, PORTA_ANTES]) {
      if (portaOcupada(porta)) {
        console.error(`🔴 a porta ${porta} já está em uso — aborta antes de subir qualquer coisa.`);
        return process.exit(2);
      }
    }

    if (t(['ls'], { tolerante: true }).trim()) {
      console.error(`🔴 o socket tmux ${SOCKET} JÁ EXISTE — não é meu. Abortando.`);
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-monitor-'));
    const home = path.join(scratch, 'home');
    const mon = path.join(scratch, 'monitor');
    const proc = path.join(scratch, 'proc');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(mon, { recursive: true });
    fs.mkdirSync(proc, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'roteiro.js'), roteiro());
    fs.writeFileSync(path.join(mon, 'historico.json'), historicoDeFixture());
    const arqMem = path.join(proc, 'meminfo');
    fs.writeFileSync(arqMem, memTexto(60));
    const trocarRam = (pct) => fs.writeFileSync(arqMem, memTexto(pct));

    // O relógio do HOST: a cada 1 s reescreve o stat falso (+100 ticks: 70 user, 30 idle) e os
    // utime dos pids. Sem ele o Δ é zero e a CPU volta para "—" na segunda leitura.
    let user = 100000; let idle = 100000; let tick = 0;
    for (const p of PID_DOS_PROCESSOS) {
      fs.mkdirSync(path.join(proc, String(p.pid)), { recursive: true });
      // a marca de job é o cwd dentro de COCKPIT_WORKTREES_DIR (S5); o alvo nem precisa existir
      if (p.job) fs.symlinkSync(path.join(scratch, 'worktrees', 'job-x'), path.join(proc, String(p.pid), 'cwd'));
    }
    const escreverProc = () => {
      fs.writeFileSync(path.join(proc, 'stat'), statTexto(user, idle));
      for (const p of PID_DOS_PROCESSOS) {
        fs.writeFileSync(path.join(proc, String(p.pid), 'stat'), textoStatPid(p.pid, p.nome, 1000 + p.passo * tick, p.rss));
        fs.writeFileSync(path.join(proc, String(p.pid), 'cmdline'), p.args.join('\0') + '\0');
      }
    };
    escreverProc();
    relogioProc = setInterval(() => { user += 70; idle += 30; tick += 1; escreverProc(); }, 1000);
    relogioProc.unref();

    // O du e o docker FALSOS: o log fica em scratch (o container o lê em /w/falsos.log)
    const logFalsos = path.join(scratch, 'falsos.log');
    const falsoDu = criarFalso(path.join(scratch, 'falsos'), 'du', { porAlvo: { [home]: duHome(home), '/': duRaiz(home) }, codigo: 1, dormeMs: 3000, log: logFalsos });
    const falsoDocker = criarFalso(path.join(scratch, 'falsos'), 'docker', { saida: DOCKER_TEXTO, log: logFalsos });

    // A lateral cheia: `ancora` leva o carimbo; a sessão `main` (a que vira abas) leva as 18 janelas
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    tmuxNoAr = true;
    t(['new-session', '-d', '-s', 'main', '-n', JANELAS[0], '-c', os.tmpdir(), 'sleep', '600']);
    for (const nome of JANELAS.slice(1)) t(['new-window', '-d', '-t', 'main', '-n', nome, '-c', os.tmpdir(), 'sleep', '600']);

    // O ANTES: a árvore da develop
    antesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-antes-monitor-'));
    const shaDevelop = execSync('git rev-parse develop', { cwd: RAIZ, encoding: 'utf8' }).trim();
    execSync(`git archive develop | tar -x -C ${antesDir}`, { cwd: RAIZ });
    console.log(`  · árvore do "antes" = develop@${shaDevelop}`);

    // Isolamento #78 por LISTA FECHADA: nada de COCKPIT_* herdado.
    const ambienteBase = { ...process.env };
    for (const k of Object.keys(ambienteBase)) if (k.startsWith('COCKPIT_')) delete ambienteBase[k];
    Object.assign(ambienteBase, {
      HOST: '127.0.0.1', HOME: home, COCKPIT_CERT_DIR: '/dev/null', COCKPIT_TOKEN: TOKEN,
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_PROC_RAIZ: proc, COCKPIT_MONITOR_DIR: mon, COCKPIT_MONITOR_MS: '2000',
      COCKPIT_DU_BIN: falsoDu, COCKPIT_DOCKER_BIN: falsoDocker, COCKPIT_WORKTREES_DIR: path.join(scratch, 'worktrees'),
      COCKPIT_VIGIA_MS: '0', COCKPIT_JOBS_DIR: path.join(scratch, 'sem-jobs'),
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'), COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
      COCKPIT_USO_DIR: path.join(scratch, 'uso'), COCKPIT_USO_CODEX_DIR: path.join(scratch, 'uso-codex'),
      COCKPIT_LEITURAS_DIR: path.join(scratch, 'leituras'), COCKPIT_STATUS_CODEX_DIR: path.join(scratch, 'status-codex'),
      COCKPIT_CLEAR_CODEX_DIR: path.join(scratch, 'clear-codex'), COCKPIT_INBOX: path.join(scratch, 'inbox'),
    });

    const subir = async (nome, dir, porta) => {
      const s = spawn(process.execPath, [path.join(dir, 'server.js')], {
        cwd: dir, env: { ...ambienteBase, PORT: String(porta) }, stdio: ['ignore', 'ignore', 'pipe'],
      });
      servidores.push(s);
      s.stderr.on('data', (d) => process.stderr.write(`[server.js:${porta}] ${d}`));
      let pronto = false;
      for (let i = 0; i < 60 && !pronto; i += 1) {
        if (s.exitCode !== null) break;
        pronto = await saude(porta);
        if (!pronto) await espera(200);
      }
      if (!pronto) throw new Error(`o servidor ${nome} (${porta}) não subiu`);
      console.log(`  · servidor ${nome} no ar em http://127.0.0.1:${porta} (pid ${s.pid})`);
      return s;
    };

    const depois = await subir('depois', RAIZ, PORTA_DEPOIS);
    const base = `http://127.0.0.1:${PORTA_DEPOIS}/?token=${TOKEN}`;

    const feitos = [];
    const problemas = [];
    const todasAsMedidas = {};
    const juntar = (rel, chave) => {
      feitos.push(...rel.feitos); problemas.push(...rel.problemas);
      todasAsMedidas[chave] = rel.medidas;
    };

    for (const vp of ['celular', 'desktop']) {
      for (const tema of ['dark', 'light']) {
        const chave = `${vp}-${tema}`;
        console.log(`\n── ${chave} ──`);
        trocarRam(60);
        juntar(await rodarModo({ modo: 'normal', base, scratch, vp, tema }), `${chave}/normal`);
        trocarRam(94);                  // o HOST troca o meminfo ANTES do modo aviso
        juntar(await rodarModo({ modo: 'aviso', base, scratch, vp, tema }), `${chave}/aviso`);
        trocarRam(60);                  // e de volta ANTES do modo volta
        juntar(await rodarModo({ modo: 'volta', base, scratch, vp, tema }), `${chave}/volta`);
        trocarRam(60);
        juntar(await rodarModo({ modo: 'eixos', base, scratch, vp, tema }), `${chave}/eixos`);
      }
    }

    const pngs = fs.readdirSync(SAIDA).filter((n) => n.endsWith('.png')).sort();
    if (pngs.length !== 32) problemas.push(`esperava 32 PNGs, achei ${pngs.length}`);

    // CONTROLE NEGATIVO: o modo `eixos` contra a develop tem de reprovar no passo 7.
    process.kill(depois.pid);
    trocarRam(60);
    await subir('antes (develop)', antesDir, PORTA_ANTES);
    const neg = await rodarModo({ modo: 'eixos', base: `http://127.0.0.1:${PORTA_ANTES}/?token=${TOKEN}`, scratch, vp: 'celular', tema: 'dark', negativo: true });
    const reprovouNoPasso7 = neg.problemas.some((p) => /passo 7: seção do disco ausente/.test(p));
    console.log(`\n── controle negativo (develop@${shaDevelop.slice(0, 7)}) ──`);
    console.log(`  ${reprovouNoPasso7 ? '✅' : '❌'} antes: ${reprovouNoPasso7 ? 'reprovou (seção do disco ausente)' : 'NÃO reprovou — o roteiro não prova nada'}`);
    if (!reprovouNoPasso7) problemas.push('controle negativo: o roteiro passou (ou falhou por outro motivo) contra a develop');
    todasAsMedidas.controleNegativo = { reprovouNoPasso7, problemas: neg.problemas };

    console.log('\n── Resultado ──');
    for (const f of feitos) console.log('  ✅ ' + f);
    for (const p of problemas) console.log('  ❌ ' + p);
    console.log('\nPNGs:');
    for (const n of pngs) console.log('  ' + path.join(SAIDA, n));
    console.log('@@MEDIDAS@@' + JSON.stringify({ problemas, medidas: todasAsMedidas }));
    limpar();
    if (problemas.length) {
      console.log('\n❌ PROVA DE TELA REPROVADA');
      return process.exit(1);
    }
    console.log('\n✅ PROVA DE TELA OK — 32 PNGs e o controle negativo reprovou na develop (passo 7)');
    return process.exit(0);
  } catch (e) {
    console.error('🔴 estourou:', e.message);
    limpar();
    return process.exit(1);
  }
})();
