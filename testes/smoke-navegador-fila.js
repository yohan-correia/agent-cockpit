#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — a bolha "na fila" sobrevive à reconexão do EventSource (card
// `mensagem-na-fila-some-da-fita`), em 390x844 — a regra de 25/08 (mudou tela, tem print).
//
// Molde: `testes/smoke-celular-primeira-leva.js` (docker `--network host`, roteiro escrito
// num scratch e montado em `/w/pane.js`, marcador de JSON no stdout, códigos 0/1/2) e
// `testes/gate-troca-arquivo.js` (o `server.js` sobe DENTRO deste processo, com `lib/abas`
// trocado no `require.cache` ANTES do `require`).
//
// Por que o servidor não é um processo filho aqui, ao contrário do molde de
// `smoke-celular-primeira-leva.js`: o dublê de `lib/abas.js` só alcança o `server.js` se os
// dois viverem no MESMO `require.cache` — um `spawn()` exigiria um preload para injetar o
// dublê num processo separado, e este plano não inventa isso à toa.
//
// Duas portas, e por quê são duas: o `server.js` só fala com o PROXY (127.0.0.1:7896); o
// Chromium (dentro do container) só fala com o PROXY (127.0.0.1:7895 — via `--network host`,
// que enxerga o localhost do host). Derrubar a RECONEXÃO de verdade exige derrubar o
// SOCKET por baixo — `EventSource.close()` não serve, ele encerra o fluxo de vez e o
// navegador não tenta de novo. O proxy TCP (~20 linhas) é o que permite fazer isso sem o
// produto ganhar rota de teste nenhuma.
//
// Uso:  SAIDA=~/.cockpit/smoke-shots/2026-09-05-fila-pendente node testes/smoke-navegador-fila.js
// Códigos: 0 = passou · 1 = falha de produto/asserção · 2 = uso ou ambiente (SAIDA ausente,
// imagem docker ausente, PNG já na pasta).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs vão cair>');
  process.exit(2);
}
const PORTA_SERVIDOR = 7896;   // nunca 7899 (gates de fase, #24), nunca 7898 (gate-troca-arquivo), nunca 7879 (produção)
const PORTA_PROXY = 7895;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const CHAVE = 'aba-fila-smoke';
const RAIZ = path.resolve(__dirname, '..');

// ─── o dublê PARCIAL de lib/abas.js (mesmo desenho de testes/gate-fila-pendente.js) ────────
//
// `enviar()` chama `registrarPendente` REAL — é ela que produz a bolha "na fila" que sobrevive
// à reconexão. Nenhum tmux de verdade entra aqui: o `.jsonl` continua sem a mensagem o tempo
// todo, e é ISSO que a prova de tela demonstra — a bolha só pode ter vindo do REGISTRO do
// servidor, porque o disco nunca teve nada para ela absorver.
const CAMINHO_ABAS = path.join(RAIZ, 'lib', 'abas.js');
const real = require(CAMINHO_ABAS);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-fila-'));
const ARQUIVO = path.join(scratch, 'conversa.jsonl');
fs.writeFileSync(ARQUIVO, '');   // vazio, e fica vazio o smoke inteiro — a mensagem NUNCA está aqui
// `temAgente`/`temClaude`: sem os dois, `desenharAvisoDoAgente` (public/app.js:2071) lê
// `info.temAgente ?? info.temClaude` como `undefined` e desenha "esta aba está sem agente
// rodando" — contradizendo o próprio print, que mostra uma mensagem acabada de enviar.
const infoAba = {
  chave: CHAVE, titulo: 'Cockpit', cwd: '/tmp', arquivo: ARQUIVO, rodando: true, esperando: false,
  temAgente: true, temClaude: true,
};
const duble = {
  ...real,
  listar: async () => [{ ...infoAba }],
  buscar: async (chave) => (chave === CHAVE ? { ...infoAba } : null),
  paraCliente: (a) => a,
  abasDoProjeto: () => [],
  enviar: async (chave, texto, anexosDoEnvio = [], id = null) => {
    const ficha = real.registrarPendente?.(chave, { id, texto, mensagem: texto });
    return { enviado: true, chave, titulo: infoAba.titulo, ficha };
  },
};
require.cache[require.resolve(CAMINHO_ABAS)] = {
  id: CAMINHO_ABAS, filename: CAMINHO_ABAS, loaded: true, exports: duble,
};

function subirServidor() {
  process.env.PORT = String(PORTA_SERVIDOR);
  process.env.HOST = '127.0.0.1';
  process.env.COCKPIT_CERT_DIR = '/dev/null';   // senão sobe TLS e o proxy fala HTTP com um servidor HTTPS (#19)
  process.env.COCKPIT_TOKEN = '';
  process.env.COCKPIT_JOBS_DIR = path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`); // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
  process.env.COCKPIT_VIGIA_MS = '0'; // sem HOME falso nem COCKPIT_TMUX_SOCKET aqui — observaria a sessão main de verdade
  require(path.join(RAIZ, 'server.js'));
  // `server.js` não exporta o servidor (`http.createServer(atender).listen(...)` e mais
  // nada volta do `require`) — não há `.close()` a chamar. Quem derruba o listener é o
  // `process.exit()` no fim deste script, como `gate-troca-arquivo.js` já faz.
}

function esperarSaude(tentativas = 60) {
  return new Promise((resolve, reject) => {
    const tenta = (i) => {
      const req = http.get({ host: '127.0.0.1', port: PORTA_SERVIDOR, path: '/health', timeout: 500 }, (res) => {
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

// ─── o proxy TCP — 127.0.0.1:7895 → 127.0.0.1:7896 ─────────────────────────────
//
// Guarda os sockets abertos: é o que permite `destroy()` neles por baixo, sem tocar no
// `EventSource` do navegador — ele não sabe que a conexão caiu por fora, então reconecta
// sozinho, do jeito que ele reconectaria numa queda de rede de verdade.
const socketsAbertos = new Set();
function subirProxy() {
  return new Promise((resolve, reject) => {
    const servidor = net.createServer((cliente) => {
      const remoto = net.connect(PORTA_SERVIDOR, '127.0.0.1');
      socketsAbertos.add(cliente);
      socketsAbertos.add(remoto);
      const tirar = (s) => () => socketsAbertos.delete(s);
      cliente.pipe(remoto);
      remoto.pipe(cliente);
      cliente.on('close', tirar(cliente));
      remoto.on('close', tirar(remoto));
      cliente.on('error', () => remoto.destroy());
      remoto.on('error', () => cliente.destroy());
    });
    servidor.on('error', reject);
    servidor.listen(PORTA_PROXY, '127.0.0.1', () => resolve(servidor));
  });
}

/** Derruba TODOS os sockets do proxy — é assim que a reconexão de verdade é forçada. */
function derrubarConexoes() {
  for (const s of socketsAbertos) s.destroy();
}

// ─── o roteiro do navegador — roda DENTRO do container (molde: smoke-celular-primeira-leva) ─
function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');
const fs = require('fs');

const BASE = process.env.BASE;
const CHAVE = process.env.CHAVE_ABA;
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
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
  pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));

  try {
    await pagina.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await pagina.waitForSelector('#abas .conversa-grupo[data-cwd] .conversa', { timeout: 15000 });

    // Abre a única aba (o dublê só tem uma) — pelo clique de verdade, não pelo hash.
    await pagina.evaluate((chave) => {
      const linhas = Array.from(document.querySelectorAll('#abas .conversa-grupo[data-cwd] .conversa'));
      const alvo = linhas.find((b) => b.textContent.includes('Cockpit')) || linhas[0];
      if (alvo) alvo.click();
    }, CHAVE);
    await pagina.waitForSelector('.painel .entrada', { timeout: 15000 });
    await espera(500);

    // Envia PELA CAIXA DO APP — o POST de verdade, o mesmo caminho que um toque no celular
    // faria. A aba está \`rodando: true\`, então a bolha nasce com o selo "na fila".
    await pagina.type('.painel .entrada', 'roda os testes enquanto o turno anda');
    await pagina.click('.painel .btn-enviar');
    await pagina.waitForSelector('.painel .fita .bolha-eu[data-fila]', { timeout: 10000 });
    await espera(400);

    // ── PNG "antes" ──
    await pagina.screenshot({ path: '/out/01-antes-na-fila.png' });
    const antes = await pagina.evaluate(() => {
      const bolhas = document.querySelectorAll('.painel .fita .bolha-eu');
      const pendente = document.querySelector('.painel .fita .bolha-eu[data-fila]');
      return {
        bolhasEu: bolhas.length,
        temPendente: Boolean(pendente),
        temSelo: Boolean(pendente && pendente.classList.contains('bolha-pendente')),
      };
    });
    if (antes.bolhasEu !== 1) problemas.push('antes: esperava 1 bolha-eu, achei ' + antes.bolhasEu);
    if (!antes.temPendente) problemas.push('antes: a bolha não tem data-fila');
    if (!antes.temSelo) problemas.push('antes: a bolha não tem a classe bolha-pendente');

    // O carimbo de "a fita ficou vazia" — é o \`sessao\`/\`limparFita()\` da reconexão rodando.
    // Sem ele, um "depois" verde poderia ser só o "antes" que nunca foi apagado.
    await pagina.evaluate(() => {
      window.__fitaEsvaziadaEm = null;
      const fita = document.querySelector('.painel .fita');
      const obs = new MutationObserver(() => {
        if (fita.children.length === 0 && window.__fitaEsvaziadaEm === null) {
          window.__fitaEsvaziadaEm = Date.now();
        }
      });
      obs.observe(fita, { childList: true });
      window.__obsFita = obs;
    });

    // Sinal para o HOST: pode derrubar o socket do proxy agora — o "antes" já foi tirado e
    // o observador já está de pé.
    console.log('@@PRONTO-PARA-DERRUBAR@@');

    // Espera por CONDIÇÃO: a fita esvaziou (reconexão de verdade aconteceu) E a bolha na
    // fila está de volta. Nunca "esperei e apareceu" — o \`.jsonl\` continua vazio o tempo
    // todo, então se isto passar, só pode ter vindo do registro do servidor (D-a).
    await pagina.waitForFunction(() => (
      window.__fitaEsvaziadaEm !== null && Boolean(document.querySelector('.painel .fita .bolha-eu[data-fila]'))
    ), { timeout: 20000, polling: 200 });
    await espera(400);

    // ── PNG "depois" ──
    await pagina.screenshot({ path: '/out/02-depois-da-reconexao.png' });

    // Asserções de fecho, medidas de DENTRO da página — um script que só conta bolhas fica
    // verde com a bolha fora da tela ou coberta.
    const depois = await pagina.evaluate(() => {
      const bolhas = document.querySelectorAll('.painel .fita .bolha-eu');
      const pendente = document.querySelector('.painel .fita .bolha-eu[data-fila]');
      if (!pendente) return { bolhasEu: bolhas.length, existe: false };
      const r = pendente.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const noPonto = document.elementFromPoint(cx, cy);
      return {
        bolhasEu: bolhas.length,
        existe: true,
        temSelo: pendente.classList.contains('bolha-pendente'),
        caixa: { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height },
        dentroDoPonto: Boolean(noPonto && (noPonto === pendente || pendente.contains(noPonto))),
      };
    });
    if (depois.bolhasEu !== 1) problemas.push('depois: esperava 1 bolha-eu (não a soma das duas), achei ' + depois.bolhasEu);
    if (!depois.existe) problemas.push('depois: a bolha na fila não existe mais no DOM');
    else {
      if (!depois.temSelo) problemas.push('depois: a bolha perdeu a classe bolha-pendente');
      if (!(depois.caixa.w > 0 && depois.caixa.h > 0)) problemas.push('depois: a bolha tem largura/altura zero');
      if (!(depois.caixa.t >= 0 && depois.caixa.b <= 844 && depois.caixa.l >= 0 && depois.caixa.r <= 390)) {
        problemas.push('depois: a bolha está fora do viewport de 390x844 — ' + JSON.stringify(depois.caixa));
      }
      if (!depois.dentroDoPonto) problemas.push('depois: outro elemento cobre o centro da bolha');
    }

    for (const arq of ['01-antes-na-fila.png', '02-depois-da-reconexao.png']) {
      const tam = fs.statSync('/out/' + arq).size;
      if (tam <= 10 * 1024) problemas.push(arq + ': só ' + tam + ' bytes — print vazio ou quebrado');
    }
    // ERR_INCOMPLETE_CHUNKED_ENCODING é o PRÓPRIO mecanismo do teste: é o navegador
    // reclamando da conexão SSE que o proxy acabou de destruir de propósito, ali em cima.
    // Um console.error de VERDADE do app é outra coisa, e continua reprovando.
    const errosReais = erros.filter((e) => !/ERR_INCOMPLETE_CHUNKED_ENCODING/.test(e));
    if (errosReais.length) problemas.push('console/pageerror: ' + errosReais.join(' | '));
  } catch (e) {
    problemas.push('o roteiro estourou — ' + String(e && e.message).slice(0, 300));
  } finally {
    await navegador.close().catch(() => {});
  }

  console.log('@@MEDIDAS-FILA@@' + JSON.stringify({ problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('erro fatal no roteiro:', e);
  console.log('@@MEDIDAS-FILA@@' + JSON.stringify({ problemas: ['o roteiro caiu: ' + String(e && e.message)] }));
  process.exit(1);
});
`;
}

(async () => {
  let codigo = 0;
  let proxy = null;
  let docker = null;
  try {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe — sem Chromium para este smoke.`);
      process.exit(2);
    }

    fs.mkdirSync(SAIDA, { recursive: true });
    const jaTemPng = fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'));
    if (jaTemPng) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. O smoke recusa sobrescrever.`);
      process.exit(2);
    }

    subirServidor();
    await esperarSaude();
    proxy = await subirProxy();
    console.log(`  · servidor em http://127.0.0.1:${PORTA_SERVIDOR}, proxy em http://127.0.0.1:${PORTA_PROXY}`);

    fs.writeFileSync(path.join(scratch, 'pane.js'), montarRoteiro());

    docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA_PROXY}`,
      '-e', `CHAVE_ABA=${CHAVE}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    let jaDisparouDerrubada = false;
    const aoReceberDados = (d) => {
      saidaDocker += d;
      if (!jaDisparouDerrubada && saidaDocker.includes('@@PRONTO-PARA-DERRUBAR@@')) {
        jaDisparouDerrubada = true;
        console.log('  · derrubando a conexão pelo proxy — a reconexão tem que acontecer sozinha');
        derrubarConexoes();
      }
    };
    docker.stdout.on('data', aoReceberDados);
    docker.stderr.on('data', aoReceberDados);
    const codigoDocker = await new Promise((r) => docker.on('close', r));
    console.log(saidaDocker.replace('@@PRONTO-PARA-DERRUBAR@@', ''));

    const MARCADOR = '@@MEDIDAS-FILA@@';
    const abre = saidaDocker.indexOf(MARCADOR);
    let relatorio = null;
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }
    const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código docker ${codigoDocker})`];
    if (problemas.length) {
      console.log('\n❌ problemas encontrados:');
      for (const p of problemas) console.log(`  · ${p}`);
      codigo = 1;
    } else {
      console.log('\n✅ a bolha na fila sobreviveu à reconexão — PNGs em ' + SAIDA);
    }
  } catch (e) {
    console.error('\n❌ o smoke quebrou:', e && e.message);
    codigo = 1;
  } finally {
    if (docker && docker.exitCode === null) docker.kill();
    for (const s of socketsAbertos) s.destroy();
    if (proxy) await new Promise((r) => proxy.close(r));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  // DEPOIS do finally, nunca dentro: sair no meio deixaria coisa presa. É este `process.exit`
  // que derruba o listener do `server.js` — ele não tem `.close()` alcançável.
  process.exit(codigo);
})();
