#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — o Enviar com foto subindo não fica calado, em 390x844 — card
// `foto-some-entre-upload-e-envio` (29/09). A regra de 25/08 vale: mudou tela, tem print.
//
// Molde: `testes/smoke-navegador-fila.js` (servidor em processo, `lib/abas` trocado no
// `require.cache` ANTES do `require`, docker `--network host`, roteiro num scratch montado
// em `/w/pane.js`, marcador de JSON no stdout, códigos 0/1/2).
//
// SEM proxy aqui (ao contrário do molde da fila): nada neste smoke derruba conexão de
// propósito, então o Chromium fala DIRETO com o servidor — uma porta só, 7883 (nunca 7879
// produção, 7897 instância de teste do celular, 7899 jobs).
//
// Os TURNOS são medidos no HOST, não no roteiro: o dublê de `lib/abas.enviar` vive no MESMO
// processo que este script (`require.cache`), então o array `turnos` é visível aqui. O
// roteiro, dentro do container, imprime `@@PASSO@@<nome>` no instante certo de cada passo; o
// host, vendo o marcador no stream do `docker` (mesmo padrão do `@@PRONTO-PARA-DERRUBAR@@` do
// molde da fila), tira uma fotografia (`JSON.parse(JSON.stringify(turnos))`) e guarda em
// `retratos[nome]`. Os asserts sobre turnos rodam no host DEPOIS que o container termina.
//
// Uso:  SAIDA=~/.cockpit/smoke-shots/2026-10-02-foto-some/antes node testes/smoke-celular-anexo-envio.js
// Códigos: 0 = passou · 1 = falha de produto/asserção · 2 = uso ou ambiente (SAIDA ausente,
// imagem docker ausente, PNG já na pasta).

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs vão cair>');
  process.exit(2);
}

// ─── Isolamento ANTES de qualquer require de lib/ ou server.js (armadilhas #78/#62) ────────
// Pelo menos 10 chaves COCKPIT_* herdadas vencem o HOME falso (ex.: COCKPIT_USO_DIR,
// COCKPIT_INBOX, COCKPIT_PROJETOS_DIR) — apagar TODAS antes de tocar em qualquer módulo do
// projeto, não só definir HOME.
for (const k of Object.keys(process.env)) if (/^COCKPIT_/.test(k)) delete process.env[k];

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const PORTA = 7883;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const CHAVE = 'aba-anexo-smoke';
const RAIZ = path.resolve(__dirname, '..');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-anexo-'));
const homeFalso = path.join(scratch, 'home');
fs.mkdirSync(homeFalso, { recursive: true });
process.env.HOME = homeFalso;
// Caminhos só — NÃO criados aqui (mesmo padrão de `bin/testes.js`: a lib cria sob demanda).
// `COCKPIT_JOBS_DIR` fica sem a pasta de propósito: desliga o painel de jobs, como no molde.
process.env.COCKPIT_PUSH_DIR = path.join(scratch, 'push');
process.env.COCKPIT_LIDAS_DIR = path.join(scratch, 'lidas');
process.env.COCKPIT_JOBS_DIR = path.join(scratch, 'jobs');
process.env.COCKPIT_TMUX_SOCKET = `cockpit-smoke-anexo-${process.pid}`;
process.env.COCKPIT_VIGIA_MS = '0';
process.env.COCKPIT_CERT_DIR = '/dev/null';
process.env.COCKPIT_TOKEN = '';
process.env.PORT = String(PORTA);
process.env.HOST = '127.0.0.1';

// ─── O dublê de lib/abas.js ──────────────────────────────────────────────────────────────
//
// `enviar()` GRAVA o turno (texto + nomes dos anexos) num array visível deste processo — é
// essa gravação, e não um "turno chegou de verdade", que os asserts do host conferem.
// `guardarAnexo` segura 3 s por upload (o 4G do celular com 3,6 MB) e LANÇA para `quebrada.jpg`
// (disco cheio, de propósito) — sem a espera não há janela de `subindo` para o Enviar pegar.
const CAMINHO_ABAS = path.join(RAIZ, 'lib', 'abas.js');
const real = require(CAMINHO_ABAS);
const ARQUIVO = path.join(scratch, 'conversa.jsonl');
fs.writeFileSync(ARQUIVO, '');   // vazio, e fica vazio o smoke inteiro
const pastaAnexos = path.join(scratch, 'anexos');
fs.mkdirSync(pastaAnexos);
const infoAba = {
  chave: CHAVE, titulo: 'Cockpit', cwd: '/tmp', arquivo: ARQUIVO,
  // `esperando: false` de propósito: com `true` a tela da pane (a pergunta do terminal) abre e
  // COBRE a fita — a 1ª rodada deste smoke deu verde com o aviso escondido atrás dela, porque o
  // seletor acha o nó mesmo invisível. Os asserts de `visivel()` abaixo pegam isso agora.
  rodando: false, esperando: false, temAgente: true, temClaude: true,
};
const turnos = [];
const duble = {
  ...real,
  listar: async () => [{ ...infoAba }],
  buscar: async (chave) => (chave === CHAVE ? { ...infoAba } : null),
  paraCliente: (a) => a,
  abasDoProjeto: () => [],
  enviar: async (chave, texto, anexos = [], id = null) => {
    // NUNCA `anexos.map(path.basename)` — o índice do map vira o `suffix` do `basename` e
    // `ERR_INVALID_ARG_TYPE` estoura. A arrow function descarta o índice de propósito.
    turnos.push({ texto, anexos: anexos.map((arquivo) => path.basename(arquivo)) });
    const ficha = real.registrarPendente?.(chave, { id, texto, mensagem: texto });
    return { enviado: true, chave, titulo: infoAba.titulo, ficha };
  },
  guardarAnexo: async ({ nome, extensao, dados }) => {
    await new Promise((r) => setTimeout(r, 3000));
    if (/quebrada/.test(String(nome))) throw new Error('disco cheio (dublê)');
    const arquivo = path.join(pastaAnexos, `${Date.now()}-${path.basename(String(nome))}`);
    fs.writeFileSync(arquivo, dados);
    return { arquivo, nome: path.basename(arquivo), bytes: dados.length };
  },
};
require.cache[require.resolve(CAMINHO_ABAS)] = {
  id: CAMINHO_ABAS, filename: CAMINHO_ABAS, loaded: true, exports: duble,
};

function subirServidor() {
  require(path.join(RAIZ, 'server.js'));
  // `server.js` não exporta o servidor — sem `.close()` a chamar. Quem derruba o listener é o
  // `process.exit()` no fim deste script (armadilha #24).
}

function esperarSaude(tentativas = 60) {
  return new Promise((resolve, reject) => {
    const tenta = (i) => {
      const req = http.get({ host: '127.0.0.1', port: PORTA, path: '/health', timeout: 500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        proxima(i);
      });
      req.on('error', () => proxima(i));
      req.on('timeout', () => { req.destroy(); proxima(i); });
    };
    const proxima = (i) => {
      if (i >= tentativas) return reject(new Error('o servidor não respondeu /health a tempo'));
      setTimeout(() => tenta(i + 1), 200);
    };
    tenta(0);
  });
}

// ─── As fotos (cabeçalho JPEG, geradas no scratch — mesmo precedente de smoke-navegador-arquivos) ──
for (const [nome, kb] of [['foto-um.jpg', 2000], ['foto-dois.jpg', 1400], ['quebrada.jpg', 200], ['foto-tres.jpg', 300]]) {
  const b = Buffer.alloc(kb * 1024, 0x41);
  b[0] = 0xff; b[1] = 0xd8;
  fs.writeFileSync(path.join(scratch, nome), b);
}

// ─── O roteiro do navegador — roda DENTRO do container ──────────────────────────────────
function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const problemas = [];
  const erros = [];
  const pagina = await navegador.newPage();
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 300)); });
  pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 300)));

  const esconder = () => pagina.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const mostrar = () => pagina.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const estadoDosAnexos = () => pagina.evaluate(() =>
    Array.from(document.querySelectorAll('.painel .anexos .anexo')).map((a) => a.dataset.estado));
  const textoDaFita = () => pagina.evaluate(() => document.querySelector('.painel .fita')?.innerText || '');
  const marcar = async (nome) => { console.log('@@PASSO@@' + nome); await espera(300); };
  // O recado tem que estar NA TELA, não só no DOM: dentro do viewport de 390x844 e sem nada por
  // cima do centro dele (mesma régua do smoke-navegador-fila). Devolve o motivo, ou '' se ok.
  const visivel = (seletor, padrao) => pagina.evaluate((sel, fonte) => {
    const re = new RegExp(fonte, 'u');
    const alvo = Array.from(document.querySelectorAll(sel)).filter((el) => re.test(el.textContent)).pop();
    if (!alvo) return 'não existe';
    const r = alvo.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return 'tamanho zero';
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) {
      return 'fora do viewport ' + JSON.stringify({ t: Math.round(r.top), b: Math.round(r.bottom) });
    }
    const noPonto = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!(noPonto && (noPonto === alvo || alvo.contains(noPonto)))) return 'coberto por ' + (noPonto ? noPonto.className || noPonto.tagName : 'nada');
    return '';
  }, seletor, padrao);

  // Cada passo recomeça limpo: o × recria TODOS os nós de \`.anexos\`, então clicar sempre o
  // PRIMEIRO até a lista esvaziar evita handle órfão.
  async function limpar() {
    for (let i = 0; i < 20; i++) {
      const tinhaAlgum = await pagina.evaluate(() => {
        const btn = document.querySelector('.painel .anexo-tira');
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!tinhaAlgum) break;
    }
    await pagina.evaluate(() => {
      const entrada = document.querySelector('.painel .entrada');
      entrada.value = '';
      entrada.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  try {
    await pagina.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    // pt-BR ANTES do app: o i18n lê o localStorage no boot e nunca mais.
    await pagina.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pagina.evaluate(() => localStorage.setItem('cockpit-idioma', 'pt-BR'));
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await pagina.waitForSelector('#lista-conversas .conversa', { timeout: 15000 });
    await pagina.evaluate(() => document.querySelector('#lista-conversas .conversa').click());
    await pagina.waitForSelector('.painel .entrada', { timeout: 15000 });
    await espera(600);

    // ── 01: enviar com as duas fotos ainda subindo ──
    await limpar();
    try {
      await pagina.type('.painel .entrada', 'E sobre essa marca, da para ler?');
      await esconder();   // simula ir para a galeria
      const input = await pagina.$('.painel .inp-arquivo');
      await input.uploadFile('/w/foto-um.jpg', '/w/foto-dois.jpg');
      await mostrar();    // volta da galeria
      await espera(200);
      const estados01 = await estadoDosAnexos();
      if (!(estados01.length === 2 && estados01.every((e) => e === 'subindo'))) {
        problemas.push('01-enviar-com-fotos-subindo: a janela de subida não existiu — o teste não testou nada (estados=' + JSON.stringify(estados01) + ')');
      }
      await pagina.click('.painel .btn-enviar');
      await espera(400);
    } catch (e) {
      problemas.push('01-enviar-com-fotos-subindo: o passo estourou — ' + String(e && e.message).slice(0, 300));
    }
    await pagina.screenshot({ path: '/out/01-enviar-com-fotos-subindo.png' });
    const temAviso01 = await pagina.evaluate(() => {
      const el = document.querySelector('.painel .fita .bolha-aviso');
      return Boolean(el && /Esperando/.test(el.textContent));
    });
    if (!temAviso01) problemas.push('01-enviar-com-fotos-subindo: sem .bolha-aviso com "Esperando" na fita (fita="' + (await textoDaFita()).slice(0, 200) + '")');
    else {
      const v01 = await visivel('.painel .fita .bolha-aviso', 'Esperando');
      if (v01) problemas.push('01-enviar-com-fotos-subindo: o aviso existe mas não está na tela — ' + v01);
    }

    // ── 02: sem tocar em mais nada, o turno sai sozinho com as duas fotos ──
    try {
      await pagina.waitForFunction(() => {
        const bolhas = Array.from(document.querySelectorAll('.painel .fita .bolha-eu'));
        return bolhas.some((b) => (b.textContent.match(/\u{1F4CE}/gu) || []).length === 2);
      }, { timeout: 15000, polling: 300 });
    } catch { /* segue mesmo sem aparecer — o host confere pelos turnos registrados */ }
    await espera(500);
    await pagina.screenshot({ path: '/out/02-turno-com-as-duas-fotos.png' });
    const temBolhaDupla = await pagina.evaluate(() => {
      const bolhas = Array.from(document.querySelectorAll('.painel .fita .bolha-eu'));
      return bolhas.some((b) => (b.textContent.match(/\u{1F4CE}/gu) || []).length === 2);
    });
    if (!temBolhaDupla) problemas.push('02-turno-com-as-duas-fotos: nenhuma bolha-eu com dois \u{1F4CE} na fita');
    else {
      const v02 = await visivel('.painel .fita .bolha-eu', '\u{1F4CE}[^]*\u{1F4CE}');
      if (v02) problemas.push('02-turno-com-as-duas-fotos: a bolha existe mas não está na tela — ' + v02);
    }
    await marcar('02');

    // ── 03: só imagem, sem texto ──
    await limpar();
    try {
      const input3 = await pagina.$('.painel .inp-arquivo');
      await input3.uploadFile('/w/foto-tres.jpg');
      await pagina.waitForFunction(() => {
        const e = Array.from(document.querySelectorAll('.painel .anexos .anexo')).map((a) => a.dataset.estado);
        return e.length === 1 && e[0] === 'pronto';
      }, { timeout: 8000, polling: 200 });
    } catch (e) {
      problemas.push('03-so-imagem-sem-texto: o anexo não ficou pronto a tempo — ' + String(e && e.message).slice(0, 200));
    }
    await pagina.click('.painel .btn-enviar');
    await espera(400);
    await pagina.screenshot({ path: '/out/03-so-imagem-sem-texto.png' });
    const d03 = await pagina.evaluate(() => ({
      fita: document.querySelector('.painel .fita')?.innerText || '',
      estados: Array.from(document.querySelectorAll('.painel .anexos .anexo')).map((a) => a.dataset.estado),
    }));
    if (!/Escreva uma mensagem/.test(d03.fita)) problemas.push('03-so-imagem-sem-texto: sem "Escreva uma mensagem" na fita (fita="' + d03.fita.slice(0, 200) + '")');
    else {
      const v03 = await visivel('.painel .fita .bolha-erro', 'Escreva uma mensagem');
      if (v03) problemas.push('03-so-imagem-sem-texto: o recado existe mas não está na tela — ' + v03);
    }
    if (!(d03.estados.length === 1 && d03.estados[0] === 'pronto')) problemas.push('03-so-imagem-sem-texto: o anexo não continuou pronto (estados=' + JSON.stringify(d03.estados) + ')');
    await marcar('03');

    // ── 04: anexo com erro ──
    await limpar();
    try {
      await pagina.type('.painel .entrada', 'isto não pode sair sem a foto');
      const input4 = await pagina.$('.painel .inp-arquivo');
      await input4.uploadFile('/w/quebrada.jpg');
      await espera(200);
      const estados04a = await estadoDosAnexos();
      if (!(estados04a.length === 1 && estados04a[0] === 'subindo')) {
        problemas.push('04-anexo-com-erro: a janela de subida não existiu — o teste não testou nada (estados=' + JSON.stringify(estados04a) + ')');
      }
      await pagina.click('.painel .btn-enviar');
      await pagina.waitForFunction(() => {
        const e = Array.from(document.querySelectorAll('.painel .anexos .anexo')).map((a) => a.dataset.estado);
        return e.length === 1 && e[0] === 'erro';
      }, { timeout: 8000, polling: 200 });
    } catch (e) {
      problemas.push('04-anexo-com-erro: ' + String(e && e.message).slice(0, 300));
    }
    await espera(600);
    await pagina.screenshot({ path: '/out/04-anexo-com-erro.png' });
    const d04 = await pagina.evaluate(() => ({
      fita: document.querySelector('.painel .fita')?.innerText || '',
      estados: Array.from(document.querySelectorAll('.painel .anexos .anexo')).map((a) => a.dataset.estado),
      valorEntrada: document.querySelector('.painel .entrada').value,
    }));
    if (!/não subiu/.test(d04.fita)) problemas.push('04-anexo-com-erro: sem "não subiu" na fita (fita="' + d04.fita.slice(0, 200) + '")');
    else {
      const v04 = await visivel('.painel .fita .bolha-erro', 'não subiu');
      if (v04) problemas.push('04-anexo-com-erro: o recado existe mas não está na tela — ' + v04);
    }
    if (!(d04.estados.length === 1 && d04.estados[0] === 'erro')) problemas.push('04-anexo-com-erro: o anexo não ficou em erro (estados=' + JSON.stringify(d04.estados) + ')');
    if (d04.valorEntrada !== 'isto não pode sair sem a foto') problemas.push('04-anexo-com-erro: o texto sumiu da caixa ("' + d04.valorEntrada + '")');
    await marcar('04');

    // ERR de status 500 é o PRÓPRIO mecanismo do passo 04 (upload de quebrada.jpg, de
    // propósito) — filtrar só esse; qualquer outro console.error/pageerror reprova.
    const errosReais = erros.filter((e) => !(/Failed to load resource/.test(e) && /500/.test(e)));
    if (errosReais.length) problemas.push('console/pageerror: ' + errosReais.join(' | '));
  } catch (e) {
    problemas.push('o roteiro estourou — ' + String(e && e.message).slice(0, 300));
  } finally {
    await navegador.close().catch(() => {});
  }

  console.log('@@MEDIDAS-ANEXO@@' + JSON.stringify({ problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.log('@@MEDIDAS-ANEXO@@' + JSON.stringify({ problemas: ['o roteiro caiu: ' + String(e && e.message)] }));
  process.exit(1);
});
`;
}

(async () => {
  let codigo = 0;
  let docker = null;
  try {
    fs.mkdirSync(SAIDA, { recursive: true });
    const jaTemPng = fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'));
    if (jaTemPng) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. O smoke recusa sobrescrever.`);
      // Sai pelo `finally` lá embaixo, que apaga o scratch — `process.exit` aqui o vazaria.
      throw Object.assign(new Error('uso'), { codigoDeSaida: 2 });
    }

    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe — sem Chromium para este smoke.`);
      throw Object.assign(new Error('ambiente'), { codigoDeSaida: 2 });
    }

    subirServidor();
    await esperarSaude();
    console.log(`  · servidor em http://127.0.0.1:${PORTA}`);

    fs.writeFileSync(path.join(scratch, 'pane.js'), montarRoteiro());

    docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const retratos = {};
    const vistos = new Set();
    let saidaDocker = '';
    const aoReceberDados = (d) => {
      saidaDocker += d;
      for (const nome of ['02', '03', '04']) {
        if (!vistos.has(nome) && saidaDocker.includes('@@PASSO@@' + nome)) {
          vistos.add(nome);
          retratos[nome] = JSON.parse(JSON.stringify(turnos));
        }
      }
    };
    docker.stdout.on('data', aoReceberDados);
    docker.stderr.on('data', aoReceberDados);
    const codigoDocker = await new Promise((r) => docker.on('close', r));
    console.log(saidaDocker.replace(/@@PASSO@@\w+/g, ''));

    const MARCADOR = '@@MEDIDAS-ANEXO@@';
    const abre = saidaDocker.indexOf(MARCADOR);
    let relatorio = null;
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }
    const problemas = relatorio ? relatorio.problemas.slice() : [`o roteiro não devolveu JSON (código docker ${codigoDocker})`];

    // ─── Asserts do HOST sobre os turnos — cada um começa conferindo se o retrato existe ──
    const confereRetrato = (nome) => {
      if (!retratos[nome]) { problemas.push(`passo ${nome} sem retrato dos turnos`); return null; }
      return retratos[nome];
    };
    const r02 = confereRetrato('02');
    if (r02) {
      if (r02.length !== 1) {
        problemas.push(`02-turno-com-as-duas-fotos: esperava 1 turno, achei ${r02.length}`);
      } else {
        const nomes = r02[0].anexos || [];
        if (nomes.length !== 2) {
          problemas.push(`02-turno-com-as-duas-fotos: esperava 2 anexos no turno, achei ${nomes.length} (${JSON.stringify(nomes)})`);
        } else {
          if (!nomes[0].endsWith('foto-um.jpg')) problemas.push(`02-turno-com-as-duas-fotos: o primeiro anexo não termina em foto-um.jpg (${nomes[0]})`);
          if (!nomes[1].endsWith('foto-dois.jpg')) problemas.push(`02-turno-com-as-duas-fotos: o segundo anexo não termina em foto-dois.jpg (${nomes[1]})`);
        }
      }
    }
    const r03 = confereRetrato('03');
    if (r02 && r03 && r03.length !== r02.length) {
      problemas.push(`03-so-imagem-sem-texto: o número de turnos mudou (${r02.length} → ${r03.length}) — mandou sem texto`);
    }
    const r04 = confereRetrato('04');
    if (r03 && r04 && r04.length !== r03.length) {
      problemas.push(`04-anexo-com-erro: o número de turnos mudou (${r03.length} → ${r04.length}) — mandou com anexo quebrado`);
    }

    if (problemas.length) {
      console.log('\n❌ problemas encontrados:');
      for (const p of problemas) console.log(`  · ${p}`);
      codigo = 1;
    } else {
      console.log('\n✅ o Enviar com anexo não fica mais calado — PNGs em ' + SAIDA);
    }
  } catch (e) {
    if (e && e.codigoDeSaida === 2) codigo = 2;   // uso/ambiente — a mensagem já saiu acima
    else {
      console.error('\n❌ o smoke quebrou:', e && e.message);
      codigo = 1;
    }
  } finally {
    if (docker && docker.exitCode === null) docker.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  // DEPOIS do finally, nunca dentro: é este `process.exit` que derruba o listener do
  // `server.js` (armadilha #24).
  process.exit(codigo);
})();
