#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — mandar VÁRIOS arquivos de uma vez pelo painel Arquivos, no celular
// (390x844). Card `enviar-varios-arquivos-de-uma-vez`, 18/09.
//
// Molde: `testes/smoke-navegador-arquivos.js` — mesmo mundo de mentira (`fixtures-arquivos`),
// mesmo socket tmux carimbado, mesmo `docker run --network host`, mesmos códigos 0/1/2.
// O que muda é o percurso: TRÊS arquivos escolhidos de uma vez, não um.
//
// Dois PNGs, cada um reprovando se o alvo não estiver na tela:
//   01-lote-escolhido   o rótulo do input com os três escolhidos ("3 arquivos · N")
//   02-lote-chegou      a nota do lote inteiro depois do envio, com a barra em 100
//
// ANTES=1 grava os PNGs e mede, mas NÃO reprova: é o modo usado para fotografar a tela com o
// código de antes do card (input sem `multiple`), onde escolher três mostra um só.
// Porta 7894 (a 7893 é do smoke irmão; 7899 é dos jobs e 7879 é PRODUÇÃO — nunca).
//
// O idioma é forçado em pt-BR no localStorage ANTES do app subir: sem isso o `public/i18n.js`
// cai no `navigator.language` do Chromium (en-US) e o print sai em inglês. É o smoke que se
// ajusta, não o app.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');
const fx = require('./fixtures-arquivos');

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs caem> (use ~/.cockpit/smoke-shots/..., nunca /tmp)');
  process.exit(2);
}
const ANTES = process.env.ANTES === '1';
const PORTA = 7894;
const PORTA_JOBS = 7897;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const PNGS = ['01-lote-escolhido', '02-lote-chegou'];
// Os três do lote e o quarto, grande, que prova que o ruim do meio não derruba os bons.
const ARQUIVOS = [
  { nome: 'lote-um.bin', bytes: 220 * 1024 },
  { nome: 'lote-dois.bin', bytes: 340 * 1024 },
  { nome: 'lote-tres.bin', bytes: 180 * 1024 },
];

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-lote-${process.pid}`;
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

function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');
const fs = require('fs');

const BASE = process.env.BASE;
const ANTES = process.env.ANTES === '1';
const ARQUIVOS = JSON.parse(process.env.ARQUIVOS);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const medidas = {};
  const problemas = [];
  const erros = [];
  const pagina = await navegador.newPage();
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
  pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));

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
    // pt-BR ANTES do app: o i18n lê o localStorage no boot e nunca mais.
    await pagina.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pagina.evaluate(() => localStorage.setItem('cockpit-idioma', 'pt-BR'));
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await espera(600);

    // ── 01: os três escolhidos ──
    await foto('01-lote-escolhido', async () => {
      await pagina.click('#btn-arquivos');
      await pagina.waitForSelector('#dialogo-arquivos[open]', { timeout: 10000 });
      await pagina.waitForFunction(() => document.querySelectorAll('#sel-pasta-inbox option').length >= 1, { timeout: 10000 });
      const input = await pagina.$('#inp-arquivo-servidor');
      if (!input) return { ok: false, porque: '#inp-arquivo-servidor não existe' };
      // O puppeteer RECUSA uploadFile de vários num input sem \`multiple\` ("Multiple file
      // uploads only work with <input type=file multiple>") — a trava na origem em pessoa.
      // No modo ANTES a foto é de UM arquivo, que é o que a tela conseguia fazer.
      const aceitaVarios = await pagina.evaluate(() => document.getElementById('inp-arquivo-servidor').multiple === true);
      const caminhos = aceitaVarios ? ARQUIVOS.map((a) => '/w/' + a.nome) : ['/w/' + ARQUIVOS[0].nome];
      await input.uploadFile(...caminhos);
      await pagina.select('#sel-pasta-inbox', '_triagem');
      await espera(300);
      const d = await pagina.evaluate(() => ({
        multiple: document.getElementById('inp-arquivo-servidor').multiple === true,
        escolhidos: (document.getElementById('inp-arquivo-servidor').files || []).length,
        rotuloEscolha: document.getElementById('arquivo-servidor-selecionado').textContent,
        chamada: document.querySelector('.arquivo-escolha strong').textContent,
      }));
      if (!ANTES && d.escolhidos !== 3) return { ok: false, porque: 'o input ficou com ' + d.escolhidos + ' arquivo(s), não 3' };
      if (!ANTES && !/3 arquivos/.test(d.rotuloEscolha)) return { ok: false, porque: 'o rótulo não conta os três: "' + d.rotuloEscolha + '"' };
      return { ok: true, dados: d };
    });

    // ── 02: o lote inteiro chegou ──
    await foto('02-lote-chegou', async () => {
      const travou = await pagina.evaluate(() => {
        const b = document.getElementById('btn-mandar-servidor');
        b.click();
        return b.dataset.recarregando === '1';
      });
      try {
        await pagina.waitForFunction(() => /chegaram|chegou|nenhum arquivo/.test(document.getElementById('nota-arquivo-servidor').textContent), { timeout: 30000 });
      } catch {
        const nota = await pagina.evaluate(() => document.getElementById('nota-arquivo-servidor').textContent);
        return { ok: false, porque: 'a nota não fechou o lote em 30 s: "' + nota + '"' };
      }
      await espera(400);
      const d = await pagina.evaluate(() => ({
        notaLote: document.getElementById('nota-arquivo-servidor').textContent,
        progresso: Number(document.getElementById('prog-arquivo-servidor').value),
        destravou: document.getElementById('btn-mandar-servidor').dataset.recarregando !== '1',
      }));
      const noDisco = ARQUIVOS.filter((a) => fs.existsSync('/fixture-home/taildrop-inbox/_triagem/' + a.nome)).map((a) => a.nome);
      const dados = Object.assign({ travouDuranteOLote: travou, noDisco }, d);
      if (!ANTES && noDisco.length !== 3) return { ok: false, porque: 'só chegaram ' + noDisco.length + ' de 3 no disco: ' + JSON.stringify(noDisco) };
      if (!ANTES && !/chegaram 3/.test(d.notaLote)) return { ok: false, porque: 'a nota não diz "chegaram 3": "' + d.notaLote + '"' };
      if (!ANTES && !d.destravou) return { ok: false, porque: 'o Mandar continua travado depois do lote' };
      return { ok: true, dados };
    });

    if (erros.length) problemas.push(erros.length + ' erro(s) de console: ' + erros.slice(0, 3).join(' | '));
  } catch (e) {
    problemas.push('o roteiro estourou — ' + String(e && e.message).slice(0, 300));
  } finally {
    await pagina.close().catch(() => {});
    await navegador.close();
  }
  console.log('@@MEDIDAS-LOTE@@' + JSON.stringify({ medidas, problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e);
  process.exit(1);
});
`;
}

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

    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);

    raiz = fx.raizTemporaria('smoke-lote-');
    const { inbox, fila } = fx.montarInbox(raiz);
    const binario = fx.binarioFalso(raiz);
    const caminhoSocket = path.join(raiz, 'tailscaled.sock');
    socket = fx.socketFalso(caminhoSocket, { filaDir: fila });
    await socket.pronto;
    for (const a of ARQUIVOS) fs.writeFileSync(path.join(raiz, a.nome), Buffer.alloc(a.bytes, 90));
    console.log(`  · fixture em ${raiz} (inbox ${inbox})`);

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

    fs.writeFileSync(path.join(raiz, 'roteiro.js'), montarRoteiro());
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-e', `ANTES=${ANTES ? '1' : '0'}`,
      '-e', `ARQUIVOS=${JSON.stringify(ARQUIVOS)}`,
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

    const MARCADOR = '@@MEDIDAS-LOTE@@';
    let relatorio = null;
    const abre = saidaDocker.indexOf(MARCADOR);
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }
    const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigo})`];
    const medidas = relatorio ? relatorio.medidas : {};

    console.log(`  · medidas: ${JSON.stringify(medidas)}`);
    ok(problemas.length === 0, problemas.length ? `o percurso reprovou: ${problemas.join(' · ')}` : 'o percurso passou');
    for (const nome of PNGS) {
      const arquivo = path.join(SAIDA, `${nome}.png`);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }
    if (!ANTES && problemas.length === 0) {
      ok(medidas.multiple === true, `o <input type=file> tem multiple (veio ${JSON.stringify(medidas.multiple)})`);
      ok(medidas.escolhidos === 3, `o input ficou com os TRÊS escolhidos (veio ${JSON.stringify(medidas.escolhidos)})`);
      ok(/3 arquivos/.test(String(medidas.rotuloEscolha)), `o rótulo conta os três ("${medidas.rotuloEscolha}")`);
      ok(medidas.travouDuranteOLote === true, 'o Mandar travou já no começo do lote');
      ok(/chegaram 3/.test(String(medidas.notaLote)), `a nota fecha o lote ("${medidas.notaLote}")`);
      ok(medidas.progresso === 100, `a barra do lote termina em 100 (veio ${JSON.stringify(medidas.progresso)})`);
      ok(medidas.destravou === true, 'e o Mandar destrava só no fim de TODOS');
      ok(Array.isArray(medidas.noDisco) && medidas.noDisco.length === 3,
        `os três estão no disco em _triagem (${JSON.stringify(medidas.noDisco)})`);
    }
    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('🔴 o smoke quebrou:', e && e.message);
    saida = 1;
  } finally {
    const limpou = await limpar();
    if (!limpou) saida = 1;
  }
  console.log(`\n${saida === 0 ? '✅' : '❌'} ${feitos - falhas}/${feitos} — ${ANTES ? 'modo ANTES (só fotografa)' : 'lote de 3 arquivos no celular'}`);
  process.exit(saida);
})();
