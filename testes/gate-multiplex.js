#!/usr/bin/env node
'use strict';
// GATE DO MULTIPLEX — `/api/eventos?abas=a,b,c`, o cano só (card `split-view`, Fase 1).
//
// A prova de que extrair `acompanharAba` de `abrirFluxoAba` não criou uma máquina de estado
// COMPARTILHADA (a proibição da §3.1 da spec): cada aba mantém seu próprio `arquivo`,
// `geracao`, `lido`, `rodando`, `esperando` — o que o cano compartilha é só a LEITURA do
// `abas.listar()` do relógio de estado (R22, "um relógio por cano, não um por aba").
//
// Como `testes/gate-troca-arquivo.js`: `lib/abas` é trocado por um duble no `require.cache`
// antes de o servidor subir — sem tmux, sem token gasto (armadilha #20).
//
// Uso:  node testes/gate-multiplex.js            (8 casos funcionais, duble, ~6s)
//       node testes/gate-multiplex.js --medir     (R32/R51 — sem duble, tmux+/proc reais)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes('--medir')) {
  medir().then((codigo) => process.exit(codigo)).catch((e) => {
    console.error('\n❌ a medição quebrou:', e.message, '\n');
    process.exit(1);
  });
} else {
  funcional().then((tudoOk) => {
    console.log(`\n${tudoOk ? '✅ GATE VERDE' : '❌ GATE VERMELHO'} — multiplex\n`);
    process.exit(tudoOk ? 0 : 1);
  }).catch((e) => {
    console.error('\n❌ o gate quebrou:', e.message, '\n');
    process.exit(1);
  });
}

// ─── parte funcional — duble de lib/abas, sem tmux ───────────────────────────

async function funcional() {
  const PORTA = Number(process.env.PORT || 7895);
  const CAMINHO_ABAS = path.join(__dirname, '..', 'lib', 'abas.js');

  // ─── o duble ────────────────────────────────────────────────────────────
  // `...real` espalhado, como em gate-troca-arquivo.js: só listar/buscar/paraCliente/
  // abasDoProjeto são trocados; `consumirPendente`/`pendentesDe` continuam sendo os de
  // verdade — `acompanharAba` os chama e eles não falam com tmux nenhum.
  const abasVivas = new Map();     // chave -> { titulo, cwd, arquivo, rodando, esperando }
  const explodemNoBuscar = new Set();
  let listarChamadas = 0;

  const registrar = (chave, dados = {}) => abasVivas.set(chave, {
    chave, titulo: `Aba ${chave}`, cwd: '/tmp', arquivo: null, rodando: false, esperando: false,
    ...dados,
  });
  const remover = (chave) => abasVivas.delete(chave);
  const atualizar = (chave, patch) => abasVivas.set(chave, { ...abasVivas.get(chave), ...patch });

  const duble = {
    ...require(CAMINHO_ABAS),
    listar: async () => { listarChamadas += 1; return [...abasVivas.values()].map((a) => ({ ...a })); },
    buscar: async (chave) => {
      if (explodemNoBuscar.has(chave)) throw new Error('explodiu de propósito (caso 3)');
      return abasVivas.has(chave) ? { ...abasVivas.get(chave) } : null;
    },
    paraCliente: (a) => a,
    abasDoProjeto: () => [],
  };
  require.cache[require.resolve(CAMINHO_ABAS)] = {
    id: require.resolve(CAMINHO_ABAS),
    filename: require.resolve(CAMINHO_ABAS),
    loaded: true,
    exports: duble,
  };

  process.env.PORT = String(PORTA);
  process.env.HOST = '127.0.0.1';
  process.env.COCKPIT_CERT_DIR = '/dev/null';
  process.env.COCKPIT_TOKEN = '';
  process.env.COCKPIT_JOBS_DIR = path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`); // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
  require(path.join(__dirname, '..', 'server.js'));
  await espera(400);

  // ─── espião de setInterval, para o caso 8 ──────────────────────────────────
  let vivos = 0;
  const setIntervalOriginal = global.setInterval;
  const clearIntervalOriginal = global.clearInterval;
  global.setInterval = (...args) => { vivos += 1; return setIntervalOriginal(...args); };
  global.clearInterval = (...args) => { if (args[0] !== undefined && args[0] !== null) vivos -= 1; return clearIntervalOriginal(...args); };

  function abrirCano(chaves) {
    return new Promise((resolve, reject) => {
      const recebido = [];
      const req = http.get(
        { host: '127.0.0.1', port: PORTA, path: `/api/eventos?abas=${chaves.join(',')}`, headers: { accept: 'text/event-stream' } },
        (res) => {
          let sobra = '';
          res.setEncoding('utf8');
          res.on('data', (pedaco) => {
            sobra += pedaco;
            const partes = sobra.split('\n\n');
            sobra = partes.pop();
            for (const parte of partes) {
              const dado = parte.split('\n').find((l) => l.startsWith('data: '));
              if (dado) recebido.push(JSON.parse(dado.slice(6)));
            }
          });
          resolve({ req, res, recebido });
        },
      );
      req.on('error', reject);
    });
  }

  function pedirStatus(caminho) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: PORTA, path: caminho }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
    });
  }

  let tudoOk = 1;

  // ── caso 1 ───────────────────────────────────────────────────────────────
  registrar('aba-1', { titulo: 'Primeira aba' });
  registrar('aba-2', { titulo: 'Segunda aba' });
  const c1 = await abrirCano(['aba-1', 'aba-2']);
  await espera(300);
  tudoOk &= ok(c1.recebido.length > 0, 'caso 1: o cano manda alguma coisa');
  tudoOk &= ok(c1.recebido.every((env) => typeof env.aba === 'string' && env.evento && typeof env.evento.tipo === 'string'),
    'caso 1: todo `data:` tem `aba` E `evento` (o envelope do multiplex)');
  const sessoes1 = c1.recebido.filter((e) => e.evento.tipo === 'sessao');
  const tituloDe = (aba) => sessoes1.find((e) => e.aba === aba)?.evento.meta.titulo;
  tudoOk &= ok(tituloDe('aba-1') === 'Primeira aba' && tituloDe('aba-2') === 'Segunda aba'
    && tituloDe('aba-1') !== tituloDe('aba-2'),
  'caso 1: os dois `sessao` têm títulos DISTINTOS — cada aba fala de si mesma, não da vizinha');
  c1.req.destroy();
  await espera(100);

  // ── caso 2 — aba inexistente vira `erro` só dela (R5) ───────────────────
  registrar('aba-3', { titulo: 'Terceira aba' });
  const c2 = await abrirCano(['aba-3', 'aba-fantasma']);
  await espera(300);
  const errosFantasma = c2.recebido.filter((e) => e.aba === 'aba-fantasma' && e.evento.tipo === 'erro');
  tudoOk &= ok(errosFantasma.length === 1, 'caso 2: a aba inexistente recebe UM `erro`, só dela');
  tudoOk &= ok(c2.recebido.some((e) => e.aba === 'aba-3' && e.evento.tipo === 'sessao'),
    'caso 2: e a aba-3 (que existe) continua recebendo normalmente — o cano não caiu junto');
  const antesDaBatida2 = c2.recebido.length;
  atualizar('aba-3', { rodando: true });
  await espera(2200);
  tudoOk &= ok(c2.recebido.slice(antesDaBatida2).some((e) => e.aba === 'aba-3' && e.evento.tipo === 'sincronizado'),
    'caso 2: e o relógio de estado do cano continua batendo para ela (R5)');
  c2.req.destroy();
  await espera(100);

  // ── caso 3 — exceção na inicialização manda `erro` E `sincronizado`, sem
  //             derrubar a outra aba (R23/R34) ───────────────────────────────
  registrar('aba-4', { titulo: 'Quarta aba' });
  explodemNoBuscar.add('aba-boom');
  const c3 = await abrirCano(['aba-4', 'aba-boom']);
  await espera(300);
  const eventosBoom = c3.recebido.filter((e) => e.aba === 'aba-boom').map((e) => e.evento.tipo);
  tudoOk &= ok(eventosBoom.includes('erro') && eventosBoom.includes('sincronizado'),
    `caso 3: a aba que explodiu na inicialização manda \`erro\` E \`sincronizado\` (recebido: ${eventosBoom.join(',')})`);
  tudoOk &= ok(eventosBoom.indexOf('sincronizado') > eventosBoom.indexOf('erro'),
    'caso 3: nessa ordem — o `sincronizado` despeja o fragmento que o `erro` sozinho deixaria preso (R34/#47)');
  tudoOk &= ok(c3.recebido.some((e) => e.aba === 'aba-4' && e.evento.tipo === 'sessao'),
    'caso 3: e a aba-4 nem percebe — o cano não derruba por causa da vizinha que explodiu');
  c3.req.destroy();
  await espera(100);

  // ── caso 4 — `removida` de uma não fecha o cano; a outra segue (R5) ──────
  registrar('aba-5', { titulo: 'Quinta aba' });
  registrar('aba-6', { titulo: 'Sexta aba' });
  const c4 = await abrirCano(['aba-5', 'aba-6']);
  await espera(300);
  const antesDeRemover = c4.recebido.length;
  remover('aba-6');
  atualizar('aba-5', { rodando: true });
  await espera(2200);
  const depoisDeRemover = c4.recebido.slice(antesDeRemover);
  tudoOk &= ok(depoisDeRemover.some((e) => e.aba === 'aba-6' && e.evento.tipo === 'removida'),
    'caso 4: a aba que sumiu do `listar()` vira `removida`');
  tudoOk &= ok(depoisDeRemover.some((e) => e.aba === 'aba-5' && e.evento.tipo === 'sincronizado'),
    'caso 4: e a outra aba do MESMO cano segue recebendo — a `removida` não fecha o `res` (R5)');
  c4.req.destroy();
  await espera(100);

  // ── caso 5 — `?abas=` vazio é 400 · chave com `:` é 400 · duplicada dedup ─
  tudoOk &= ok((await pedirStatus('/api/eventos?abas=')) === 400, 'caso 5: `?abas=` vazio → 400');
  tudoOk &= ok((await pedirStatus('/api/eventos?abas=aba%3A1')) === 400, 'caso 5: chave com `:` → 400');
  registrar('aba-7', { titulo: 'Sétima aba' });
  const c5 = await abrirCano(['aba-7', 'aba-7']);
  await espera(300);
  const sessoes7 = c5.recebido.filter((e) => e.aba === 'aba-7' && e.evento.tipo === 'sessao');
  tudoOk &= ok(sessoes7.length === 1, `caso 5: \`abas=aba-7,aba-7\` deduplica — UM \`sessao\` só (achei ${sessoes7.length})`);
  c5.req.destroy();
  await espera(100);

  // ── caso 6 — 20 chaves abrem 20 envelopes, sem teto (R20) ────────────────
  const vinte = [];
  for (let i = 0; i < 20; i += 1) {
    const chave = `aba-vinte-${i}`;
    vinte.push(chave);
    registrar(chave, { titulo: `Aba número ${i}` });
  }
  const c6 = await abrirCano(vinte);
  await espera(500);
  const abasQueMandaramSessao = new Set(c6.recebido.filter((e) => e.evento.tipo === 'sessao').map((e) => e.aba));
  tudoOk &= ok(vinte.every((chave) => abasQueMandaramSessao.has(chave)),
    `caso 6: as 20 chaves abrem 20 envelopes — sem teto numérico (achei ${abasQueMandaramSessao.size}/20)`);
  c6.req.destroy();
  await espera(100);

  // ── caso 7 — `listar()` UMA vez por batida de 2s, não N (R22) ────────────
  registrar('aba-8', { titulo: 'Oitava' });
  registrar('aba-9', { titulo: 'Nona' });
  registrar('aba-10', { titulo: 'Décima' });
  const antesDoCaso7 = listarChamadas;
  const c7 = await abrirCano(['aba-8', 'aba-9', 'aba-10']);
  await espera(4300);   // pouco mais de duas batidas de 2s
  const chamadasNoCaso7 = listarChamadas - antesDoCaso7;
  tudoOk &= ok(chamadasNoCaso7 === 2,
    `caso 7: 3 abas no MESMO cano, ~4.3s: \`listar()\` chamado 2 vezes, não 6 (achei ${chamadasNoCaso7})`);
  c7.req.destroy();
  await espera(100);

  // ── caso 8 — `req.destroy()` não deixa `setInterval` vivo ────────────────
  registrar('aba-11', {});
  registrar('aba-12', {});
  const vivosAntes = vivos;
  const c8 = await abrirCano(['aba-11', 'aba-12']);
  await espera(300);
  tudoOk &= ok(vivos > vivosAntes, 'caso 8: abrir o cano com 2 abas cria intervalos de verdade');
  c8.req.destroy();
  await espera(200);
  tudoOk &= ok(vivos === vivosAntes,
    `caso 8: e fechar o cano (\`req.destroy\`) devolve a contagem ao que era antes (${vivosAntes} → ${vivos})`);

  global.setInterval = setIntervalOriginal;
  global.clearInterval = clearIntervalOriginal;

  return Boolean(tudoOk);
}

// ─── modo --medir (R32/R51) — sem duble, tmux + /proc reais ──────────────────
//
// "Sem duble" tem que valer de verdade: `lib/abas.js` resolve o arquivo de uma aba pelo
// `~/.claude/sessions/<pid>.json` do CLI (`lib/abas.js:559`) — tmux + `.jsonl` sozinhos
// entregariam 6 abas com `arquivo: null`, e a medição diria "está rápido" medindo NADA.
// O arreio é o mesmo de `testes/smoke-celular-primeira-leva.js:654-687` (sem a parte de
// navegador/docker, que aqui não faz falta): HOME falso, `COCKPIT_PROC_RAIZ` para um /proc
// de mentira, `escreverSessao()` por pane, e um socket tmux próprio pela D35.
async function medir() {
  const N = 6;
  const SOCKET = `cockpit-smoke-multiplex-${process.pid}`;
  const SESSAO = 'main';
  const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
  // As sessões que ESTE script cria. A limpeza fail-closed compara o socket com este
  // conjunto antes de derrubar qualquer coisa (D35).
  const MINHAS_SESSOES = new Set(['ancora', SESSAO]);

  const herdado = process.env.COCKPIT_TMUX_SOCKET || '';
  if (herdado && !/^cockpit-smoke-/.test(herdado)) {
    console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${herdado}" — abortando antes de tocar em nada.`);
    return 1;
  }

  const t = (args, { tolerante = false } = {}) => {
    try {
      return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      if (tolerante) return '';
      throw e;
    }
  };
  if (t(['ls'], { tolerante: true }).trim()) {
    console.error(`🔴 o socket ${SOCKET} JÁ EXISTE — não é meu. Abortando.`);
    return 1;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-multiplex-'));
  const home = path.join(scratch, 'home');
  const raizProc = path.join(scratch, 'proc');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(raizProc, { recursive: true });

  let falhouLimpeza = false;
  const limpar = () => {
    // Fail-closed (D35): confere o carimbo ANTES de matar. Sumiu → não é meu socket mais,
    // e `kill-server` derrubaria sessão de outra coisa. `kill-server`, não `kill-session`
    // por sessão: o socket inteiro (`cockpit-smoke-multiplex-<pid>`) é nosso, ninguém mais
    // fala com ele.
    // A D35 pede DUAS respostas, não uma: o carimbo prova que EU criei aquilo, e a
    // enumeração prova que não há mais ninguém no socket. São perguntas diferentes, e matar
    // exige as duas — o achado do painel de execução de 08/09 era que só a primeira estava
    // aqui (e no molde que copiei).
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    const sessoesAgora = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
      .split('\n').map((n) => n.trim()).filter(Boolean);
    const intrusas = sessoesAgora.filter((n) => !MINHAS_SESSOES.has(n));
    if (temCarimbo && !intrusas.length) {
      t(['kill-server'], { tolerante: true });
    } else if (temCarimbo) {
      // Sobrou quem eu não criei: mata só as minhas e deixa o socket de pé, reclamando.
      for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
      falhouLimpeza = true;
      console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
    } else {
      falhouLimpeza = true;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    return !falhouLimpeza;
  };

  /** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}`, padrão "exec direto". */
  function plantarAgenteFalso(pid, starttime) {
    const dir = path.join(raizProc, String(pid));
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

  function escreverSessao({ pid, janela, pane, sessaoId, cwd, starttime, status }) {
    const raiz = path.join(home, '.claude', 'sessions');
    fs.mkdirSync(raiz, { recursive: true });
    fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
      kind: 'interactive', sessionId: sessaoId, cwd, status, updatedAt: Date.now(),
      pid, procStart: starttime, tmux: `${SESSAO}:${janela}.${pane}`,
    }));
  }

  function caminhoDoJsonl(cwd, sessaoId) {
    const pasta = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    return path.join(home, '.claude', 'projects', pasta, `${sessaoId}.jsonl`);
  }

  const linhaTexto = (texto) => `${JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: texto }] },
  })}\n`;

  try {
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', 'aba-0', '-c', os.tmpdir(), 'sleep', '600']);
    for (let i = 1; i < N; i += 1) {
      t(['new-window', '-t', SESSAO, '-n', `aba-${i}`, '-c', os.tmpdir(), 'sleep', '600']);
    }

    const saidaPanes = t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']);
    const panes = {};
    for (const linha of saidaPanes.split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      if (/^aba-\d+$/.test(nome)) panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }
    const chaves = [];
    for (let i = 0; i < N; i += 1) {
      const nome = `aba-${i}`;
      if (!panes[nome]) throw new Error(`a pane "${nome}" não apareceu no list-panes`);
      chaves.push(nome);
    }

    // 1 MB por arquivo, de saída — o escritor de baixo os faz CRESCER durante a coleta.
    const UM_MB = 'x'.repeat(1024 * 1024);
    const arquivos = {};
    for (const chave of chaves) {
      const { panePid, janelaId, paneId } = panes[chave];
      plantarAgenteFalso(panePid, 1000000 + panePid);
      const cwd = `/home/gate/projetos/${chave}`;
      const sessaoId = `sess-${chave}`;
      escreverSessao({
        pid: panePid, janela: janelaId, pane: paneId, sessaoId, cwd,
        starttime: 1000000 + panePid, status: 'busy',
      });
      const arquivo = caminhoDoJsonl(cwd, sessaoId);
      fs.mkdirSync(path.dirname(arquivo), { recursive: true });
      fs.writeFileSync(arquivo, linhaTexto(UM_MB));
      arquivos[chave] = arquivo;
    }

    // O escritor: 2 KB a cada 500 ms, em CADA um dos 6 arquivos, durante toda a coleta.
    let escrevendo = true;
    const escritor = setInterval(() => {
      if (!escrevendo) return;
      for (const chave of chaves) fs.appendFileSync(arquivos[chave], linhaTexto('x'.repeat(2000)));
    }, 500);

    Object.assign(process.env, {
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: SESSAO,
      COCKPIT_PROC_RAIZ: raizProc,
      COCKPIT_BIN_CLAUDE: '/bin/true',
      HOME: home,
    });
    // `require` fresco: sem isto, um `lib/abas.js` já carregado por outro módulo do
    // processo (não deveria haver, mas o gate não confia) leria os env vars ANTIGOS.
    delete require.cache[require.resolve(path.join(__dirname, '..', 'lib', 'abas.js'))];
    const abas = require(path.join(__dirname, '..', 'lib', 'abas.js'));
    const agentes = require(path.join(__dirname, '..', 'lib', 'agentes.js'));
    const { leitor } = agentes.de('claude');

    // ── asserção de sanidade — antes de medir qualquer coisa ────────────────
    //
    // `chave` (o que a lista manda para o cliente, e o que `?abas=` espera) NÃO é o nome da
    // janela tmux — `lib/abas.js` deriva algo como `aba-p0` a partir do `pane_id`
    // (`chaveDaAba`). O nome da janela (`aba-0`…`aba-5`, usado acima para achar pid/arquivo)
    // é só um rótulo NOSSO; o mapeamento real sai do próprio `listar()`.
    const linhas = await abas.listar();
    const chaveRealDe = {};
    for (const chave of chaves) {
      const linha = linhas.find((l) => l.titulo === chave);
      if (linha) chaveRealDe[chave] = linha.chave;
    }
    const chavesReais = chaves.map((chave) => chaveRealDe[chave]).filter(Boolean);
    const comArquivo = chaves
      .map((chave) => linhas.find((l) => l.chave === chaveRealDe[chave]))
      .filter((l) => l && l.arquivo);
    if (comArquivo.length !== N) {
      console.error(`🔴 sanidade: só ${comArquivo.length}/${N} abas vieram com \`arquivo\` não-nulo`
        + ' — o benchmark mediria o vazio.');
      escrevendo = false; clearInterval(escritor);
      return 2;
    }
    const lidoInicial = {};
    for (const chave of chaves) lidoInicial[chave] = 0;
    const primeiraLeitura = await Promise.all(chaves.map(async (chave) => {
      const arquivo = linhas.find((l) => l.chave === chaveRealDe[chave]).arquivo;
      const r = await leitor.lerConversa(arquivo, 0);
      lidoInicial[chave] = r ? r.tamanho : 0;
      return r;
    }));
    if (primeiraLeitura.some((r) => !r)) {
      console.error('🔴 sanidade: a leitura inicial de alguma aba veio vazia — mediria o vazio.');
      escrevendo = false; clearInterval(escritor);
      return 2;
    }

    // ── a medição — dez segundos, os dois relógios separados ────────────────
    const amostrasArquivo = [];
    const amostrasEstado = [];
    // O que o plano pede é "ms por batida AGREGADA": o trabalho TOTAL de um tique com as
    // seis abas — um `listar()` mais seis leituras —, não a média das durações soltas.
    // Misturar as amostras individuais dilui o caro no barato e mede outra coisa (achado do
    // painel de execução de 08/09). É este número que responde "o servidor aguenta?".
    const amostrasBatida = [];
    const inicio = Date.now();
    const lido = { ...lidoInicial };
    while (Date.now() - inicio < 10000) {
      const tBatida = Date.now();
      const t0 = Date.now();
      const linhasAgora = await abas.listar();
      amostrasEstado.push(Date.now() - t0);
      for (const chave of chaves) {
        const l = linhasAgora.find((x) => x.chave === chaveRealDe[chave]);
        const t1 = Date.now();
        const r = await leitor.lerConversa(l.arquivo, lido[chave]);
        amostrasArquivo.push(Date.now() - t1);
        if (r) lido[chave] = r.tamanho;
      }
      amostrasBatida.push(Date.now() - tBatida);
      await espera(700);
    }
    escrevendo = false;
    clearInterval(escritor);

    const cresceram = chaves.every((chave) => lido[chave] > lidoInicial[chave]);
    if (!cresceram) {
      console.error('🔴 sanidade: o `lido` de alguma aba não cresceu durante a coleta — mediria o vazio.');
      limpar();
      return 2;
    }

    const percentil = (amostras, p) => {
      const s = [...amostras].sort((a, b) => a - b);
      if (!s.length) return 0;
      const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
      return s[i];
    };
    const junto = [...amostrasArquivo, ...amostrasEstado];
    const p50Arquivo = percentil(amostrasArquivo, 50);
    const p95Arquivo = percentil(amostrasArquivo, 95);
    const p50Estado = percentil(amostrasEstado, 50);
    const p95Estado = percentil(amostrasEstado, 95);
    const p50Batida = percentil(amostrasBatida, 50);
    const p95Agregado = percentil(amostrasBatida, 95);
    const leiturasPorSegundo = (junto.length / 10).toFixed(1);

    console.log(`  · relógio de ARQUIVO — p50 ${p50Arquivo}ms · p95 ${p95Arquivo}ms (${amostrasArquivo.length} leituras)`);
    console.log(`  · relógio de ESTADO  — p50 ${p50Estado}ms · p95 ${p95Estado}ms (${amostrasEstado.length} leituras)`);
    console.log(`  · leituras/s: ${leiturasPorSegundo}`);
    console.log(`  · POR BATIDA (1 listar + ${chaves.length} leituras) — p50 ${p50Batida}ms · p95 ${p95Agregado}ms (limite: 50ms)`);

    // ── abertura do cano com 6 abas (§4.6/§1.3) — dez rodadas, p50/p95 ──────
    process.env.PORT = '';
    const PORTA_SERVIDOR = 7895;
    delete process.env.COCKPIT_TOKEN;
    const ambienteServidor = { ...process.env, HOST: '127.0.0.1', PORT: String(PORTA_SERVIDOR), COCKPIT_CERT_DIR: '/dev/null', COCKPIT_JOBS_DIR: path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`) }; // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
    const { spawn } = require('node:child_process');
    const servidor = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: ambienteServidor, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const saude = () => new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: PORTA_SERVIDOR, path: '/health', timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    // Espera o processo MORRER de verdade, não só o `SIGTERM` sair — sem isto, um
    // `process.exit()` deste script logo depois deixaria o servidor filho órfão ainda
    // segurando a porta, e a PRÓXIMA rodada do gate encontraria a 7895 ocupada por um
    // servidor de uma fixture (e um tmux) que já foi embora.
    const matarEEsperar = (filho) => new Promise((resolve) => {
      if (filho.exitCode !== null || filho.signalCode !== null) return resolve();
      filho.once('exit', () => resolve());
      filho.kill();
      setTimeout(() => { filho.kill('SIGKILL'); resolve(); }, 2000);
    });
    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (servidor.exitCode !== null) break;
      pronto = await saude();
      if (!pronto) await espera(200);
    }
    if (!pronto) {
      console.error('🔴 o servidor para medir a abertura do cano não subiu.');
      await matarEEsperar(servidor);
      limpar();
      return 2;
    }

    const abrirEMedirAte6Sincronizados = () => new Promise((resolve, reject) => {
      const t0 = Date.now();
      let sincronizados = 0;
      const vistos = new Set();
      const req = http.get(
        { host: '127.0.0.1', port: PORTA_SERVIDOR, path: `/api/eventos?abas=${chavesReais.join(',')}`, headers: { accept: 'text/event-stream' } },
        (res) => {
          let sobra = '';
          res.setEncoding('utf8');
          res.on('data', (pedaco) => {
            sobra += pedaco;
            const partes = sobra.split('\n\n');
            sobra = partes.pop();
            for (const parte of partes) {
              const dado = parte.split('\n').find((l) => l.startsWith('data: '));
              if (!dado) continue;
              const env = JSON.parse(dado.slice(6));
              if (env.evento.tipo === 'sincronizado' && !vistos.has(env.aba)) {
                vistos.add(env.aba);
                sincronizados += 1;
                if (sincronizados === N) {
                  const ms = Date.now() - t0;
                  req.destroy();
                  resolve(ms);
                }
              }
            }
          });
        },
      );
      req.on('error', reject);
      setTimeout(() => { req.destroy(); reject(new Error('não fechou os 6 `sincronizado` em 5s')); }, 5000);
    });

    const amostrasAbertura = [];
    for (let i = 0; i < 10; i += 1) {
      amostrasAbertura.push(await abrirEMedirAte6Sincronizados());
      await espera(50);
    }
    const p50Abertura = percentil(amostrasAbertura, 50);
    const p95Abertura = percentil(amostrasAbertura, 95);
    console.log(`  · abertura do cano com ${N} abas — p50 ${p50Abertura}ms · p95 ${p95Abertura}ms (limite: 600ms)`);

    await matarEEsperar(servidor);
    const limpezaOk = limpar();

    if (!limpezaOk) {
      console.error('🔴 a limpeza do socket tmux falhou — sessão sobrando que este gate não criou.');
      return 1;
    }
    if (p95Agregado > 50) {
      console.error(`🔴 p95 agregado (${p95Agregado}ms) passou de 50ms — R32.`);
      return 1;
    }
    if (p95Abertura > 600) {
      console.error(`🔴 p95 da abertura do cano (${p95Abertura}ms) passou de 600ms.`);
      return 1;
    }
    console.log('\n✅ GATE VERDE — medição do multiplex\n');
    return 0;
  } catch (e) {
    console.error('🔴 a medição estourou:', e.message);
    limpar();
    return 1;
  }
}
