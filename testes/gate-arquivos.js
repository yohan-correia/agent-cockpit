#!/usr/bin/env node
'use strict';
// GATE DA TELA "ARQUIVOS" — upload por stream, Taildrop e mandar pra fora (spec
// design original, §3.6.1).
//
// Offline e sem token da assinatura: sobe o `server.js` na 7895 (e um auxiliar na 7898,
// várias vezes em sequência) contra o mundo de mentira de `fixtures-arquivos.js` — inbox
// num tmp FORA de /home, localapi num unix socket do próprio gate, `tailscale` que só
// registra os argumentos. Nunca encosta no Tailscale real nem no `~/taildrop-inbox`.
//
// Cada asserção imprime `✅ [bloco] mensagem` ou `❌ [bloco] mensagem`; o bloco é o R da
// spec que ela prova. A última linha é `GATE VERDE — n/m` ou `GATE VERMELHO — n/m`.
// Os blocos que fazem `require('../lib/arquivos')` embrulham o require num try/catch: o gate
// nunca aborta por módulo ausente — ele reprova, que é o vermelho esperado da Fase 0.
//
// Uso:  node testes/gate-arquivos.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const fx = require('./fixtures-arquivos');

const { espera } = fx;
const PORTA = 7895;
const PORTA_AUX = 7898;
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

let feitos = 0;
let falhas = 0;
const ok = (bloco, c, texto) => {
  feitos += 1;
  if (!c) falhas += 1;
  console.log(`${c ? '✅' : '❌'} [${bloco}] ${texto}`);
  return Boolean(c);
};
const info = (bloco, texto) => console.log(`ℹ️ [${bloco}] ${texto}`);
const aviso = (bloco, texto) => console.log(`⚠️ [${bloco}] ${texto}`);

/** Um bloco que estoura vira UM ❌ com o motivo, e o gate segue para o próximo. */
async function bloco(nome, fn) {
  try {
    await fn();
  } catch (e) {
    ok(nome, false, `o bloco estourou: ${e && e.message ? e.message : e}`);
  }
}

// ─── HTTP de teste ──────────────────────────────────────────────────────────

function montar(res, pedacos) {
  const texto = Buffer.concat(pedacos).toString('utf8');
  let json = null;
  try { json = JSON.parse(texto); } catch { json = null; }
  return { status: res.statusCode, cabecalhos: res.headers, texto, json: json && typeof json === 'object' ? json : {} };
}

function requisicao(porta, metodo, caminho, { corpo = null, cabecalhos = {} } = {}) {
  return new Promise((resolve) => {
    const cab = { ...cabecalhos };
    if (corpo && cab['content-length'] === undefined) cab['content-length'] = String(corpo.length);
    const req = http.request({ host: '127.0.0.1', port: porta, method: metodo, path: caminho, headers: cab, agent: false }, (res) => {
      const pedacos = [];
      res.on('data', (b) => pedacos.push(b));
      res.on('end', () => resolve(montar(res, pedacos)));
      res.on('error', (e) => resolve({ ...montar(res, pedacos), erro: e.code || e.message }));
    });
    req.on('error', (e) => resolve({ status: 0, erro: e.code || e.message, cabecalhos: {}, texto: '', json: {} }));
    if (corpo) req.write(corpo);
    req.end();
  });
}

const json = (porta, metodo, caminho, objeto) => requisicao(porta, metodo, caminho, {
  corpo: Buffer.from(JSON.stringify(objeto)), cabecalhos: { 'content-type': 'application/json' },
});

const caminhoUpload = (pasta, nome) => `/api/arquivos?${new URLSearchParams({ pasta, nome })}`;

function upload(porta, pasta, nome, corpo, cabecalhos = {}) {
  return requisicao(porta, 'POST', caminhoUpload(pasta, nome), {
    corpo, cabecalhos: { 'content-type': 'application/octet-stream', ...cabecalhos },
  });
}

/** Abre um upload SEM terminar o corpo. `total` null = chunked (sem content-length). */
function abrirUpload(porta, { pasta = 'projeto-a', nome, total, cabecalhos = {}, caminho = null, metodo = 'POST' }) {
  const cab = { 'content-type': 'application/octet-stream', ...cabecalhos };
  if (total !== null && total !== undefined) cab['content-length'] = String(total);
  const req = http.request({
    host: '127.0.0.1', port: porta, method: metodo, path: caminho || caminhoUpload(pasta, nome), headers: cab, agent: false,
  });
  req.on('error', () => {});
  const resposta = new Promise((resolve) => {
    req.on('response', (res) => {
      const pedacos = [];
      res.on('data', (b) => pedacos.push(b));
      res.on('end', () => resolve(montar(res, pedacos)));
      res.on('error', (e) => resolve({ ...montar(res, pedacos), erro: e.code || e.message }));
    });
    req.on('error', (e) => resolve({ status: 0, erro: e.code || e.message, cabecalhos: {}, texto: '', json: {} }));
  });
  const fechado = new Promise((resolve) => {
    req.on('socket', (s) => s.on('close', () => resolve(Date.now())));
  });
  return { req, resposta, fechado };
}

/** Escreve um pedaço e espera o `drain` (com teto de 5 s e saída no `close`). Devolve se ainda está vivo. */
function escrever(req, pedaco) {
  return new Promise((resolve) => {
    if (req.destroyed || (req.socket && req.socket.destroyed)) return resolve(false);
    let precisaDrain = false;
    try { precisaDrain = !req.write(pedaco); } catch { return resolve(false); }
    if (!precisaDrain) return resolve(true);
    const t = setTimeout(() => resolve(false), 5000);
    const fim = (v) => { clearTimeout(t); resolve(v); };
    req.once('drain', () => fim(true));
    req.once('close', () => fim(false));
    return undefined;
  });
}

async function uploadEmPedacos(porta, { pasta = 'projeto-a', nome, dados, pedaco = MiB, pausa = 0, aoPedaco = null }) {
  const u = abrirUpload(porta, { pasta, nome, total: dados.length });
  let n = 0;
  for (let i = 0; i < dados.length; i += pedaco) {
    const vivo = await escrever(u.req, dados.subarray(i, i + pedaco));
    n += 1;
    if (aoPedaco) await aoPedaco(n);
    if (!vivo) break;
    if (pausa) await espera(pausa);
  }
  u.req.end();
  return u.resposta;
}

const corrida = (promessa, ms, valor) => Promise.race([promessa, espera(ms).then(() => valor)]);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const listar = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const parciais = (dir) => listar(dir).filter((n) => n.endsWith('~parcial'));
const ler = (arquivo) => { try { return fs.readFileSync(arquivo); } catch { return null; } };
const lerTexto = (arquivo) => { const b = ler(arquivo); return b === null ? null : b.toString('utf8'); };
const semErro = (objeto) => JSON.stringify(objeto, (k, v) => (k === 'erro' ? undefined : v));

// ─── O gate ─────────────────────────────────────────────────────────────────

(async () => {
  let principal = null;
  let auxiliar = null;
  let socket = null;
  let raiz = null;

  async function derrubarAuxiliar() {
    if (auxiliar) { await auxiliar.matar(); auxiliar = null; }
  }

  try {
    for (const p of [PORTA, PORTA_AUX]) {
      const livre = await new Promise((resolve) => {
        const s = require('node:net').createServer();
        s.once('error', () => resolve(false));
        s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
      });
      if (!livre) {
        ok('servidor', false, `a porta ${p} está ocupada — ache o dono com ss -lptn e mate PELO PID (#24)`);
        throw new Error('porta ocupada');
      }
    }

    raiz = fx.raizTemporaria('gate-arquivos-');
    ok('servidor', !raiz.startsWith('/home'), `o mundo de mentira fica FORA de /home: ${raiz}`);
    const { inbox, fila } = fx.montarInbox(raiz);
    const binario = fx.binarioFalso(raiz);
    const caminhoSocket = path.join(raiz, 'tailscaled.sock');
    const estado = { filaDir: fila };
    socket = fx.socketFalso(caminhoSocket, estado);
    await socket.pronto;
    const pastaAlav = path.join(inbox, 'projeto-a');
    const inboxReal = fs.realpathSync(inbox);
    const lerLog = () => { try { return fs.readFileSync(path.join(raiz, 'chamadas.log'), 'utf8'); } catch { return ''; } };
    const linhasLog = (prefixo) => lerLog().split('\n').filter((l) => l.startsWith(prefixo));

    let modulo = null;
    try { modulo = require('../lib/arquivos'); } catch { modulo = null; }

    try {
      principal = await fx.subirServidor({ porta: PORTA, home: raiz, socket: caminhoSocket, binario });
    } catch (e) {
      ok('servidor', false, `o servidor principal não subiu: ${e.message}`);
      throw e;
    }
    ok('servidor', true, `servidor principal no ar em 127.0.0.1:${PORTA} (pid ${principal.processo.pid})`);
    const pid = principal.processo.pid;

    const provarContadorZerado = async (porta, pasta, dirPasta, contexto) => {
      const abertos = [];
      for (let i = 0; i < 3; i += 1) {
        const u = abrirUpload(porta, { pasta, nome: `r51-${i}.bin`, total: 200000 });
        await escrever(u.req, Buffer.alloc(100000, i + 1));
        abertos.push(u);
      }
      await espera(250);
      const quarto = await upload(porta, pasta, 'r51-quarto.bin', Buffer.alloc(1000, 9));
      ok('R51', quarto.status === 429, `depois de "${contexto}": três uploads abertos e o quarto é 429 (${quarto.status})`);
      const respostas = await Promise.all(abertos.map(async (u) => {
        await escrever(u.req, Buffer.alloc(100000, 7));
        u.req.end();
        return u.resposta;
      }));
      ok('R51', respostas.every((r) => r.status === 201),
        `e os três terminam 201 (${respostas.map((r) => r.status).join(',')}) — o contador voltou a zero`);
      for (const r of respostas) { if (r.json && r.json.nome) { try { fs.unlinkSync(path.join(dirPasta, r.json.nome)); } catch { /* já foi */ } } }
    };

    // ── R3: requestTimeout = 0, no objeto vivo e no texto ──────────────────
    await bloco('R3', async () => {
      const saude = await requisicao(PORTA, 'GET', '/health');
      ok('R3', saude.status === 200 && saude.json.requestTimeout === 0,
        `/health traz requestTimeout === 0 lido do Server vivo (veio ${JSON.stringify(saude.json.requestTimeout)})`);
      const fonte = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      const chamadas = (fonte.match(/semTimeoutDeRequisicao\(/g) || []).length - (fonte.match(/function semTimeoutDeRequisicao\(/g) || []).length;
      ok('R3', chamadas === 3, `server.js chama semTimeoutDeRequisicao( três vezes — os dois do ramo TLS são provados por texto (veio ${chamadas})`);
    });

    // ── R2: a pasta é um NOME da lista; R21: symlink de pasta fica de fora ──
    await bloco('R2', async () => {
      const pastas = await requisicao(PORTA, 'GET', '/api/arquivos/pastas');
      const nomes = (pastas.json.pastas || []).map((p) => p.nome);
      ok('R2', pastas.status === 200 && nomes.includes('_triagem') && nomes.includes('projeto-a') && nomes.includes('projeto-b'),
        `/pastas lista _triagem, projeto-a e projeto-b (${pastas.status}: ${nomes.join(', ')})`);
      ok('R2', nomes[0] === '_triagem', `_triagem vem primeiro (${nomes[0]})`);
      ok('R2', !nomes.includes('.escondido'), 'sem .escondido (o que começa com ponto fica de fora)');
      ok('R2', fs.existsSync(path.join(inbox, '_triagem')) && fs.lstatSync(path.join(inbox, '_triagem')).isDirectory(),
        '_triagem existe no disco mesmo que o tmp não a tivesse — o módulo criou');
      ok('R2', pastas.json.teto === 2 * GiB, `teto padrão é 2 GiB (${pastas.json.teto})`);
      ok('R21', !nomes.includes('pasta-link'), '/pastas NÃO lista pasta-link (symlink de pasta para fora)');

      const bom = await upload(PORTA, 'projeto-a', 'r2.txt', Buffer.from('conteudo do r2'));
      ok('R2', bom.status === 201 && bom.json.nome === 'r2.txt' && bom.json.bytes === 14 && bom.json.pasta === 'projeto-a',
        `pasta=projeto-a → 201 { nome, bytes, pasta } (${bom.status} ${JSON.stringify(bom.json)})`);
      ok('R2', fs.existsSync(path.join(pastaAlav, 'r2.txt')) && lerTexto(path.join(pastaAlav, 'r2.txt')) === 'conteudo do r2',
        'e o arquivo está em <inbox>/projeto-a/r2.txt com o conteúdo inteiro');
      for (const pasta of ['..', '_triagem/x', 'Projeto-a', '']) {
        const r = await upload(PORTA, pasta, 'x.txt', Buffer.from('x'));
        ok('R2', r.status === 400, `pasta=${JSON.stringify(pasta)} → 400 (${r.status})`);
      }
      const link = await upload(PORTA, 'pasta-link', 'x.txt', Buffer.from('x'));
      ok('R21', link.status === 400, `pasta=pasta-link → 400 (${link.status})`);
      ok('R21', !fs.existsSync(path.join(raiz, 'cofre', 'x.txt')), 'e nada foi escrito no cofre');
    });

    // ── R7: nome seguro; R25: o corte preserva a extensão; R61: teto do nome ──
    await bloco('R7', async () => {
      const casos = [
        ['../../etc/passwd', 'passwd'],
        ['relatório final.tar.gz', 'relat-rio-final.tar.gz'],
        ['..', 'arquivo'],
        ['.escondido', 'escondido'],
        ['日本.txt', 'arquivo.txt'],
        ['x~parcial', 'x-parcial'],
      ];
      for (const [nome, esperado] of casos) {
        const r = await upload(PORTA, 'projeto-a', nome, Buffer.from('r7'));
        ok('R7', r.status === 201 && r.json.nome === esperado && fs.existsSync(path.join(pastaAlav, esperado)),
          `nome=${JSON.stringify(nome)} → ${JSON.stringify(esperado)} dentro da pasta (${r.status} ${JSON.stringify(r.json.nome)})`);
      }
      ok('R7', !fs.existsSync(path.join(raiz, 'etc', 'passwd')) && !fs.existsSync('/etc/passwd-gate'), 'nada saiu da pasta');
      const longo = 'a'.repeat(200) + '.tar.gz';
      const r25 = await upload(PORTA, 'projeto-a', longo, Buffer.from('r25'));
      ok('R25', r25.status === 201 && r25.json.nome.length <= 120 && r25.json.nome.endsWith('.gz'),
        `nome de 200 chars + .tar.gz → ${r25.json.nome ? r25.json.nome.length : '?'} chars terminando em .gz`);
      const r61 = await upload(PORTA, 'projeto-a', 'b'.repeat(2000) + '.bin', Buffer.from('r61'));
      ok('R61', r61.status === 400 && /grande/.test(r61.json.erro || ''), `nome com 2000 chars → 400 "grande" (${r61.status} ${r61.json.erro})`);
    });

    // ── vazio: content-length 0 ──────────────────────────────────────────
    await bloco('vazio', async () => {
      const r = await requisicao(PORTA, 'POST', caminhoUpload('projeto-a', 'vazio.bin'), {
        cabecalhos: { 'content-length': '0', 'content-type': 'application/octet-stream' },
      });
      ok('vazio', r.status === 400 && /vazio/.test(r.json.erro || ''), `content-length: 0 → 400 "vazio" (${r.status} ${r.json.erro})`);
      ok('vazio', !fs.existsSync(path.join(pastaAlav, 'vazio.bin')) && parciais(pastaAlav).length === 0, 'nada na pasta, nenhum ~parcial');
      await provarContadorZerado(PORTA, 'projeto-a', pastaAlav, 'vazio');
    });

    // ── S1: colisão de nome, em sequência e ao mesmo tempo; R27: link, não rename ──
    await bloco('S1', async () => {
      const a1 = await upload(PORTA, 'projeto-a', 'a.txt', Buffer.from('um'));
      const a2 = await upload(PORTA, 'projeto-a', 'a.txt', Buffer.from('dois'));
      ok('S1', a1.json.nome === 'a.txt' && a2.json.nome === 'a (1).txt', `a.txt duas vezes → ${a1.json.nome} e ${a2.json.nome}`);
      ok('S1', lerTexto(path.join(pastaAlav, 'a.txt')) === 'um' && lerTexto(path.join(pastaAlav, 'a (1).txt')) === 'dois',
        'e cada um tem o próprio conteúdo — o primeiro não foi sobrescrito');
      const b1 = await upload(PORTA, 'projeto-a', 'a b.txt', Buffer.from('espaco'));
      const b2 = await upload(PORTA, 'projeto-a', 'a-b.txt', Buffer.from('hifen'));
      ok('S1', b1.json.nome === 'a-b.txt' && b2.json.nome === 'a-b (1).txt', `"a b.txt" e "a-b.txt" lavam igual → ${b1.json.nome} e ${b2.json.nome}`);

      // Concorrente: dois pedidos do MESMO nome, corpos intercalados.
      const c1 = crypto.randomBytes(2 * MiB);
      const c2 = crypto.randomBytes(2 * MiB);
      const u1 = abrirUpload(PORTA, { nome: 'mesmo.bin', total: c1.length });
      const u2 = abrirUpload(PORTA, { nome: 'mesmo.bin', total: c2.length });
      for (let i = 0; i < c1.length; i += 256 * 1024) {
        await escrever(u1.req, c1.subarray(i, i + 256 * 1024));
        await escrever(u2.req, c2.subarray(i, i + 256 * 1024));
      }
      u1.req.end(); u2.req.end();
      const [r1, r2] = await Promise.all([u1.resposta, u2.resposta]);
      ok('S1', r1.status === 201 && r2.status === 201 && r1.json.nome !== r2.json.nome,
        `dois uploads simultâneos de mesmo.bin → 201 e 201 com nomes diferentes (${r1.json.nome} / ${r2.json.nome})`);
      const integro = r1.json.nome && r2.json.nome
        && ler(path.join(pastaAlav, r1.json.nome)) !== null && sha256(ler(path.join(pastaAlav, r1.json.nome))) === sha256(c1)
        && ler(path.join(pastaAlav, r2.json.nome)) !== null && sha256(ler(path.join(pastaAlav, r2.json.nome))) === sha256(c2);
      ok('S1', integro, 'e os dois arquivos estão íntegros (sha256 de cada corpo)');

      // R27: alguém cria `corrida.bin` POR FORA no meio do upload.
      const dados = crypto.randomBytes(2 * MiB);
      let externoCriado = false;
      const resposta = await uploadEmPedacos(PORTA, {
        nome: 'corrida.bin', dados, pedaco: 256 * 1024, pausa: 30,
        aoPedaco: async (n) => {
          if (n !== 1 || externoCriado) return;
          for (let i = 0; i < 40 && !fs.existsSync(path.join(pastaAlav, 'corrida.bin~parcial')); i += 1) await espera(50);
          fs.writeFileSync(path.join(pastaAlav, 'corrida.bin'), 'EXTERNO');
          externoCriado = true;
        },
      });
      ok('R27', resposta.status === 201 && resposta.json.nome === 'corrida (1).bin',
        `arquivo criado por fora durante o upload → 201 com nome "corrida (1).bin" (${resposta.status} ${resposta.json.nome})`);
      ok('R27', lerTexto(path.join(pastaAlav, 'corrida.bin')) === 'EXTERNO', 'o externo continua EXTERNO — link, não rename');
      ok('R27', ler(path.join(pastaAlav, 'corrida (1).bin')) !== null && sha256(ler(path.join(pastaAlav, 'corrida (1).bin'))) === sha256(dados),
        'e o (1) tem o sha256 do corpo enviado');
      ok('R27', parciais(pastaAlav).length === 0, 'nenhum ~parcial sobrou');
    });

    // ── R4: stream por observação; RSS só informativo ────────────────────
    await bloco('R4', async () => {
      const dados = crypto.randomBytes(32 * MiB);
      let maiorVisto = 0;
      const observador = setInterval(() => {
        for (const n of parciais(pastaAlav)) {
          try { maiorVisto = Math.max(maiorVisto, fs.statSync(path.join(pastaAlav, n)).size); } catch { /* sumiu */ }
        }
      }, 20);
      const t0 = Date.now();
      const r = await uploadEmPedacos(PORTA, { nome: 'r4.bin', dados, pedaco: MiB, pausa: 40 });
      clearInterval(observador);
      const janela = Date.now() - t0;
      ok('R4', r.status === 201 && r.json.bytes === dados.length, `32 MB em pedaços → 201 com bytes=${r.json.bytes} (${janela} ms)`);
      ok('R4', maiorVisto > 8 * MiB, `um observador independente viu um ~parcial de ${(maiorVisto / MiB).toFixed(1)} MB no meio do envio — é stream, não RAM`);
      ok('R4', ler(path.join(pastaAlav, 'r4.bin')) !== null && sha256(ler(path.join(pastaAlav, 'r4.bin'))) === sha256(dados), 'sha256 igual no disco');
      ok('R4', parciais(pastaAlav).length === 0, 'nenhum ~parcial no fim');
      try { fs.unlinkSync(path.join(pastaAlav, 'r4.bin')); } catch { /* não chegou */ }

      const rss = () => {
        try { const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/); return m ? Number(m[1]) / 1024 : 0; } catch { return 0; }
      };
      const inicial = rss();
      let pico = inicial;
      const amostrador = setInterval(() => { pico = Math.max(pico, rss()); }, 200);
      const pedaco = crypto.randomBytes(4 * MiB);
      const u = abrirUpload(PORTA, { nome: 'r4-grande.bin', total: 128 * MiB });
      for (let i = 0; i < 32; i += 1) { if (!(await escrever(u.req, pedaco))) break; }
      u.req.end();
      const grande = await u.resposta;
      clearInterval(amostrador);
      pico = Math.max(pico, rss());
      info('R4', `RSS +${Math.max(0, pico - inicial).toFixed(0)} MB durante um upload de 128 MB (inicial ${inicial.toFixed(0)} MB, pico ${pico.toFixed(0)} MB) — informativo, ${grande.status}`);
      try { fs.unlinkSync(path.join(pastaAlav, 'r4-grande.bin')); } catch { /* não chegou */ }
    });

    // ── 413 antes do corpo; R52; R58 para 400 e 413 ──────────────────────
    await bloco('413', async () => {
      const u = abrirUpload(PORTA, { nome: 'tres-gb.bin', total: 3221225472 });
      u.req.flushHeaders();
      const r = await corrida(u.resposta, 5000, { status: 0, json: {}, cabecalhos: {} });
      ok('413', r.status === 413, `content-length de 3 GB sem corpo → 413 antes do corpo (${r.status})`);
      u.req.destroy();
      ok('413', !fs.existsSync(path.join(pastaAlav, 'tres-gb.bin')) && parciais(pastaAlav).length === 0, 'nada no disco');

      const u52 = abrirUpload(PORTA, { nome: 'absurdo.bin', total: '10000000000000000' });
      u52.req.flushHeaders();
      const r52 = await corrida(u52.resposta, 5000, { status: 0, json: {}, cabecalhos: {} });
      ok('R52', r52.status === 413, `content-length com 17 dígitos → 413 na hora, nunca "ausente" (${r52.status})`);
      u52.req.destroy();

      const provarRecusa = async (rotulo, u2, esperado) => {
        u2.req.write(Buffer.alloc(65536, 1));
        const rr = await corrida(u2.resposta, 5000, { status: 0, json: {}, cabecalhos: {} });
        const fechou = await corrida(u2.fechado.then(() => true), 2000, false);
        ok('R58', rr.status === esperado && String(rr.cabecalhos.connection || '').toLowerCase() === 'close',
          `${rotulo}: ${esperado} chega com connection: close com o cliente ainda escrevendo (${rr.status}, connection=${rr.cabecalhos.connection})`);
        ok('R58', fechou, `${rotulo}: e o socket fecha em até 2 s`);
        u2.req.destroy();
      };
      await provarRecusa('400 (pasta=..)', abrirUpload(PORTA, { pasta: '..', nome: 'x.bin', total: 4000000 }), 400);
      await provarRecusa('413 (3 GB declarado)', abrirUpload(PORTA, { nome: 'x413.bin', total: 3221225472 }), 413);
      await provarContadorZerado(PORTA, 'projeto-a', pastaAlav, '413 sem corpo');
    });

    // ── 429: três de cada vez; R44: 429 antes do 413; R58 para 429 ────────
    await bloco('429', async () => {
      const tres = [0, 1, 2].map((i) => abrirUpload(PORTA, { nome: `r429-${i}.bin`, total: 4000000 }));
      for (const u of tres) await escrever(u.req, Buffer.alloc(65536, 3));
      await espera(250);
      const quarto = abrirUpload(PORTA, { nome: 'r429-quarto.bin', total: 4000000 });
      quarto.req.write(Buffer.alloc(65536, 4));
      const r4 = await corrida(quarto.resposta, 5000, { status: 0, json: {}, cabecalhos: {} });
      const fechou = await corrida(quarto.fechado.then(() => true), 2000, false);
      ok('429', r4.status === 429 && /3/.test(r4.json.erro || ''), `o quarto upload simultâneo é 429 na hora (${r4.status} ${r4.json.erro})`);
      ok('R58', r4.status === 429 && String(r4.cabecalhos.connection || '').toLowerCase() === 'close' && fechou,
        `429: chega com connection: close e o socket fecha em até 2 s (connection=${r4.cabecalhos.connection}, fechou=${fechou})`);
      quarto.req.destroy();
      const quinto = abrirUpload(PORTA, { nome: 'r429-quinto.bin', total: 3221225472 });
      quinto.req.flushHeaders();
      const r5 = await corrida(quinto.resposta, 5000, { status: 0, json: {}, cabecalhos: {} });
      ok('429', r5.status === 429, `com três abertos, um quarto ACIMA do teto recebe 429, não 413 — a ordem vive em receber (${r5.status})`);
      quinto.req.destroy();
      const respostas = await Promise.all(tres.map(async (u) => {
        await escrever(u.req, Buffer.alloc(4000000 - 65536, 5));
        u.req.end();
        return u.resposta;
      }));
      ok('429', respostas.every((r) => r.status === 201), `e os três terminam 201 (${respostas.map((r) => r.status).join(',')})`);
      ok('429', [0, 1, 2].every((i) => fs.existsSync(path.join(pastaAlav, `r429-${i}.bin`)) && fs.statSync(path.join(pastaAlav, `r429-${i}.bin`)).size === 4000000),
        'com 4 000 000 bytes cada');
      for (let i = 0; i < 3; i += 1) { try { fs.unlinkSync(path.join(pastaAlav, `r429-${i}.bin`)); } catch { /* já */ } }
    });

    // ── queda: o cliente some no meio ─────────────────────────────────────
    await bloco('queda', async () => {
      const u = abrirUpload(PORTA, { nome: 'queda.bin', total: 2000000 });
      await escrever(u.req, Buffer.alloc(500 * 1024, 6));
      await espera(100);
      const tinhaParcial = parciais(pastaAlav).some((n) => n.startsWith('queda.bin'));
      u.req.destroy();
      await espera(500);
      ok('queda', tinhaParcial, 'o ~parcial existia enquanto o cliente escrevia (a queda tem o que limpar)');
      ok('queda', !fs.existsSync(path.join(pastaAlav, 'queda.bin')) && parciais(pastaAlav).length === 0,
        'cliente destruiu o socket no meio → nenhum nome bom, nenhum ~parcial (após 500 ms)');
      await provarContadorZerado(PORTA, 'projeto-a', pastaAlav, 'queda');
    });

    // ── R47: content-length que não bate ──────────────────────────────────
    await bloco('R47', async () => {
      const u = abrirUpload(PORTA, { nome: 'r47.bin', total: 1000 });
      await escrever(u.req, Buffer.alloc(1500, 8));
      u.req.end();
      const r = await corrida(u.resposta, 5000, { status: 0, json: {}, cabecalhos: {} });
      await espera(300);
      const existe = fs.existsSync(path.join(pastaAlav, 'r47.bin'));
      const tamanho = existe ? fs.statSync(path.join(pastaAlav, 'r47.bin')).size : null;
      ok('R47', (r.status === 201 && r.json.bytes === 1000) || r.status === 400 || r.status === 0, `content-length 1000 com 1500 escritos → 201 com 1000 bytes, ou o 400 cru do parser do Node para o excedente, ou queda — nunca 404 (${r.status || r.erro})`);
      ok('R47', !existe || tamanho === 1000, `no disco: ${existe ? `arquivo de ${tamanho} bytes` : 'nenhum arquivo'}, nunca 1500`);
      ok('R47', parciais(pastaAlav).length === 0, 'nenhum ~parcial');
      try { fs.unlinkSync(path.join(pastaAlav, 'r47.bin')); } catch { /* não existe */ }
      await provarContadorZerado(PORTA, 'projeto-a', pastaAlav, 'R47');
    });

    // ── R16: a localapi exige o Host; R6: os blocos do Taildrop degradam sozinhos ──
    await bloco('R16', async () => {
      const direto = (cabecalhos) => new Promise((resolve) => {
        const req = http.request({ socketPath: caminhoSocket, path: '/localapi/v0/files/', headers: cabecalhos }, (res) => {
          let corpo = '';
          res.on('data', (d) => { corpo += d; });
          res.on('end', () => resolve({ status: res.statusCode, corpo }));
        });
        req.on('error', (e) => resolve({ status: 0, corpo: e.code }));
        req.end();
      });
      const sem = await direto({});
      const com = await direto({ host: 'local-tailscaled.sock' });
      ok('R16', sem.status === 403, `o socket falso SEM Host responde 403 (${sem.status}) — a exigência existe de verdade`);
      ok('R16', com.status === 200 && JSON.parse(com.corpo).length === 2, `e com Host: local-tailscaled.sock responde 200 (${com.status})`);
      const r = await requisicao(PORTA, 'GET', '/api/taildrop/fila');
      ok('R16', r.status === 200 && Array.isArray(r.json.fila) && r.json.fila.length === 2,
        `o servidor manda o Host: GET /api/taildrop/fila traz 2 itens (${r.status} ${JSON.stringify(r.json.fila)})`);
    });

    await bloco('R6', async () => {
      const r = await requisicao(PORTA, 'GET', '/api/taildrop/fila');
      const fila2 = Array.isArray(r.json.fila) ? r.json.fila : [];
      ok('R6', r.status === 200 && fila2.length === 2 && fila2[0].nome === 'a.pdf' && fila2[0].bytes === 10 && fila2[1].nome === 'b.zip' && fila2[1].bytes === 20,
        `fila com 2 itens { nome, bytes } (${JSON.stringify(r.json.fila)})`);
      ok('R6', !/"Name"|"Size"|PeerAPIURL/.test(r.texto), 'só nome e bytes saem — nada do formato da localapi vaza');

      estado.demora = 5000;
      const t0 = Date.now();
      const lenta = await requisicao(PORTA, 'GET', '/api/taildrop/fila');
      const levou = Date.now() - t0;
      estado.demora = 0;
      ok('R6', lenta.status === 200 && lenta.json.fila === null && typeof lenta.json.erro === 'string' && levou < 4000,
        `localapi demorando 5 s → 200 { fila: null, erro } em ${levou} ms (R45: o destroy do timeout)`);
      estado.status = 500;
      const s500 = await requisicao(PORTA, 'GET', '/api/taildrop/fila');
      estado.status = 200;
      ok('R6', s500.status === 200 && s500.json.fila === null && s500.json.erro, `localapi 500 → fila: null (${JSON.stringify(s500.json)})`);
      estado.lixo = true;
      const lixo = await requisicao(PORTA, 'GET', '/api/taildrop/fila');
      estado.lixo = false;
      ok('R6', lixo.status === 200 && lixo.json.fila === null, `corpo "{not json" → fila: null (${JSON.stringify(lixo.json.fila)})`);
      estado.semNome = true;
      const semNome = await requisicao(PORTA, 'GET', '/api/taildrop/fila');
      estado.semNome = false;
      ok('R6', semNome.status === 200 && semNome.json.fila === null, `item sem Name → fila: null (${JSON.stringify(semNome.json.fila)})`);
      estado.gigante = true;
      const gigante = await requisicao(PORTA, 'GET', '/api/taildrop/fila');
      estado.gigante = false;
      ok('R6', gigante.status === 200 && gigante.json.fila === null && gigante.json.erro, `2 MiB de JSON válido → fila: null (R37: corte em 1 MiB) (${JSON.stringify(gigante.json.fila)})`);
      estado.filaNula = true;
      const nula = await requisicao(PORTA, 'GET', '/api/taildrop/fila');
      estado.filaNula = false;
      ok('R6', nula.status === 200 && Array.isArray(nula.json.fila) && nula.json.fila.length === 0, `files/ respondendo null → fila: [] (${JSON.stringify(nula.json.fila)})`);

      const d = await requisicao(PORTA, 'GET', '/api/taildrop/destinos');
      const destinos = Array.isArray(d.json.destinos) ? d.json.destinos : [];
      ok('R6', d.status === 200 && destinos.length === 2 && destinos[0].nome === 'galaxy-falso' && destinos[0].online === true && destinos[0].so === 'android'
        && destinos[1].nome === 'caixa-offline' && destinos[1].online === false,
        `destinos: [{ nome, online, so }] (${JSON.stringify(d.json.destinos)})`);

      socket.fechar();
      await espera(100);
      const semSocket = await requisicao(PORTA, 'GET', '/api/taildrop/fila');
      const semSocketD = await requisicao(PORTA, 'GET', '/api/taildrop/destinos');
      ok('R6', semSocket.status === 200 && semSocket.json.fila === null && typeof semSocket.json.erro === 'string',
        `socket derrubado → 200 { fila: null, erro } (${semSocket.status} ${JSON.stringify(semSocket.json)})`);
      ok('R6', semSocketD.status === 200 && semSocketD.json.destinos === null && typeof semSocketD.json.erro === 'string',
        `e destinos idem (${semSocketD.status} ${JSON.stringify(semSocketD.json)})`);
      const aindaSobe = await upload(PORTA, 'projeto-a', 'sem-taildrop.bin', Buffer.from('upload nao depende da localapi'));
      ok('R6', aindaSobe.status === 201, `no MESMO servidor, POST /api/arquivos continua 201 (${aindaSobe.status}) — os blocos degradam separados`);
      socket = fx.socketFalso(caminhoSocket, estado);
      await socket.pronto;
      const voltou = await requisicao(PORTA, 'GET', '/api/taildrop/fila');
      ok('R6', voltou.status === 200 && Array.isArray(voltou.json.fila) && voltou.json.fila.length === 2, `socket de volta → fila com 2 de novo (${JSON.stringify(voltou.json.fila)})`);
    });

    // ── lista: as três raízes, um nível, sem lixo ─────────────────────────
    await bloco('lista', async () => {
      const r = await requisicao(PORTA, 'GET', '/api/arquivos/lista?raiz=inbox');
      const itens = Array.isArray(r.json.itens) ? r.json.itens : [];
      const nomes = itens.map((i) => i.nome);
      const tipo = (n) => (itens.find((i) => i.nome === n) || {}).tipo;
      ok('lista', r.status === 200 && r.json.raiz === 'inbox' && r.json.caminho === '' && tipo('_triagem') === 'pasta' && tipo('projeto-a') === 'pasta' && tipo('projeto-b') === 'pasta',
        `raiz=inbox lista _triagem, projeto-a e projeto-b como pasta (${r.status} ${nomes.join(', ')})`);
      ok('lista', !nomes.includes('.escondido') && !nomes.includes('node_modules') && !nomes.includes('x~parcial'),
        'e esconde .escondido, node_modules e x~parcial');
      ok('lista', itens.every((i) => typeof i.bytes === 'number' && typeof i.modificadoEm === 'number' && ['pasta', 'arquivo'].includes(i.tipo)),
        'bytes e modificadoEm numéricos, tipo pasta|arquivo');
      const pastasPrimeiro = itens.findIndex((i) => i.tipo === 'arquivo') === -1 || itens.findIndex((i) => i.tipo === 'arquivo') > itens.map((i) => i.tipo).lastIndexOf('pasta');
      ok('lista', pastasPrimeiro, 'pastas antes dos arquivos');
      const sub = await requisicao(PORTA, 'GET', '/api/arquivos/lista?raiz=inbox&caminho=projeto-a');
      const subNomes = (sub.json.itens || []).map((i) => i.nome);
      ok('lista', sub.status === 200 && sub.json.caminho === 'projeto-a' && subNomes.includes('r2.txt') && (sub.json.itens || []).find((i) => i.nome === 'r2.txt').bytes === 14,
        `caminho=projeto-a lista r2.txt com 14 bytes (${sub.status} ${subNomes.slice(0, 5).join(', ')}…)`);
      const proj = await requisicao(PORTA, 'GET', '/api/arquivos/lista?raiz=projetos');
      ok('lista', proj.status === 200 && (proj.json.itens || []).some((i) => i.nome === 'projeto-b' && i.tipo === 'pasta'), `raiz=projetos lista projeto-b (${proj.status})`);
      const projSub = await requisicao(PORTA, 'GET', '/api/arquivos/lista?raiz=projetos&caminho=projeto-b');
      ok('lista', projSub.status === 200 && (projSub.json.itens || []).some((i) => i.nome === 'README.md' && i.tipo === 'arquivo'), `projetos/projeto-b lista README.md (${projSub.status})`);
      const ck = await requisicao(PORTA, 'GET', '/api/arquivos/lista?raiz=cockpit');
      ok('lista', ck.status === 200 && (ck.json.itens || []).some((i) => i.nome === 'anexos' && i.tipo === 'pasta'), `raiz=cockpit lista anexos (${ck.status})`);
      const semCaminho = await requisicao(PORTA, 'GET', '/api/arquivos/lista?raiz=inbox');
      const pastas = await requisicao(PORTA, 'GET', '/api/arquivos/pastas');
      const filaR = await requisicao(PORTA, 'GET', '/api/taildrop/fila');
      const dest = await requisicao(PORTA, 'GET', '/api/taildrop/destinos');
      const tudo = [semCaminho, sub, proj, ck, pastas, filaR, dest].map((x) => semErro(x.json)).join('');
      ok('lista', !tudo.includes('/home/') && !tudo.includes(raiz), 'nenhum caminho absoluto (/home/ ou o tmp) no JSON de lista/pastas/fila/destinos');
    });

    // ── R1: mandar pra fora só de dentro das raízes, e só o realpath vai para a CLI ──
    await bloco('R1', async () => {
      const cps = () => linhasLog('file\tcp').length;
      const antes = cps();
      const ruins = [
        ['GET', '/api/arquivos/lista?raiz=inbox&caminho=..', null],
        ['GET', '/api/arquivos/lista?raiz=cofre', null],
        ['GET', '/api/arquivos/lista?raiz=inbox&caminho=pasta-link', null],
        ['GET', '/api/arquivos/lista?raiz=inbox&caminho=../../cofre/segredo.txt', null],
        ['POST', '/api/taildrop/enviar', { raiz: 'inbox', caminho: 'link-para-fora', destino: 'galaxy-falso' }],
        ['POST', '/api/taildrop/enviar', { raiz: 'inbox', caminho: 'pasta-link/segredo.txt', destino: 'galaxy-falso' }],
        ['POST', '/api/taildrop/enviar', { raiz: 'inbox', caminho: '../../cofre/segredo.txt', destino: 'galaxy-falso' }],
        ['POST', '/api/taildrop/enviar', { raiz: 'inbox', caminho: '..', destino: 'galaxy-falso' }],
        ['POST', '/api/taildrop/enviar', { raiz: 'cofre', caminho: 'segredo.txt', destino: 'galaxy-falso' }],
        ['POST', '/api/taildrop/enviar', { raiz: 'inbox', caminho: 'projeto-a', destino: 'galaxy-falso' }],
        ['POST', '/api/taildrop/enviar', { raiz: 'inbox', caminho: ['projeto-a/r2.txt'], destino: 'galaxy-falso' }],
      ];
      for (const [metodo, rota, corpo] of ruins) {
        const r = corpo ? await json(PORTA, metodo, rota, corpo) : await requisicao(PORTA, metodo, rota);
        ok('R1', r.status === 400, `${metodo} ${rota}${corpo ? ' ' + JSON.stringify(corpo) : ''} → 400 (${r.status} ${r.json.erro || ''})`);
      }
      ok('R1', cps() === antes, 'e nenhum dos caminhos ruins chegou à CLI (chamadas.log sem cp novo)');

      const bom = await json(PORTA, 'POST', '/api/taildrop/enviar', { raiz: 'inbox', caminho: 'projeto-a/r2.txt', destino: 'galaxy-falso' });
      ok('R1', bom.status === 200 && bom.json.enviado === true && bom.json.bytes === 14 && bom.json.destino === 'galaxy-falso',
        `caminho bom + destino da lista → 200 { enviado, bytes, destino } (${bom.status} ${JSON.stringify(bom.json)})`);
      const esperado = `file\tcp\t${path.join(inboxReal, 'projeto-a', 'r2.txt')}\tgalaxy-falso:`;
      ok('R1', lerLog().split('\n').includes(esperado), `chamadas.log tem exatamente "file cp <realpath> galaxy-falso:"`);

      const antesOff = cps();
      const off = await json(PORTA, 'POST', '/api/taildrop/enviar', { raiz: 'inbox', caminho: 'projeto-a/r2.txt', destino: 'caixa-offline' });
      ok('R1', off.status === 502 && /offline/.test(off.json.erro || ''), `destino offline → 502 com "offline" na mensagem — quem decide é a CLI (${off.status} ${JSON.stringify(off.json.erro)})`);
      ok('R1', off.json.erro && !off.json.erro.includes('\x1b') && !off.json.erro.includes(raiz),
        'e a mensagem não tem sequência ANSI nem o caminho absoluto');
      ok('R1', cps() === antesOff + 1, 'o log tem a chamada file cp para caixa-offline: (a lista não decide, a CLI decide)');
      const antesNao = cps();
      const nao = await json(PORTA, 'POST', '/api/taildrop/enviar', { raiz: 'inbox', caminho: 'projeto-a/r2.txt', destino: 'nao-existe' });
      ok('R1', nao.status === 400 && cps() === antesNao, `destino=nao-existe → 400 sem chamada (${nao.status})`);

      const tresEnvios = await Promise.all([0, 1, 2].map(() => json(PORTA, 'POST', '/api/taildrop/enviar', { raiz: 'inbox', caminho: 'projeto-a/r2.txt', destino: 'galaxy-falso' })));
      const statusEnvios = tresEnvios.map((r) => r.status).sort();
      ok('R54', statusEnvios.join(',') === '200,200,429', `três envios no mesmo tick → dois 200 e um 429 (${statusEnvios.join(',')})`);
      ok('R54', /2/.test((tresEnvios.find((r) => r.status === 429) || { json: {} }).json.erro || ''), 'e o 429 diz que já tem 2 envios saindo');

      estado.duplicado = true;
      const antesDup = cps();
      const dup = await json(PORTA, 'POST', '/api/taildrop/enviar', { raiz: 'inbox', caminho: 'projeto-a/r2.txt', destino: 'galaxy-falso' });
      estado.duplicado = false;
      ok('R55', dup.status === 502 && /mesmo nome/.test(dup.json.erro || ''), `dois aparelhos com o mesmo nome → 502 "mesmo nome" (${dup.status} ${dup.json.erro})`);
      ok('R55', cps() === antesDup, 'e nenhuma linha nova em chamadas.log — não escolhe um');
    });

    // ── R5/R28/R23/R29: puxar a fila, medido no disco ─────────────────────
    await bloco('R5', async () => {
      fx.reporFila(raiz);
      ok('R28', !fs.existsSync(path.join(inbox, 'a.pdf')) && !fs.existsSync(path.join(inbox, 'b.zip')), 'antes do puxar, a raiz do inbox não tem a.pdf nem b.zip');
      const gets = () => linhasLog('file\tget');
      const antes = gets().length;
      const r = await json(PORTA, 'POST', '/api/taildrop/puxar', {});
      ok('R5', r.status === 200 && r.json.puxados === 2, `POST /api/taildrop/puxar → 200 com puxados: 2 (${r.status} ${JSON.stringify(r.json.puxados)})`);
      const novas = gets().slice(antes);
      ok('R5', novas.length === 1 && novas[0] === `file\tget\t--conflict=rename\t${path.join(raiz, 'taildrop-inbox')}`,
        `o log tem exatamente "file get --conflict=rename <inbox>" (${JSON.stringify(novas)})`);
      ok('R28', fs.existsSync(path.join(inbox, 'a.pdf')) && fs.existsSync(path.join(inbox, 'b.zip')), 'depois, a.pdf e b.zip estão na raiz do inbox — puxados veio do disco');
      const filaDepois = await requisicao(PORTA, 'GET', '/api/taildrop/fila');
      ok('R28', filaDepois.status === 200 && Array.isArray(filaDepois.json.fila) && filaDepois.json.fila.length === 0,
        `e GET /api/taildrop/fila logo depois é fila: [] — o socket lê o disco que o binário esvaziou (${JSON.stringify(filaDepois.json.fila)})`);
      const saida = String(r.json.saida || '');
      ok('R5', saida.includes('~/x'), `a saída da CLI troca $HOME por ~ (${JSON.stringify(saida.slice(0, 80))})`);
      ok('R29', saida.includes('inbox/y') && !saida.includes('taildrop-inbox/y'), 'e o caminho do inbox vira o rótulo "inbox" (não "~/taildrop-inbox")');
      ok('R29', !saida.includes(raiz) && !saida.includes('/tmp/'), 'e o tmp fora de /home não aparece — a promessa cobre os caminhos que o módulo entregou à CLI');
    });

    // ── R34: um puxar por vez ─────────────────────────────────────────────
    await bloco('R34', async () => {
      fx.reporFila(raiz);
      const antes = linhasLog('file\tget').length;
      const [a, b] = await Promise.all([json(PORTA, 'POST', '/api/taildrop/puxar', {}), json(PORTA, 'POST', '/api/taildrop/puxar', {})]);
      const status = [a.status, b.status].sort();
      ok('R34', status.join(',') === '200,409', `dois puxar no mesmo tick → um 200 e um 409 (${status.join(',')})`);
      ok('R34', /puxando/.test((a.status === 409 ? a : b).json.erro || ''), 'e o 409 diz "já estou puxando a fila"');
      ok('R34', linhasLog('file\tget').length === antes + 1, 'chamadas.log ganhou exatamente UMA linha file get');
    });

    // ── R32: conferirTemporario isolada + ordem no texto ─────────────────
    await bloco('R32', async () => {
      if (!modulo) { ok('R32', false, 'lib/arquivos.js não existe'); return; }
      process.env.COCKPIT_INBOX = inbox;
      const fora = path.join(inbox, 'pasta-link', 't~parcial');
      const dentro = path.join(pastaAlav, 't~parcial');
      fs.writeFileSync(fora, 'x');
      fs.writeFileSync(dentro, 'x');
      let codigo = null;
      try { await modulo.conferirTemporario(fora); } catch (e) { codigo = e.codigo; }
      ok('R32', codigo === 400, `conferirTemporario(<inbox>/pasta-link/t~parcial) rejeita com codigo 400 (${codigo})`);
      let passou = false;
      try { await modulo.conferirTemporario(dentro); passou = true; } catch { passou = false; }
      ok('R32', passou, 'e <inbox>/projeto-a/t~parcial passa');
      fs.unlinkSync(fora); fs.unlinkSync(dentro);
      const fonte = fs.readFileSync(path.join(__dirname, '..', 'lib', 'arquivos.js'), 'utf8');
      const ocorrencias = (fonte.match(/conferirTemporario\(/g) || []).length;
      ok('R32', ocorrencias >= 2, `conferirTemporario( aparece ≥ 2 vezes no fonte (${ocorrencias})`);
      const iReceber = fonte.indexOf('async function receber(');
      const fimReceber = (() => { const m = fonte.slice(iReceber + 1).search(/\n(async )?function /); return m === -1 ? fonte.length : iReceber + 1 + m; })();
      const corpo = fonte.slice(iReceber, fimReceber);
      const iOpen = corpo.indexOf('fsp.open(');
      const iConf = corpo.indexOf('conferirTemporario(', iOpen + 1);
      const iPipe = corpo.indexOf('pipeline(');
      ok('R32', iReceber >= 0 && iOpen > 0 && iConf > iOpen && iPipe > iConf,
        `no corpo de receber: fsp.open( (${iOpen}) < conferirTemporario( (${iConf}) < pipeline( (${iPipe})`);
      const antesDaConf = corpo.slice(0, Math.max(iConf, 0));
      ok('R32', iConf > 0 && !/req\.on\('data'|req\.pipe\(|req\.read\(|for await \(.* of req\)/.test(antesDaConf),
        'e nenhum req.on(data)/req.pipe/req.read/for await antes da conferência (R35)');
    });

    // ── R24/R31 no módulo: env lixo cai no padrão ─────────────────────────
    await bloco('R24', async () => {
      if (!modulo) { ok('R24', false, 'lib/arquivos.js não existe'); return; }
      process.env.COCKPIT_SILENCIO_UPLOAD_MS = 'abc';
      ok('R24', modulo.silencioDoUpload() === 120000, `silencioDoUpload() com env "abc" → 120000 (${modulo.silencioDoUpload()})`);
      process.env.COCKPIT_SILENCIO_UPLOAD_MS = '-5';
      ok('R24', modulo.silencioDoUpload() === 120000, `e com "-5" → 120000 (${modulo.silencioDoUpload()})`);
      delete process.env.COCKPIT_SILENCIO_UPLOAD_MS;
      process.env.COCKPIT_TETO_ARQUIVO = '1.5';
      ok('R24', modulo.tetoDoUpload() === 2 * GiB, `tetoDoUpload() com "1.5" → 2 GiB (${modulo.tetoDoUpload()})`);
      delete process.env.COCKPIT_TETO_ARQUIVO;
    });
    await bloco('R31', async () => {
      if (!modulo) { ok('R31', false, 'lib/arquivos.js não existe'); return; }
      process.env.COCKPIT_SILENCIO_MS = 'abc';
      ok('R31', modulo.silencioGeral() === 300000, `silencioGeral() com env "abc" → 300000 (${modulo.silencioGeral()})`);
      delete process.env.COCKPIT_SILENCIO_MS;
    });

    // ── Auxiliar (a): teto 1 MiB, silêncios de 1,5 s, CLI que dorme 3 s ───
    const inboxA = path.join(raiz, 'inbox-a');
    fs.mkdirSync(path.join(inboxA, 'projeto-a'), { recursive: true });
    const pastaA = path.join(inboxA, 'projeto-a');
    await bloco('servidor', async () => {
      auxiliar = await fx.subirServidor({
        porta: PORTA_AUX, home: raiz, socket: caminhoSocket, binario,
        extras: { COCKPIT_INBOX: inboxA, COCKPIT_TETO_ARQUIVO: String(MiB), COCKPIT_SILENCIO_UPLOAD_MS: '1500', COCKPIT_SILENCIO_MS: '1500', TAILSCALE_FALSO_DORMIR_MS: '3000' },
      });
      ok('servidor', true, `auxiliar (a) no ar na ${PORTA_AUX} (pid ${auxiliar.processo.pid}) — teto 1 MiB, silêncios 1,5 s`);
    });
    if (auxiliar) {
      await bloco('413', async () => {
        const pastas = await requisicao(PORTA_AUX, 'GET', '/api/arquivos/pastas');
        ok('413', pastas.json.teto === MiB, `o auxiliar publica teto = 1 MiB (${pastas.json.teto})`);
        const u = abrirUpload(PORTA_AUX, { nome: 'contador.bin', total: null });
        for (let i = 0; i < 8; i += 1) { if (!(await escrever(u.req, Buffer.alloc(256 * 1024, 2)))) break; }
        u.req.end();
        const r = await corrida(u.resposta, 5000, { status: 0, erro: 'timeout', json: {}, cabecalhos: {} });
        await espera(300);
        const aceito = r.status === 413 || ['ECONNRESET', 'EPIPE'].includes(r.erro);
        ok('413', aceito, `2 MB sem content-length com teto de 1 MiB → 413 ou queda de conexão (${r.status || r.erro}) — melhor esforço`);
        ok('413', !fs.existsSync(path.join(pastaA, 'contador.bin')) && parciais(pastaA).length === 0, 'e o disco fica limpo: sem nome bom, sem ~parcial');
        await provarContadorZerado(PORTA_AUX, 'projeto-a', pastaA, '413 pelo contador');
      });
      await bloco('R24', async () => {
        const u = abrirUpload(PORTA_AUX, { nome: 'silencio.bin', total: 2000000 });
        await escrever(u.req, Buffer.alloc(500 * 1024, 1));
        const t0 = Date.now();
        const fechou = await corrida(u.fechado.then(() => true), 4000, false);
        await espera(200);
        ok('R24', fechou, `upload calado depois de 500 KB → o servidor fecha o socket em ${Date.now() - t0} ms (silêncio de 1,5 s)`);
        ok('R24', !fs.existsSync(path.join(pastaA, 'silencio.bin')) && parciais(pastaA).length === 0, 'e a pasta não tem nem o nome final nem ~parcial');
        u.req.destroy();
        await provarContadorZerado(PORTA_AUX, 'projeto-a', pastaA, 'silêncio');
      });
      await bloco('R31', async () => {
        const u = abrirUpload(PORTA_AUX, { caminho: '/api/taildrop/enviar', total: 200, cabecalhos: { 'content-type': 'application/json' } });
        u.req.write('{"raiz":');
        const t0 = Date.now();
        const fechou = await corrida(u.fechado.then(() => true), 4000, false);
        ok('R31', fechou, `POST /api/taildrop/enviar com JSON pela metade e calado → socket fechado em ${Date.now() - t0} ms (silêncio geral de 1,5 s)`);
        u.req.destroy();
      });
      await bloco('R39', async () => {
        fx.reporFila(raiz);
        const t0 = Date.now();
        const r = await json(PORTA_AUX, 'POST', '/api/taildrop/puxar', {});
        const levou = Date.now() - t0;
        ok('R39', r.status === 200 && levou >= 2500, `com a CLI dormindo 3 s e o silêncio em 1,5 s, puxar responde 200 em ${levou} ms — o silêncio não derrubou a espera (${r.status})`);
        fx.reporFila(raiz);
      });
      await derrubarAuxiliar();
    }

    // ── Auxiliar (b): teto = livre + 2 GiB, para o 507 e o R59 ───────────
    const st = fs.statfsSync(pastaAlav);
    const livre = Number(st.bavail) * Number(st.bsize);
    await bloco('servidor', async () => {
      if (!Number.isSafeInteger(livre) || livre <= 0) throw new Error(`livre inválido: ${livre}`);
      auxiliar = await fx.subirServidor({
        porta: PORTA_AUX, home: raiz, socket: caminhoSocket, binario,
        extras: { COCKPIT_TETO_ARQUIVO: String(livre + 2 * GiB) },
      });
      ok('servidor', true, `auxiliar (b) no ar — teto ${((livre + 2 * GiB) / GiB).toFixed(1)} GiB, disco livre ${(livre / GiB).toFixed(1)} GiB`);
    });
    if (auxiliar) {
      await bloco('507', async () => {
        const u = abrirUpload(PORTA_AUX, { nome: 'nao-cabe.bin', total: livre + GiB });
        u.req.write(Buffer.alloc(65536, 1));
        const r = await corrida(u.resposta, 5000, { status: 0, json: {}, cabecalhos: {} });
        const fechou = await corrida(u.fechado.then(() => true), 2000, false);
        ok('507', r.status === 507 && /disco/.test(r.json.erro || ''), `content-length = livre + 1 GiB → 507 "não cabe no disco" sem escrever (${r.status} ${r.json.erro})`);
        ok('R58', r.status === 507 && String(r.cabecalhos.connection || '').toLowerCase() === 'close' && fechou,
          `507: chega com connection: close e o socket fecha em até 2 s (connection=${r.cabecalhos.connection}, fechou=${fechou})`);
        ok('507', !fs.existsSync(path.join(pastaAlav, 'nao-cabe.bin')) && parciais(pastaAlav).length === 0, 'nada no disco');
        u.req.destroy();
        if (livre + GiB > 2 * GiB) {
          const p = abrirUpload(PORTA, { nome: 'nao-cabe-principal.bin', total: livre + GiB });
          p.req.flushHeaders();
          const rp = await corrida(p.resposta, 5000, { status: 0, json: {}, cabecalhos: {} });
          ok('507', rp.status === 413, `no principal (teto 2 GiB) o mesmo pedido é 413 — o teto vem antes do disco (R33) (${rp.status})`);
          p.req.destroy();
        } else {
          aviso('507', 'disco pequeno demais para a prova de precedência');
        }
        const terco = Math.floor(livre / 3);
        const abertos = [];
        for (let i = 0; i < 3; i += 1) {
          const a = abrirUpload(PORTA_AUX, { nome: `r59-${i}.bin`, total: terco });
          a.req.flushHeaders();
          abertos.push(a);
          await espera(150);
        }
        const terceiro = await corrida(abertos[2].resposta, 5000, { status: 0, json: {}, cabecalhos: {} });
        ok('R59', terceiro.status === 507, `três uploads de livre/3 abertos → o terceiro é 507: a soma dos em curso + 256 MiB passa do disco (${terceiro.status})`);
        const primeiros = await Promise.all(abertos.slice(0, 2).map((a) => corrida(a.resposta, 200, { status: 'pendente' })));
        ok('R59', primeiros.every((r) => r.status === 'pendente'), `e os dois primeiros continuam abertos (${primeiros.map((r) => r.status).join(',')})`);
        for (const a of abertos) a.req.destroy();
        await espera(400);
        const depois = await upload(PORTA_AUX, 'projeto-a', 'r59-depois.bin', Buffer.from('cabe'));
        ok('R59', depois.status === 201, `com os dois destruídos, um upload pequeno volta a ser 201 — o reservado foi liberado (${depois.status})`);
        try { fs.unlinkSync(path.join(pastaAlav, 'r59-depois.bin')); } catch { /* já */ }
        ok('507', parciais(pastaAlav).length === 0, 'nenhum ~parcial dos abortados');
        await provarContadorZerado(PORTA_AUX, 'projeto-a', pastaAlav, '507');
      });
      await derrubarAuxiliar();
    }

    // ── Auxiliar (c): inbox só leitura → não consegue criar _triagem (R50) ──
    const inboxRo = path.join(raiz, 'inbox-ro');
    fs.mkdirSync(inboxRo, { recursive: true });
    if (process.getuid && process.getuid() === 0) {
      aviso('R50', 'root — prova pulada');
    } else {
      fs.chmodSync(inboxRo, 0o500);
      await bloco('R50', async () => {
        auxiliar = await fx.subirServidor({ porta: PORTA_AUX, home: raiz, socket: caminhoSocket, binario, extras: { COCKPIT_INBOX: inboxRo } });
        const r = await requisicao(PORTA_AUX, 'GET', '/api/arquivos/pastas');
        ok('R50', r.status === 500 && /_triagem/.test(r.json.erro || ''), `inbox sem permissão de escrita → GET /pastas é 500 com _triagem na mensagem (${r.status} ${r.json.erro})`);
        ok('R50', !fs.existsSync(path.join(inboxRo, '_triagem')), 'e nada foi criado');
      });
      await derrubarAuxiliar();
      fs.chmodSync(inboxRo, 0o700);
    }

    // ── Auxiliar (d): _triagem como ARQUIVO (R60) e a CLI que fala demais (R53) ──
    const inboxD = path.join(raiz, 'inbox-d');
    fs.mkdirSync(inboxD, { recursive: true });
    fs.writeFileSync(path.join(inboxD, '_triagem'), 'não sou pasta');
    await bloco('R60', async () => {
      fx.reporFila(raiz);
      auxiliar = await fx.subirServidor({ porta: PORTA_AUX, home: raiz, socket: caminhoSocket, binario, extras: { COCKPIT_INBOX: inboxD, TAILSCALE_FALSO_GRITAR: '1' } });
      const r = await requisicao(PORTA_AUX, 'GET', '/api/arquivos/pastas');
      ok('R60', r.status === 500 && /_triagem/.test(r.json.erro || ''), `_triagem pré-criada como arquivo → /pastas é 500 com _triagem na mensagem (${r.status} ${r.json.erro})`);
      ok('R60', fs.readFileSync(path.join(inboxD, '_triagem'), 'utf8') === 'não sou pasta', 'e o arquivo não foi tocado');
      const p = await json(PORTA_AUX, 'POST', '/api/taildrop/puxar', {});
      ok('R53', p.status === 502 && /falou demais/.test(p.json.erro || ''), `CLI despejando 2 MiB no stdout → puxar é 502 "falou demais" (${p.status} ${p.json.erro})`);
    });
    await derrubarAuxiliar();
    fx.reporFila(raiz);

    // ── Auxiliar (e): teto lixo cai no padrão ────────────────────────────
    await bloco('413', async () => {
      auxiliar = await fx.subirServidor({ porta: PORTA_AUX, home: raiz, socket: caminhoSocket, binario, extras: { COCKPIT_TETO_ARQUIVO: 'abc' } });
      const r = await requisicao(PORTA_AUX, 'GET', '/api/arquivos/pastas');
      ok('413', r.status === 200 && r.json.teto === 2 * GiB, `COCKPIT_TETO_ARQUIVO=abc → /pastas traz o padrão de 2 GiB (${r.json.teto})`);
    });
    await derrubarAuxiliar();
  } catch (e) {
    if (!/porta ocupada|não respondeu/.test(String(e && e.message))) ok('servidor', false, `o gate estourou: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
  } finally {
    await derrubarAuxiliar();
    if (principal) await principal.matar();
    if (socket) socket.fechar();
    if (raiz) {
      try { fs.chmodSync(path.join(raiz, 'inbox-ro'), 0o700); } catch { /* não existe */ }
      fs.rmSync(raiz, { recursive: true, force: true });
    }
    console.log(`GATE ${falhas ? 'VERMELHO' : 'VERDE'} — ${feitos - falhas}/${feitos}`);
    process.exit(falhas ? 1 : 0);
  }
})();
