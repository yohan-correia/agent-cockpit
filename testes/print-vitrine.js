#!/usr/bin/env node
'use strict';
// GERADOR DE PRINTS DA VITRINE — as imagens do README público (`agent-cockpit`).
//
// NÃO é um smoke: não prova nada, não reprova nada de produto. Ele existe para que a foto do
// app possa ser REFEITA quando a tela mudar, em vez de virar uma imagem de 2026 pendurada num
// README para sempre. Mexeu em layout → rode isto de novo e troque os PNGs.
//
// 🔴 A RAZÃO DE SER DA FIXTURE FALSA: o destino destas imagens é um repositório PÚBLICO. As
// abas de uma máquina em uso carregam nome de cliente e de projeto privado, e a conversa
// dentro delas carrega o que se falou. Fotografar a instância de produção publicaria tudo
// isso de uma vez, sem volta. Por isso o roteiro sobe um mundo próprio: socket de tmux só
// dele, HOME de mentira, pasta de jobs vazia, quatro abas de nome genérico e uma conversa
// escrita à mão. NUNCA aponte este script para a instância de produção.
//
// (Este arquivo também é publicado — a regra vale para os comentários dele. Não escreva aqui
// o nome real de aba, de projeto ou de cliente nenhum.)
//
// Molde: `testes/smoke-celular-split.js` (docker run --network host + puppeteer-core, HOME
// falso com `.claude/sessions/<pid>.json` e `.claude/projects/<slug>/<id>.jsonl`, `/proc` de
// mentira por `COCKPIT_PROC_RAIZ`). O que muda aqui é o propósito: lá as medidas mandam e o
// PNG é subproduto; aqui o PNG é o produto e não há assert de layout nenhum.
//
// Uso:  SAIDA=/tmp/vitrine node testes/print-vitrine.js
//
// Códigos de saída: 0 = PNGs gerados · 1 = falhou no meio · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const PORTA = 7893;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const SAIDA = process.env.SAIDA || '/tmp/vitrine';
const SOCKET = `cockpit-smoke-vitrine-${process.pid}`;
const SESSAO = 'vitrine';
const CARIMBO = `ancora-vitrine-${process.pid}`;
const MINHAS_SESSOES = new Set(['ancora', SESSAO]);

// As três abas da vitrine. Nome genérico de propósito (ver o bloco vermelho acima): elas
// precisam parecer com um projeto qualquer, não com os do dono da máquina.
const ABAS = [
  { nome: 'meu-site', cwd: '/home/exemplo/projetos/meu-site', sessaoId: 'sess-meu-site' },
  { nome: 'api-pedidos', cwd: '/home/exemplo/projetos/api-pedidos', sessaoId: 'sess-api-pedidos' },
  { nome: 'loja-mobile', cwd: '/home/exemplo/projetos/loja-mobile', sessaoId: 'sess-loja-mobile' },
  { nome: 'notas', cwd: '/home/exemplo/projetos/notas', sessaoId: 'sess-notas' },
];
const ESTRELA = 'meu-site'; // a aba que aparece aberta no print de conversa

// Os dois idiomas do README (`README.md` e `README.en.md`). O cliente lê a escolha de
// `localStorage['cockpit-idioma']` (`public/i18n.js:5`) e só cai no `navigator.language`
// quando não há nada salvo — dentro do container esse padrão é `en`, e foi o que produziu a
// primeira leva de prints toda em inglês. Aqui a chave é plantada ANTES do goto.
const IDIOMAS = (process.env.IDIOMAS || 'pt-BR,en').split(',').map((s) => s.trim()).filter(Boolean);

const VIEWPORTS = [
  { nome: 'desktop', largura: 1440, altura: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 2 },
  { nome: 'celular', largura: 390, altura: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];

// ─── Fail-closed antes de tocar em qualquer coisa ────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

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

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── A fixture: /proc, sessions e conversa, todos de mentira ─────────────────

const raizProc = (scratch) => path.join(scratch, 'proc');

/** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}` no padrão "exec direto". */
function plantarAgenteFalso(scratch, pid, starttime) {
  const dir = path.join(raizProc(scratch), String(pid));
  fs.mkdirSync(dir, { recursive: true });
  const campos = new Array(52).fill('0');
  campos[0] = String(pid);
  campos[1] = '(claude)';
  campos[2] = 'S';
  campos[3] = '1';
  campos[4] = String(pid);
  campos[5] = String(pid);
  campos[6] = '34816';
  campos[7] = String(pid);
  campos[21] = String(starttime);
  fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), '/usr/bin/claude\0');
  fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task', String(pid), 'children'), '');
}

function escreverSessao(home, { pid, janela, pane, sessaoId, cwd, starttime }) {
  const raiz = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(raiz, { recursive: true });
  fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
    kind: 'interactive',
    sessionId: sessaoId,
    cwd,
    status: 'idle',
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

const linhaHumano = (iso, texto) => `${JSON.stringify({ type: 'user', timestamp: iso, message: { content: texto } })}\n`;
const linhaAssistente = (iso, texto, extra = {}) => `${JSON.stringify({
  type: 'assistant',
  timestamp: iso,
  message: { content: [{ type: 'text', text: texto }], ...extra },
})}\n`;

/**
 * A conversa da foto. Escrita à mão, curta e sem nada de ninguém: é o que um visitante do
 * README vê primeiro, então ela precisa mostrar o app trabalhando — pergunta, resposta com
 * bloco de código e o `usage` na cauda, que é o que acende o medidor de consumo no topo.
 */
// O texto da conversa muda com o idioma da vitrine: um README em inglês com a conversa em
// português parece descuido, e é a primeira coisa que um visitante lê. Por isso a fixture é
// reescrita entre as levas, e não escrita uma vez só no começo.
const TEXTOS = {
  'pt-BR': {
    estrela: [
      'o build do site quebrou depois que mexi no rodapé. o que aconteceu?',
      'Duas coisas: a importação do rodapé aponta para um arquivo que foi renomeado, e o teste de rota ficou sem o endpoint de saúde. A primeira derruba o build; a segunda só o teste.',
      'conserta as duas e roda o teste',
      'Corrigido o caminho da importação e devolvido o endpoint:',
      'Teste rodado: 24 passaram, 0 falharam.',
      'boa. e o aviso de depreciação que aparece no terminal?',
      'Vem da versão antiga do empacotador, não do seu código. Subir uma versão menor resolve sem tocar em nada do site — mas isso muda o `lock`, então prefiro fazer num passo separado.',
      'faz num passo separado então',
      'Feito e commitado à parte. O aviso sumiu e os 24 testes seguem passando.',
    ],
    curtas: {
      'api-pedidos': ['o endpoint de pedidos está lento, dá pra medir?', 'Medido: a consulta de itens roda uma vez por pedido da lista. Trinta pedidos na tela viram trinta e uma idas ao banco.'],
      'loja-mobile': ['a lista pisca quando eu puxo pra atualizar', 'É o estado sendo zerado antes da resposta chegar. Dá pra manter o conteúdo antigo na tela enquanto a nova leva carrega.'],
      notas: ['resume o que decidi sobre o cache', 'Ficou assim: cache só na leitura, quinze minutos, e invalidação no salvar. Escrita nunca lê do cache.'],
    },
  },
  en: {
    estrela: [
      'the site build broke after I touched the footer. what happened?',
      'Two things: the footer import points at a file that was renamed, and the route test lost its health endpoint. The first one breaks the build; the second only breaks the test.',
      'fix both and run the tests',
      'Fixed the import path and put the endpoint back:',
      'Tests run: 24 passed, 0 failed.',
      'good. what about the deprecation warning in the terminal?',
      'That comes from the old bundler version, not from your code. A minor bump clears it without touching the site — but it changes the `lock`, so I would rather do it as a separate step.',
      'do it as a separate step then',
      'Done and committed separately. The warning is gone and all 24 tests still pass.',
    ],
    curtas: {
      'api-pedidos': ['the orders endpoint is slow, can we measure it?', 'Measured: the items query runs once per order in the list. Thirty orders on screen turn into thirty-one trips to the database.'],
      'loja-mobile': ['the list flickers when I pull to refresh', 'The state is cleared before the response arrives. We can keep the old content on screen while the new batch loads.'],
      notas: ['sum up what I decided about caching', 'It came out like this: cache on reads only, fifteen minutes, invalidated on save. Writes never read from the cache.'],
    },
  },
};

function conversaDaVitrine(caminho, idioma) {
  const txt = TEXTOS[idioma].estrela;
  const base = Date.now() - 25 * 60000;
  const em = (min) => new Date(base + min * 60000).toISOString();
  // 🔴 PRIMEIRA linha curta de propósito, e não só o bloco todo. Duas levas de print
  // ensinaram a regra: (1) uma linha só com `res.json({ ok: true })` estoura a largura nos
  // dois viewports; (2) quebrado em três linhas, a PRIMEIRA continuou cortada no celular —
  // os badges `js` e `copiar` flutuam SOBRE ela, e só sobre ela. Por isso a linha 1 aqui é um
  // comentário de 16 caracteres: é a única que vive embaixo dos badges.
  // (O corte pelos badges é defeito da tela, não desta fixture — está relatado ao dono.)
  const bloco = [
    '```js',
    idioma === 'en' ? '// health route' : '// rota de saúde',
    'app.get("/health", (req, res) => {',
    '  res.json({ ok: true });',
    '});',
    '```',
  ].join('\n');
  const linhas = [
    linhaHumano(em(0), txt[0]),
    linhaAssistente(em(1), txt[1]),
    linhaHumano(em(3), txt[2]),
    linhaAssistente(em(4), `${txt[3]}\n\n${bloco}\n\n${txt[4]}`),
    linhaHumano(em(6), txt[5]),
    linhaAssistente(em(7), txt[6]),
    linhaHumano(em(9), txt[7]),
    linhaAssistente(em(10), txt[8], {
      model: 'claude-opus-5',
      usage: { input_tokens: 92000, cache_read_input_tokens: 17002, output_tokens: 812 },
    }),
  ];
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, linhas.join(''));
}

/** As outras abas: uma troca curta só para a lista não nascer muda. */
function conversaCurta(caminho, pergunta, resposta) {
  const base = Date.now() - 90 * 60000;
  const em = (min) => new Date(base + min * 60000).toISOString();
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, linhaHumano(em(0), pergunta) + linhaAssistente(em(1), resposta));
}

/** Reescreve as quatro conversas no idioma pedido. Chamada uma vez por leva. */
function escreverConversas(home, idioma) {
  for (const aba of ABAS) {
    const jsonl = caminhoDoJsonl(home, aba.cwd, aba.sessaoId);
    if (aba.nome === ESTRELA) conversaDaVitrine(jsonl, idioma);
    else conversaCurta(jsonl, ...TEXTOS[idioma].curtas[aba.nome]);
  }
}

function saude() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: '/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ─── O roteiro do navegador — roda DENTRO do container ───────────────────────
//
// Sem crase nenhuma aqui dentro de propósito: o roteiro viaja inteiro dentro de um template
// literal, e uma crase fecharia a string no meio.

function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const VIEWPORTS = JSON.parse(process.env.VIEWPORTS_JSON);
const ESTRELA = process.env.ESTRELA;
const IDIOMA = process.env.IDIOMA;
const SUFIXO_IDIOMA = IDIOMA === 'en' ? 'en' : 'pt';
const ABAS_ESPERADAS = Number(process.env.ABAS_ESPERADAS);

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const problemas = [];
const gerados = [];

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  for (const vp of VIEWPORTS) {
    for (const tema of ['dark', 'light']) {
      const pagina = await navegador.newPage();
      const prefixo = vp.nome + '-' + tema + '-' + SUFIXO_IDIOMA;
      try {
        await pagina.setViewport({
          width: vp.largura, height: vp.altura, isMobile: vp.isMobile,
          hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor,
        });
        await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: tema }]);
        // ANTES do goto: o i18n le a chave no carregamento. Plantada depois, a pagina ja
        // nasceu no idioma do navigator (que dentro do container e sempre 'en').
        await pagina.evaluateOnNewDocument((valor) => {
          try { localStorage.setItem('cockpit-idioma', valor); } catch (e) { /* vale nesta pagina */ }
        }, IDIOMA);
        await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
        await pagina.waitForSelector('#abas', { timeout: 15000 });
        await espera(800);

        // Guarda antes do obturador: lista vazia vira um PNG bonito e MENTIROSO, e num README
        // isso é pior que imagem nenhuma.
        const quantas = await pagina.evaluate(() => document.querySelectorAll('#abas .conversa-linha').length);
        if (quantas < ABAS_ESPERADAS) { problemas.push(prefixo + ': a lista tem ' + quantas + ' aba(s), esperava ' + ABAS_ESPERADAS); await pagina.close().catch(() => {}); continue; }

        // Terceira guarda: o idioma REALMENTE trocou. Sem ela, uma regressao no i18n devolve
        // prints em ingles com nome de arquivo dizendo "pt" — e ninguem confere nome de PNG.
        const lang = await pagina.evaluate(() => document.documentElement.lang);
        if (lang !== IDIOMA) { problemas.push(prefixo + ': a pagina esta em "' + lang + '", esperava "' + IDIOMA + '"'); await pagina.close().catch(() => {}); continue; }

        await pagina.screenshot({ path: '/out/' + prefixo + '-1-abas.png' });
        gerados.push(prefixo + '-1-abas.png');

        const clicou = await pagina.evaluate((alvoNome) => {
          const linhas = Array.from(document.querySelectorAll('#abas .conversa-linha'));
          const alvo = linhas.find((l) => {
            const t2 = l.querySelector('.conversa-titulo');
            return t2 && t2.textContent.includes(alvoNome);
          });
          const botao = alvo && alvo.querySelector('.conversa');
          if (botao) botao.click();
          return Boolean(botao);
        }, ESTRELA);
        if (!clicou) { problemas.push(prefixo + ': nao achei a linha de ' + ESTRELA); await pagina.close().catch(() => {}); continue; }

        await pagina.waitForSelector('.chat-topo:not([hidden])', { timeout: 10000 }).catch(() => {});
        await espera(900);

        // Segunda guarda: a conversa tem de ter DESENHADO. O modo de falha classico deste
        // projeto e o print da tela de "escolha uma conversa" passando por print da conversa.
        const temFita = await pagina.evaluate(() => {
          const f = document.querySelector('.fita');
          return Boolean(f && f.textContent && f.textContent.trim().length > 40);
        });
        if (!temFita) { problemas.push(prefixo + ': a .fita nao desenhou a conversa'); await pagina.close().catch(() => {}); continue; }

        await pagina.screenshot({ path: '/out/' + prefixo + '-2-conversa.png' });
        gerados.push(prefixo + '-2-conversa.png');
      } catch (e) {
        problemas.push(prefixo + ': o roteiro estourou — ' + String(e && e.message).slice(0, 300));
      } finally {
        await pagina.close().catch(() => {});
      }
    }
  }

  await navegador.close();
  console.log('@@VITRINE@@' + JSON.stringify({ gerados, problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e);
  process.exit(1);
});
`;
}

// ─── Corrida ─────────────────────────────────────────────────────────────────

(async () => {
  let s3 = null;
  let scratch = null;

  function limpar() {
    if (s3 && s3.exitCode === null) {
      try { process.kill(s3.pid); } catch { /* já morreu */ }
      console.log(`  · servidor (pid ${s3.pid}) derrubado pelo pid exato`);
    }
    // Duas respostas, não uma (D35): o carimbo prova que EU criei, a enumeração prova que não
    // há mais ninguém no socket. Matar exige as duas.
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    const intrusas = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
      .split('\n').map((n) => n.trim()).filter(Boolean)
      .filter((n) => !MINHAS_SESSOES.has(n));
    if (temCarimbo && !intrusas.length) {
      t(['kill-server'], { tolerante: true });
    } else if (temCarimbo) {
      for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
      console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
    } else {
      console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }

  try {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
      return process.exit(2);
    }

    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Não sobrescrevo print antigo às cegas.`);
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vitrine-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'jobs'), { recursive: true });

    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', ABAS[0].nome, '-c', os.tmpdir(), 'sleep', '600']);
    for (const aba of ABAS.slice(1)) {
      t(['new-window', '-d', '-t', SESSAO, '-n', aba.nome, '-c', os.tmpdir(), 'sleep', '600']);
    }

    const panes = {};
    for (const linha of t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']).split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }

    let starttime = 3000001;
    for (const aba of ABAS) {
      const pane = panes[aba.nome];
      if (!pane) throw new Error(`a pane "${aba.nome}" não apareceu no list-panes`);
      plantarAgenteFalso(scratch, pane.panePid, starttime);
      escreverSessao(home, {
        pid: pane.panePid, janela: pane.janelaId, pane: pane.paneId,
        sessaoId: aba.sessaoId, cwd: aba.cwd, starttime,
      });
      starttime += 1;
    }
    console.log(`  · fixture pronta: ${ABAS.map((a) => a.nome).join(', ')}`);

    const ambiente = { ...process.env };
    delete ambiente.COCKPIT_TOKEN;
    Object.assign(ambiente, {
      HOST: '127.0.0.1',
      PORT: String(PORTA),
      HOME: home,
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: SESSAO,
      COCKPIT_PROC_RAIZ: raizProc(scratch),
      COCKPIT_BIN_CLAUDE: '/bin/true',
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
      // 🔴 Pasta VAZIA, e obrigatória (o A10 do `gate-jobs-disco.js` reprova quem sobe o
      // server sem apontar esta variável). Sem ela o cockpit lê a pasta de jobs de verdade, e
      // a faixa de jobs — títulos de projeto privado — entraria nos PNGs da vitrine pública.
      COCKPIT_JOBS_DIR: path.join(scratch, 'jobs'),
    });
    s3 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: ambiente, stdio: ['ignore', 'ignore', 'pipe'],
    });

    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (s3.exitCode !== null) break;
      pronto = await saude();
      if (!pronto) await espera(200);
    }
    if (!pronto) {
      console.error(`🔴 o servidor (${PORTA}) não subiu`);
      limpar();
      return process.exit(1);
    }
    console.log(`  · servidor no ar em http://127.0.0.1:${PORTA} (pid ${s3.pid}), socket ${SOCKET}`);

    fs.writeFileSync(path.join(scratch, 'pane.js'), montarRoteiro());

    // Uma leva por idioma: a conversa no disco é reescrita antes de cada leva, porque o texto
    // dentro dos balões também muda de língua. O servidor relê o `.jsonl` a cada pedido, então
    // não há o que reiniciar entre uma leva e outra.
    const gerados = [];
    const problemas = [];
    for (const idioma of IDIOMAS) {
      escreverConversas(home, idioma);
      console.log(`  · leva ${idioma}`);
      const docker = spawn('docker', [
        'run', '--rm', '--network', 'host', '--entrypoint', 'node',
        '-e', `BASE=http://127.0.0.1:${PORTA}`,
        '-e', `VIEWPORTS_JSON=${JSON.stringify(VIEWPORTS)}`,
        '-e', `ESTRELA=${ESTRELA}`,
        '-e', `IDIOMA=${idioma}`,
        '-e', `ABAS_ESPERADAS=${ABAS.length}`,
        '-v', `${scratch}:/w:ro`,
        '-v', `${SAIDA}:/out`,
        IMAGEM, '/w/pane.js',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let saidaDocker = '';
      docker.stdout.on('data', (d) => { saidaDocker += d; });
      docker.stderr.on('data', (d) => { saidaDocker += d; });
      const codigo = await new Promise((r) => docker.on('close', r));

      const MARCADOR = '@@VITRINE@@';
      const abre = saidaDocker.indexOf(MARCADOR);
      let relatorio = null;
      if (abre >= 0) {
        try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
        if (saidaDocker.slice(0, abre).trim()) console.log(saidaDocker.slice(0, abre).trim());
      } else {
        console.log(saidaDocker);
      }

      if (!relatorio) {
        problemas.push(`leva ${idioma}: o roteiro não devolveu JSON (código ${codigo})`);
        continue;
      }
      gerados.push(...relatorio.gerados);
      problemas.push(...relatorio.problemas);
    }

    for (const nome of gerados) console.log(`  ✅ ${path.join(SAIDA, nome)}`);
    for (const p of problemas) console.error(`  ❌ ${p}`);

    limpar();
    return process.exit(problemas.length ? 1 : 0);
  } catch (e) {
    console.error('🔴 estourou:', e && e.message ? e.message : e);
    limpar();
    return process.exit(1);
  }
})();
