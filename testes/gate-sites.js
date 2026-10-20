#!/usr/bin/env node
'use strict';
// GATE — a faixa PROD FORA (D87; spec 2026-10-16-faixa-prod-fora-design.md): o leitor do estado
// do vigia de prod (lib/sites.js), a rota só-leitura `GET /api/sites` e a costura da tela
// (public/monitor.js + public/traducoes.js + public/index.html + public/estilo.css).
//
// S1-S12 provam o leitor (funções PURAS + `ler()` com disco de fixture) contra um arquivo de
// estado SEMPRE em `mkdtemp` — nunca o real, nunca rede. S13/S14 (a costura da tela e as puras
// de `public/monitor.js`) entram na fase 2, junto com os casos de TEXTO.
//
// Isolamento: `COCKPIT_VIGIA_PROD_ARQ` é definida ANTES do `require('../lib/sites')` — ela VENCE
// um `HOME` falso (#62): sem a env, o módulo cairia no `~/.cockpit/vigia-prod/estado.json` de
// quem estiver rodando o gate.
//
// Uso: node testes/gate-sites.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

let falhas = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); if (!cond) falhas += 1; return cond; };

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-sites-'));
// Caminho que não existe ainda (a pasta "nada" nunca é criada) — estado neutro antes de o
// primeiro caso plantar o arquivo de verdade.
process.env.COCKPIT_VIGIA_PROD_ARQ = path.join(RAIZ, 'nada', 'estado.json');
const sites = require('../lib/sites');

const ARQ = path.join(RAIZ, 'estado.json');

/** Planta o arquivo de estado (objeto → JSON; string → texto cru) e aponta a env para ele. */
function plantar(objOuTexto) {
  const texto = typeof objOuTexto === 'string' ? objOuTexto : JSON.stringify(objOuTexto);
  fs.writeFileSync(ARQ, texto);
  process.env.COCKPIT_VIGIA_PROD_ARQ = ARQ;
}

/** Remove o arquivo (o site ausente) sem mudar o caminho apontado pela env. */
function removerArquivo() {
  fs.rmSync(ARQ, { force: true });
  process.env.COCKPIT_VIGIA_PROD_ARQ = ARQ;
}

const iso = (msAtras) => new Date(Date.now() - msAtras).toISOString();

async function main() {
  // ─── S1 — site no ar ───
  {
    sites._zerarParaTeste();
    plantar({ loja: { url: 'http://loja.exemplo', status: 'up', falhas: 0, desde: null, ultimo_check: iso(30000), ultimo_detalhe: '200', ultimo_aviso: null, quedas: [] } });
    const r = await sites.ler();
    const loja = r.sites.find((s) => s.nome === 'loja');
    ok(r.arquivo === 'ok', `S1: arquivo "ok" (veio ${r.arquivo})`);
    ok(loja && loja.situacao === 'no-ar' && loja.fora === false, `S1: no ar, falhas 0 (veio ${JSON.stringify(loja)})`);
  }

  // ─── S2 — site fora ───
  {
    sites._zerarParaTeste();
    plantar({ loja: { url: 'http://loja.exemplo', status: 'down', falhas: 13, desde: iso(720000), ultimo_check: iso(0), ultimo_detalhe: '502' } });
    const r = await sites.ler();
    const loja = r.sites.find((s) => s.nome === 'loja');
    ok(loja && loja.fora === true, `S2: fora (veio ${JSON.stringify(loja)})`);
    ok(loja && loja.foraHaS >= 715 && loja.foraHaS <= 725, `S2: foraHaS ≈ 720 — desde e derivado coincidem (veio ${loja && loja.foraHaS})`);
    ok(loja && loja.detalhe === '502', `S2: detalhe "502" (veio ${loja && loja.detalhe})`);
  }

  // ─── S3 — Telegram fora NA QUEDA (status fica "up" com falhas subindo) ───
  {
    sites._zerarParaTeste();
    plantar({ loja: { status: 'up', falhas: 3, ultimo_check: iso(0) } });
    const r = await sites.ler();
    const loja = r.sites.find((s) => s.nome === 'loja');
    ok(loja && loja.fora === true, `S3: falhas 3 com status "up" ainda é fora (veio ${JSON.stringify(loja)})`);
    ok(loja && loja.foraHaS >= 115 && loja.foraHaS <= 125, `S3: início = check − 2 min (veio ${loja && loja.foraHaS})`);
  }

  // ─── S4 — Telegram fora NA VOLTA (status fica "down" com falhas zeradas) ───
  {
    sites._zerarParaTeste();
    plantar({ loja: { status: 'down', falhas: 0, ultimo_check: iso(0) } });
    const r = await sites.ler();
    const loja = r.sites.find((s) => s.nome === 'loja');
    ok(loja && loja.situacao === 'no-ar' && loja.fora === false, `S4: falhas 0 volta a "no-ar" mesmo com status "down" (veio ${JSON.stringify(loja)})`);
  }

  // ─── S5 — 1 falha só (ainda não confirmou queda) ───
  {
    sites._zerarParaTeste();
    plantar({ loja: { status: 'up', falhas: 1, ultimo_check: iso(0) } });
    const r = await sites.ler();
    const loja = r.sites.find((s) => s.nome === 'loja');
    ok(loja && loja.situacao === 'no-ar', `S5: 1 falha → ainda "no-ar" (veio ${JSON.stringify(loja)})`);
  }

  // ─── S6 — vigia parado (sem queda) ───
  {
    sites._zerarParaTeste();
    plantar({ loja: { status: 'up', falhas: 0, ultimo_check: iso(360000) } });
    const r = await sites.ler();
    const loja = r.sites.find((s) => s.nome === 'loja');
    ok(loja && loja.situacao === 'parado' && loja.checadoHaS >= 355 && loja.checadoHaS <= 365, `S6: check há 6 min → parado (veio ${JSON.stringify(loja)})`);
  }

  // ─── S7 — parado DURANTE uma queda ───
  {
    sites._zerarParaTeste();
    plantar({ loja: { status: 'down', falhas: 4, ultimo_check: iso(1200000) } });
    const r = await sites.ler();
    const loja = r.sites.find((s) => s.nome === 'loja');
    ok(loja && loja.fora === true && loja.parado === true && loja.situacao === 'fora', `S7: fora + parado, situacao continua "fora" (veio ${JSON.stringify(loja)})`);
  }

  // ─── S8 — arquivo ausente ───
  {
    sites._zerarParaTeste();
    plantar({ loja: { status: 'up', falhas: 0, ultimo_check: iso(0) } });
    await sites.ler();
    removerArquivo();
    const r = await sites.ler();
    ok(r.arquivo === 'ausente' && r.sites.length === 0, `S8: ausente → sites vazio (veio ${JSON.stringify(r)})`);
  }

  // ─── S9 — corrompido (4 sabores) ───
  {
    sites._zerarParaTeste();
    plantar('{ "loja": { "status": "up"');
    const r1 = await sites.ler();
    ok(r1.arquivo === 'ilegivel', `S9: "{" cortado → ilegivel (veio ${r1.arquivo})`);

    sites._zerarParaTeste();
    plantar('[1, 2, 3]');
    const r2 = await sites.ler();
    ok(r2.arquivo === 'ilegivel', `S9: raiz array → ilegivel (veio ${r2.arquivo})`);

    sites._zerarParaTeste();
    plantar('null');
    const r3 = await sites.ler();
    ok(r3.arquivo === 'ilegivel', `S9: raiz null → ilegivel (veio ${r3.arquivo})`);

    sites._zerarParaTeste();
    plantar('x'.repeat(300 * 1024));
    const r4 = await sites.ler();
    ok(r4.arquivo === 'ilegivel', `S9: arquivo de 300 KB → ilegivel (veio ${r4.arquivo})`);
  }

  // ─── S10 — saneamento ───
  {
    sites._zerarParaTeste();
    plantar({
      loja: { url: 'http://loja.exemplo/segredo', status: 'up', falhas: 0, ultimo_check: iso(30000), ultimo_detalhe: '200 ok', quedas: [{ inicio: 'x', fim: 'y', segundos: 1 }] },
      'nome inválido': { status: 'up', falhas: 0, ultimo_check: iso(30000) },
      'tem/barra': { status: 'up', falhas: 0, ultimo_check: iso(30000) },
      semcheck: { status: 'up', falhas: 0, ultimo_check: 'não é uma data' },
    });
    const r = await sites.ler();
    const bruto = JSON.stringify(r);
    ok(!bruto.includes('url') && !bruto.includes('quedas') && !bruto.includes('segredo'), `S10: url/quedas nunca no corpo (veio ${bruto})`);
    ok(!r.sites.some((s) => s.nome === 'nome inválido' || s.nome === 'tem/barra'), 'S10: nome com espaço ou "/" é pulado');
    const loja = r.sites.find((s) => s.nome === 'loja');
    ok(loja && loja.detalhe === null, `S10: detalhe com espaço → null (veio ${loja && loja.detalhe})`);
    const semcheck = r.sites.find((s) => s.nome === 'semcheck');
    ok(semcheck && semcheck.checadoHaS === null && semcheck.parado === true, `S10: ultimo_check inválido → parado, checadoHaS null (veio ${JSON.stringify(semcheck)})`);
  }

  // ─── S10b — campo inválido (falhas) nunca vira "no ar" ───
  {
    sites._zerarParaTeste();
    plantar({
      semfalhas: { status: 'down', ultimo_check: iso(0) },
      falhasstring: { status: 'down', falhas: '3', ultimo_check: iso(0) },
      falhasnegativa: { status: 'down', falhas: -1, ultimo_check: iso(0) },
      statustalvezfora: { status: 'talvez', falhas: 5, ultimo_check: iso(0) },
      statustalvezok: { status: 'talvez', falhas: 0, ultimo_check: iso(0) },
    });
    const r = await sites.ler();
    const s = (n) => r.sites.find((x) => x.nome === n);
    ok(s('semfalhas') && s('semfalhas').situacao === 'parado' && s('semfalhas').situacao !== 'no-ar', `S10b: falhas ausente → parado (veio ${JSON.stringify(s('semfalhas'))})`);
    ok(s('falhasstring') && s('falhasstring').situacao === 'parado', `S10b: falhas "3" (string) → parado (veio ${JSON.stringify(s('falhasstring'))})`);
    ok(s('falhasnegativa') && s('falhasnegativa').situacao === 'parado', `S10b: falhas -1 → parado (veio ${JSON.stringify(s('falhasnegativa'))})`);
    ok(s('statustalvezfora') && s('statustalvezfora').fora === true, `S10b: status "talvez" + falhas 5 → fora (veio ${JSON.stringify(s('statustalvezfora'))})`);
    ok(s('statustalvezok') && s('statustalvezok').situacao === 'no-ar', `S10b: status "talvez" + falhas 0 → no-ar (veio ${JSON.stringify(s('statustalvezok'))})`);
  }

  // ─── S10c — queda → volta sem Telegram → nova queda (o `max` entra em ação) ───
  {
    sites._zerarParaTeste();
    plantar({ loja: { status: 'down', desde: iso(5 * 3600 * 1000), falhas: 2, ultimo_check: iso(30000) } });
    const r = await sites.ler();
    const loja = r.sites.find((s) => s.nome === 'loja');
    ok(loja && loja.fora === true, `S10c: fora (veio ${JSON.stringify(loja)})`);
    ok(loja && loja.foraHaS >= 85 && loja.foraHaS <= 95, `S10c: foraHaS ≈ 90 (o max), não 5 h (veio ${loja && loja.foraHaS})`);
  }

  // ─── S10d — ilegível DEPOIS de uma queda (a memória segura a faixa vermelha) ───
  {
    sites._zerarParaTeste();
    plantar({ loja: { status: 'down', falhas: 3, ultimo_check: iso(0), desde: iso(180000) } });
    const r1 = await sites.ler();
    const loja1 = r1.sites.find((s) => s.nome === 'loja');
    ok(loja1 && loja1.fora === true, `S10d: 1ª leitura — fora (veio ${JSON.stringify(loja1)})`);

    plantar('isto quebrou {');
    const r2 = await sites.ler();
    const loja2 = r2.sites.find((s) => s.nome === 'loja');
    ok(r2.arquivo === 'ilegivel' && loja2 && loja2.fora === true && loja2.parado === true, `S10d: 2ª leitura — ilegivel, mas "loja" continua fora + parado (veio ${JSON.stringify(r2)})`);

    sites._zerarParaTeste();
    plantar('nunca houve leitura boa {');
    const r3 = await sites.ler();
    ok(r3.arquivo === 'ilegivel' && r3.sites.length === 0, `S10d: sem leitura boa antes → sites vazio (veio ${JSON.stringify(r3)})`);

    sites._zerarParaTeste();
    plantar({ loja: { status: 'down', falhas: 3, ultimo_check: iso(0) } });
    await sites.ler();
    removerArquivo();
    await sites.ler(); // ausente — limpa a memória
    plantar('lixo outra vez {');
    const r4 = await sites.ler();
    ok(r4.arquivo === 'ilegivel' && r4.sites.length === 0, `S10d: "ausente" no meio limpou a memória (veio ${JSON.stringify(r4)})`);
  }

  // ─── S10e — "{}" válido ───
  {
    sites._zerarParaTeste();
    plantar({});
    const r = await sites.ler();
    ok(r.arquivo === 'ok' && r.sites.length === 0, `S10e: "{}" → ok, sites vazio (veio ${JSON.stringify(r)})`);
  }

  // ─── S10f — `stat` falha com ENOENT (pasta inexistente) → ausente, não ilegivel ───
  {
    sites._zerarParaTeste();
    const guardado = process.env.COCKPIT_VIGIA_PROD_ARQ;
    process.env.COCKPIT_VIGIA_PROD_ARQ = path.join(RAIZ, 'pasta-que-nao-existe', 'estado.json');
    const r = await sites.ler();
    ok(r.arquivo === 'ausente', `S10f: pasta inexistente → ausente, não ilegivel (veio ${r.arquivo})`);
    process.env.COCKPIT_VIGIA_PROD_ARQ = guardado;
  }

  // ─── S10h — log só na transição ───
  {
    sites._zerarParaTeste();
    const original = console.error;
    let contador = 0;
    console.error = () => { contador += 1; };
    try {
      plantar('lixo 1 {');
      await sites.ler();
      await sites.ler();
      await sites.ler();
      ok(contador === 1, `S10h: 3 leituras ilegíveis seguidas → 1 linha de log (veio ${contador})`);
      plantar({ loja: { status: 'up', falhas: 0, ultimo_check: iso(10000) } });
      await sites.ler(); // ok — reseta o último código logado
      plantar('lixo 2 {');
      await sites.ler();
      ok(contador === 2, `S10h: ok → ilegível de novo → 2ª linha (veio ${contador})`);
    } finally {
      console.error = original;
    }
  }

  // ─── S11 — a rota, com `server.js` FILHO ───
  {
    const portaLivre = (porta) => {
      try {
        const saida = execFileSync('ss', ['-H', '-lptn'], { encoding: 'utf8' });
        return !saida.split('\n').some((l) => (l.trim().split(/\s+/)[3] || '').endsWith(`:${porta}`));
      } catch { return true; }
    };
    const PORTA = [7884, 7885, 7886, 7887].find(portaLivre);
    const TOKEN = 'gate-sites';
    const raizS11 = path.join(RAIZ, 's11');
    const certVazio = path.join(raizS11, 'cert-vazio');
    fs.mkdirSync(certVazio, { recursive: true });
    const arqS11 = path.join(raizS11, 'estado.json');
    fs.writeFileSync(arqS11, JSON.stringify({ loja: { url: 'http://loja.exemplo', status: 'down', falhas: 3, ultimo_check: iso(0), desde: iso(60000), ultimo_detalhe: '502' } }));

    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('COCKPIT_')) delete env[k];
    Object.assign(env, {
      PORT: String(PORTA), HOST: '127.0.0.1', COCKPIT_CERT_DIR: certVazio, COCKPIT_TOKEN: TOKEN,
      HOME: path.join(raizS11, 'home'), COCKPIT_MONITOR_DIR: path.join(raizS11, 'monitor'), COCKPIT_MONITOR_MS: '0',
      COCKPIT_VIGIA_MS: '0', COCKPIT_JOBS_DIR: path.join(raizS11, 'jobs-inexistente'),
      COCKPIT_TMUX_SOCKET: `gate-sites-${process.pid}`,
      COCKPIT_PUSH_DIR: path.join(raizS11, 'push'), COCKPIT_LIDAS_DIR: path.join(raizS11, 'lidas'),
      COCKPIT_DU_BIN: path.join(raizS11, 'nao-existe-du'), COCKPIT_DOCKER_BIN: path.join(raizS11, 'nao-existe-docker'),
      COCKPIT_VIGIA_PROD_ARQ: arqS11,
    });

    const pedir = (metodo, rota, { semToken = false } = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo,
        headers: semToken ? {} : { authorization: `Bearer ${TOKEN}` } }, (res) => {
        let bruto = ''; res.setEncoding('utf8');
        res.on('data', (c) => { bruto += c; });
        res.on('end', () => { let corpo = null; try { corpo = JSON.parse(bruto); } catch { /* não-JSON */ } resolve({ status: res.statusCode, corpo, bruto }); });
      });
      req.on('error', reject); req.end();
    });

    let filho = null;
    try {
      ok(PORTA !== undefined, `S11: achou porta livre na lista (${PORTA})`);
      filho = await new Promise((resolve, reject) => {
        const f = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
        let saiu = false;
        f.once('exit', (c) => { if (!saiu) reject(new Error(`server.js caiu antes de subir (código ${c})`)); });
        f.stdout.on('data', (d) => { if (!saiu && String(d).includes('cockpit-agentes em')) { saiu = true; resolve(f); } });
        f.stderr.on('data', (d) => process.stderr.write(`[server.js:${PORTA}] ${d}`));
        setTimeout(() => { if (!saiu) { saiu = true; resolve(f); } }, 3000);
      });

      const sem = await pedir('GET', '/api/sites', { semToken: true });
      ok(sem.status === 401, `S11: GET /api/sites sem token → 401 (veio ${sem.status})`);

      const r = await pedir('GET', '/api/sites');
      const loja = r.corpo && r.corpo.sites && r.corpo.sites.find((s) => s.nome === 'loja');
      ok(r.status === 200 && r.corpo && r.corpo.arquivo === 'ok', `S11: GET /api/sites → 200, arquivo "ok" (veio ${r.status}/${r.corpo && r.corpo.arquivo})`);
      ok(Boolean(loja) && loja.fora === true, `S11: o site "loja" está fora (veio ${JSON.stringify(loja)})`);
      ok(!r.bruto.includes('url') && !r.bruto.includes('quedas') && !r.bruto.includes('loja.exemplo'), 'S11: o corpo bruto não traz url/quedas nem a URL da fixture');

      fs.writeFileSync(arqS11, 'lixo {');
      const r2 = await pedir('GET', '/api/sites');
      ok(r2.status === 200 && r2.corpo && r2.corpo.arquivo === 'ilegivel', `S11: arquivo trocado por lixo → 200, arquivo "ilegivel" (veio ${r2.status}/${r2.corpo && r2.corpo.arquivo})`);
      const lojaR2 = r2.corpo && r2.corpo.sites && r2.corpo.sites.find((s) => s.nome === 'loja');
      ok(Boolean(lojaR2) && lojaR2.fora === true, `S11: o site "loja" continua fora — memória da última leitura boa (veio ${JSON.stringify(lojaR2)})`);

      const saude = await pedir('GET', '/health');
      ok(saude.status === 200, `S11: GET /health → 200 — o servidor continua respondendo depois do lixo (veio ${saude.status})`);

      const post = await pedir('POST', '/api/sites');
      ok(post.status === 404, `S11: POST /api/sites → 404 (veio ${post.status})`);
    } finally {
      if (filho && !filho.killed) filho.kill('SIGTERM'); // pelo PID — nunca pkill (#19)
    }
  }

  // ─── S12 — isolamento ───
  {
    const bateria = fs.readFileSync(path.join(__dirname, '..', 'bin', 'testes.js'), 'utf8');
    ok(bateria.includes('COCKPIT_VIGIA_PROD_ARQ'), 'S12: bin/testes.js define COCKPIT_VIGIA_PROD_ARQ (#62)');

    sites._zerarParaTeste();
    const arqA = path.join(RAIZ, 's12-a.json');
    const arqB = path.join(RAIZ, 's12-b.json');
    fs.writeFileSync(arqA, JSON.stringify({ a: { status: 'up', falhas: 0, ultimo_check: iso(0) } }));
    fs.writeFileSync(arqB, JSON.stringify({ b: { status: 'up', falhas: 0, ultimo_check: iso(0) } }));
    process.env.COCKPIT_VIGIA_PROD_ARQ = arqA;
    const rA = await sites.ler();
    sites._zerarParaTeste();
    process.env.COCKPIT_VIGIA_PROD_ARQ = arqB;
    const rB = await sites.ler();
    ok(rA.sites[0] && rA.sites[0].nome === 'a' && rB.sites[0] && rB.sites[0].nome === 'b', `S12: trocar a env entre duas chamadas muda o arquivo lido (veio ${JSON.stringify(rA.sites)} / ${JSON.stringify(rB.sites)})`);
  }

  // ─── S14 — as puras de public/monitor.js, alimentadas pela saída REAL de sites.interpretar ───
  {
    require('../public/monitor.js');
    const { duracaoCurta, textoProdFora, bolinhasDe, notaDosSites } = globalThis.cockpitMonitor;
    // Um `tr` de mentira (molde gate-monitor-ui.js:69) que sabe as duas formas de chamada.
    const tr = (s, ...v) => (Array.isArray(s) ? s.map((p, i) => p + (i < v.length ? v[i] : '')).join('') : s);

    ok(duracaoCurta(59) === '1 min', `S14: duracaoCurta(59) → "1 min" (veio "${duracaoCurta(59)}")`);
    ok(duracaoCurta(720) === '12 min', `S14: duracaoCurta(720) → "12 min" (veio "${duracaoCurta(720)}")`);
    ok(duracaoCurta(3900) === '1 h 05 min', `S14: duracaoCurta(3900) → "1 h 05 min" (veio "${duracaoCurta(3900)}")`);
    // Trunca como o vigia (`seg // 60`): 119 s é "1 min" lá, tem de ser "1 min" aqui.
    ok(duracaoCurta(119) === '1 min' && duracaoCurta(7199) === '1 h 59 min', `S14: trunca como o vigia — 119 → "1 min", 7199 → "1 h 59 min" (veio "${duracaoCurta(119)}"/"${duracaoCurta(7199)}")`);
    ok(duracaoCurta(null) === '', `S14: duracaoCurta(null) → "" (veio "${duracaoCurta(null)}")`);

    const agoraMs = Date.now();
    // O `iso` do topo relê o relógio: 1 ms depois do `agoraMs`, 360 s viravam 359 s ("há 5 min") —
    // achado do painel de execução, 6 em 100 mil. Aqui ele fica preso ao MESMO instante do `interpretar`.
    const iso = (msAtras) => new Date(agoraMs - msAtras).toISOString();
    const umFora = sites.interpretar(JSON.stringify({ loja: { status: 'down', falhas: 3, ultimo_check: iso(0) } }), agoraMs);
    const t1 = textoProdFora(umFora, tr);
    ok(t1 === 'PROD FORA — loja há 2 min', `S14: um site fora, 3 falhas → início 2 min antes do check (veio "${t1}")`);
    // S2 com texto EXATO, a partir da saída real do `interpretar` (fixture da tabela da spec).
    const s2 = sites.interpretar(JSON.stringify({ loja: { status: 'down', falhas: 13, ultimo_check: iso(0), desde: iso(720000), ultimo_detalhe: '502' } }), agoraMs);
    ok(textoProdFora(s2, tr) === 'PROD FORA — loja há 12 min (502)', `S2 (texto): "PROD FORA — loja há 12 min (502)" (veio "${textoProdFora(s2, tr)}")`);

    const doisFora = sites.interpretar(JSON.stringify({
      loja: { status: 'down', falhas: 3, ultimo_check: iso(0) },
      api: { status: 'down', falhas: 5, ultimo_check: iso(0) },
    }), agoraMs);
    const t2 = textoProdFora(doisFora, tr);
    ok(t2.includes(' · ') && /loja/.test(t2) && /api/.test(t2), `S14: dois sites fora juntos com " · " (veio "${t2}")`);

    const foraEParado = sites.interpretar(JSON.stringify({ loja: { status: 'down', falhas: 3, ultimo_check: iso(1200000) } }), agoraMs);
    const t3 = textoProdFora(foraEParado, tr);
    ok(t3.endsWith('vigia parado'), `S14: fora + parado termina em "vigia parado" (veio "${t3}")`);

    const ilegivelComMemoria = { arquivo: 'ilegivel', sites: [{ nome: 'loja', situacao: 'fora', fora: true, parado: true, foraHaS: 60, checadoHaS: null, detalhe: null }] };
    const t4 = textoProdFora(ilegivelComMemoria, tr);
    ok(t4.endsWith('vigia de prod ilegível'), `S14: ilegível termina em "vigia de prod ilegível" (veio "${t4}")`);

    const nenhumFora = sites.interpretar(JSON.stringify({ loja: { status: 'up', falhas: 0, ultimo_check: iso(0) } }), agoraMs);
    ok(textoProdFora(nenhumFora, tr) === '', 'S14: nenhum site fora → ""');

    ok(JSON.stringify(bolinhasDe({ arquivo: 'ausente', sites: [] })) === '[]', 'S14: bolinhasDe com "ausente" → []');

    const notaIlegivel = notaDosSites({ arquivo: 'ilegivel', sites: [] }, tr);
    ok(notaIlegivel === 'vigia de prod ilegível', `S14: notaDosSites — "ilegivel" tem prioridade (veio "${notaIlegivel}")`);
    // S6 com texto EXATO, a partir da saída real do `interpretar`.
    const s6 = sites.interpretar(JSON.stringify({ loja: { status: 'up', falhas: 0, ultimo_check: iso(360000) } }), agoraMs);
    const notaComDuracao = notaDosSites(s6, tr);
    ok(notaComDuracao === 'vigia parado há 6 min', `S6 (texto): notaDosSites → "vigia parado há 6 min" (veio "${notaComDuracao}")`);
    const notaSemDuracao = notaDosSites({ arquivo: 'ok', sites: [{ nome: 'loja', situacao: 'parado', fora: false, parado: true, foraHaS: null, checadoHaS: null, detalhe: null }] }, tr);
    ok(notaSemDuracao === 'vigia parado', `S14: notaDosSites — parado sem duração conhecida, sem inventar (veio "${notaSemDuracao}")`);
  }

  // ─── S10g — tom e texto da faixa do topo ───
  {
    require('../public/monitor.js');
    const { tomDaFaixa, textoDaFaixa } = globalThis.cockpitMonitor;
    const tr = (s, ...v) => (Array.isArray(s) ? s.map((p, i) => p + (i < v.length ? v[i] : '')).join('') : s);

    const agoraMs = Date.now();
    // O `iso` do topo relê o relógio: 1 ms depois do `agoraMs`, 360 s viravam 359 s ("há 5 min") —
    // achado do painel de execução, 6 em 100 mil. Aqui ele fica preso ao MESMO instante do `interpretar`.
    const iso = (msAtras) => new Date(agoraMs - msAtras).toISOString();
    const soParado = sites.interpretar(JSON.stringify({ loja: { status: 'up', falhas: 0, ultimo_check: iso(360000) } }), agoraMs);
    ok(tomDaFaixa(soParado) === 'parado', `S10g: só parado → tom "parado" (veio "${tomDaFaixa(soParado)}")`);
    ok(textoDaFaixa(soParado, tr) === 'Vigia de prod parado há 6 min — sem notícia de prod', `S10g: texto exato (veio "${textoDaFaixa(soParado, tr)}")`);

    const ilegivelSemSites = { arquivo: 'ilegivel', sites: [] };
    ok(tomDaFaixa(ilegivelSemSites) === 'parado', `S10g: ilegível sem sites → tom "parado" (veio "${tomDaFaixa(ilegivelSemSites)}")`);
    ok(textoDaFaixa(ilegivelSemSites, tr) === 'Vigia de prod sem leitura — sem notícia de prod', `S10g: "sem leitura" (veio "${textoDaFaixa(ilegivelSemSites, tr)}")`);

    // Ilegível COM memória (sites do retrato velho, todos parado): o texto não inventa duração.
    const ilegivelComMemoria = { arquivo: 'ilegivel', sites: [{ nome: 'loja', situacao: 'parado', fora: false, parado: true, foraHaS: null, checadoHaS: 30, detalhe: '200' }] };
    ok(textoDaFaixa(ilegivelComMemoria, tr) === 'Vigia de prod sem leitura — sem notícia de prod', `S10g: ilegível com memória → "sem leitura", nunca "parado há 1 min" (veio "${textoDaFaixa(ilegivelComMemoria, tr)}")`);

    const algumFora = sites.interpretar(JSON.stringify({ loja: { status: 'down', falhas: 3, ultimo_check: iso(0) } }), agoraMs);
    ok(tomDaFaixa(algumFora) === 'fora', `S10g: algum fora → tom "fora" (veio "${tomDaFaixa(algumFora)}")`);

    const tudoNoAr = sites.interpretar(JSON.stringify({ loja: { status: 'up', falhas: 0, ultimo_check: iso(0) } }), agoraMs);
    ok(tomDaFaixa(tudoNoAr) === '', `S10g: tudo no ar → tom "" (veio "${tomDaFaixa(tudoNoAr)}")`);
  }

  // ─── S13 — a costura, como texto ───
  {
    const htmlTexto = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const posProdFora = htmlTexto.indexOf('id="prod-fora"');
    const posApp = htmlTexto.indexOf('id="app"');
    ok(posProdFora >= 0 && posApp >= 0 && posProdFora < posApp, 'S13: index.html tem id="prod-fora" ANTES de id="app"');

    const posFaixa = htmlTexto.indexOf('id="monitor-faixa"');
    const posSites = htmlTexto.indexOf('id="monitor-sites"');
    const posButtonFechamento = htmlTexto.indexOf('</button>', posFaixa);
    ok(posFaixa >= 0 && posSites > posFaixa && posSites < posButtonFechamento, 'S13: id="monitor-sites" ENTRE id="monitor-faixa" e o </button> seguinte');

    const monTexto = fs.readFileSync(path.join(__dirname, '..', 'public', 'monitor.js'), 'utf8');
    ok(!monTexto.includes('.innerHTML'), 'S13: monitor.js sem .innerHTML (#26)');

    const tradTexto = fs.readFileSync(path.join(__dirname, '..', 'public', 'traducoes.js'), 'utf8');
    for (const chave of ['PROD FORA', '{0} há {1}', 'vigia parado', 'vigia parado há {0}', 'vigia de prod ilegível',
      'Vigia de prod parado há {0} — sem notícia de prod', 'Vigia de prod sem leitura — sem notícia de prod']) {
      ok(tradTexto.includes(`"${chave}":`), `S13: traducoes.js tem o par de "${chave}"`);
    }

    const cssTexto = fs.readFileSync(path.join(__dirname, '..', 'public', 'estilo.css'), 'utf8');
    const primeiroRoot = cssTexto.indexOf(':root {');
    const fimPrimeiroRoot = cssTexto.indexOf('}', primeiroRoot);
    ok(primeiroRoot >= 0 && cssTexto.slice(primeiroRoot, fimPrimeiroRoot).includes('--prod-fora-h'), 'S13: --prod-fora-h declarada dentro do PRIMEIRO bloco :root');

    const cor = require('./cor');
    const paletas = cor.paletas(cssTexto);
    ok(paletas.length >= 11, `S13: cor.paletas devolve ao menos 11 blocos (veio ${paletas.length})`);
    const raiz = paletas[0].variaveis;
    const falhouContraste = [];
    for (const t of paletas) {
      const v = (k) => t.variaveis[k] || raiz[k];
      const c1 = cor.contraste(v('--sobre-perigo'), v('--perigo'));
      const c2 = cor.contraste(v('--texto'), v('--fundo-3'));
      if (!(c1 >= 4.5)) falhouContraste.push(`${t.rotulo}: --sobre-perigo/--perigo=${c1}`);
      if (!(c2 >= 4.5)) falhouContraste.push(`${t.rotulo}: --texto/--fundo-3=${c2}`);
    }
    ok(falhouContraste.length === 0, `S13: --sobre-perigo sobre --perigo e --texto sobre --fundo-3 ≥ 4.5:1 em TODAS as paletas (falhou: ${falhouContraste.join(', ') || 'nenhuma'})`);
  }

  fs.rmSync(RAIZ, { recursive: true, force: true });
  console.log(falhas ? `\n❌ ${falhas} falha(s)` : '\n✅ gate-sites verde');
  process.exitCode = falhas ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
