#!/usr/bin/env node
'use strict';
// GATE — o mapa de "lido" no servidor (lib/lidas.js) e as duas rotas que o expõem: `lidoEm`
// dentro de `GET /api/abas` e a escrita em `POST /api/lidas` (spec
// docs/superpowers/specs/2026-09-14-lido-compartilhado-entre-aparelhos-design.md, §5.2).
//
// Sobe `server.js` DE VERDADE, em processo FILHO — nunca por `require`, que subiria na porta
// de produção. 14 casos: 1-13 sobre a rota e o módulo, e o 14, a varredura durável que garante
// que nenhum smoke novo escreva no `~/.cockpit` de produção. Registrado em `bin/testes.js`.
//
// Uso: node testes/gate-lidas.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

let falhas = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); if (!cond) falhas += 1; return cond; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Uma pasta própria do gate — apagada inteira no fim. Duas pastas, mas quem importa aqui é
// COCKPIT_LIDAS_DIR: ela vai para os DOIS processos (este e o filho), porque o caso 6 lê o
// módulo direto neste processo e compara com o que o servidor (no filho) gravou no MESMO
// arquivo.
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lidas-'));
const DIR_LIDAS = path.join(RAIZ, 'lidas');
// A10 (testes/gate-jobs-disco.js:394) exige de todo teste que mencione `server.js`, mesmo
// quando o gate não tem tmux nenhum — R1/#57.
const DIR_JOBS = path.join(RAIZ, 'jobs-inexistente');
// Sem isto o servidor sobe HTTPS (há certificado em ~/.cockpit/cert de quem roda à mão) e
// toda requisição colhe 301 em vez do que o caso pede — R5/#19.
const CERT_DIR_VAZIO = path.join(RAIZ, 'cert-vazio');
fs.mkdirSync(CERT_DIR_VAZIO, { recursive: true });

// process.env ANTES do require: `lib/lidas.js` resolve `DIR` no `require`, NO PROCESSO DE
// QUEM REQUER (§1.1 do plano) — não é um `dirX()` resolvido a cada chamada como os irmãos
// (`lib/uso.js`, `lib/status-codex.js`). Rodado à mão, sem esta linha, o `require` abaixo
// leria o `~/.cockpit/lidas.json` de produção do dono (armadilha #62).
process.env.COCKPIT_LIDAS_DIR = DIR_LIDAS;
const lidas = require('../lib/lidas');
const ARQ = path.join(DIR_LIDAS, 'lidas.json');

// Porta ESCOLHIDA na faixa alta, nunca chumbada: porta fixa já deixou um gate vermelho em
// 12/09 por colidir com um smoke rodando junto (7892) — falha de AGENDA lida como falha de
// código. A 7897 é a primeira preferência, mas ela tem TRÊS donos (`smoke-abas-tmux.js:413`,
// `smoke-navegador-atalhos.js:32` — essa chumbada — e `smoke-navegador-erro-codex.js:33`), e
// este gate roda dentro do `npm test`, que alguém dispara com um smoke aberto ao lado.
// Mesmo mecanismo de `testes/gate-adaptador-job.js:252`. Nunca 7899 (jobs, #24) nem 7879
// (produção). Fail-closed: faixa inteira ocupada aborta sem subir nada.
function portaLivre(porta) {
  try {
    const saida = execFileSync('ss', ['-H', '-lptn'], { encoding: 'utf8' });
    return !saida.split('\n').some((linha) => (linha.trim().split(/\s+/)[3] || '').endsWith(`:${porta}`));
  } catch {
    return true;
  }
}
const PORTA = Number(process.env.PORT) || [7897, 7893, 7890, 7892].find(portaLivre);
if (!PORTA) {
  console.error('🔴 nenhuma porta livre na faixa — abortando sem subir servidor.');
  process.exit(1);
}
const TOKEN = 'gate-lidas-token';

let filho = null;

function subirServidor() {
  return new Promise((resolve, reject) => {
    filho = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(PORTA), HOST: '127.0.0.1', COCKPIT_CERT_DIR: CERT_DIR_VAZIO,
        COCKPIT_TOKEN: TOKEN, COCKPIT_JOBS_DIR: DIR_JOBS, COCKPIT_LIDAS_DIR: DIR_LIDAS,
        // Socket que não existe: sem isto `COCKPIT_TMUX_SOCKET` cai no default (''), que É o
        // tmux de verdade de quem roda o gate — este gate não quer listar painel nenhum.
        COCKPIT_TMUX_SOCKET: `gate-lidas-${process.pid}`,
        COCKPIT_VIGIA_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let saiu = false;
    filho.once('exit', (codigo) => {
      if (!saiu) reject(new Error(`server.js caiu antes de subir (código ${codigo})`));
    });
    filho.stdout.on('data', (d) => {
      if (!saiu && String(d).includes('cockpit-agentes em')) { saiu = true; resolve(); }
    });
    filho.stderr.on('data', (d) => process.stderr.write(`[server.js] ${d}`));
    setTimeout(() => { if (!saiu) { saiu = true; resolve(); } }, 2500);
  });
}

function derrubarServidor() {
  if (filho && !filho.killed) filho.kill('SIGTERM'); // pelo PID — nunca pkill (#19)
}

// ─── HTTP contra o servidor filho ────────────────────────────────────────────────────────

/** Manda `corpoTexto` CRU no corpo — é o que deixa mandar JSON deliberadamente inválido. */
function pedirBruto(metodo, rota, corpoTexto, { semToken = false } = {}) {
  return new Promise((resolve, reject) => {
    const cabecalhos = {};
    if (!semToken) cabecalhos.authorization = `Bearer ${TOKEN}`;
    if (corpoTexto !== undefined) cabecalhos['content-type'] = 'application/json';
    const req = http.request(
      { host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers: cabecalhos },
      (res) => {
        let bruto = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { bruto += c; });
        res.on('end', () => {
          let corpo = null;
          try { corpo = bruto ? JSON.parse(bruto) : null; } catch { /* resposta não-JSON */ }
          resolve({ status: res.statusCode, corpo });
        });
      },
    );
    req.on('error', reject);
    if (corpoTexto !== undefined) req.write(corpoTexto);
    req.end();
  });
}

/** `pedir()` injeta `Authorization: Bearer` — o caso 7 é o ÚNICO que chama com `semToken`. */
const pedir = (metodo, rota, { corpo, semToken } = {}) =>
  pedirBruto(metodo, rota, corpo === undefined ? undefined : JSON.stringify(corpo), { semToken });

// ─── Uma cópia isolada do módulo, com pasta própria — usada SÓ no caso 10 ───────────────────
//
// O teto de 500 precisa de um mapa que comece do ZERO e nada mais o toque durante o teste,
// senão a poda (que é sobre o arquivo INTEIRO, não sobre "as entradas que este caso criou")
// fica refém da ordem em que os outros 12 casos rodaram. Uma pasta nova + um `require` novo
// resolvem isso sem tocar no servidor nem no arquivo que os outros casos compartilham.
function requerLidasEm(dir) {
  const anterior = process.env.COCKPIT_LIDAS_DIR;
  process.env.COCKPIT_LIDAS_DIR = dir;
  delete require.cache[require.resolve('../lib/lidas')];
  const modulo = require('../lib/lidas');
  process.env.COCKPIT_LIDAS_DIR = anterior;
  return modulo;
}

// ─── Os casos 1-13 (o 14 vem depois) ─────────────────────────────────────────────────────────────────────────

async function caso1() {
  // Este gate não tem tmux (COCKPIT_TMUX_SOCKET aponta para um socket que não existe, de
  // propósito): a lista sai vazia, então o que dá para provar aqui é a FORMA da resposta e o
  // efeito colateral — não o valor de `lidoEm` por aba viva (isso é o caso 6, no módulo).
  const { status, corpo } = await pedir('GET', '/api/abas');
  ok(status === 200, `caso 1: GET /api/abas com mapa inexistente responde 200 (veio ${status})`);
  ok(Array.isArray(corpo?.abas), 'caso 1: e a resposta já tem a forma { abas: [...] }');
  ok(!fs.existsSync(ARQ), 'caso 1: um GET sozinho não cria o arquivo — mapa() nunca escreve');
}

async function casos234() {
  const r2 = await pedir('POST', '/api/lidas', { corpo: { sessaoId: 's1', carimbo: 1000 } });
  ok(r2.status === 200, `caso 2: POST válido responde 200 (veio ${r2.status})`);
  ok(fs.existsSync(ARQ), 'caso 2: o arquivo nasceu');
  const modo = fs.statSync(ARQ).mode & 0o777;
  ok(modo === 0o600, `caso 2: o arquivo nasce com mode 0600 (veio ${modo.toString(8)})`);

  const r3 = await pedir('POST', '/api/lidas', { corpo: { sessaoId: 's1', carimbo: 2000 } });
  ok(r3.status === 200 && r3.corpo?.lidoEm === 2000, `caso 3: carimbo maior grava 2000 (veio ${JSON.stringify(r3.corpo)})`);

  const r4 = await pedir('POST', '/api/lidas', { corpo: { sessaoId: 's1', carimbo: 1000 } });
  ok(r4.status === 200 && r4.corpo?.lidoEm === 2000,
    `caso 4: o POST atrasado (1000 depois de 2000) NÃO some com o carimbo maior (veio ${JSON.stringify(r4.corpo)})`);
  const mapaAtual = await lidas.mapa();
  ok(mapaAtual.s1 === 2000, 'caso 4: e o disco confirma — o max venceu, não o último a chegar');
}

async function caso6() {
  const r = await pedir('POST', '/api/lidas', { corpo: { sessaoId: '__proto__', carimbo: 5000 } });
  ok(r.status === 200, `caso 6: POST com sessaoId "__proto__" responde 200 (veio ${r.status})`);
  // Pela ROTA não dá para provar: GET /api/abas só devolve carimbo de aba VIVA, e este gate
  // não tem tmux — a lista sai vazia e o assert passaria sem exercitar nada (achado do
  // painel). Provar no MÓDULO é o que mede a coisa certa.
  const m = await lidas.mapa();
  ok(m.__proto__ === 5000, `caso 6: lidas.mapa() direto devolve o carimbo de "__proto__" (veio ${m.__proto__})`);
  ok(Object.getPrototypeOf({}) === Object.prototype,
    'caso 6: e o Object.prototype global do processo continua limpo — Object.create(null) segurou');
}

async function caso7() {
  const r = await pedir('POST', '/api/lidas', { corpo: { sessaoId: 's1', carimbo: 1000 }, semToken: true });
  ok(r.status === 401, `caso 7: POST sem token responde 401 (veio ${r.status})`);
}

async function caso8() {
  const antes = fs.statSync(ARQ).mtimeMs;
  const invalidos = [
    ['carimbo string', JSON.stringify({ sessaoId: 's8', carimbo: 'abc' })],
    // `NaN` não é JSON válido — a mensagem chega cru, sem passar por `JSON.stringify` (que
    // trocaria `NaN` por `null` na fiação e mudaria o que o caso está provando).
    ['carimbo NaN (JSON malformado)', '{"sessaoId":"s8","carimbo":NaN}'],
    ['carimbo negativo', JSON.stringify({ sessaoId: 's8', carimbo: -1 })],
    ['carimbo zero', JSON.stringify({ sessaoId: 's8', carimbo: 0 })],
    ['carimbo ausente', JSON.stringify({ sessaoId: 's8' })],
    // Achado do painel: corpo `null` não pode virar 500 (`corpo.sessaoId` lançaria TypeError
    // sem `codigo`). `corpo?.sessaoId` no server.js é o que fecha isto.
    ['corpo null', 'null'],
  ];
  for (const [rotulo, texto] of invalidos) {
    const r = await pedirBruto('POST', '/api/lidas', texto);
    ok(r.status === 400, `caso 8: ${rotulo} ⇒ 400 (veio ${r.status})`);
  }
  ok(fs.statSync(ARQ).mtimeMs === antes, 'caso 8: nenhum dos seis POSTs inválidos tocou o arquivo');
}

async function caso9() {
  const invalidos = [
    ['sessaoId de 65 chars', 'a'.repeat(65)],
    ['sessaoId com "/"', 'a/b'],
    ['sessaoId vazio', ''],
  ];
  for (const [rotulo, sessaoId] of invalidos) {
    const r = await pedir('POST', '/api/lidas', { corpo: { sessaoId, carimbo: 1000 } });
    ok(r.status === 400, `caso 9: ${rotulo} ⇒ 400 (veio ${r.status})`);
  }
  const rAusente = await pedir('POST', '/api/lidas', { corpo: { carimbo: 1000 } });
  ok(rAusente.status === 400, `caso 9: sessaoId ausente ⇒ 400 (veio ${rAusente.status})`);
}

async function caso5() {
  // 50 POSTs concorrentes na MESMA fila (o servidor filho é um processo só): se `naFila` não
  // serializasse ler→decidir→gravar, uma escrita perderia a decisão da outra.
  const respostas = await Promise.all(
    Array.from({ length: 50 }, (_, i) => pedir('POST', '/api/lidas', {
      corpo: { sessaoId: `conc-${i + 1}`, carimbo: 1000 + i },
    })),
  );
  ok(respostas.every((r) => r.status === 200), 'caso 5: as 50 respostas vieram 200');
  const m = await lidas.mapa();
  const todasCertas = Array.from({ length: 50 }, (_, i) => m[`conc-${i + 1}`] === 1000 + i).every(Boolean);
  ok(todasCertas, 'caso 5: as 50 entradas estão no arquivo, cada uma com o SEU carimbo — nenhuma se perdeu na fila');
}

async function caso10() {
  const dirTeto = fs.mkdtempSync(path.join(RAIZ, 'teto-'));
  const lidasTeto = requerLidasEm(dirTeto);
  for (let i = 1; i <= 501; i += 1) {
    await lidasTeto.marcar(`t${i}`, i); // ascendente: t1 tem o MENOR carimbo
  }
  const m = await lidasTeto.mapa();
  ok(Object.keys(m).length === 500, `caso 10: 501 entradas ⇒ o mapa fica com 500 (veio ${Object.keys(m).length})`);
  ok(!('t1' in m), 'caso 10: e a MENOR (t1) foi a que saiu');
  ok('t2' in m && 't501' in m, 'caso 10: as outras 500, inclusive a recém-inserida, continuam');
}

async function caso11() {
  fs.writeFileSync(ARQ, '{', { mode: 0o600 }); // lixo de propósito — arquivo truncado
  const { status, corpo } = await pedir('GET', '/api/abas');
  ok(status === 200, `caso 11: lidas.json ilegível não derruba GET /api/abas (veio ${status})`);
  ok(Array.isArray(corpo?.abas), 'caso 11: e a resposta continua tendo a forma esperada — degrada, não quebra');
}

function caso12() {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'lib', 'lidas.js'), 'utf8');
  // Assert de TEXTO-FONTE (armadilha #53): `.includes()` booleano, nunca `slice` de índice —
  // um `indexOf` que não acha devolve `-1`, e uma fatia a partir daí mentiria em vez de
  // estourar. Depende dos símbolos `gravarJson` e `fsp.rename`: quem renomear qualquer um dos
  // dois numa refatoração futura tem de achar este comentário antes de o gate ficar vermelho.
  ok(fonte.includes('rename('), 'caso 12: lib/lidas.js ainda grava por tmp+rename (fsp.rename)');
  ok(!fonte.includes('writeFile(ARQ'), 'caso 12: e nunca escreve direto em cima do arquivo final');
}

async function caso13() {
  // Uma sessão nova, para não herdar mtime de nenhum caso anterior.
  const r1 = await pedir('POST', '/api/lidas', { corpo: { sessaoId: 's13', carimbo: 1000 } });
  ok(r1.status === 200, `caso 13: primeiro POST responde 200 (veio ${r1.status})`);
  const mtimeAntes = fs.statSync(ARQ).mtimeMs;
  await espera(20); // folga de relógio: mtime tem granularidade de alguns ms em alguns FS
  const r2 = await pedir('POST', '/api/lidas', { corpo: { sessaoId: 's13', carimbo: 1000 } });
  ok(r2.status === 200 && r2.corpo?.lidoEm === 1000, 'caso 13: o segundo POST idêntico também responde 200');
  ok(fs.statSync(ARQ).mtimeMs === mtimeAntes,
    'caso 13: mas NÃO grava de novo — o mtime do arquivo não mudou (R3: max que não muda não escreve)');
}

/**
 * Caso 14 — a varredura durável (§5.4 da spec). O equivalente da A10
 * (`testes/gate-jobs-disco.js:394`) para esta escrita nova: todo arquivo de `testes/` que
 * sobe o `server.js` de verdade, fala com um navegador via puppeteer e NÃO isola `HOME`
 * (o próprio `os.homedir()` já resolveria sozinho, se isolasse) tem de apontar
 * `COCKPIT_LIDAS_DIR` — senão um smoke novo escreve "lido" no `~/.cockpit` de produção do
 * o dono sem ninguém perceber.
 *
 * Cada critério existe por um motivo medido:
 *   - "server.js" + "puppeteer": só isso é smoke de navegador contra o servidor de verdade —
 *     gate de API pura nunca abre aba, e servidor de mentira (`smoke-catalogo-codex.js`,
 *     `smoke-idioma.js`) não fala com o disco.
 *   - `HOME:`/`HOME =`: quem já isola `HOME` está protegido por construção — editar esses 8
 *     arquivos seria ruído no diff por uma proteção que já existe.
 *   - `subirServidor`: quem sobe pelo helper `testes/fixtures-arquivos.js` já está coberto
 *     POR ELE — não é exceção, é o caminho certo, e a A10 já reconhece o mesmo nome
 *     (`testes/gate-jobs-disco.js:432-434`).
 */
function caso14() {
  const dir = __dirname;
  // Allowlist com MOTIVO por entrada, ou não entra — mesma régua da A10.
  const excecoes = new Map([
    ['smoke-celular-medidor.js', 'não sobe servidor — exige BASE= de quem chama; motivo completo no cabeçalho do próprio arquivo'],
    ['smoke-catalogo-codex.js', 'servidor de mentira próprio; cita "server.js" só para dizer que NUNCA o usa — o cabeçalho diz isso com todas as letras'],
    ['gate-ui.js', 'cita `api/lidas` só no `aoBuscar` de mentira e lê o TEXTO-FONTE do server.js por regex; roda em DOM falso, nunca sobe processo nem toca disco'],
  ]);

  const faltando = [];
  for (const nome of fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort()) {
    const fonte = fs.readFileSync(path.join(dir, nome), 'utf8');
    if (excecoes.has(nome)) continue;
    // Quem POSTA em /api/lidas precisa da variável SEMPRE — inclusive com HOME falso, porque
    // ela VENCE o HOME (#62) e um valor herdado do shell mandaria a fixture para o mapa de
    // PRODUÇÃO. Vem antes das outras regras de propósito: este é o caminho que escreve de
    // verdade, e foi assim que `smoke-celular-primeira-leva.js` passou a escrever sem
    // isolamento (achado [Alta] do painel de execução, Codex).
    if (/api\/lidas/.test(fonte) && !fonte.includes('COCKPIT_LIDAS_DIR')) { faltando.push(nome); continue; }
    if (!fonte.includes('server.js')) continue;
    if (!fonte.includes('puppeteer')) continue;
    if (/\bHOME\s*[:=]/.test(fonte)) continue;
    // Sobe pelo HELPER (`fixtures-arquivos.js`), que é o dono da variável — a mesma isenção
    // que a A10 dá (`gate-jobs-disco.js:432`). Casar pela PALAVRA `subirServidor` era furo:
    // `smoke-navegador-fila.js:78` define uma função com esse nome e saía da rede de graça
    // (achado do painel de execução, Codex). A marca tem de ser o `require` do helper.
    if (/require\(['"]\.\/fixtures-arquivos['"]\)/.test(fonte)) continue;
    if (!fonte.includes('COCKPIT_LIDAS_DIR')) faltando.push(nome);
  }
  ok(faltando.length === 0,
    `caso 14: todo smoke que sobe server.js + fala com navegador, sem HOME falso, aponta COCKPIT_LIDAS_DIR${faltando.length ? ` — faltam: ${faltando.join(', ')}` : ''}`);
}

async function principal() {
  try {
    await subirServidor();
    await caso1();
    await casos234();
    await caso6();
    await caso7();
    await caso8();
    await caso9();
    await caso5();
    await caso10();
    await caso11();
    caso12();
    await caso13();
    caso14();
  } finally {
    derrubarServidor();
    fs.rmSync(RAIZ, { recursive: true, force: true });
  }
  console.log(`\n${falhas === 0 ? '✅ GATE VERDE' : `❌ GATE VERMELHO (${falhas} falha(s))`} — lib/lidas.js + /api/abas + /api/lidas\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

principal().catch((e) => {
  console.error('🔴 o gate estourou —', e);
  derrubarServidor();
  process.exit(1);
});
