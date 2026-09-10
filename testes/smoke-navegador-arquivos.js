#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — a tela "Arquivos" no celular (spec 2026-09-03, §3.6.2), em 390x844.
//
// Molde: `testes/smoke-celular-primeira-leva.js` (spawn do `server.js`, socket tmux próprio
// carimbado, `docker run --network host`, marcador na saída, códigos 0/1/2, recusa `SAIDA`
// com PNG dentro). O mundo de mentira é o MESMO do `gate-arquivos.js`, vindo de
// `fixtures-arquivos.js`: inbox num tmp fora de /home, localapi num unix socket falso,
// `tailscale` que só registra os argumentos. O estado compartilhado entre socket e binário
// é o DISCO (R28): a fila que o socket lista é `<raiz>/fila-falsa/`, e o binário move de lá
// em `file get` — depois de "Puxar tudo" a lista fica vazia sem canal combinado nenhum.
//
// Três PNGs, cada um reprovando se o alvo não estiver na tela:
//   01-arquivos-aberto   painel aberto: pastas, fila com 2, "Puxar tudo (2 arquivos)", 2 aparelhos
//   02-upload-chegou     3 MB subiram: barra em 100, nota "chegou", arquivo no disco com sha igual
//   03-mandar-pra-fora   puxou a fila (log + "nada chegando"), entrou em _triagem, mandou pra
//                        galaxy-falso (log) — o print é tirado DEPOIS do "enviado"
//
// Porta 7893 (S3 desta entrega) e 7896 (o `/api/jobs` de mentira). NUNCA 7899 (#24) nem 7879.
// Tema escuro forçado, como no molde. Códigos: 0 = passou · 1 = falha de produto/assert ·
// 2 = uso (falta SAIDA, PNG na pasta) ou ambiente (imagem docker ausente, servidor não subiu).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const fx = require('./fixtures-arquivos');

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs e o medidas.json vão cair>');
  process.exit(2);
}
const PORTA = 7893;
const PORTA_JOBS = 7896;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const PNGS = ['01-arquivos-aberto', '02-upload-chegou', '03-mandar-pra-fora'];

// ─── Fail-closed do socket tmux, mesmo padrão do molde ────────────────────────
const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-arquivos-${process.pid}`;
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
const { espera } = fx;

function subirMockDeJobs() {
  return new Promise((resolve) => {
    const corpo = JSON.stringify({ jobs: [] });
    const servidor = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(corpo);
    });
    servidor.listen(PORTA_JOBS, '127.0.0.1', () => resolve(servidor));
  });
}

// ─── O roteiro do navegador — roda DENTRO do container ───────────────────────
function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');
const fs = require('fs');
const crypto = require('crypto');

const BASE = process.env.BASE;
const SHA_ESPERADO = process.env.SHA_ESPERADO;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const lerLog = () => { try { return fs.readFileSync('/fixture-home/chamadas.log', 'utf8'); } catch { return ''; } };

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const medidas = {};
  const problemas = [];
  const erros = [];
  const requisicoes = [];
  const pagina = await navegador.newPage();
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
  pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
  pagina.on('response', (r) => { if (r.status() >= 400) requisicoes.push(r.status() + ' ' + r.url()); });

  const rolarCorpo = (ate) => pagina.evaluate((a) => {
    const corpo = document.querySelector('#dialogo-arquivos .dialogo-corpo');
    if (corpo) corpo.scrollTop = a === 'fim' ? corpo.scrollHeight : 0;
  }, ate);

  async function foto(nome, passo) {
    try {
      const veredito = await passo();
      if (veredito && veredito.ok === false) { problemas.push(nome + ': ' + veredito.porque); return; }
      await espera(300);
      await pagina.screenshot({ path: '/out/' + nome + '.png' });
      Object.assign(medidas, (veredito && veredito.dados) || {});
    } catch (e) {
      problemas.push(nome + ': o roteiro estourou — ' + String(e && e.message).slice(0, 300));
    }
  }

  try {
    await pagina.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await espera(600);
    const geral = await pagina.evaluate(() => ({
      folhasComRegras: Array.from(document.styleSheets).filter((f) => { try { return f.cssRules && f.cssRules.length > 0; } catch { return true; } }).length,
      imagensQuebradas: Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).length,
      usoFechado: getComputedStyle(document.getElementById('dialogo-uso')).display === 'none',
      topoVisivel: document.querySelector('.marca').getBoundingClientRect().top >= 0,
    }));
    if (!geral.folhasComRegras) problemas.push('geral: NENHUMA folha de estilo com regras');
    if (geral.imagensQuebradas) problemas.push('geral: ' + geral.imagensQuebradas + ' imagem(ns) quebrada(s)');
    if (!geral.usoFechado || !geral.topoVisivel) problemas.push('geral: painel fechado deslocou a lista para fora da tela');

    // ── 01 ──
    await foto('01-arquivos-aberto', async () => {
      const temBotao = await pagina.evaluate(() => !!document.getElementById('btn-arquivos'));
      if (!temBotao) return { ok: false, porque: '#btn-arquivos não existe' };
      await pagina.click('#btn-arquivos');
      await pagina.waitForSelector('#dialogo-arquivos[open]', { timeout: 10000 });
      try {
        await pagina.waitForFunction(() => document.querySelectorAll('#sel-pasta-inbox option').length >= 3
          && document.querySelectorAll('#lista-taildrop .arquivos-item').length === 2
          && document.querySelectorAll('#sel-destino-taildrop option').length === 2, { timeout: 10000 });
      } catch {
        const d = await pagina.evaluate(() => ({
          pastas: document.querySelectorAll('#sel-pasta-inbox option').length,
          fila: document.querySelectorAll('#lista-taildrop .arquivos-item').length,
          destinos: document.querySelectorAll('#sel-destino-taildrop option').length,
          notas: [document.getElementById('nota-arquivo-servidor'), document.getElementById('nota-taildrop'), document.getElementById('nota-envio')].map((n) => n && n.textContent),
        }));
        return { ok: false, porque: 'o painel não carregou os três blocos em 10 s: ' + JSON.stringify(d) };
      }
      const d = await pagina.evaluate(() => {
        const b = document.getElementById('btn-puxar-taildrop');
        return {
          opcoesPasta: document.querySelectorAll('#sel-pasta-inbox option').length,
          linhasFila: document.querySelectorAll('#lista-taildrop .arquivos-item').length,
          textoPuxar: b.textContent,
          puxarHabilitado: !b.disabled,
          destinos: document.querySelectorAll('#sel-destino-taildrop option').length,
          rotulo: document.getElementById('rotulo-arquivo-servidor').textContent,
        };
      });
      if (!d.puxarHabilitado || !/\\(2 arquivos\\)/.test(d.textoPuxar)) return { ok: false, porque: 'Puxar tudo não diz (2 arquivos) habilitado: ' + JSON.stringify(d) };
      if (!/GB/.test(d.rotulo)) return { ok: false, porque: 'o rótulo do arquivo não traz o teto do servidor: ' + d.rotulo };
      await rolarCorpo('topo');
      return { ok: true, dados: { opcoesPasta: d.opcoesPasta, linhasFila: d.linhasFila, textoPuxar: d.textoPuxar } };
    });

    // ── 02 ──
    await foto('02-upload-chegou', async () => {
      const input = await pagina.$('#inp-arquivo-servidor');
      if (!input) return { ok: false, porque: '#inp-arquivo-servidor não existe' };
      await input.uploadFile('/w/envio-3mb.bin');
      await pagina.select('#sel-pasta-inbox', '_triagem');
      // Clique e leitura no MESMO evaluate: o upload de 3 MB em localhost leva milissegundos,
      // e um round-trip entre o click e a leitura perderia a janela do "travado".
      const travou = await pagina.evaluate(() => {
        const b = document.getElementById('btn-mandar-servidor');
        b.click();
        return b.dataset.recarregando === '1';
      });
      try {
        await pagina.waitForFunction(() => /chegou/.test(document.getElementById('nota-arquivo-servidor').textContent), { timeout: 20000 });
      } catch {
        const nota = await pagina.evaluate(() => document.getElementById('nota-arquivo-servidor').textContent);
        return { ok: false, porque: 'a nota não disse "chegou" em 20 s: "' + nota + '"' };
      }
      const d = await pagina.evaluate(() => ({
        progresso: Number(document.getElementById('prog-arquivo-servidor').value),
        notaUpload: document.getElementById('nota-arquivo-servidor').textContent,
        destravou: document.getElementById('btn-mandar-servidor').dataset.recarregando !== '1',
      }));
      const arquivo = '/fixture-home/taildrop-inbox/_triagem/envio-3mb.bin';
      const existe = fs.existsSync(arquivo);
      const shaIgual = existe && sha256(fs.readFileSync(arquivo)) === SHA_ESPERADO;
      if (!travou) return { ok: false, porque: 'o Mandar não estava travado logo após o clique' };
      if (d.progresso !== 100) return { ok: false, porque: 'a barra não está em 100 (' + d.progresso + ')' };
      if (!d.destravou) return { ok: false, porque: 'o Mandar continua travado depois do "chegou"' };
      if (!existe) return { ok: false, porque: 'o arquivo não está em _triagem no disco' };
      if (!shaIgual) return { ok: false, porque: 'o sha256 do arquivo no disco não bate' };
      await rolarCorpo('topo');
      return { ok: true, dados: { travouDuranteUpload: travou, progresso: d.progresso, notaUpload: d.notaUpload, shaIgual } };
    });

    // ── 03 ──
    await foto('03-mandar-pra-fora', async () => {
      await pagina.click('details.arquivos-bloco:has(#btn-puxar-taildrop) > summary');
      await pagina.click('#btn-puxar-taildrop');
      try {
        await pagina.waitForFunction(() => /nada chegando/.test(document.getElementById('lista-taildrop').textContent), { timeout: 15000 });
      } catch {
        const nota = await pagina.evaluate(() => document.getElementById('nota-taildrop').textContent);
        return { ok: false, porque: 'a fila não ficou vazia depois de Puxar tudo: "' + nota + '"' };
      }
      const puxouNoLog = /file\\tget\\t--conflict=rename/.test(lerLog());
      if (!puxouNoLog) return { ok: false, porque: 'chamadas.log não tem file get --conflict=rename' };
      const notaPuxar = await pagina.evaluate(() => document.getElementById('nota-taildrop').textContent);
      await pagina.click('details.arquivos-bloco:has(#sel-raiz-envio) > summary');
      await pagina.select('#sel-raiz-envio', 'inbox');
      try {
        await pagina.waitForFunction(() => Array.from(document.querySelectorAll('#lista-envio .arquivos-pasta button'))
          .some((b) => /^_triagem/.test(b.textContent)), { timeout: 10000 });
      } catch {
        return { ok: false, porque: '_triagem não apareceu em #lista-envio' };
      }
      await pagina.evaluate(() => {
        const b = Array.from(document.querySelectorAll('#lista-envio .arquivos-pasta button')).find((x) => /^_triagem/.test(x.textContent));
        b.click();
      });
      try {
        await pagina.waitForFunction(() => Array.from(document.querySelectorAll('#lista-envio .arquivos-item .nome'))
          .some((n) => n.textContent === 'envio-3mb.bin'), { timeout: 10000 });
      } catch {
        return { ok: false, porque: 'envio-3mb.bin não apareceu na lista de _triagem' };
      }
      await pagina.evaluate(() => {
        const linha = Array.from(document.querySelectorAll('#lista-envio .arquivos-item'))
          .find((l) => { const n = l.querySelector('.nome'); return n && n.textContent === 'envio-3mb.bin'; });
        linha.querySelector('button.btn').click();
      });
      try {
        await pagina.waitForFunction(() => Array.from(document.querySelectorAll('#lista-envio .arquivos-item .estado'))
          .some((e) => /enviado para galaxy-falso/.test(e.textContent)), { timeout: 15000 });
      } catch {
        const estados = await pagina.evaluate(() => Array.from(document.querySelectorAll('#lista-envio .arquivos-item .estado')).map((e) => e.textContent));
        return { ok: false, porque: 'a linha não disse "enviado para galaxy-falso": ' + JSON.stringify(estados) };
      }
      const log = lerLog();
      const enviouNoLog = /file\\tcp\\t[^\\n]*\\tgalaxy-falso:/.test(log);
      if (!enviouNoLog) return { ok: false, porque: 'chamadas.log não tem file cp … galaxy-falso:' };
      const caminhoEnvio = await pagina.evaluate(() => document.getElementById('caminho-envio').textContent);
      if (/\\/home\\//.test(caminhoEnvio)) return { ok: false, porque: '#caminho-envio mostra /home/: ' + caminhoEnvio };
      await rolarCorpo('fim');
      return { ok: true, dados: { puxouNoLog, enviouNoLog, caminhoEnvio, notaPuxar } };
    });

    if (erros.length) problemas.push(erros.length + ' erro(s) de console: ' + erros.slice(0, 3).join(' | '));
    if (requisicoes.length) problemas.push(requisicoes.length + ' requisição(ões) >=400: ' + requisicoes.slice(0, 3).join(' | '));
  } catch (e) {
    problemas.push('o roteiro estourou — ' + String(e && e.message).slice(0, 300));
  } finally {
    await pagina.close().catch(() => {});
    await navegador.close();
  }
  console.log('@@MEDIDAS-ARQUIVOS@@' + JSON.stringify({ medidas, problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e);
  process.exit(1);
});
`;
}

// ─── Corrida ──────────────────────────────────────────────────────────────
(async () => {
  let saida = 1;
  let servidor = null;
  let socket = null;
  let mockJobs = null;
  let raiz = null;

  async function limpar() {
    let falhouLimpeza = false;
    if (servidor) {
      const pid = servidor.processo.pid;
      await servidor.matar();
      console.log(`  · S3 (pid ${pid}) derrubado pelo pid exato`);
    }
    if (socket) socket.fechar();
    if (mockJobs) {
      try { mockJobs.closeAllConnections(); } catch { /* versão sem o método */ }
      mockJobs.close();
    }
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    if (temCarimbo) {
      t(['kill-server'], { tolerante: true });
    } else {
      falhouLimpeza = true;
      falhas += 1;
      console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    }
    if (raiz) fs.rmSync(raiz, { recursive: true, force: true });
    return !falhouLimpeza;
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
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. O smoke recusa sobrescrever.`);
      return process.exit(2);
    }

    // ── 1) o socket tmux próprio, só com a âncora: a lista de abas nasce VAZIA ──
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);

    // ── 2) o mundo de mentira ──
    raiz = fx.raizTemporaria('smoke-arquivos-');
    const { inbox, fila } = fx.montarInbox(raiz);
    const binario = fx.binarioFalso(raiz);
    const caminhoSocket = path.join(raiz, 'tailscaled.sock');
    socket = fx.socketFalso(caminhoSocket, { filaDir: fila });
    await socket.pronto;
    const envio = crypto.randomBytes(3 * 1024 * 1024);
    fs.writeFileSync(path.join(raiz, 'envio-3mb.bin'), envio);
    const shaEsperado = crypto.createHash('sha256').update(envio).digest('hex');
    console.log(`  · fixture em ${raiz} (inbox ${inbox})`);

    // ── 3) o /api/jobs de mentira e o S3 ──
    mockJobs = await subirMockDeJobs();
    try {
      servidor = await fx.subirServidor({
        porta: PORTA, home: raiz, socket: caminhoSocket, binario,
        extras: {
          COCKPIT_TMUX_SOCKET: SOCKET,
          COCKPIT_TMUX_SESSAO: 'main',
          COCKPIT_BIN_CLAUDE: '/bin/true',
        },
      });
    } catch (e) {
      console.error(`🟡 ambiente: ${e.message}`);
      await limpar();
      return process.exit(2);
    }
    console.log(`  · S3 no ar em http://127.0.0.1:${PORTA} (pid ${servidor.processo.pid}), socket ${SOCKET}`);

    // ── 4) o roteiro, dentro do container ──
    fs.writeFileSync(path.join(raiz, 'roteiro.js'), montarRoteiro());
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-e', `SHA_ESPERADO=${shaEsperado}`,
      '-v', `${raiz}:/w:ro`,
      '-v', `${raiz}:/fixture-home:rw`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/roteiro.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigo = await new Promise((r) => docker.on('close', r));
    console.log(saidaDocker);

    const MARCADOR = '@@MEDIDAS-ARQUIVOS@@';
    let relatorio = null;
    const abre = saidaDocker.indexOf(MARCADOR);
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }
    const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigo})`];
    const medidas = relatorio ? relatorio.medidas : {};

    ok(problemas.length === 0, problemas.length
      ? `o percurso reprovou: ${problemas.join(' · ')}`
      : 'os três passos passaram: CSS, console, requisições e os asserts de DOM e de disco de cada um');
    for (const nome of PNGS) {
      const arquivo = path.join(SAIDA, `${nome}.png`);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }
    if (problemas.length === 0) {
      const alvo = { linhasFila: 2, travouDuranteUpload: true, progresso: 100, shaIgual: true, puxouNoLog: true, enviouNoLog: true };
      ok(Number(medidas.opcoesPasta) >= 3, `opcoesPasta >= 3 — _triagem e as subpastas do inbox (veio ${JSON.stringify(medidas.opcoesPasta)})`);
      for (const [chave, valor] of Object.entries(alvo)) {
        ok(JSON.stringify(medidas[chave]) === JSON.stringify(valor), `${chave} === ${JSON.stringify(valor)} (veio ${JSON.stringify(medidas[chave])})`);
      }
      ok(/\(2 arquivos\)/.test(String(medidas.textoPuxar)), `textoPuxar diz "(2 arquivos)" (${medidas.textoPuxar})`);
      ok(/chegou: envio-3mb\.bin em _triagem/.test(String(medidas.notaUpload)), `notaUpload diz "chegou: envio-3mb.bin em _triagem" (${medidas.notaUpload})`);
      ok(medidas.caminhoEnvio === 'inbox/_triagem', `caminhoEnvio é "inbox/_triagem", sem /home/ (${medidas.caminhoEnvio})`);
      ok(/2 arquivos novos na raiz do inbox/.test(String(medidas.notaPuxar)), `a nota do puxar diz "2 arquivos novos na raiz do inbox" (${medidas.notaPuxar})`);
      fs.writeFileSync(path.join(SAIDA, 'medidas.json'), JSON.stringify(medidas, null, 2));
    }
    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('\n🔴 o smoke estourou:', e && e.message);
    saida = 1;
  } finally {
    const limpezaOk = await limpar();
    if (!limpezaOk) saida = saida || 1;
    console.log(`\n${falhas || saida ? '❌ SMOKE DE ARQUIVOS VERMELHO' : '✅ SMOKE DE ARQUIVOS VERDE'}`
      + ` — ${feitos - falhas}/${feitos} · PNGs e medidas.json em ${SAIDA}\n`);
  }
  process.exit(saida);
})();
