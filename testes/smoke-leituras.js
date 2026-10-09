#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — a vista "leituras" (cards `leituras-trilhas` 2026-10-02 e `leituras-v2`
// 2026-10-04; spec docs/superpowers/specs/2026-10-04-leituras-v2-design.md, §7.3).
//
// Molde: `testes/smoke-lido-dois-aparelhos.js` (servidor filho + `docker run --network host`
// com a imagem `cockpit-smoke:latest` + roteiro puppeteer). SEM tmux: esta vista não depende
// de pane nenhuma — por isso `COCKPIT_TMUX_SOCKET` aponta para um socket que NUNCA é criado.
//
// Cenários:
//   1) celular marca `ia-0` num progresso vazio, recarrega a página, confere que persistiu.
//   2) desktop faz o MESMO percurso, servidor e pasta PRÓPRIOS (nunca o mesmo arquivo do 1).
//   3) catálogo ausente (`COCKPIT_TRILHAS` para um arquivo que não existe) — um servidor só,
//      os dois viewports (celular e desktop), porque é leitura pura, sem marcar nada.
//   4) "lendo" (D61, card leituras-v2) — celular/desktop × claro/escuro, 4 corridas, servidor e
//      pasta PRÓPRIOS cada: marca "lendo", recarrega, filtra por texto e por status, termina um
//      livro que estava lendo.
//      Ajuste 05/10: no mesmo percurso, escolhe uma trilha no <select>, recolhe a trilha ia
//      (sobrevive à batida de 5 s e ao reload) e busca um livro dela (a busca a abre).
//      Ajuste 06/10: o "Lendo agora" passa pelo mesmo filtro — a busca e o status o filtram, a
//      trilha escolhida esconde o livro da outra (print 17: trilha IA com só ia-1 no topo).
//   6) catálogo REAL (ajuste 05/10) — só se `TRILHAS_REAL` (padrão: o trilhas.json do
//      midia-exemplo) existir: SÓ LEITURA, nenhum clique que grave; pasta de progresso vazia e
//      temporária. Prova o <select> e o recolhido com as 6 trilhas de verdade.
//   5) "antes" — mesmo percurso visual do cenário 4, mas contra a develop EXPORTADA (sem o
//      código novo), só se `RAIZ_ANTES` apontar para uma pasta com `server.js`. Sem a env, pula
//      e AVISA no fim (não é verde silencioso).
//
// Códigos de saída: 0 = passou · 1 = falha de produto/assert · 2 = erro de USO ou de AMBIENTE
// (imagem docker ausente).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA || path.join(os.homedir(), '.cockpit', 'smoke-shots', '2026-10-04-leituras-v2');
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const RAIZ_ANTES = process.env.RAIZ_ANTES || '';
const TEM_ANTES = Boolean(RAIZ_ANTES) && fs.existsSync(path.join(RAIZ_ANTES, 'server.js'));
// Catálogo de OUTRO projeto: só é passado ao servidor filho, que só o LÊ. Nunca escrito aqui.
const TRILHAS_REAL = process.env.TRILHAS_REAL || process.env.COCKPIT_TRILHAS || path.join(os.homedir(), '.cockpit', 'trilhas.json');
const TEM_REAL = fs.existsSync(TRILHAS_REAL);

// celular/desktop × claro/escuro — a ordem em que os PNGs do cenário "lendo" nascem.
const COMBOS = [
  ['celular', 'claro'], ['celular', 'escuro'],
  ['desktop', 'claro'], ['desktop', 'escuro'],
];

const PNGS = [
  '01-celular-antes', '01-celular-marcado', '01-celular-catalogo-ausente',
  '02-desktop-antes', '02-desktop-marcado', '02-desktop-catalogo-ausente',
  ...COMBOS.flatMap(([aparelho, tema]) => [
    `10-${aparelho}-${tema}-lendo`,
    `11-${aparelho}-${tema}-filtro-texto`,
    `12-${aparelho}-${tema}-filtro-status`,
    `13-${aparelho}-${tema}-terminado`,
    `14-${aparelho}-${tema}-seletor-trilha`,
    `15-${aparelho}-${tema}-recolhida`,
    `16-${aparelho}-${tema}-busca-abre`,
    `17-${aparelho}-${tema}-lendo-filtrado`,
  ]),
  ...(TEM_REAL ? COMBOS.flatMap(([aparelho, tema]) => [
    `20-${aparelho}-${tema}-real-seletor`,
    `21-${aparelho}-${tema}-real-recolhidas`,
  ]) : []),
  // Os PNGs "antes" só entram na lista — e só são exigidos — quando RAIZ_ANTES existe.
  ...(TEM_ANTES ? COMBOS.map(([aparelho, tema]) => `00-antes-${aparelho}-${tema}`) : []),
];

// ─── Porta — fail-closed, nunca herdada, nunca 7879 (produção)/7899 (jobs)/7897 (celular) ───

function portaLivre(porta) {
  try {
    const saida = execFileSync('ss', ['-H', '-lptn'], { encoding: 'utf8' });
    return !saida.split('\n').some((linha) => (linha.trim().split(/\s+/)[3] || '').endsWith(`:${porta}`));
  } catch {
    return true;
  }
}
const FAIXA = [7893, 7892, 7891, 7894, 7895, 7898];
function proximaPorta() {
  const p = FAIXA.find(portaLivre);
  if (!p) throw new Error('nenhuma porta livre na faixa 7891-7895/7898 — abortando sem subir servidor.');
  return p;
}

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
// Socket que nunca é criado: esta vista não depende de tmux nenhum.
const SOCKET = `cockpit-smoke-leituras-${process.pid}`;

let falhas = 0;
let feitos = 0;
const avisos = [];
const ok = (c, texto) => { feitos += 1; if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${texto}`); return c; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Ambiente FECHADO (#78): só o que está aqui — nunca herdar `COCKPIT_TOKEN` do ambiente de
 *  quem roda o smoke (a tela tem de funcionar sem token, como a produção real faz hoje).
 *  `raizApp` (padrão a worktree) é quem sobe `server.js` — o cenário "antes" passa a pasta da
 *  develop exportada em /tmp, nunca uma worktree manual (R7 da auditoria). */
function subirServidor({ scratch, dirLeituras, trilhas, porta, raizApp = path.join(__dirname, '..') }) {
  return new Promise((resolve, reject) => {
    // Lista FECHADA (#78): NENHUM `COCKPIT_*` herdado — não só o token. `COCKPIT_USO_DIR` e os
    // irmãos vencem o HOME falso, e o boot do server.js apaga cache de uso velho
    // (lib/uso.js:494): herdado apontando para produção, o smoke apagaria o cache de verdade
    // (painel de execução, Codex [Alta]).
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('COCKPIT_')) delete env[k];
    Object.assign(env, {
      HOME: path.join(scratch, 'home'), HOST: '127.0.0.1', PORT: String(porta),
      COCKPIT_CERT_DIR: '/dev/null', COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_JOBS_DIR: path.join(scratch, 'jobs-inexistente'),
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
      COCKPIT_LEITURAS_DIR: dirLeituras, COCKPIT_TRILHAS: trilhas,
      COCKPIT_VIGIA_MS: '0', COCKPIT_BIN_CLAUDE: '/bin/true',
    });
    const processo = spawn(process.execPath, [path.join(raizApp, 'server.js')], {
      cwd: raizApp, env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let decidido = false;
    processo.once('exit', (codigo) => {
      if (!decidido) { decidido = true; reject(new Error(`server.js caiu antes de subir (código ${codigo})`)); }
    });
    processo.stderr.on('data', (d) => process.stderr.write(`[server.js:${porta}] ${d}`));
    (async () => {
      for (let i = 0; i < 60 && !decidido; i += 1) {
        if (await saude(porta)) { decidido = true; resolve(processo); return; }
        await espera(200);
      }
      if (!decidido) { decidido = true; reject(new Error(`server.js (${porta}) não respondeu a tempo`)); }
    })();
  });
}

/** Derruba pelo PID EXATO — nunca pkill (#19) — e espera o processo sair de verdade. */
function derrubar(processo) {
  return new Promise((resolve) => {
    if (!processo || processo.exitCode !== null) return resolve();
    processo.once('exit', () => resolve());
    processo.kill('SIGTERM');
  });
}

function rodarDocker({ base, aparelho, modo, scratch, tema = 'escuro', caminhoAusente = '' }) {
  return new Promise((resolve) => {
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=${base}`, '-e', `APARELHO=${aparelho}`, '-e', `MODO=${modo}`, '-e', `TEMA=${tema}`,
      '-e', `CAMINHO_AUSENTE=${caminhoAusente}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let saidaTexto = '';
    docker.stdout.on('data', (d) => { saidaTexto += d; });
    docker.stderr.on('data', (d) => { saidaTexto += d; });
    docker.on('close', (codigo) => resolve({ codigo, saidaTexto }));
  });
}

// ─── O roteiro — um PAGE por cenário, MODO=marcar|ausente|lendo|antes, APARELHO=celular|desktop ─

function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');
const BASE = process.env.BASE;
const APARELHO = process.env.APARELHO;
const MODO = process.env.MODO;
const TEMA = process.env.TEMA;
const CAMINHO_AUSENTE = process.env.CAMINHO_AUSENTE;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = {
  celular: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { width: 1400, height: 900 },
};
const PREFIXO = APARELHO === 'celular' ? '01' : '02';

// Defensivo (#52): escopar pela SEÇÃO da trilha, nunca \`[data-trilha="x"]\` sozinho — mesmo
// com os chips do filtro usando \`data-filtro-trilha\` (sem colisão hoje), um chip futuro que
// reusasse \`data-trilha\` seria achado no lugar da seção.
const contadorDaTrilha = (pagina, trilhaId) => pagina.evaluate((id) => {
  const secao = document.querySelector('.leituras-trilha[data-trilha="' + id + '"]');
  const contador = secao && secao.querySelector('.leituras-contador');
  return contador ? contador.textContent.trim() : null;
}, trilhaId);

const temProximo = (pagina, livroId) => pagina.evaluate((id) => (
  Boolean(document.querySelector('[data-livro="' + id + '"][data-proximo="1"]'))
), livroId);

// Clique de VERDADE (mouse no centro do elemento, com rolagem até ele): \`caixa.click()\` dentro
// de \`evaluate\` funcionaria até com a caixa encoberta ou fora da tela, e não provaria que o
// dedo consegue marcar (painel de execução, Codex).
const clicarCaixaDoLivro = async (pagina, livroId) => {
  const caixa = await pagina.$('[data-livro="' + livroId + '"] input');
  if (!caixa) return false;
  await caixa.click();
  return true;
};

const clicarBotaoLendo = async (pagina, livroId) => {
  const botao = await pagina.$('[data-livro="' + livroId + '"] button.livro-lendo');
  if (!botao) return false;
  await botao.click();
  return true;
};

const botaoLendoEstado = (pagina, livroId) => pagina.evaluate((id) => {
  const linha = document.querySelector('[data-livro="' + id + '"]');
  const botao = linha ? linha.querySelector('button.livro-lendo') : null;
  return botao ? { disabled: botao.disabled, pressed: botao.getAttribute('aria-pressed') } : null;
}, livroId);

const estadoDoLivro = (pagina, livroId) => pagina.evaluate((id) => {
  const label = document.querySelector('[data-livro="' + id + '"]');
  if (!label) return null;
  const caixa = label.querySelector('input');
  const data = label.querySelector('.livro-data');
  return { checked: caixa ? caixa.checked : null, data: data ? data.textContent.trim() : '' };
}, livroId);

const textoDaVista = (pagina) => pagina.evaluate(() => {
  const el = document.getElementById('abas');
  return el ? el.textContent : '';
});

// No navegador de verdade o combinador por espaço FUNCIONA (ao contrário do DOM falso do
// gate-ui.js) — usado aqui sem o escopo em dois passos.
const idsNasTrilhas = (pagina) => pagina.evaluate(() => (
  Array.from(document.querySelectorAll('.leituras-trilha .livro')).map((l) => l.dataset.livro)
));

// Ajuste 06/10: o que está no "Lendo agora" — \`null\` quando a seção nem existe.
const idsNoLendoAgora = (pagina) => pagina.evaluate(() => {
  const secao = document.querySelector('.leituras-lendo-agora');
  return secao ? Array.from(secao.querySelectorAll('.livro')).map((l) => l.dataset.lendoAgora) : null;
});

const rolarListaAoTopo = (pagina) => pagina.evaluate(() => {
  const el = document.getElementById('abas');
  if (el) el.scrollTop = 0;
});

// Trilha recolhível (ajuste 05/10): estado lido do DOM de verdade — o botão do cabeçalho e os
// livros que a seção tem desenhados.
const estadoDaTrilha = (pagina, trilhaId) => pagina.evaluate((id) => {
  const secao = document.querySelector('.leituras-trilha[data-trilha="' + id + '"]');
  if (!secao) return null;
  const botao = secao.querySelector('.leituras-alternar');
  return {
    expandido: botao ? botao.getAttribute('aria-expanded') : null,
    seta: (secao.querySelector('.leituras-seta') || {}).textContent || '',
    livros: secao.querySelectorAll('.livro').length,
    contador: (secao.querySelector('.leituras-contador') || {}).textContent || '',
  };
}, trilhaId);

const abrirLeituras = async (pagina) => {
  await pagina.reload({ waitUntil: 'networkidle2' });
  await pagina.waitForSelector('#abas', { timeout: 15000 });
  await pagina.click('#barra-leituras');
  await pagina.waitForSelector('.leituras-trilha', { timeout: 15000 });
  await espera(400);
};

const problemas = [];

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const contexto = await navegador.createBrowserContext();
  const pagina = await contexto.newPage();
  const erros = [];
  pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push('CONSOLE: ' + m.text().slice(0, 200)); });
  pagina.on('response', (r) => { if (r.status() >= 400) erros.push(r.status() + ' ' + r.url()); });

  // Idioma fixo: sem isto o i18n.js escolhe inglês se o Chromium do container disser en-US,
  // e os \`exigir\` de texto em português reprovariam uma tela certa. O \`try\` é necessário
  // porque o puppeteer roda este script também no \`about:blank\` inicial (origem opaca, sem
  // localStorage) antes do \`goto\` — sem ele, um PAGEERROR de propósito nenhum reprovava o
  // percurso (achado ao rodar o smoke pela primeira vez, intermitente por aparelho).
  await pagina.evaluateOnNewDocument(() => {
    try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch { /* about:blank — ignora */ }
  });
  await pagina.setViewport(VIEWPORTS[APARELHO]);
  // TEMA (D61): claro força \`prefers-color-scheme: light\`, qualquer outra coisa (inclusive
  // ausente, nos cenários 1-3 que não testam contraste) força \`dark\` — determinístico, nunca
  // o tema do host. Não grava \`cockpit-tema\`: quem manda é o \`prefers-color-scheme\` emulado.
  await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: TEMA === 'claro' ? 'light' : 'dark' }]);
  await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  await pagina.waitForSelector('#abas', { timeout: 15000 });

  await pagina.click('#barra-leituras');
  await pagina.waitForSelector('.leituras-trilha', { timeout: 15000 }).catch(() => {});
  await espera(400);

  if (MODO === 'ausente') {
    const texto = await textoDaVista(pagina);
    if (!texto.includes('catálogo não encontrado')) {
      problemas.push('texto "catálogo não encontrado" ausente (' + texto.slice(0, 200) + ')');
    }
    // O caminho esperado tem de estar NA TELA — é o que diz ao dono onde pôr o arquivo.
    if (!texto.includes(CAMINHO_AUSENTE)) {
      problemas.push('caminho do catálogo ausente da tela (esperava ' + CAMINHO_AUSENTE + ')');
    }
    await pagina.screenshot({ path: '/out/' + PREFIXO + '-' + APARELHO + '-catalogo-ausente.png' });
  } else if (MODO === 'antes') {
    // Só visual: a develop exportada não conhece "lendo" nem filtro — prova que a página sobe
    // e desenha as 2 trilhas, sem erro de console. PNG antes/depois é o próprio par de pastas.
    const trilhas = await pagina.evaluate(() => document.querySelectorAll('.leituras-trilha').length);
    if (trilhas !== 2) problemas.push('MODO antes: esperava 2 .leituras-trilha, veio ' + trilhas);
    await pagina.screenshot({ path: '/out/00-antes-' + APARELHO + '-' + TEMA + '.png' });
  } else if (MODO === 'lendo') {
    // 5.1 — marca ia-1 e eco-1 como "lendo": clique de verdade, espera o POST 200 e SÓ ENTÃO o
    // botão daquele livro voltar a disabled=false com aria-pressed="true" (o \`data-lendo\`
    // sozinho aparece ANTES do POST, pelo valor pretendido — painel do plano r2, Codex).
    for (const livroId of ['ia-1', 'eco-1']) {
      const esperaPost = pagina.waitForResponse(
        (r) => r.url().includes('api/leituras') && r.request().method() === 'POST',
        { timeout: 15000 },
      );
      const clicou = await clicarBotaoLendo(pagina, livroId);
      if (!clicou) problemas.push('não achei o botão "lendo" de ' + livroId);
      else {
        const resp = await esperaPost.catch(() => null);
        if (!resp || resp.status() !== 200) problemas.push('POST de lendo (' + livroId + ') não veio 200 (' + (resp && resp.status()) + ')');
        let habilitado = null;
        for (let i = 0; i < 30; i += 1) {
          habilitado = await botaoLendoEstado(pagina, livroId);
          if (habilitado && habilitado.disabled === false && habilitado.pressed === 'true') break;
          await espera(200);
        }
        if (!habilitado || habilitado.disabled !== false || habilitado.pressed !== 'true') {
          problemas.push('botão "lendo" de ' + livroId + ' não reabilitou a tempo (' + JSON.stringify(habilitado) + ')');
        }
      }
    }

    // 5.2 — reload, abre leituras, "Lendo agora" com os dois, próximo/terminado certos.
    await pagina.reload({ waitUntil: 'networkidle2' });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await pagina.click('#barra-leituras');
    await pagina.waitForSelector('.leituras-trilha', { timeout: 15000 });
    await espera(400);

    const temLendoAgora = await pagina.evaluate(() => (
      Boolean(document.querySelector('.leituras-lendo-agora [data-lendo-agora="ia-1"]'))
      && Boolean(document.querySelector('.leituras-lendo-agora [data-lendo-agora="eco-1"]'))
    ));
    if (!temLendoAgora) problemas.push('"Lendo agora" não tem ia-1 e eco-1 depois do reload');

    const ia0Riscado = await pagina.evaluate(() => {
      const titulo = document.querySelector('[data-livro="ia-0"] .livro-titulo');
      return titulo ? getComputedStyle(titulo).textDecorationLine.includes('line-through') : false;
    });
    if (!ia0Riscado) problemas.push('ia-0 (terminado) sem text-decoration: line-through');

    if (!(await temProximo(pagina, 'eco-0'))) problemas.push('eco-0 não é o próximo da economia');
    const nenhumProximoNaIa = await pagina.evaluate(() => (
      document.querySelectorAll('.leituras-trilha[data-trilha="ia"] [data-proximo="1"]').length === 0
    ));
    if (!nenhumProximoNaIa) problemas.push('a trilha ia tem [data-proximo] — deveria ter nenhum (ia-1 lendo, ia-2 opcional)');

    const cores = await pagina.evaluate(() => {
      const prova = document.createElement('span');
      prova.style.color = 'var(--texto-2)';
      document.body.appendChild(prova);
      const esperado = getComputedStyle(prova).color;
      prova.remove();
      const autor = document.querySelector('[data-livro="ia-1"] .livro-autor');
      return { esperado, real: autor ? getComputedStyle(autor).color : null };
    });
    if (!cores.real || cores.real !== cores.esperado) {
      problemas.push('cor efetiva de .livro-autor (ia-1) != --texto-2 resolvida (' + JSON.stringify(cores) + ')');
    }

    await rolarListaAoTopo(pagina);
    await pagina.screenshot({ path: '/out/10-' + APARELHO + '-' + TEMA + '-lendo.png' });

    // 5.3 — busca por texto, digitada em duas partes com uma batida do tique (5s) no meio.
    await pagina.click('#filtro-texto');
    await pagina.keyboard.type('rap');
    await espera(5500);
    await pagina.keyboard.type('ido');

    const focoEValor = await pagina.evaluate(() => ({
      foco: document.activeElement && document.activeElement.id,
      valor: document.getElementById('filtro-texto').value,
    }));
    if (focoEValor.foco !== 'filtro-texto' || focoEValor.valor !== 'rapido') {
      problemas.push('busca perdeu foco ou valor (' + JSON.stringify(focoEValor) + ')');
    }
    const soEco1 = JSON.stringify(await idsNasTrilhas(pagina)) === JSON.stringify(['eco-1']);
    if (!soEco1) problemas.push('busca "rapido" não isolou eco-1 (' + JSON.stringify(await idsNasTrilhas(pagina)) + ')');
    // Ajuste 06/10: a busca filtra o "Lendo agora" também — ia-1 sai, só eco-1 fica no topo.
    const lendoAgoraNaBusca = await idsNoLendoAgora(pagina);
    if (JSON.stringify(lendoAgoraNaBusca) !== JSON.stringify(['eco-1'])) {
      problemas.push('busca "rapido" não filtrou o "Lendo agora" (' + JSON.stringify(lendoAgoraNaBusca) + ')');
    }

    await pagina.screenshot({ path: '/out/11-' + APARELHO + '-' + TEMA + '-filtro-texto.png' });

    // 5.4 — limpa a busca (seleção tripla + Backspace), filtra por status "lidos", recarrega
    // e confere que o filtro salvo no aparelho sobrevive ao reload.
    await pagina.click('#filtro-texto', { clickCount: 3 });
    await pagina.keyboard.press('Backspace');
    await pagina.click('[data-filtro-status="lidos"]');

    const soIa0 = JSON.stringify(await idsNasTrilhas(pagina)) === JSON.stringify(['ia-0']);
    if (!soIa0) problemas.push('status "lidos" não isolou ia-0 (' + JSON.stringify(await idsNasTrilhas(pagina)) + ')');
    const contadorIaAposStatus = await contadorDaTrilha(pagina, 'ia');
    if (contadorIaAposStatus !== '1/3') problemas.push('contador ia mudou com o filtro (' + contadorIaAposStatus + ')');
    // Ajuste 06/10: com "lidos" ninguém que está lendo passa — a seção some, cabeçalho junto.
    if ((await idsNoLendoAgora(pagina)) !== null) problemas.push('status "lidos" deixou o "Lendo agora" na tela');

    await pagina.screenshot({ path: '/out/12-' + APARELHO + '-' + TEMA + '-filtro-status.png' });

    await pagina.reload({ waitUntil: 'networkidle2' });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await pagina.click('#barra-leituras');
    await pagina.waitForSelector('.leituras-trilha', { timeout: 15000 });
    await espera(400);
    const lidosContinuaPressed = await pagina.evaluate(() => {
      const chip = document.querySelector('[data-filtro-status="lidos"]');
      return chip ? chip.getAttribute('aria-pressed') : null;
    });
    if (lidosContinuaPressed !== 'true') problemas.push('filtro de status não persistiu no reload (' + lidosContinuaPressed + ')');
    await pagina.click('[data-filtro-status="todos"]');
    await espera(200);

    // 5.5 — termina eco-1 (que estava lendo): sai do "Lendo agora", ia-1 continua lá.
    const clicouCheckbox = await clicarCaixaDoLivro(pagina, 'eco-1');
    if (!clicouCheckbox) problemas.push('não achei o checkbox de eco-1 para terminar');

    let saiuDoLendoAgora = false;
    let eco1Terminado = false;
    let ia1AindaLendo = false;
    for (let i = 0; i < 30; i += 1) {
      const estado = await pagina.evaluate(() => ({
        eco1NoLendoAgora: Boolean(document.querySelector('[data-lendo-agora="eco-1"]')),
        ia1NoLendoAgora: Boolean(document.querySelector('[data-lendo-agora="ia-1"]')),
        eco1Terminado: (() => {
          const el = document.querySelector('[data-livro="eco-1"]');
          return el ? el.dataset.terminado === '1' : false;
        })(),
      }));
      saiuDoLendoAgora = !estado.eco1NoLendoAgora;
      eco1Terminado = estado.eco1Terminado;
      ia1AindaLendo = estado.ia1NoLendoAgora;
      if (saiuDoLendoAgora && eco1Terminado && ia1AindaLendo) break;
      await espera(200);
    }
    if (!saiuDoLendoAgora) problemas.push('eco-1 não saiu de "Lendo agora" a tempo');
    if (!eco1Terminado) problemas.push('eco-1 não ficou data-terminado a tempo');
    if (!ia1AindaLendo) problemas.push('ia-1 saiu de "Lendo agora" junto — deveria continuar');

    await pagina.screenshot({ path: '/out/13-' + APARELHO + '-' + TEMA + '-terminado.png' });

    // 5.6 (ajuste 05/10) — sem etiqueta "lendo" na linha da trilha (o botão já diz).
    const etiquetasLendo = await pagina.evaluate(() => document.querySelectorAll('.etiqueta-lendo').length);
    if (etiquetasLendo !== 0) problemas.push('ainda há ' + etiquetasLendo + ' .etiqueta-lendo na vista');

    // 5.7 — o <select> de trilha: escolhe "economia" (o \`select\` do puppeteer dispara o change
    // como o dedo), só ela fica; volta a "todas".
    await pagina.select('#filtro-trilha', 'economia');
    await espera(200);
    const soEconomia = await pagina.evaluate(() => ({
      valor: document.getElementById('filtro-trilha').value,
      trilhas: Array.from(document.querySelectorAll('.leituras-trilha')).map((s) => s.dataset.trilha),
      opcoes: Array.from(document.querySelectorAll('#filtro-trilha option')).map((o) => o.textContent),
    }));
    if (soEconomia.valor !== 'economia' || JSON.stringify(soEconomia.trilhas) !== '["economia"]') {
      problemas.push('seletor "economia" não isolou a trilha (' + JSON.stringify(soEconomia) + ')');
    }
    if (JSON.stringify(soEconomia.opcoes) !== JSON.stringify(['todas as trilhas', 'IA', 'Economia'])) {
      problemas.push('opções do seletor erradas (' + JSON.stringify(soEconomia.opcoes) + ')');
    }
    // Ajuste 06/10: eco-1 já terminou (5.5) e ia-1 é de IA — com Economia escolhida, o "Lendo
    // agora" não tem ninguém e SOME (era o caso do dono: livro de IA no topo com Economia escolhida).
    if ((await idsNoLendoAgora(pagina)) !== null) problemas.push('trilha Economia deixou o "Lendo agora" na tela (' + JSON.stringify(await idsNoLendoAgora(pagina)) + ')');
    await rolarListaAoTopo(pagina);
    await pagina.screenshot({ path: '/out/14-' + APARELHO + '-' + TEMA + '-seletor-trilha.png' });

    // 5.7b (ajuste 06/10) — trilha IA escolhida: o "Lendo agora" fica só com ia-1, e a lista só
    // com a trilha IA. O print 17 é a prova visual do "Lendo agora" filtrado.
    await pagina.select('#filtro-trilha', 'ia');
    await espera(200);
    const lendoAgoraIa = await idsNoLendoAgora(pagina);
    const trilhasIa = await pagina.evaluate(() => Array.from(document.querySelectorAll('.leituras-trilha')).map((s) => s.dataset.trilha));
    if (JSON.stringify(lendoAgoraIa) !== JSON.stringify(['ia-1']) || JSON.stringify(trilhasIa) !== '["ia"]') {
      problemas.push('trilha IA: esperava "Lendo agora" = [ia-1] e só a trilha ia (' + JSON.stringify({ lendoAgoraIa, trilhasIa }) + ')');
    }
    await rolarListaAoTopo(pagina);
    await pagina.screenshot({ path: '/out/17-' + APARELHO + '-' + TEMA + '-lendo-filtrado.png' });
    await pagina.select('#filtro-trilha', '');
    await espera(200);

    // 5.8 — recolhe a ia com clique de verdade; a batida de 5 s e o reload não desfazem.
    await pagina.click('.leituras-trilha[data-trilha="ia"] .leituras-alternar');
    await espera(200);
    let ia = await estadoDaTrilha(pagina, 'ia');
    if (!ia || ia.expandido !== 'false' || ia.livros !== 0 || ia.seta !== '▸' || ia.contador !== '1/3') {
      problemas.push('ia não recolheu certo (' + JSON.stringify(ia) + ')');
    }
    await espera(5500);
    ia = await estadoDaTrilha(pagina, 'ia');
    if (!ia || ia.expandido !== 'false' || ia.livros !== 0) problemas.push('a batida de 5 s desfez o recolhido (' + JSON.stringify(ia) + ')');
    await abrirLeituras(pagina);
    ia = await estadoDaTrilha(pagina, 'ia');
    if (!ia || ia.expandido !== 'false' || ia.livros !== 0) problemas.push('o recolhido não sobreviveu ao reload (' + JSON.stringify(ia) + ')');
    const eco = await estadoDaTrilha(pagina, 'economia');
    if (!eco || eco.expandido !== 'true' || eco.livros !== 2 || eco.seta !== '▾') problemas.push('economia deveria seguir aberta (' + JSON.stringify(eco) + ')');
    await rolarListaAoTopo(pagina);
    await pagina.screenshot({ path: '/out/15-' + APARELHO + '-' + TEMA + '-recolhida.png' });

    // 5.9 — busca "super" abre a ia recolhida (só ia-2); limpar volta ao recolhido salvo.
    await pagina.click('#filtro-texto');
    await pagina.keyboard.type('super');
    await espera(200);
    ia = await estadoDaTrilha(pagina, 'ia');
    if (!ia || ia.expandido !== 'true' || ia.livros !== 1) problemas.push('a busca não abriu a ia recolhida (' + JSON.stringify(ia) + ')');
    await rolarListaAoTopo(pagina);
    await pagina.screenshot({ path: '/out/16-' + APARELHO + '-' + TEMA + '-busca-abre.png' });
    await pagina.click('#filtro-texto', { clickCount: 3 });
    await pagina.keyboard.press('Backspace');
    await espera(200);
    ia = await estadoDaTrilha(pagina, 'ia');
    if (!ia || ia.expandido !== 'false' || ia.livros !== 0) problemas.push('limpar a busca não voltou ao recolhido (' + JSON.stringify(ia) + ')');
  } else if (MODO === 'real') {
    // Catálogo REAL, SÓ LEITURA: nenhum clique em caixa nem em "lendo" — só filtro e recolher,
    // que moram no localStorage do navegador descartável.
    const real = await pagina.evaluate(() => ({
      trilhas: Array.from(document.querySelectorAll('.leituras-trilha')).map((s) => s.dataset.trilha),
      opcoes: Array.from(document.querySelectorAll('#filtro-trilha option')).map((o) => o.value),
    }));
    if (real.trilhas.length < 2) problemas.push('catálogo real com menos de 2 trilhas na tela (' + real.trilhas.length + ')');
    if (JSON.stringify(real.opcoes) !== JSON.stringify([''].concat(real.trilhas))) {
      problemas.push('opções do seletor != todas + trilhas do catálogo (' + JSON.stringify(real) + ')');
    }
    console.log('@@TRILHAS-REAIS@@' + JSON.stringify(real.trilhas));
    const escolhida = real.trilhas[1];
    await pagina.select('#filtro-trilha', escolhida);
    await espera(200);
    const so = await pagina.evaluate(() => Array.from(document.querySelectorAll('.leituras-trilha')).map((s) => s.dataset.trilha));
    if (JSON.stringify(so) !== JSON.stringify([escolhida])) problemas.push('seletor no real não isolou ' + escolhida + ' (' + JSON.stringify(so) + ')');
    await rolarListaAoTopo(pagina);
    await pagina.screenshot({ path: '/out/20-' + APARELHO + '-' + TEMA + '-real-seletor.png' });

    // Volta a todas e recolhe todas menos a ÚLTIMA: todos os cabeçalhos (com k/N) cabem na tela
    // de cima e a aberta fica embaixo — as duas setas na mesma foto.
    await pagina.select('#filtro-trilha', '');
    await espera(200);
    const aberta = real.trilhas[real.trilhas.length - 1];
    for (const id of real.trilhas) {
      if (id === aberta) continue;
      await pagina.click('.leituras-trilha[data-trilha="' + id + '"] .leituras-alternar');
      await espera(150);
    }
    const estados = [];
    for (const id of real.trilhas) estados.push([id, await estadoDaTrilha(pagina, id)]);
    for (const [id, e] of estados) {
      const deveAberta = id === aberta;
      if (!e || e.expandido !== String(deveAberta) || (deveAberta ? e.livros === 0 : e.livros !== 0)) {
        problemas.push('real: ' + id + ' deveria estar ' + (deveAberta ? 'aberta' : 'recolhida') + ' (' + JSON.stringify(e) + ')');
      }
    }
    await rolarListaAoTopo(pagina);
    await pagina.screenshot({ path: '/out/21-' + APARELHO + '-' + TEMA + '-real-recolhidas.png' });
  } else {
    const trilhas = await pagina.evaluate(() => document.querySelectorAll('.leituras-trilha').length);
    if (trilhas !== 2) problemas.push('esperava 2 .leituras-trilha, veio ' + trilhas);
    const contadorAntes = await contadorDaTrilha(pagina, 'ia');
    if (contadorAntes !== '0/3') problemas.push('contador ia ANTES != 0/3 (' + contadorAntes + ')');
    if (!(await temProximo(pagina, 'ia-0'))) problemas.push('ia-0 não é o próximo antes de marcar');
    await pagina.screenshot({ path: '/out/' + PREFIXO + '-' + APARELHO + '-antes.png' });

    const clicou = await clicarCaixaDoLivro(pagina, 'ia-0');
    if (!clicou) problemas.push('não achei a caixa de ia-0 para clicar');

    let contadorDepois = null;
    for (let i = 0; i < 30; i += 1) {
      contadorDepois = await contadorDaTrilha(pagina, 'ia');
      if (contadorDepois === '1/3') break;
      await espera(200);
    }
    if (contadorDepois !== '1/3') problemas.push('contador ia não virou 1/3 a tempo (' + contadorDepois + ')');

    // A vista é MOMENTÂNEA (D51): o reload nasce em conversas — por isso clica de novo.
    await pagina.reload({ waitUntil: 'networkidle2' });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await pagina.click('#barra-leituras');
    await pagina.waitForSelector('.leituras-trilha', { timeout: 15000 });
    await espera(400);

    const estadoIa0 = await estadoDoLivro(pagina, 'ia-0');
    if (!estadoIa0 || estadoIa0.checked !== true) problemas.push('ia-0 não está checked depois do reload (' + JSON.stringify(estadoIa0) + ')');
    if (!estadoIa0 || !estadoIa0.data) problemas.push('ia-0 sem .livro-data depois do reload');
    const contadorFinal = await contadorDaTrilha(pagina, 'ia');
    if (contadorFinal !== '1/3') problemas.push('contador FINAL != 1/3 (' + contadorFinal + ')');
    if (!(await temProximo(pagina, 'ia-1'))) problemas.push('ia-1 não virou o próximo depois de marcar ia-0');

    await pagina.screenshot({ path: '/out/' + PREFIXO + '-' + APARELHO + '-marcado.png' });
  }

  if (erros.length) problemas.push(erros.length + ' erro(s)/requisição(ões) ruim(ns): ' + erros.slice(0, 5).join(' | '));

  await navegador.close();
  console.log('@@MEDIDAS-SMOKE-LEITURAS@@' + JSON.stringify({ problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e);
  process.exit(1);
});
`;
}

// ─── Corrida ─────────────────────────────────────────────────────────────────

(async () => {
  let saida = 1;
  let scratch = null;
  let servidorAtual = null;

  // R9/§10 da spec, o fato do qual a segurança depende: nenhum teste nem smoke grava no
  // `~/.cockpit/leituras.json` de produção, e nada no cockpit grava em `~/projetos/midia-
  // exemplo`. Capturado ANTES de tocar em qualquer coisa — comparar só no fim seria tarde
  // demais para provar que nada mudou NO MEIO. `ENOENT` trata como `ausente`, nunca cria pasta.
  const ARQ_PRODUCAO = path.join(os.homedir(), '.cockpit', 'leituras.json');
  const mtimeAntes = fs.existsSync(ARQ_PRODUCAO) ? fs.statSync(ARQ_PRODUCAO).mtimeMs : null;
  const impressaoCatalogo = () => {
    if (!fs.existsSync(TRILHAS_REAL)) return null;
    const st = fs.statSync(TRILHAS_REAL);
    return { tamanho: st.size, mtimeMs: st.mtimeMs, sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(TRILHAS_REAL)).digest('hex') };
  };
  const catalogoAntes = impressaoCatalogo();

  function limpar() {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }

  try {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
      console.error(`   PNGs NÃO gerados: ${PNGS.join(', ')}`);
      return process.exit(2);
    }

    fs.mkdirSync(SAIDA, { recursive: true });
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-leituras-'));
    fs.mkdirSync(path.join(scratch, 'home'), { recursive: true });
    const FIXTURE = path.join(__dirname, 'fixtures', 'trilhas-teste.json');
    const NAO_EXISTE = path.join(scratch, 'nao-existe.json');
    fs.writeFileSync(path.join(scratch, 'pane.js'), montarRoteiro());

    const resultados = [];

    // ── Cenário 1: celular marca ia-0 num progresso NOVO e vazio ────────────────────────────
    const dirCelular = fs.mkdtempSync(path.join(scratch, 'leituras-celular-'));
    let porta = proximaPorta();
    servidorAtual = await subirServidor({ scratch, dirLeituras: dirCelular, trilhas: FIXTURE, porta });
    console.log(`  · servidor celular no ar em http://127.0.0.1:${porta} (pid ${servidorAtual.pid})`);
    resultados.push(['celular (marcar)', await rodarDocker({ base: `http://127.0.0.1:${porta}`, aparelho: 'celular', modo: 'marcar', scratch })]);
    console.log(resultados[resultados.length - 1][1].saidaTexto);
    await derrubar(servidorAtual); servidorAtual = null;

    // ── Cenário 2: desktop — servidor E pasta de progresso PRÓPRIOS (nunca o mesmo arquivo) ─
    const dirDesktop = fs.mkdtempSync(path.join(scratch, 'leituras-desktop-'));
    porta = proximaPorta();
    servidorAtual = await subirServidor({ scratch, dirLeituras: dirDesktop, trilhas: FIXTURE, porta });
    console.log(`  · servidor desktop no ar em http://127.0.0.1:${porta} (pid ${servidorAtual.pid})`);
    resultados.push(['desktop (marcar)', await rodarDocker({ base: `http://127.0.0.1:${porta}`, aparelho: 'desktop', modo: 'marcar', scratch })]);
    console.log(resultados[resultados.length - 1][1].saidaTexto);
    await derrubar(servidorAtual); servidorAtual = null;

    // ── Cenário 3: catálogo ausente — um servidor só, os dois viewports (só leitura) ────────
    const dirAusente = fs.mkdtempSync(path.join(scratch, 'leituras-ausente-'));
    porta = proximaPorta();
    servidorAtual = await subirServidor({ scratch, dirLeituras: dirAusente, trilhas: NAO_EXISTE, porta });
    console.log(`  · servidor catálogo-ausente no ar em http://127.0.0.1:${porta} (pid ${servidorAtual.pid})`);
    resultados.push(['celular (ausente)', await rodarDocker({ base: `http://127.0.0.1:${porta}`, aparelho: 'celular', modo: 'ausente', scratch, caminhoAusente: NAO_EXISTE })]);
    console.log(resultados[resultados.length - 1][1].saidaTexto);
    resultados.push(['desktop (ausente)', await rodarDocker({ base: `http://127.0.0.1:${porta}`, aparelho: 'desktop', modo: 'ausente', scratch, caminhoAusente: NAO_EXISTE })]);
    console.log(resultados[resultados.length - 1][1].saidaTexto);
    await derrubar(servidorAtual); servidorAtual = null;

    // ── Cenário 4 ("lendo", D61): celular/desktop × claro/escuro, servidor e pasta PRÓPRIOS ──
    // O progresso é semeado por ARQUIVO, ANTES de subir o servidor: ia-0 já terminado, para o
    // percurso de "lendo" e de próximo coincidir com o §7.3 da spec (ia da develop: ia-0; da
    // branch: ia-1).
    for (const [aparelho, tema] of COMBOS) {
      const dirLendo = fs.mkdtempSync(path.join(scratch, 'leituras-lendo-'));
      fs.writeFileSync(path.join(dirLendo, 'leituras.json'), JSON.stringify({
        'ia-0': { terminado_em: '2026-10-02T15:00:00.000Z' },
      }));
      porta = proximaPorta();
      servidorAtual = await subirServidor({ scratch, dirLeituras: dirLendo, trilhas: FIXTURE, porta });
      console.log(`  · servidor lendo (${aparelho}/${tema}) no ar em http://127.0.0.1:${porta} (pid ${servidorAtual.pid})`);
      resultados.push([`lendo (${aparelho}/${tema})`, await rodarDocker({ base: `http://127.0.0.1:${porta}`, aparelho, modo: 'lendo', tema, scratch })]);
      console.log(resultados[resultados.length - 1][1].saidaTexto);
      await derrubar(servidorAtual); servidorAtual = null;
    }

    // ── Cenário 6 (ajuste 05/10): catálogo REAL, só leitura, pasta de progresso vazia ────────
    if (TEM_REAL) {
      const dirReal = fs.mkdtempSync(path.join(scratch, 'leituras-real-'));
      porta = proximaPorta();
      servidorAtual = await subirServidor({ scratch, dirLeituras: dirReal, trilhas: TRILHAS_REAL, porta });
      console.log(`  · servidor catálogo REAL (só leitura) no ar em http://127.0.0.1:${porta} (pid ${servidorAtual.pid})`);
      for (const [aparelho, tema] of COMBOS) {
        resultados.push([`real (${aparelho}/${tema})`, await rodarDocker({ base: `http://127.0.0.1:${porta}`, aparelho, modo: 'real', tema, scratch })]);
        console.log(resultados[resultados.length - 1][1].saidaTexto);
      }
      await derrubar(servidorAtual); servidorAtual = null;
      // Nenhum clique gravou: a pasta de progresso continua sem leituras.json.
      ok(!fs.existsSync(path.join(dirReal, 'leituras.json')), 'catálogo real: nenhum progresso gravado (só leitura)');
    } else {
      avisos.push(`TRILHAS_REAL (${TRILHAS_REAL}) não existe — os PNGs do catálogo real foram PULADOS.`);
    }

    // ── Cenário 5 ("antes"): só visual, contra a develop EXPORTADA — exige RAIZ_ANTES ───────
    if (TEM_ANTES) {
      const dirAntes = fs.mkdtempSync(path.join(scratch, 'leituras-antes-'));
      fs.writeFileSync(path.join(dirAntes, 'leituras.json'), JSON.stringify({
        'ia-0': { terminado_em: '2026-10-02T15:00:00.000Z' },
      }));
      porta = proximaPorta();
      servidorAtual = await subirServidor({ scratch, dirLeituras: dirAntes, trilhas: FIXTURE, porta, raizApp: RAIZ_ANTES });
      console.log(`  · servidor "antes" (develop exportada) no ar em http://127.0.0.1:${porta} (pid ${servidorAtual.pid})`);
      for (const [aparelho, tema] of COMBOS) {
        resultados.push([`antes (${aparelho}/${tema})`, await rodarDocker({ base: `http://127.0.0.1:${porta}`, aparelho, modo: 'antes', tema, scratch })]);
        console.log(resultados[resultados.length - 1][1].saidaTexto);
      }
      await derrubar(servidorAtual); servidorAtual = null;
    } else {
      avisos.push('RAIZ_ANTES não aponta para uma pasta com server.js — os 4 PNGs "antes" foram PULADOS, não gerados.');
    }

    const MARCADOR = '@@MEDIDAS-SMOKE-LEITURAS@@';
    function extrair(saidaTexto) {
      const abre = saidaTexto.indexOf(MARCADOR);
      if (abre < 0) return null;
      try { return JSON.parse(saidaTexto.slice(abre + MARCADOR.length)); } catch { return null; }
    }
    for (const [rotulo, r] of resultados) {
      const relatorio = extrair(r.saidaTexto);
      const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${r.codigo})`];
      ok(problemas.length === 0, problemas.length ? `${rotulo}: ${problemas.join(' · ')}` : `${rotulo}: percurso passou`);
    }

    for (const nome of PNGS) {
      const arquivo = path.join(SAIDA, `${nome}.png`);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }

    // R9/§10: o arquivo de progresso de produção não pode ter nascido nem mudado de mtime.
    const mtimeDepois = fs.existsSync(ARQ_PRODUCAO) ? fs.statSync(ARQ_PRODUCAO).mtimeMs : null;
    ok(mtimeAntes === null ? mtimeDepois === null : mtimeDepois === mtimeAntes,
      `~/.cockpit/leituras.json de produção intacto (antes ${mtimeAntes}, depois ${mtimeDepois})`);

    // E o ARQUIVO do catálogo real (só lido) não mudou — se não existe, "antes" e "depois" são ambos ausente.
    const catalogoDepois = impressaoCatalogo();
    ok(JSON.stringify(catalogoAntes) === JSON.stringify(catalogoDepois),
      `o catálogo real intacto (antes ${JSON.stringify(catalogoAntes)}, depois ${JSON.stringify(catalogoDepois)})`);

    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('\n🔴 o smoke estourou:', e && e.message);
    saida = 1;
  } finally {
    if (servidorAtual) await derrubar(servidorAtual);
    limpar();
    for (const aviso of avisos) console.log(`\n🟡 ${aviso}`);
    console.log(`\n${falhas || saida ? '❌ SMOKE VERMELHO' : '✅ SMOKE VERDE'}`
      + ` — ${feitos - falhas}/${feitos} · PNGs em ${SAIDA}\n`);
  }
  process.exit(saida);
})();
