#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — tema escolhido por `TEMA=` (09/09; Ryu por padrão).
//
// O que ele prova: o tema existe no `<select>`, entra no `<html data-tema>`,
// e as cores que CHEGAM na tela são as da paleta — não as que estão escritas no CSS. São
// coisas diferentes: uma regra pode existir e nunca vencer a cascata, e nenhum teste de
// string pega isso. Aqui quem responde é o `getComputedStyle` do navegador de verdade.
//
// Ele também mede o CONTRASTE do jeito que o olho vê, sobre a cor realmente pintada atrás do
// elemento, e não sobre a variável que se supõe estar ali.
//
// O Ryu é o único tema com a escala de fundos INVERTIDA (lateral #050505 mais escura que a
// conversa #0d0d0d) — decisão deliberada de 09/09. Esse é o assert mais importante para ele:
// se alguém "consertar" a ordem achando que é engano, é aqui que vai apitar. O Abyss tem a
// escala NORMAL, e a tabela abaixo é quem sabe a diferença — não há regra implícita no código.
//
// Esqueleto copiado de `testes/smoke-navegador-pre-sessao.js` — mesma infra (fixture de /proc
// falso, tmux em socket próprio, docker run --network host com puppeteer-core).
//
// Códigos de saída: 0 = verde · 1 = defeito · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs vão cair>');
  process.exit(2);
}

const PORTA = Number(process.env.PORT) || 7895;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';

// A paleta esperada por tema, em rgb() como o navegador devolve — comparar hex com o que o
// `getComputedStyle` retorna nunca casa. `invertida` diz se a lateral é MAIS ESCURA que a
// conversa; é um fato do tema, não uma regra do cockpit, e por isso mora no dado.
const PALETAS = {
  ryu: {
    nome: 'Ryu',
    fundo: 'rgb(13, 13, 13)',         // #0d0d0d — a conversa
    fundo2: 'rgb(5, 5, 5)',           // #050505 — a lateral e a caixa de envio
    texto: 'rgb(214, 208, 197)',      // #D6D0C5
    accent: 'rgb(194, 164, 109)',     // #C2A46D — o dourado, só no que se clica
    sobreAccent: 'rgb(13, 13, 13)',   // #0d0d0d — o rótulo dentro do botão
    barra: '#0d0d0d',
    invertida: true,
  },
  abyss: {
    nome: 'Abyss',
    fundo: 'rgb(6, 9, 11)',           // #06090b — a conversa, a mais escura do tema
    fundo2: 'rgb(11, 18, 25)',        // #0B1219 — a lateral e a caixa de envio
    texto: 'rgb(216, 223, 229)',      // #D8DFE5
    accent: 'rgb(194, 164, 109)',     // #C2A46D — o mesmo dourado do Ryu, de propósito
    sobreAccent: 'rgb(6, 9, 11)',     // #06090b — o rótulo dentro do botão
    barra: '#06090b',
    invertida: false,
  },
};

const SLUG = process.env.TEMA || 'ryu';
const TEMA = PALETAS[SLUG];
if (!TEMA) {
  console.error(`\u{1F534} TEMA="${SLUG}" não existe. Conhecidos: ${Object.keys(PALETAS).join(', ')}`);
  process.exit(2);
}

// ─── Fail-closed do socket, mesmo padrão dos outros smokes ───────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-tema-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
const MINHAS_SESSOES = new Set(['ancora', SESSAO]);

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

// ─── Fixture ─────────────────────────────────────────────────────────────────

const raizProc = (scratch) => path.join(scratch, 'proc');

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
const linhaAssistente = (iso, texto) => `${JSON.stringify({
  type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: texto }] },
})}\n`;

/**
 * A conversa da fixture existe para o PRINT, e por isso ela carrega o que o tema pinta: uma
 * bolha minha (--bolha-eu), uma resposta do agente (--texto sobre --fundo) e um trecho de
 * código, que é onde o cinza do Ryu aparece. Conversa de duas linhas provaria a cor de menos
 * coisa do que a tela mostra na vida real.
 */
function escreverConversa(caminho) {
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  const base = Date.now() - 900000;
  fs.writeFileSync(caminho, [
    // A conversa existe para DAR O QUE FOTOGRAFAR: bolha do usuário, bolha do agente, tabela e
    // código, que é onde as cores do tema aparecem de verdade. O conteúdo segue o tema medido
    // para o print servir de prova — tela de "escolha uma conversa" não prova cor nenhuma.
    linhaHumano(new Date(base).toISOString(), `troca o tema do cockpit para o ${TEMA.nome}`),
    linhaAssistente(new Date(base + 20000).toISOString(),
      `O ${TEMA.nome} entra como \`[data-tema="${SLUG}"]\` no \`estilo.css\`, junto dos outros temas.\n\n`
      + `| Onde | Cor |\n|---|---|\n| Lateral | \`${TEMA.fundo2}\` |\n| Conversa | \`${TEMA.fundo}\` |\n| Enviar | \`${TEMA.accent}\` |`),
    linhaHumano(new Date(base + 60000).toISOString(), 'e o contraste do texto secundário?'),
    linhaAssistente(new Date(base + 90000).toISOString(),
      'Medido no navegador, sobre a cor realmente pintada atrás do elemento — é o que este smoke faz abaixo.'),
  ].join(''));
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

const ROTEIRO = `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const TEMA = ${JSON.stringify(TEMA)};
    const SLUG = ${JSON.stringify(SLUG)};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { nome: 'celular', width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 },
  { nome: 'desktop', width: 1600, height: 1000, isMobile: false, deviceScaleFactor: 1 },
];

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const problemas = [];
  const medidas = {};

  // Luminância e contraste da WCAG, sobre a cor REALMENTE pintada — o navegador devolve
  // 'rgb(r, g, b)', então não há hex para converter nem suposição sobre qual variável venceu.
  const contrasteNoNavegador = \`(function () {
    const lum = (rgb) => {
      const n = rgb.match(/\\\\d+/g).slice(0, 3).map((v) => {
        const x = Number(v) / 255;
        return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2];
    };
    return function (a, b) {
      const la = lum(a), lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
  })()\`;

  const abrirPrimeiraConversa = (pagina) => pagina.evaluate(() => {
    const botao = document.querySelector('#abas .conversa-linha .conversa');
    if (botao) botao.click();
    return Boolean(botao);
  });

  try {
    for (const vp of VIEWPORTS) {
      const pagina = await navegador.newPage();
      const erros = [];
      pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
      pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
      await pagina.setViewport(vp);

      // ── ANTES: o tema padrão, sem nada no localStorage ────────────────────
      await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
      await pagina.waitForSelector('#abas', { timeout: 15000 });
      await espera(500);
      if (!await abrirPrimeiraConversa(pagina)) problemas.push(vp.nome + ': não achei conversa na lista');
      await espera(1200);
      await pagina.screenshot({ path: '/out/tema-antes-' + vp.nome + '.png' }).catch(() => {});

      // ── DEPOIS: escolhe o tema pelo MESMO caminho do usuário — a chave que o
      //    script inline do index.html lê no boot. Escrever data-tema na mão
      //    provaria o CSS e pularia justamente a parte que pode quebrar.
      await pagina.evaluate((slug) => localStorage.setItem('cockpit-tema', slug), SLUG);
      await pagina.reload({ waitUntil: 'networkidle2', timeout: 30000 });
      await pagina.waitForSelector('#abas', { timeout: 15000 });
      await espera(500);
      if (!await abrirPrimeiraConversa(pagina)) problemas.push(vp.nome + ': não achei conversa depois do tema');
      await espera(1200);
      await pagina.screenshot({ path: '/out/tema-depois-' + vp.nome + '.png' }).catch(() => {});

      medidas[vp.nome] = await pagina.evaluate((contrasteFonte, slug) => {
        const contraste = eval(contrasteFonte);
        const css = (el, prop) => (el ? getComputedStyle(el).getPropertyValue(prop).trim() : null);
        const lateral = document.querySelector('.lateral');
        const painel = document.querySelector('#paineis .painel');
        // O botão de enviar ÚNICO (id) morreu em 21f29cd, a caixa de escrita por painel (D42): ele
        // agora nasce dentro de criarPainel, com classe e sem id. Procurar pelo id devolvia null e
        // estourava no cálculo de contraste — o smoke ficava vermelho por isso, não pelo tema.
        const enviar = document.querySelector('#paineis .painel .btn-enviar')
          || document.querySelector('.btn-enviar');
        const opcoes = Array.from(document.querySelectorAll('#sel-tema option')).map((o) => o.value);
        const fundoDaConversa = css(painel, 'background-color') !== 'rgba(0, 0, 0, 0)'
          ? css(painel, 'background-color') : css(document.body, 'background-color');
        const secundario = document.querySelector('.conversa-caminho, .caminho, .marca small');
        return {
          tema: document.documentElement.getAttribute('data-tema'),
          temOpcaoRyu: opcoes.includes(slug),
          corpo: css(document.body, 'background-color'),
          lateral: css(lateral, 'background-color'),
          conversa: fundoDaConversa,
          texto: css(document.body, 'color'),
          enviarFundo: css(enviar, 'background-color'),
          enviarTexto: css(enviar, 'color'),
          barra: (document.querySelector('#meta-tema') || {}).content || null,
          contrasteTexto: Number(contraste(css(document.body, 'color'), fundoDaConversa).toFixed(2)),
          contrasteEnviar: Number(contraste(css(enviar, 'color'), css(enviar, 'background-color')).toFixed(2)),
          contrasteSecundario: secundario
            ? Number(contraste(css(secundario, 'color'), css(secundario.closest('.lateral') ? lateral : painel, 'background-color') || fundoDaConversa).toFixed(2))
            : null,
        };
      }, contrasteNoNavegador, SLUG);

      const m = medidas[vp.nome];
      const p = (cond, texto) => { if (!cond) problemas.push(vp.nome + ': ' + texto); };
      p(m.tema === SLUG, 'o <html> não ficou com data-tema="' + SLUG + '" (' + m.tema + ')');
      p(m.temOpcaoRyu, 'o <select> de tema não tem a opção "' + SLUG + '"');
      p(m.corpo === TEMA.fundo, 'o corpo deveria ser ' + TEMA.fundo + ' e é ' + m.corpo);
      p(m.lateral === TEMA.fundo2, 'a lateral deveria ser ' + TEMA.fundo2 + (TEMA.invertida ? ' (mais ESCURA que a conversa, escala invertida de propósito)' : ' (mais clara que a conversa, escala normal)') + ' e é ' + m.lateral);
      p(m.texto === TEMA.texto, 'o texto deveria ser ' + TEMA.texto + ' e é ' + m.texto);
      p(m.enviarFundo === TEMA.accent, 'o Enviar deveria ser o dourado ' + TEMA.accent + ' e é ' + m.enviarFundo);
      p(m.enviarTexto === TEMA.sobreAccent, 'o rótulo do Enviar deveria ser ' + TEMA.sobreAccent + ' e é ' + m.enviarTexto);
      p(m.barra === TEMA.barra, 'a barra do sistema deveria ser ' + TEMA.barra + ' e é ' + m.barra);
      p(m.contrasteTexto >= 4.5, 'texto sobre a conversa em ' + m.contrasteTexto + ':1');
      p(m.contrasteEnviar >= 4.5, 'rótulo dentro do Enviar em ' + m.contrasteEnviar + ':1');
      if (erros.length) problemas.push(vp.nome + ': ' + erros.length + ' erro(s) de console: ' + erros.slice(0, 2).join(' | '));
      await pagina.close();
    }
  } catch (e) {
    problemas.push('o roteiro estourou: ' + String(e && e.message).slice(0, 300));
  }

  await navegador.close();
  console.log('@@MEDIDAS-TEMA@@' + JSON.stringify({ medidas, problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e);
  process.exit(1);
});
`;

// ─── Corrida ─────────────────────────────────────────────────────────────────

(async () => {
  let saida = 1;
  let servidor = null;
  let scratch = null;

  function limpar() {
    let falhouLimpeza = false;
    if (servidor && servidor.exitCode === null) {
      try { process.kill(servidor.pid); } catch { /* já morreu */ }
      console.log(`  · servidor (pid ${servidor.pid}) derrubado pelo pid exato`);
    }
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    const sessoesAgora = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
      .split('\n').map((n) => n.trim()).filter(Boolean);
    const intrusas = sessoesAgora.filter((n) => !MINHAS_SESSOES.has(n));
    if (temCarimbo && !intrusas.length) {
      t(['kill-server'], { tolerante: true });
    } else if (temCarimbo) {
      for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
      falhouLimpeza = true;
      console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
    } else {
      falhouLimpeza = true;
      falhas += 1;
      console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
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
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. O smoke recusa sobrescrever.`);
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), `smoke-tema-${SLUG}-`));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });

    t(['new-session', '-d', '-x', '200', '-y', '50', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-x', '200', '-y', '50', '-s', SESSAO, '-n', 'cockpit-agentes', '-c', os.tmpdir(), 'sleep', '600']);

    const panes = {};
    for (const linha of t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']).split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }

    const aba = panes['cockpit-agentes'];
    if (!aba) throw new Error('a pane "cockpit-agentes" não apareceu no list-panes');
    const cwd = '/home/smoke/projetos/cockpit-agentes';
    escreverConversa(caminhoDoJsonl(home, cwd, 'sess-tema'));
    plantarAgenteFalso(scratch, aba.panePid, { starttime: 3000001 });
    escreverSessao(home, {
      pid: aba.panePid, janela: aba.janelaId, pane: aba.paneId,
      sessaoId: 'sess-tema', cwd, starttime: 3000001, status: 'idle',
    });
    console.log('  · fixture pronta: uma aba com conversa de quatro turnos (bolha, tabela e código)');

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
      COCKPIT_JOBS_DIR: path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`), // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
    });
    servidor = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: ambiente, stdio: ['ignore', 'ignore', 'pipe'],
    });

    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (servidor.exitCode !== null) break;
      pronto = await saude();
      if (!pronto) await espera(200);
    }
    if (!pronto) {
      ok(false, `o servidor (${PORTA}) não subiu`);
      limpar();
      return process.exit(1);
    }
    console.log(`  · servidor no ar em http://127.0.0.1:${PORTA} (pid ${servidor.pid}), socket ${SOCKET}`);

    fs.writeFileSync(path.join(scratch, 'pane.js'), ROTEIRO);

    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigo = await new Promise((r) => docker.on('close', r));

    let relatorio = null;
    const MARCADOR = '@@MEDIDAS-TEMA@@';
    const abre = saidaDocker.indexOf(MARCADOR);
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
      console.log(saidaDocker.slice(0, abre));
    } else {
      console.log(saidaDocker);
    }

    if (relatorio) {
      for (const [vp, m] of Object.entries(relatorio.medidas)) {
        console.log(`  · ${vp}: corpo ${m.corpo} · lateral ${m.lateral} · Enviar ${m.enviarFundo}`
          + ` · texto ${m.contrasteTexto}:1 · rótulo do Enviar ${m.contrasteEnviar}:1`);
      }
    }

    const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigo})`];
    ok(problemas.length === 0, problemas.length
      ? `o percurso reprovou: ${problemas.join(' · ')}`
      : `o ${TEMA.nome} entra pelo <select>, pinta a lateral ${TEMA.invertida ? 'mais escura' : 'mais clara'} que a conversa e o destaque só no Enviar`);

    for (const nome of ['tema-antes-celular.png', 'tema-depois-celular.png',
      'tema-antes-desktop.png', 'tema-depois-desktop.png']) {
      const arquivo = path.join(SAIDA, nome);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }

    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('\n🔴 o smoke estourou:', e && e.message);
    saida = 1;
  } finally {
    const limpezaOk = limpar();
    if (!limpezaOk) saida = saida || 1;
    console.log(`\n${falhas || saida ? `❌ SMOKE DO TEMA ${TEMA.nome.toUpperCase()} VERMELHO` : `✅ SMOKE DO TEMA ${TEMA.nome.toUpperCase()} VERDE`}`
      + ` — ${feitos - falhas}/${feitos} · PNGs em ${SAIDA}\n`);
  }
  process.exit(saida);
})();
