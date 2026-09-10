#!/usr/bin/env node
'use strict';
// GATE DO CODEX — offline. Zero token, zero tmux, zero rede.
//
// Tudo aqui roda sobre FIXTURES em `mkdtemp`, removidas no `finally`. Nenhum caso toca o
// `~/.codex/` real, nenhum caso sobe servidor, nenhum caso fala com tmux — quem faz isso é
// o `smoke-matar-pane.js` (a regra destrutiva do `matarAgora()`) e o `smoke-codex-tmux.js`
// (o fluxo real, que gasta turno da assinatura).
//
// Duas costuras tornam metade deste catálogo implementável, e as duas são raízes
// injetáveis, não mocks de `fs`:
//
//   COCKPIT_PROC_RAIZ   uma árvore `/proc` DE MENTIRA, com `stat`, `cmdline`, `cwd` (um
//                       symlink de verdade) e `task/<pid>/children`. Espionar `fsp.readFile`
//                       não resolveria o `readlink` do `cwd`.
//   COCKPIT_CODEX_RAIZ  onde o adaptador procura rollouts (a partir da fase do casamento).
//
// As duas são lidas em TEMPO DE CHAMADA, nunca no `require` — senão o gate não trocaria de
// raiz entre um bloco de casos e outro.
//
// Modo `--entrada-fase7`: as duas asserções OFFLINE do guarda de rebase do campo `Agente`
// (a `criar()` existe e é chamável; ela rejeita com `codigo === 409`). As outras duas
// asserções daquele guarda falam HTTP e vivem no `gate-ui.js parte 2`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tudoOk = true;
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) tudoOk = false; return c; };

/**
 * Roda um GRUPO de asserções isolando o estouro dele.
 *
 * Sem isto, a primeira função que ainda não existe derruba o gate inteiro e esconde o
 * vermelho dos outros grupos — e é justamente a saída por grupo que prova que cada asserção
 * nova nasceu vermelha.
 */
const grupos = [];
const grupo = (rotulo, fn) => grupos.push({ rotulo, fn });

const paraApagar = [];
const temporario = (prefixo) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
  paraApagar.push(dir);
  return dir;
};

// ─── A árvore /proc de mentira ───────────────────────────────────────────────

/**
 * Monta uma `/proc` falsa e devolve o caminho dela.
 *
 * `processos` é `{ <pid>: { comm, estado, ppid, pgrp, tpgid, argv, cwd, filhos, starttime } }`.
 *
 * O `stat` sai com os 52 campos que o kernel escreve, porque o módulo lê DOIS deles por
 * índice — o 5 (pgrp) e o 8 (tpgid) — e o `mesmoProcesso()` lê o 22. Um `stat` curto passaria
 * pelos primeiros e devolveria `undefined` no terceiro, verde por acidente.
 *
 * O `comm` entra entre parênteses e PODE ter espaço dentro: é justamente por isso que o
 * módulo corta a partir do ÚLTIMO ')', e um dos casos usa um nome com espaço para provar.
 */
function arvoreProc(processos) {
  const raiz = temporario('gate-codex-proc-');
  for (const [pid, p] of Object.entries(processos)) {
    const dir = path.join(raiz, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    const campos = new Array(52).fill('0');
    campos[0] = String(pid);
    campos[1] = `(${p.comm ?? 'proc'})`;
    campos[2] = p.estado ?? 'S';
    campos[3] = String(p.ppid ?? 1);
    campos[4] = String(p.pgrp ?? pid);          // campo 5
    campos[5] = String(p.sessao ?? pid);
    campos[6] = '34816';
    campos[7] = String(p.tpgid ?? -1);          // campo 8
    campos[21] = String(p.starttime ?? 1000);   // campo 22
    fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
    fs.writeFileSync(path.join(dir, 'cmdline'), `${(p.argv || ['proc']).join('\0')}\0`);
    if (p.cwd) {
      // Symlink DE VERDADE: é `readlink` que o casamento vai chamar, e um arquivo comum com
      // o caminho dentro passaria num mock de `readFile` e falharia no código real.
      try { fs.symlinkSync(p.cwd, path.join(dir, 'cwd')); } catch { /* já existe */ }
    }
    const tarefa = path.join(dir, 'task', String(pid));
    fs.mkdirSync(tarefa, { recursive: true });
    fs.writeFileSync(path.join(tarefa, 'children'), `${(p.filhos || []).join(' ')}${p.filhos?.length ? ' ' : ''}`);
    // O `procStartMs` sai do MTIME do diretório `/proc/<pid>` — é assim no kernel e é assim
    // que `detectarAgente()` o lê. Por último, depois de escrever tudo lá dentro: cada
    // arquivo criado empurra o mtime do diretório para agora.
    if (p.nascidoEm) fs.utimesSync(dir, new Date(p.nascidoEm), new Date(p.nascidoEm));
  }
  return raiz;
}

// ─── O espião do `execFile` ──────────────────────────────────────────────────
//
// Mesmo contrato do `gate-ui.js`: `roteiro` é um array de respostas, uma por chamada, na
// ordem em que o teste as espera. Assinatura copiada de propósito — mock inventado por gate
// é como dois testes passam a discordar sobre o mesmo módulo.

async function comEspiao(env, roteiro, corpo) {
  const cp = require('node:child_process');
  const original = cp.execFile;
  const antes = { ...process.env };
  const chamadas = [];
  let i = 0;
  cp.execFile = (bin, args, opts, cb) => {
    chamadas.push([bin, args]);
    const r = roteiro[i++] || { saida: '' };
    const pronto = cb || opts;
    if (!r.erro) return pronto(null, r.saida ?? '', '');
    const e = new Error(r.erro.stderr || 'tmux falhou');
    e.killed = Boolean(r.erro.killed);
    return pronto(e, '', r.erro.stderr || '');
  };
  Object.assign(process.env, env);
  const limpo = () => {
    for (const m of ['../lib/abas', '../lib/agentes', '../lib/adaptador-codex']) {
      delete require.cache[require.resolve(m)];
    }
  };
  limpo();
  try {
    return await corpo(require('../lib/abas'), chamadas);
  } finally {
    cp.execFile = original;
    for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k];
    Object.assign(process.env, antes);
    limpo();
  }
}

/** Uma linha do `list-panes -a` com os sete campos que o `listar()` pede. */
const linhaPane = ({
  janela, sessao = 'main', indice = 0, nome = 'janela', cwd = '/home/y/projetos/x', pane, pid,
}) => `${janela}\t${sessao}\t${indice}\t${nome}\t${cwd}\t${pane}\t${pid}\n`;

// ─── Um HOME de mentira com o arquivo de sessão do Claude ────────────────────

/**
 * Planta um `~/.claude/sessions/<pid>.json` que o módulo aceita como VIVO.
 *
 * O `mesmoProcesso()` confere o campo 22 do `/proc/<pid>/stat` contra o `procStart` do
 * arquivo. Como aqui o `/proc` é de mentira, o número é o que a árvore diz — e é por isso
 * que os dois têm que ser plantados juntos, nunca um sem o outro.
 */
function casaComSessao({ pid, janela, pane, sessaoId = 'sess-codex', cwd = '/home/y/projetos/x', starttime = 1000, status = 'idle' }) {
  const raiz = temporario('gate-codex-home-');
  fs.mkdirSync(path.join(raiz, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(raiz, '.claude', 'sessions', `${pid}.json`), JSON.stringify({
    kind: 'interactive',
    sessionId: sessaoId,
    cwd,
    status,
    updatedAt: Date.now(),
    pid,
    procStart: starttime,
    tmux: `main:${janela}.${pane}`,
  }));
  return raiz;
}

// ═════════════════════════════════════════════════════════════════════════════
//  FASE 1b — o registro dos agentes e a detecção por pane
// ═════════════════════════════════════════════════════════════════════════════

grupo('23/32 — o registro é o whitelist, e `de()` nunca devolve null', async () => {
  const agentes = require('../lib/agentes');

  // 23
  ok(agentes.existe('bash') === false, 'agentes.existe("bash") é false — o whitelist não é uma lista solta');
  ok(agentes.existe('claude') === true && agentes.existe('codex') === true,
    'e os dois que existem existem');
  ok(JSON.stringify(agentes.ids()) === JSON.stringify(['claude', 'codex']),
    `ids() === ["claude","codex"] (${JSON.stringify(agentes.ids())})`);

  // 32 — as seis chaves do contrato. Sem esta asserção, §3.1 e §3.8 poderiam divergir e só
  // o servidor descobriria, em produção.
  const c = agentes.de('claude');
  const chaves = ['id', 'rotulo', 'bin', 'padraoCmd', 'leitor', 'medidor'];
  ok(chaves.every((k) => k in c), `de("claude") traz as 6 chaves do contrato (${Object.keys(c).join(',')})`);
  ok(typeof c.bin === 'function' && typeof c.padraoCmd?.test === 'function',
    '`bin` é FUNÇÃO (lida em tempo de chamada) e `padraoCmd` é regex');
  ok(Array.isArray(agentes.de('codex').args) && agentes.de('codex').args.length === 0,
    'o Codex traz `args` SEPARADO do `bin` — a validação de binário roda sobre o caminho puro');
  ok(!/\s/.test(agentes.de('codex').bin()),
    `e o \`bin\` do Codex é um caminho puro, sem flag dentro (${agentes.de('codex').bin()})`);
  ok(agentes.existe('nao-existe') === false, 'existe("nao-existe") é false');
  ok(agentes.de('nao-existe') === agentes.de('claude'), 'mas de("nao-existe") cai no padrão, não em null');
  ok(agentes.AGENTE_PADRAO === 'claude', 'e o padrão é o claude');

  // O `bin` é lido em TEMPO DE CHAMADA: sem isso o gate não troca de binário entre blocos.
  const antes = process.env.COCKPIT_BIN_CODEX;
  process.env.COCKPIT_BIN_CODEX = '/tmp/codex-de-mentira';
  ok(agentes.de('codex').bin() === '/tmp/codex-de-mentira',
    'trocar COCKPIT_BIN_CODEX muda o retorno SEM recarregar o módulo');
  if (antes === undefined) delete process.env.COCKPIT_BIN_CODEX; else process.env.COCKPIT_BIN_CODEX = antes;
});

grupo('24 — o fail-safe do R12: aba sem `agente` não derruba o despacho', async () => {
  const agentes = require('../lib/agentes');
  // O duble de `lib/abas` do `gate-troca-arquivo.js` monta abas com seis campos e nenhum
  // deles é `agente`. Consertar o teste para o código passar seria o avesso: o padrão certo
  // para "não sei qual agente" é o Claude, que é o que 100% das abas eram até ontem.
  ok(agentes.de(undefined).leitor === agentes.de('claude').leitor,
    'de(undefined).leitor === de("claude").leitor');
  ok(agentes.de(null).medidor === agentes.de('claude').medidor, 'e de(null).medidor idem');
  ok(agentes.de('').leitor === agentes.de('claude').leitor, 'e a string vazia também');
});

grupo('25/49 — o padrão casa `argv[0]`, nunca o cmdline inteiro', async () => {
  const agentes = require('../lib/agentes');
  const codex = agentes.de('codex').padraoCmd;
  const claude = agentes.de('claude').padraoCmd;

  // Os CINCO da tabela do R6, medidos na máquina em 29/08. O vencedor é o binário rust da
  // profundidade 2 — o `node /usr/bin/codex` da profundidade 1 tem `argv[0] = "node"`.
  const tabela = [
    ['node', false, 'o wrapper `node /usr/bin/codex` — argv[0] é `node`, e ele NÃO casa'],
    ['/home/y/.cache/codex-linux-x64/bin/codex', true, 'o binário rust da profundidade 2 CASA'],
    ['/usr/bin/codex', true, 'e o caminho absoluto simples também'],
    ['/home/y/.cache/codex-linux-x64/bin/codex-code-mode-host', false,
      'o `codex-code-mode-host` NÃO casa — vem `-` depois de `codex`'],
    ['vim', false, '`vim /tmp/codex-notes.txt` não casa: argv[0] é `vim`'],
  ];
  for (const [argv0, esperado, texto] of tabela) {
    ok(codex.test(argv0) === esperado, `${texto} (${JSON.stringify(argv0)})`);
  }

  // 49 — a #6 pela porta dos fundos. Com o cmdline INTEIRO, isto casaria e o `send-keys`
  // iria para um SHELL.
  ok(codex.test('bash') === false, 'o `bash` de `bash -c "/usr/bin/codex --foo"` NÃO casa (caso 49)');
  // E o contrário é o PORQUÊ de a comparação ser contra `argv[0]`: a linha inteira CASA.
  // Quem comparasse o cmdline todo aceitaria um shell como se fosse o Codex, e o `send-keys`
  // do usuário iria para o bash. A asserção afirma a armadilha, não a ausência dela.
  ok(codex.test("bash -c '/usr/bin/codex --foo'") === true,
    'o cmdline INTEIRO casaria — é exatamente por isso que a detecção compara argv[0]');
  ok(claude.test('claude') && claude.test('/usr/bin/claude'), 'o padrão do claude casa os dois formatos dele');
  ok(claude.test('claude-code-router') === false, 'e não casa um nome que só começa igual');
});

grupo('37/38/39 — a detecção na árvore de /proc', async () => {
  const abas = require('../lib/abas');
  const antes = process.env.COCKPIT_PROC_RAIZ;
  try {
    // 37 — `exec codex`: o próprio `pane_pid` É o agente, sem filho nenhum. Começar a busca
    // nos filhos devolveria "nenhum agente" numa aba que tem um.
    process.env.COCKPIT_PROC_RAIZ = arvoreProc({
      100: { comm: 'codex', argv: ['/usr/bin/codex', '--yolo'], pgrp: 100, tpgid: 100 },
    });
    const execado = await abas.detectarAgente(100);
    ok(execado?.agente === 'codex' && execado.pid === 100,
      `caso 37: \`exec codex\` é detectado no próprio pane_pid (${JSON.stringify(execado)})`);
    ok(Number.isFinite(execado?.procStartMs), 'e o procStartMs sai do mtime de /proc/<pid>, não de ticks');

    // O caminho NORMAL: o shell da pane espera, e o agente é filho dele. O shell tem
    // `pgrp !== tpgid` por construção — barrar a descida ali quebraria toda aba real.
    process.env.COCKPIT_PROC_RAIZ = arvoreProc({
      200: { comm: 'bash', argv: ['-bash'], pgrp: 200, tpgid: 300, filhos: [300] },
      300: { comm: 'node', argv: ['node', '/usr/bin/codex', '--yolo'], pgrp: 300, tpgid: 300, filhos: [301] },
      301: { comm: 'codex', argv: ['/home/y/.cache/codex-linux-x64/bin/codex', '--yolo'], pgrp: 300, tpgid: 300 },
    });
    const normal = await abas.detectarAgente(200);
    ok(normal?.agente === 'codex' && normal.pid === 301,
      `o vencedor é o binário rust da profundidade 2, não o wrapper node (${JSON.stringify(normal)})`);

    // 38 — fora do foreground. Um `codex &`, um `codex` suspenso com Ctrl-Z ou um filho
    // esquecido: a aba diria "tem agente" e o `send-keys` iria para o SHELL (#6).
    process.env.COCKPIT_PROC_RAIZ = arvoreProc({
      400: { comm: 'bash', argv: ['-bash'], pgrp: 400, tpgid: 400, filhos: [401] },
      401: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 999, tpgid: 400 },
    });
    ok(await abas.detectarAgente(400) === null,
      'caso 38: processo do agente FORA do foreground ⇒ nenhum agente — a trava da #6');

    // 39 — pane sem processo em primeiro plano. `tpgid <= 0` acontece de verdade.
    process.env.COCKPIT_PROC_RAIZ = arvoreProc({
      500: { comm: 'bash', argv: ['-bash'], pgrp: 500, tpgid: -1, filhos: [501] },
      501: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 500, tpgid: -1 },
    });
    ok(await abas.detectarAgente(500) === null, 'caso 39: tpgid <= 0 ⇒ nenhum agente, sem exceção');

    // E `/proc` que não responde: `null`, nunca exceção. Processo que morre no meio da
    // varredura é o caso comum, não o excepcional.
    process.env.COCKPIT_PROC_RAIZ = path.join(temporario('gate-codex-vazio-'), 'nao-existe');
    ok(await abas.detectarAgente(600) === null, 'raiz de /proc inexistente ⇒ null, sem estourar');
    ok(await abas.detectarAgente(0) === null && await abas.detectarAgente('x') === null,
      'pid torto ⇒ null, sem chegar ao disco');

    // O nome do executável com ESPAÇO dentro dos parênteses: é por isso que o corte é a
    // partir do ÚLTIMO ')'. Um split no espaço leria o campo errado e o pgrp viraria lixo.
    process.env.COCKPIT_PROC_RAIZ = arvoreProc({
      700: { comm: 'meu programa', argv: ['/usr/bin/codex'], pgrp: 700, tpgid: 700 },
    });
    ok((await abas.detectarAgente(700))?.agente === 'codex',
      'nome de executável COM ESPAÇO não desalinha a leitura do stat');
  } finally {
    if (antes === undefined) delete process.env.COCKPIT_PROC_RAIZ; else process.env.COCKPIT_PROC_RAIZ = antes;
  }
});

grupo('45/46/48b/31 — a janela com Claude e Codex vira DUAS abas', async () => {
  // O cenário misto, e ele é a prova da decisão do projeto: janela `@5` ("Projeto-a") com
  // claude na `%5` e codex na `%71`. Com uma aba por JANELA, o Codex dele fica invisível por
  // construção — que é o card inteiro.
  const proc = arvoreProc({
    10: { comm: 'bash', pgrp: 10, tpgid: 11, filhos: [11] },
    11: { comm: 'claude', argv: ['claude'], pgrp: 11, tpgid: 11, starttime: 4242, cwd: '/home/y/projetos/projeto-a' },
    70: { comm: 'bash', pgrp: 70, tpgid: 71, filhos: [71] },
    71: { comm: 'codex', argv: ['/usr/bin/codex', '--yolo'], pgrp: 71, tpgid: 71, cwd: '/home/y/projetos/cockpit' },
  });
  const home = casaComSessao({
    pid: 11, janela: '@5', pane: '%5', sessaoId: 'sess-claude', starttime: 4242,
    cwd: '/home/y/projetos/projeto-a',
  });
  const lista = await comEspiao(
    { COCKPIT_PROC_RAIZ: proc, HOME: home, COCKPIT_TMUX_SOCKET: 'gate-codex-fake', COCKPIT_TMUX_SESSAO: 'main' },
    [{ saida:
      linhaPane({ janela: '@5', nome: 'Projeto-a', pane: '%5', pid: 10, cwd: '/home/y/projetos/projeto-a' })
      + linhaPane({ janela: '@5', nome: 'Projeto-a', pane: '%71', pid: 70, cwd: '/home/y/projetos/cockpit' }) }],
    async (mod) => mod.listar(),
  );

  // 45
  ok(lista.length === 2, `caso 45: saem DUAS abas da mesma janela (${lista.length})`);
  ok(lista.map((a) => a.chave).join(',') === 'aba-p5,aba-p71',
    `e as chaves são aba-p5 e aba-p71, na ordem do pane_id (${lista.map((a) => a.chave).join(',')})`);

  const doClaude = lista.find((a) => a.chave === 'aba-p5');
  const doCodex = lista.find((a) => a.chave === 'aba-p71');

  // 46 — `aba.pane` é a pane DAQUELA aba. Ler de um CLI e digitar no outro é a #6, e é o bug
  // de 28/08 voltando por outro caminho.
  ok(doClaude?.agente === 'claude' && doClaude.pane === '%5',
    `caso 46: aba-p5 é claude e mira a pane %5 (${doClaude?.agente}, ${doClaude?.pane})`);
  ok(String(doClaude?.arquivo || '').endsWith('sess-claude.jsonl'),
    `e o arquivo dela é o .jsonl do Claude (${doClaude?.arquivo})`);
  ok(doCodex?.agente === 'codex' && doCodex.pane === '%71',
    `caso 47 (parcial): aba-p71 é codex e mira a pane %71 (${doCodex?.agente}, ${doCodex?.pane})`);

  // 31 — sem isto a TELA mostra "sem claude" numa aba de Codex, que é o risco de maior
  // impacto da entrega.
  ok(doCodex?.temAgente === true && doCodex?.temClaude === false,
    `caso 31: a aba de Codex sai temAgente:true e temClaude:false (${doCodex?.temAgente}/${doCodex?.temClaude})`);
  ok(doClaude?.temAgente === true && doClaude?.temClaude === true,
    'e a de Claude sai true nos dois — o legado não quebra');

  // 48b — mesmo título, agente diferente. É o chip que as distingue na tela.
  ok(doClaude?.titulo === doCodex?.titulo && doClaude?.agente !== doCodex?.agente,
    `caso 48b: mesmo título ("${doClaude?.titulo}"), agentes diferentes — o chip é o que as separa`);

  // 48 — nenhuma vaza o arquivo da outra, e `paraCliente()` não deixa caminho nenhum passar.
  const abasLib = require('../lib/abas');
  const doCliente = lista.map((a) => abasLib.paraCliente(a));
  const json = JSON.stringify(doCliente);
  // `cwd` continua saindo, e deve: a lista mostra a pasta do projeto desde sempre. O que não
  // pode sair é o caminho do ARQUIVO da conversa — o `.jsonl` do Claude e o rollout do Codex.
  ok(!json.includes('.jsonl') && !json.includes('.codex'),
    `caso 48/22: paraCliente() não deixa passar o caminho da conversa — nem .jsonl, nem ~/.codex`);
  ok(doCliente.every((a) => !('arquivo' in a) && !('pane' in a) && !('alvo' in a)),
    'e os três campos internos (arquivo, pane, alvo) continuam fora do JSON do navegador');
  ok(doCliente.every((a) => 'agente' in a),
    'e o campo `agente` PASSA — é o dado do chip (§3.13); sem ele as duas linhas ficam idênticas');
  ok(doCodex?.sessaoId === null,
    'a aba de Codex não herda o sessaoId do vizinho — o casamento dela é outro (é a #6)');
});

grupo('34 — a invariante de `aba.pane` vale nos DOIS sentidos', async () => {
  // Invertendo o cenário: Codex na `%5`, Claude na `%71`. Uma invariante que só vale num
  // sentido é um acaso de ordenação esperando ser descoberto em produção.
  const proc = arvoreProc({
    10: { comm: 'bash', pgrp: 10, tpgid: 11, filhos: [11] },
    11: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 11, tpgid: 11 },
    70: { comm: 'bash', pgrp: 70, tpgid: 71, filhos: [71] },
    71: { comm: 'claude', argv: ['claude'], pgrp: 71, tpgid: 71, starttime: 777 },
  });
  const home = casaComSessao({ pid: 71, janela: '@5', pane: '%71', sessaoId: 'sess-invertida', starttime: 777 });
  const lista = await comEspiao(
    { COCKPIT_PROC_RAIZ: proc, HOME: home, COCKPIT_TMUX_SOCKET: 'gate-codex-fake', COCKPIT_TMUX_SESSAO: 'main' },
    [{ saida: linhaPane({ janela: '@5', pane: '%5', pid: 10 }) + linhaPane({ janela: '@5', pane: '%71', pid: 70 }) }],
    async (mod) => mod.listar(),
  );
  const porPane = Object.fromEntries(lista.map((a) => [a.pane, a.agente]));
  ok(lista.length === 2 && porPane['%5'] === 'codex' && porPane['%71'] === 'claude',
    `caso 34: invertido, cada aba continua com a SUA pane (${JSON.stringify(porPane)})`);
  ok(lista.find((a) => a.pane === '%71')?.sessaoId === 'sess-invertida',
    'e o arquivo do Claude segue a pane dele, não a posição na janela');
});

grupo('73 — incidente 08/09: registro Claude não pode vencer numa pane que é Codex', async () => {
  // O incidente real: um executor interativo do CLAUDE herdou TMUX/TMUX_PANE de uma pane
  // (pid 99) e publicou `~/.claude/sessions/99.json` com `tmux: "main:@22.%27"` — a MESMA
  // pane onde `detectarAgente()` acha um Codex simulado (pid 27). Antes do conserto,
  // `const cli = agente ? (pane.cli || null) : null` deixava o registro Claude vencer
  // porque `agente` (Codex) era truthy; ele só devia participar quando `agente === 'claude'`.
  const proc = arvoreProc({
    20: { comm: 'bash', pgrp: 20, tpgid: 27, filhos: [27] },
    27: { comm: 'codex', argv: ['/usr/bin/codex', '--yolo'], pgrp: 27, tpgid: 27, starttime: 5000, cwd: '/home/y/projetos/x' },
    99: { comm: 'claude', argv: ['claude'], pgrp: 99, tpgid: 99, starttime: 9999 },
  });
  const home = casaComSessao({
    pid: 99, janela: '@22', pane: '%27', sessaoId: 'sess-claude-executor-rogue',
    starttime: 9999, status: 'busy',
  });
  const lista = await comEspiao(
    { COCKPIT_PROC_RAIZ: proc, HOME: home, COCKPIT_TMUX_SOCKET: 'gate-codex-fake', COCKPIT_TMUX_SESSAO: 'main' },
    [{ saida: linhaPane({ janela: '@22', nome: 'aba-p27', pane: '%27', pid: 20, cwd: '/home/y/projetos/x' }) }],
    async (mod) => mod.listar(),
  );
  ok(lista.length === 1, `caso 73: a janela com pane só produz UMA aba (${lista.length})`);
  const aba = lista[0];
  ok(aba?.agente === 'codex', `caso 73: identidade, cwd e "rodando" continuam do Codex (${aba?.agente})`);
  ok(aba?.sessaoId !== 'sess-claude-executor-rogue' && aba?.sessaoId === null,
    `caso 73: o sessaoId do registro Claude NUNCA vaza para uma aba detectada como Codex (${aba?.sessaoId})`);
  ok(aba?.rodando !== true && aba?.rodando === null,
    `caso 73: o "busy" do registro Claude não vira "rodando" da aba de Codex (${aba?.rodando})`);
  ok(aba?.temClaude === false, 'e temClaude continua false — o legado não mente');
  ok(aba?.cwd === '/home/y/projetos/x' && aba?.arquivo === null && aba?.status === null,
    'cwd, arquivo e status também não vêm do registro Claude concorrente');
});

grupo('48c/48d — a regra (a): nada some da lista, e htop não vira aba', async () => {
  // 48c — janela SEM agente em pane nenhuma, com 3 panes. Antes disso, TODA janela da sessão
  // aparecia; uma regra "só pane com agente vira aba" faria janelas do usuário sumirem sem
  // aviso, e ele decidiu que nada suma.
  const semAgente = arvoreProc({
    10: { comm: 'bash', argv: ['-bash'], pgrp: 10, tpgid: 11, filhos: [11] },
    11: { comm: 'htop', argv: ['htop'], pgrp: 11, tpgid: 11 },
    20: { comm: 'bash', argv: ['-bash'], pgrp: 20, tpgid: 21, filhos: [21] },
    21: { comm: 'tail', argv: ['tail', '-f', '/var/log/x'], pgrp: 21, tpgid: 21 },
    30: { comm: 'bash', argv: ['-bash'], pgrp: 30, tpgid: -1 },
  });
  const tresPanes = await comEspiao(
    { COCKPIT_PROC_RAIZ: semAgente, HOME: temporario('gate-codex-vazio-'), COCKPIT_TMUX_SOCKET: 'f', COCKPIT_TMUX_SESSAO: 'main' },
    [{ saida: linhaPane({ janela: '@9', nome: 'sucata', pane: '%1', pid: 10 })
      + linhaPane({ janela: '@9', nome: 'sucata', pane: '%2', pid: 20 })
      + linhaPane({ janela: '@9', nome: 'sucata', pane: '%3', pid: 30 }) }],
    async (mod) => mod.listar(),
  );
  ok(tresPanes.length === 1, `caso 48c: janela sem agente com 3 panes vira UMA aba (${tresPanes.length})`);
  ok(tresPanes[0]?.agente === null && tresPanes[0]?.temAgente === false,
    'com agente:null e temAgente:false — o pino ○, como sempre foi');
  ok(tresPanes[0]?.chave === 'aba-9',
    `e a chave dela é a da JANELA (${tresPanes[0]?.chave}) — é isso que faz o fechar virar kill-window`);

  // 48d — janela com Claude na `%5` e um `htop` na `%9`. Sem esta regra a lista encheria de
  // `htop` e `tail -f`.
  const misto = arvoreProc({
    40: { comm: 'bash', pgrp: 40, tpgid: 41, filhos: [41] },
    41: { comm: 'claude', argv: ['claude'], pgrp: 41, tpgid: 41, starttime: 55 },
    50: { comm: 'bash', pgrp: 50, tpgid: 51, filhos: [51] },
    51: { comm: 'htop', argv: ['htop'], pgrp: 51, tpgid: 51 },
  });
  const comHtop = await comEspiao(
    { COCKPIT_PROC_RAIZ: misto, HOME: casaComSessao({ pid: 41, janela: '@3', pane: '%5', starttime: 55 }), COCKPIT_TMUX_SOCKET: 'f', COCKPIT_TMUX_SESSAO: 'main' },
    [{ saida: linhaPane({ janela: '@3', pane: '%5', pid: 40 }) + linhaPane({ janela: '@3', pane: '%9', pid: 50 }) }],
    async (mod) => mod.listar(),
  );
  ok(comHtop.length === 1, `caso 48d: a pane do htop NÃO vira aba (${comHtop.length} aba)`);
  ok(comHtop[0]?.pane === '%5' && comHtop[0]?.agente === 'claude',
    `e a aba que sai é a do Claude, na pane dele (${comHtop[0]?.pane})`);
});

grupo('30 — `horaDaUltimaMensagem` com um argumento continua funcionando', async () => {
  const abas = require('../lib/abas');
  // O R13: os três casos que o `gate-ui.js` já exercita chamam com UM argumento. O default
  // `'claude'` é o que os mantém verdes sem edição.
  const dir = temporario('gate-codex-hora-');
  const arquivo = path.join(dir, 'conversa.jsonl');
  fs.writeFileSync(arquivo, `${JSON.stringify({
    type: 'assistant', timestamp: '2026-08-28T10:00:00.000Z',
    message: { content: [{ type: 'text', text: 'oi' }] },
  })}\n`);
  const hora = await abas.horaDaUltimaMensagem(arquivo);
  ok(hora === Date.parse('2026-08-28T10:00:00.000Z'),
    `caso 30: com um argumento só, devolve a hora da fala (${hora})`);
  ok(await abas.horaDaUltimaMensagem(null) === null, 'e sem arquivo devolve null, como sempre');
});

// ═════════════════════════════════════════════════════════════════════════════
//  FASE 2 — o casamento aba ↔ conversa
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Escreve um rollout de mentira em `<raiz>/AAAA/MM/DD/rollout-<nome>.jsonl`.
 *
 * A primeira linha imita o `session_meta` REAL, com os DOIS `timestamp` — o do envelope e o
 * do payload, nesta ordem. Não é enfeite: é justamente por eles serem dois que a extração
 * ancora no `"payload"`, e uma fixture com um só deixaria o caso 27 incapaz de reprovar o
 * que promete.
 */
function rollout(raiz, {
  dia = '2026/08/28', nome, cwd, originator = 'codex-tui', source = 'cli',
  nascimento = '2026-08-28T04:17:17.588Z', envelope = '2026-08-28T04:17:20.491Z',
  mtime = null, corpo = [], meta = null, sessaoId = null,
}) {
  const pasta = path.join(raiz, dia);
  fs.mkdirSync(pasta, { recursive: true });
  const caminho = path.join(pasta, `rollout-${nome}.jsonl`);
  const payload = meta || {
    session_id: sessaoId || nome,
    id: sessaoId || nome,
    timestamp: nascimento,
    cwd,
    originator,
    cli_version: '0.147.0',
    source,
    // O `base_instructions` real tem 18 KB e é o que estoura a linha. Um placeholder do
    // mesmo tamanho preserva o que interessa (a emenda de blocos) sem pôr o system prompt
    // do Codex num arquivo de teste versionado.
    base_instructions: { text: 'x'.repeat(18000) },
  };
  const linhas = [JSON.stringify({ timestamp: envelope, type: 'session_meta', payload }), ...corpo];
  fs.writeFileSync(caminho, `${linhas.join('\n')}\n`);
  if (mtime !== null) fs.utimesSync(caminho, new Date(mtime), new Date(mtime));
  return caminho;
}

/**
 * Carrega o adaptador LIMPO — o cache do `session_meta` é de módulo, e mora entre casos.
 *
 * `async` + `await` não é estilo: sem o `await`, o `finally` restaura `COCKPIT_CODEX_RAIZ`
 * ANTES de o corpo terminar, e a varredura cai no `~/.codex/` REAL do usuário. Este gate é
 * declarado offline e nenhum caso pode tocar aquela pasta — o defeito foi cometido aqui uma
 * vez, e o diagnóstico foram 109 rollouts de verdade abertos no meio de um caso.
 */
async function comAdaptador(env, corpo) {
  const antes = { ...process.env };
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../lib/adaptador-codex')];
  try {
    return await corpo(require('../lib/adaptador-codex'));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k];
    Object.assign(process.env, antes);
    delete require.cache[require.resolve('../lib/adaptador-codex')];
  }
}

const PROC = 1787890632736;   // o `procStartMs` da pane nas fixtures desta fase
const pane = (extra = {}) => ({
  sessaoTmux: 'main', janelaId: '@5', paneId: '%71',
  pid: 3004580, procStartMs: PROC, cwd: '/home/y/projetos/cockpit', ...extra,
});
const chaveDe = (p) => `${p.sessaoTmux}:${p.janelaId}.${p.paneId}`;

grupo('16/19/43 — quem entra na lista de candidatos, e quem não entra', async () => {
  const raiz = temporario('gate-codex-roll-');
  // 43 — o caso normal: um rollout de TUI, nascido depois do processo, tocado até agora.
  rollout(raiz, { nome: 'bom', cwd: '/home/y/projetos/cockpit', mtime: PROC + 60_000 });
  // 16 — o `codex exec` do `avaliador-externo`, no MESMO cwd. Sem o filtro do
  // `originator` ele roubaria a fita — e isso aconteceu de verdade, durante a redação da spec.
  rollout(raiz, {
    nome: 'do-avaliador', cwd: '/home/y/projetos/cockpit',
    originator: 'codex_exec', source: 'exec', mtime: PROC + 120_000,
  });
  // 19 — nascido ANTES do processo subir: é a conversa da sessão ANTERIOR no mesmo cwd.
  rollout(raiz, {
    nome: 'da-sessao-anterior', cwd: '/home/y/projetos/cockpit',
    nascimento: '2026-08-27T10:00:00.000Z', envelope: '2026-08-27T10:00:00.100Z',
    mtime: PROC + 30_000,
  });

  const mapa = await comAdaptador({ COCKPIT_CODEX_RAIZ: raiz }, (ad) => ad.sessoesDoCodex([pane()]));
  const casada = mapa.get(chaveDe(pane()));
  ok(casada?.casamento === 'ok', `caso 43: com um candidato válido, o casamento é "ok" (${casada?.casamento})`);
  ok(String(casada?.arquivo || '').endsWith('rollout-bom.jsonl'),
    `caso 16/19: venceu o rollout da TUI, não o do codex_exec nem o da sessão anterior (${path.basename(casada?.arquivo || 'nenhum')})`);
  ok(casada?.sessaoId === 'bom', `e o sessaoId sai do session_meta (${casada?.sessaoId})`);

  // 16 isolado: com o `codex_exec` sozinho no disco, NADA casa.
  const soExec = temporario('gate-codex-roll-');
  rollout(soExec, {
    nome: 'so-exec', cwd: '/home/y/projetos/cockpit',
    originator: 'codex_exec', source: 'exec', mtime: PROC + 60_000,
  });
  const semTui = await comAdaptador({ COCKPIT_CODEX_RAIZ: soExec }, (ad) => ad.sessoesDoCodex([pane()]));
  ok(semTui.get(chaveDe(pane()))?.casamento === 'nenhum',
    'caso 16: só um rollout `codex_exec` no disco ⇒ NENHUM casa, aba sem fita');
  ok(semTui.get(chaveDe(pane()))?.arquivo === null, 'e o arquivo sai null, não o do avaliador');
});

grupo('17 — duas panes de Codex no MESMO cwd: nenhuma casa', async () => {
  const raiz = temporario('gate-codex-roll-');
  rollout(raiz, { nome: 'a', cwd: '/home/y/projetos/cockpit', mtime: PROC + 10_000 });
  rollout(raiz, { nome: 'b', cwd: '/home/y/projetos/cockpit', mtime: PROC + 20_000 });

  const duas = [pane({ paneId: '%71' }), pane({ paneId: '%72', pid: 3004999 })];
  const mapa = await comAdaptador({ COCKPIT_CODEX_RAIZ: raiz }, (ad) => ad.sessoesDoCodex(duas));
  for (const p of duas) {
    const r = mapa.get(chaveDe(p));
    ok(r?.casamento === 'ambiguo', `caso 17: ${p.paneId} sai "ambiguo" (${r?.casamento})`);
    ok(r?.arquivo === null, `e ${p.paneId} sai SEM fita — nunca com a fita da outra (#6, D15)`);
  }
});

grupo('17b — duas panes no mesmo cwd que subiram em DIAS diferentes: cada uma com a sua', async () => {
  // O caso real de 02/09, na tela do usuário: um `codex --yolo` aberto em
  // `~/projetos/cockpit-agentes` desde 28/08 (pane %71) e outro aberto no MESMO cwd em 02/09
  // (pane %85). A versão que contava panes por `cwd` cegava AS DUAS, e a tela dizia "não deu
  // para saber qual conversa é desta aba" com as duas conversas intactas no disco.
  //
  // O sinal que resolve: o rollout nasce 2 a 5 s depois de a TUI subir. O de 02/09 passa no
  // filtro da pane velha (para ela, tudo depois de 28/08 "nasceu depois do processo"), mas só
  // a pane nova estava de pé 2 s antes dele.
  const CINCO_DIAS = 5 * 24 * 60 * 60 * 1000;
  const raiz = temporario('gate-codex-roll-');
  rollout(raiz, {
    dia: '2026/08/28', nome: 'da-velha', cwd: '/home/y/projetos/cockpit',
    nascimento: new Date(PROC + 5_000).toISOString(), mtime: PROC + 60_000,
  });
  rollout(raiz, {
    dia: '2026/09/02', nome: 'da-nova', cwd: '/home/y/projetos/cockpit',
    nascimento: new Date(PROC + CINCO_DIAS + 2_000).toISOString(),
    mtime: PROC + CINCO_DIAS + 60_000,
  });

  const velha = pane({ paneId: '%71' });
  const nova = pane({ paneId: '%85', pid: 3005555, procStartMs: PROC + CINCO_DIAS });
  const mapa = await comAdaptador({ COCKPIT_CODEX_RAIZ: raiz }, (ad) => ad.sessoesDoCodex([velha, nova]));

  const rv = mapa.get(chaveDe(velha));
  const rn = mapa.get(chaveDe(nova));
  ok(rv?.casamento === 'ok', `caso 17b: a pane VELHA casa, não fica cega (${rv?.casamento})`);
  ok(String(rv?.arquivo || '').endsWith('rollout-da-velha.jsonl'),
    `e ela fica com a conversa DELA (${path.basename(rv?.arquivo || 'nenhum')})`);
  ok(rn?.casamento === 'ok', `caso 17b: a pane NOVA casa (${rn?.casamento})`);
  ok(String(rn?.arquivo || '').endsWith('rollout-da-nova.jsonl'),
    `e ela fica com a conversa DELA (${path.basename(rn?.arquivo || 'nenhum')})`);
  ok(rv?.arquivo !== rn?.arquivo, 'e as duas NUNCA apontam para o mesmo rollout (#6, D15)');

  // A trava continua onde ela vale: subindo dentro da mesma folga, o carimbo não separa uma
  // da outra e as duas voltam a ficar sem fita. É o caso 17, provado aqui pelo outro lado.
  const gemea = pane({ paneId: '%86', pid: 3005556, procStartMs: PROC + CINCO_DIAS + 1_000 });
  const mapa2 = await comAdaptador({ COCKPIT_CODEX_RAIZ: raiz }, (ad) => ad.sessoesDoCodex([nova, gemea]));
  ok(mapa2.get(chaveDe(nova))?.casamento === 'ambiguo'
    && mapa2.get(chaveDe(gemea))?.casamento === 'ambiguo',
    'caso 17b: duas TUIs subindo dentro da folga de 2 s ⇒ as DUAS ambíguas, o sinal sumiu');
  ok(mapa2.get(chaveDe(nova))?.arquivo === null && mapa2.get(chaveDe(gemea))?.arquivo === null,
    'e nenhuma das duas fica com a fita da outra');
});

grupo('18/41/42/44 — os quatro cenários temporais da trava da sobreposição', async () => {
  // 18/41 — `/new` na mesma TUI: A nasce e PARA, B nasce depois e cresce. Sequenciais ⇒ casa B.
  const novo = temporario('gate-codex-roll-');
  rollout(novo, {
    nome: 'velho', cwd: '/home/y/projetos/cockpit',
    nascimento: new Date(PROC + 5_000).toISOString(), mtime: PROC + 60_000,
  });
  rollout(novo, {
    nome: 'novo', cwd: '/home/y/projetos/cockpit',
    nascimento: new Date(PROC + 70_000).toISOString(), mtime: PROC + 600_000,
  });
  const r41 = (await comAdaptador({ COCKPIT_CODEX_RAIZ: novo }, (ad) => ad.sessoesDoCodex([pane()]))).get(chaveDe(pane()));
  ok(r41?.casamento === 'ok' && String(r41.arquivo).endsWith('rollout-novo.jsonl'),
    `caso 18/41: /new na mesma TUI casa com o NOVO (${path.basename(r41?.arquivo || 'nenhum')}, ${r41?.casamento})`);

  // 42 — pane paralela que morreu. A nasce cedo e é tocada até agora; B nasce depois e
  // também. Sobrepostos ⇒ NENHUM. Sem esta trava, a regra do maior `mtime` escolheria a
  // conversa de uma aba que não existe mais — e a regra da ambiguidade não pega, porque só
  // há uma pane de Codex agora.
  const paralelo = temporario('gate-codex-roll-');
  rollout(paralelo, {
    nome: 'a-viva', cwd: '/home/y/projetos/cockpit',
    nascimento: new Date(PROC + 5_000).toISOString(), mtime: PROC + 900_000,
  });
  rollout(paralelo, {
    nome: 'b-da-pane-morta', cwd: '/home/y/projetos/cockpit',
    nascimento: new Date(PROC + 300_000).toISOString(), mtime: PROC + 800_000,
  });
  const r42 = (await comAdaptador({ COCKPIT_CODEX_RAIZ: paralelo }, (ad) => ad.sessoesDoCodex([pane()]))).get(chaveDe(pane()));
  ok(r42?.casamento === 'ambiguo',
    `caso 42: rollouts SOBREPOSTOS ⇒ nenhum casa, aba sem fita (${r42?.casamento})`);
  ok(r42?.arquivo === null, 'e o arquivo sai null — nunca a conversa da pane que morreu');

  // 44 — `mtime` de baixa resolução: os dois com o MESMO carimbo. Empate é ambiguidade, não
  // desempate por ordem de `readdir`. Quando o sinal é fraco, a resposta certa é sem fita.
  const empate = temporario('gate-codex-roll-');
  rollout(empate, { nome: 'x', cwd: '/home/y/projetos/cockpit', mtime: PROC + 50_000 });
  rollout(empate, { nome: 'y', cwd: '/home/y/projetos/cockpit', mtime: PROC + 50_000 });
  const r44 = (await comAdaptador({ COCKPIT_CODEX_RAIZ: empate }, (ad) => ad.sessoesDoCodex([pane()]))).get(chaveDe(pane()));
  ok(r44?.casamento === 'ambiguo', `caso 44: empate de mtime ⇒ ambiguo, nunca desempate por ordem (${r44?.casamento})`);
});

grupo('27/35/36 — a extração do `session_meta` do prefixo', async () => {
  // 27 — o carimbo SÓ no envelope. Este é o caso que a âncora do `"payload"` existe para
  // fazer funcionar: sem ela, a busca do byte 0 acha o `timestamp` de fora e a fixture vira
  // candidata, e o caso não consegue reprovar o que promete.
  const semCarimbo = temporario('gate-codex-roll-');
  rollout(semCarimbo, {
    nome: 'sem-timestamp', cwd: '/home/y/projetos/cockpit', mtime: PROC + 60_000,
    meta: {
      session_id: 'sem-timestamp',
      cwd: '/home/y/projetos/cockpit',
      originator: 'codex-tui',
      source: 'cli',
      base_instructions: { text: 'x'.repeat(18000) },
    },
  });
  const r27 = (await comAdaptador({ COCKPIT_CODEX_RAIZ: semCarimbo }, (ad) => ad.sessoesDoCodex([pane()]))).get(chaveDe(pane()));
  ok(r27?.casamento === 'nenhum',
    `caso 27: sem \`timestamp\` DENTRO do payload não é candidato (${r27?.casamento})`);

  // E a prova de que a âncora funciona: o mesmo arquivo, lido pelo `sessionMetaDe`, devolve
  // `null` em vez do carimbo do envelope.
  await comAdaptador({ COCKPIT_CODEX_RAIZ: semCarimbo }, async (ad) => {
    const dir = path.join(semCarimbo, '2026/08/28');
    const meta = await ad.sessionMetaDe(path.join(dir, 'rollout-sem-timestamp.jsonl'));
    ok(meta === null, 'sessionMetaDe() devolve null — o carimbo do ENVELOPE não é aceito no lugar');
  });

  // 27b — sem `originator`.
  const semOrig = temporario('gate-codex-roll-');
  rollout(semOrig, {
    nome: 'sem-originator', cwd: '/home/y/projetos/cockpit', mtime: PROC + 60_000,
    meta: {
      session_id: 'sem-originator',
      timestamp: new Date(PROC + 5_000).toISOString(),
      cwd: '/home/y/projetos/cockpit',
      base_instructions: { text: 'x'.repeat(18000) },
    },
  });
  const r27b = (await comAdaptador({ COCKPIT_CODEX_RAIZ: semOrig }, (ad) => ad.sessoesDoCodex([pane()]))).get(chaveDe(pane()));
  ok(r27b?.casamento === 'nenhum', `caso 27: sem \`originator\` não é candidato (${r27b?.casamento})`);

  // 35 — `cwd` com aspa e barra invertida ESCAPADAS. O casamento compara por igualdade de
  // string com o `readlink` de `/proc/<pid>/cwd`, então o valor TEM que chegar desescapado.
  const escapado = temporario('gate-codex-roll-');
  const cwdTorto = '/home/y/proj "a"\\b/c';
  rollout(escapado, { nome: 'escapado', cwd: cwdTorto, mtime: PROC + 60_000 });
  const r35 = (await comAdaptador({ COCKPIT_CODEX_RAIZ: escapado },
    (ad) => ad.sessoesDoCodex([pane({ cwd: cwdTorto })]))).get(chaveDe(pane()));
  ok(r35?.casamento === 'ok',
    `caso 35: \`cwd\` com \\" e \\\\ escapados é lido DESESCAPADO e casa (${r35?.casamento})`);

  // 36 — campos em ORDEM TROCADA. Cada campo tem a sua própria busca no prefixo; reordenar o
  // `session_meta` numa versão futura do CLI não pode quebrar nada.
  const trocado = temporario('gate-codex-roll-');
  rollout(trocado, {
    nome: 'trocado', cwd: '/home/y/projetos/cockpit', mtime: PROC + 60_000,
    meta: {
      source: 'cli',
      originator: 'codex-tui',
      cwd: '/home/y/projetos/cockpit',
      cli_version: '0.147.0',
      timestamp: new Date(PROC + 5_000).toISOString(),
      session_id: 'trocado',
      base_instructions: { text: 'x'.repeat(18000) },
    },
  });
  const r36 = (await comAdaptador({ COCKPIT_CODEX_RAIZ: trocado }, (ad) => ad.sessoesDoCodex([pane()]))).get(chaveDe(pane()));
  ok(r36?.casamento === 'ok' && r36.sessaoId === 'trocado',
    `caso 36: ordem dos campos trocada continua sendo lida (${r36?.casamento}, ${r36?.sessaoId})`);
});

grupo('origem da TUI — subagentes e metadados herdados não disputam a pane', async () => {
  const base = { id: 'pai', session_id: 'herdado', timestamp: new Date(PROC + 5_000).toISOString(),
    cwd: pane().cwd, originator: 'codex-tui', source: 'cli' };
  const casar = async (metas) => {
    const raiz = temporario('gate-codex-origem-');
    for (const [i, meta] of metas.entries()) rollout(raiz, {
      nome: `origem-${i}`, meta, mtime: PROC + 60_000 + i * 1000,
    });
    return (await comAdaptador({ COCKPIT_CODEX_RAIZ: raiz }, (ad) => ad.sessoesDoCodex([pane()]))).get(chaveDe(pane()));
  };
  const filho = { ...base, id: 'filho', session_id: 'pai',
    source: { subagent: { thread_spawn: { parent_thread_id: 'pai', depth: 1 } } },
    forked_from_id: 'pai', parent_thread_id: 'pai' };
  const juntos = await casar([base, filho]);
  ok(juntos.casamento === 'ok' && juntos.sessaoId === 'pai', 'pai e filho sobrepostos: somente a TUI principal casa pelo id canônico');
  for (const [nome, source] of Object.entries({ filho: filho.source, nested: { source: 'cli' }, exec: 'exec', ausente: undefined, desconhecido: 'unknown' })) {
    const r = await casar([{ ...base, source }]);
    ok(r.casamento === 'nenhum', `origem ${nome}: não é candidata à pane`);
  }
  const canonico = await casar([base]);
  ok(canonico.sessaoId === 'pai', 'id canônico prevalece sobre session_id herdado');
  const legado = { ...base }; delete legado.id;
  ok((await casar([legado])).sessaoId === 'herdado', 'session_id continua aceito quando id está ausente');
  ok((await casar([{ ...base, id: null }])).casamento === 'nenhum', 'id presente inválido não cai no session_id herdado');
  const nested = { info: base, id: 'falso' };
  ok((await casar([nested])).casamento === 'nenhum', 'metadados nested não substituem campos do payload');
  ok((await casar([{ info: { source: 'exec', id: 'intruso', texto: '\" } , [ \\ ' }, ...base }])).sessaoId === 'pai',
    'objetos anteriores com strings escapadas não alteram profundidade nem id');
  ok((await casar([{ info: { source: 'cli' }, ...base, source: 'exec' }])).casamento === 'nenhum',
    'source cli nested antes de source exec não promove headless a TUI');
  ok((await casar([{ ...base, base_instructions: { text: 'x'.repeat(100_000) } }])).sessaoId === 'pai',
    'instruções de 100 KB depois dos campos não impedem casamento pelo prefixo');
  const raiz = temporario('gate-codex-herdado-');
  rollout(raiz, { nome: 'herdado', meta: { id: 'filho' }, mtime: PROC + 60_000,
    corpo: [JSON.stringify({ type: 'session_meta', payload: base })] });
  const r = (await comAdaptador({ COCKPIT_CODEX_RAIZ: raiz }, (ad) => ad.sessoesDoCodex([pane()]))).get(chaveDe(pane()));
  ok(r.casamento === 'nenhum', 'primeira linha curta não busca metadados de pai em linhas posteriores');
  const errado = temporario('gate-codex-envelope-');
  const arquivo = rollout(errado, { nome: 'tipo-errado', meta: base });
  fs.writeFileSync(arquivo, JSON.stringify({ type: 'event_msg', payload: base }) + '\n');
  fs.utimesSync(arquivo, new Date(PROC + 60_000), new Date(PROC + 60_000));
  const tipo = (await comAdaptador({ COCKPIT_CODEX_RAIZ: errado }, (ad) => ad.sessoesDoCodex([pane()]))).get(chaveDe(pane()));
  ok(tipo.casamento === 'nenhum', 'payload completo em outro tipo de evento não é session_meta');
});

grupo('20/21 — o custo: I/O contado, não milissegundos cronometrados', async () => {
  // Teto de milissegundos em teste é flaky por disco frio, CI e vizinho barulhento. O que se
  // conta aqui é CHAMADA, que é determinístico: não depende de hardware nem de aquecimento.
  const raiz = temporario('gate-codex-custo-');
  // 600 rollouts no disco, como a máquina do usuário tem. Só três podem interessar.
  for (let i = 0; i < 597; i += 1) {
    rollout(raiz, {
      dia: `2026/07/${String((i % 28) + 1).padStart(2, '0')}`,
      nome: `ruido-${i}`, cwd: '/home/y/projetos/outro', mtime: PROC - 1_000_000,
    });
  }
  for (const n of ['vivo-1', 'vivo-2', 'vivo-3']) {
    rollout(raiz, { nome: n, cwd: `/home/y/projetos/${n}`, mtime: PROC + 60_000 });
  }

  const fsp = require('node:fs/promises');
  const abrirOriginal = fsp.open;
  const readdirOriginal = fsp.readdir;
  let aberturas = 0;
  let leituras = 0;
  fsp.open = (...a) => { aberturas += 1; return abrirOriginal(...a); };
  fsp.readdir = (...a) => { leituras += 1; return readdirOriginal(...a); };
  try {
    await comAdaptador({ COCKPIT_CODEX_RAIZ: raiz }, async (ad) => {
      const uma = [pane({ cwd: '/home/y/projetos/vivo-1' })];
      const quatro = [
        pane({ paneId: '%71', cwd: '/home/y/projetos/vivo-1' }),
        pane({ paneId: '%72', cwd: '/home/y/projetos/vivo-2' }),
        pane({ paneId: '%73', cwd: '/home/y/projetos/vivo-3' }),
        pane({ paneId: '%74', cwd: '/home/y/projetos/vivo-1x' }),
      ];

      // Três das quatro panes casam com um rollout; a quarta não casa com nada. Cada pane
      // que casa custa DUAS aberturas na primeira volta: o PREFIXO (`session_meta`, que é
      // cacheado por caminho) e a CAUDA (o `task_*` do busy/idle, que NÃO pode ser cacheada
      // — é justamente ela que muda a cada turno). Seis, não seiscentas: é isso que o caso
      // existe para provar.
      aberturas = 0; leituras = 0;
      await ad.sessoesDoCodex(quatro);
      const primeira = { aberturas, leituras };
      ok(primeira.aberturas <= 6,
        `caso 20: a 1a chamada abre no máximo 2 por pane que casa — 6 dos 600 (${primeira.aberturas})`);

      aberturas = 0;
      await ad.sessoesDoCodex(quatro);
      ok(aberturas === 3,
        `caso 20: a 2a chamada abre só as 3 CAUDAS — os prefixos vieram do cache (${aberturas})`);
      ok(aberturas < primeira.aberturas,
        `e ela abre MENOS que a primeira, que é o cache fazendo o trabalho (${aberturas} < ${primeira.aberturas})`);

      // A asserção da varredura é RELATIVA, não absoluta: percorrer uma árvore AAAA/MM/DD
      // exige vários `readdir`, e "1 varredura" não é implementável como número. O que
      // importa é que ela não MULTIPLIQUE pelo número de panes.
      leituras = 0;
      await ad.sessoesDoCodex(uma);
      const comUma = leituras;
      leituras = 0;
      await ad.sessoesDoCodex(quatro);
      ok(leituras === comUma,
        `caso 20: 1 pane e 4 panes fazem o MESMO número de readdir (${comUma} vs ${leituras})`);
    });

    // 21 — o arquivo ATIVO cresce a cada append: `mtime` e `size` mudam a cada batida. Um
    // cache com chave `(caminho, mtime, size)` releria justamente o arquivo que interessa,
    // para sempre. A chave é o CAMINHO, e o prefixo é imutável.
    await comAdaptador({ COCKPIT_CODEX_RAIZ: raiz }, async (ad) => {
      const uma = [pane({ cwd: '/home/y/projetos/vivo-1' })];
      await ad.sessoesDoCodex(uma);
      const ativo = path.join(raiz, '2026/08/28', 'rollout-vivo-1.jsonl');
      fs.appendFileSync(ativo, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`);
      fs.utimesSync(ativo, new Date(PROC + 900_000), new Date(PROC + 900_000));
      // A asserção mira o `sessionMetaDe`, que é quem tem cache — a cauda do busy/idle é
      // relida de propósito. Um cache com chave `(caminho, mtime, size)` releria TAMBÉM o
      // prefixo, e o arquivo vivo, que é justamente o que interessa, seria reaberto para
      // sempre. A chave é o CAMINHO, e o prefixo é imutável.
      aberturas = 0;
      const meta = await ad.sessionMetaDe(ativo);
      ok(aberturas === 0,
        `caso 21: o arquivo ATIVO cresceu (mtime e size mudaram) e o PREFIXO não foi reaberto (${aberturas})`);
      ok(meta?.originator === 'codex-tui', 'e o meta cacheado continua correto');
      const depois = await ad.sessoesDoCodex(uma);
      ok(depois.get(chaveDe(uma[0]))?.casamento === 'ok',
        'e a pane continua casando depois do append');
    });
  } finally {
    fsp.open = abrirOriginal;
    fsp.readdir = readdirOriginal;
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  FASE 3 — a fita
// ═════════════════════════════════════════════════════════════════════════════

/** Uma linha `event_msg/item_completed`, que é a FONTE ÚNICA da fita. */
const itemFeito = (item, quando = '2026-08-28T12:00:00.000Z') => JSON.stringify({
  timestamp: quando, type: 'event_msg', payload: { type: 'item_completed', item },
});

/** Escreve um arquivo de conversa com as linhas dadas e devolve o caminho. */
function conversa(linhas, { mtime = null } = {}) {
  const dir = temporario('gate-codex-fita-');
  const caminho = path.join(dir, 'rollout-fita.jsonl');
  fs.writeFileSync(caminho, `${linhas.join('\n')}\n`);
  if (mtime !== null) fs.utimesSync(caminho, new Date(mtime), new Date(mtime));
  return caminho;
}

grupo('1/2/5 — as falas: humano, agente (nas duas fases) e o Reasoning que não vira nada', async () => {
  const ad = require('../lib/adaptador-codex');

  const humano = ad.eventosDoObjeto(JSON.parse(itemFeito({
    id: 'msg_1', type: 'UserMessage', content: [{ type: 'text', text: 'oi' }],
  })), 0);
  ok(humano.length === 1 && humano[0].tipo === 'humano' && humano[0].texto === 'oi',
    `caso 1: UserMessage vira {tipo:'humano'} (${JSON.stringify(humano)})`);
  ok(humano[0].quando === '2026-08-28T12:00:00.000Z',
    'e ele carrega `quando` — a fala é o único evento com hora própria');

  // 2 — as DUAS fases são fala do agente. Filtrar por `phase` sumiria com 6 das 9 mensagens
  // do rollout medido.
  for (const phase of ['commentary', 'final_answer']) {
    const r = ad.eventosDoObjeto(JSON.parse(itemFeito({
      id: `msg_${phase}`, type: 'AgentMessage', phase, content: [{ type: 'text', text: `fala ${phase}` }],
    })), 0);
    ok(r.length === 1 && r[0].tipo === 'texto' && r[0].texto === `fala ${phase}`,
      `caso 2: AgentMessage phase=${phase} vira {tipo:'texto'} (${r.length})`);
  }

  // 5 — `summary_text` e `raw_content` vieram VAZIOS nas 46 ocorrências medidas.
  const raciocinio = ad.eventosDoObjeto(JSON.parse(itemFeito({
    id: 'rs_1', type: 'Reasoning', summary_text: '', raw_content: '',
  })), 0);
  ok(raciocinio.length === 0, `caso 5: Reasoning não vira evento nenhum (${raciocinio.length})`);

  // Conteúdo com várias partes é concatenado com \n, como do outro lado.
  const varias = ad.eventosDoObjeto(JSON.parse(itemFeito({
    id: 'm', type: 'AgentMessage', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
  })), 0);
  ok(varias[0]?.texto === 'a\nb', `partes de conteúdo são juntadas com \\n (${JSON.stringify(varias[0]?.texto)})`);
});

grupo('3/4 — a FONTE ÚNICA: a mesma frase não pode sair duas vezes', async () => {
  const ad = require('../lib/adaptador-codex');

  // 3 — medido: os ordinais 343 e 344 do rollout são a MESMA frase, uma como
  // `response_item/message` e outra como `item_completed/UserMessage`.
  const arquivo = conversa([
    JSON.stringify({
      timestamp: '2026-08-28T12:00:00.000Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Teste' }] },
    }),
    itemFeito({ id: 'u1', type: 'UserMessage', content: [{ type: 'text', text: 'Teste' }] }),
    // 4 — o `task_complete` carrega a última fala do agente em texto puro. Redundante com o
    // `AgentMessage`; lê-lo duplicaria a resposta na tela.
    itemFeito({ id: 'a1', type: 'AgentMessage', content: [{ type: 'text', text: 'Recebido.' }] }),
    JSON.stringify({
      timestamp: '2026-08-28T12:00:02.000Z', type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'T1', last_agent_message: 'Recebido.', duration_ms: 900 },
    }),
  ]);
  const r = await ad.lerConversa(arquivo, 0, {});
  const textos = r.eventos.filter((e) => e.tipo === 'humano' || e.tipo === 'texto').map((e) => e.texto);
  ok(textos.filter((t) => t === 'Teste').length === 1,
    `caso 3: "Teste" aparece UMA vez — o response_item é ignorado inteiro (${textos.filter((t) => t === 'Teste').length})`);
  ok(textos.filter((t) => t === 'Recebido.').length === 1,
    `caso 4: "Recebido." aparece UMA vez — o last_agent_message é ignorado (${textos.filter((t) => t === 'Recebido.').length})`);
});

grupo('6/28/29/40 — os três tipos de ferramenta, campo a campo', async () => {
  const ad = require('../lib/adaptador-codex');

  // 6 — CommandExecution vira o par completo.
  const cmd = ad.eventosDoObjeto(JSON.parse(itemFeito({
    id: 'exec-1', type: 'CommandExecution', command: ['git', 'status'], cwd: '/tmp',
    status: 'completed', exit_code: 0, aggregated_output: 'nada a commitar',
  })), 0);
  ok(cmd.length === 2 && cmd[0].tipo === 'ferramenta' && cmd[1].tipo === 'resultado_ferramenta',
    `caso 6: CommandExecution vira o PAR ferramenta+resultado (${cmd.length})`);
  ok(cmd[0].nome === 'Bash' && cmd[0].entrada.command === 'git status',
    `com nome Bash e o comando juntado (${cmd[0]?.entrada?.command})`);
  ok(cmd[0].id === cmd[1].id && cmd[0].id === 'exec-1', 'e os dois compartilham o `item.id` — é ele que casa o par');
  ok(cmd[1].erro === false, 'exit_code 0 ⇒ erro false');
  ok(!('quando' in cmd[0]) && !('quando' in cmd[1]),
    'e nenhum dos dois carrega hora: máquina falando com máquina não vira bolha com relógio');

  const falhou = ad.eventosDoObjeto(JSON.parse(itemFeito({
    id: 'exec-2', type: 'CommandExecution', command: ['false'], exit_code: 1, aggregated_output: '',
  })), 0);
  ok(falhou[1].erro === true, 'exit_code 1 ⇒ erro true');

  // 40 — campo AUSENTE nunca vira cartão vermelho. Os três casos saem `erro: false`.
  for (const [rotulo, item] of [
    ['ausente', { id: 'e', type: 'CommandExecution', command: ['x'] }],
    ['null', { id: 'e', type: 'CommandExecution', command: ['x'], exit_code: null }],
    ['zero', { id: 'e', type: 'CommandExecution', command: ['x'], exit_code: 0 }],
  ]) {
    const r = ad.eventosDoObjeto(JSON.parse(itemFeito(item)), 0);
    ok(r[1]?.erro === false, `caso 40: exit_code ${rotulo} ⇒ erro:false (${r[1]?.erro})`);
  }

  // O teto de saída: uma bolha de celular não transporta um `cat` de arquivo grande.
  const gigante = ad.eventosDoObjeto(JSON.parse(itemFeito({
    id: 'e', type: 'CommandExecution', command: ['cat'], exit_code: 0, aggregated_output: 'z'.repeat(9000),
  })), 0);
  ok(gigante[1].saida.length === 4000, `a saída é cortada em 4000, como do outro lado (${gigante[1].saida.length})`);

  // 28 — FileChange: os tipos e os caminhos, NUNCA o `unified_diff`.
  const arquivoMudado = ad.eventosDoObjeto(JSON.parse(itemFeito({
    id: 'fc-1',
    type: 'FileChange',
    changes: {
      'lib/a.js': { type: 'modified', unified_diff: '@@ -1 +1 @@\n-a\n+b' },
      'lib/b.js': { type: 'added', unified_diff: '@@ +1 @@\n+novo' },
    },
  })), 0);
  ok(arquivoMudado.length === 2, `caso 28: FileChange emite o PAR (${arquivoMudado.length})`);
  ok(arquivoMudado[0].nome === 'Edit'
    && JSON.stringify(arquivoMudado[0].entrada.caminhos) === JSON.stringify(['lib/a.js', 'lib/b.js']),
    `com os caminhos na entrada (${JSON.stringify(arquivoMudado[0]?.entrada?.caminhos)})`);
  ok(!/unified_diff|@@/.test(JSON.stringify(arquivoMudado)),
    'e o `unified_diff` NÃO vai para a tela — a fita do Claude também não desenha diff');
  ok(arquivoMudado[1].saida === 'modified lib/a.js\nadded lib/b.js',
    `a saída são os tipos e os caminhos (${JSON.stringify(arquivoMudado[1]?.saida)})`);

  // 28 — ImageView emite o par COMPLETO. Um cartão que nunca fecha fica girando para sempre.
  const imagem = ad.eventosDoObjeto(JSON.parse(itemFeito({ id: 'iv-1', type: 'ImageView', path: '/tmp/a.png' })), 0);
  ok(imagem.length === 2 && imagem[1].tipo === 'resultado_ferramenta',
    `caso 28: ImageView emite o par COMPLETO, com resultado (${imagem.length})`);
  ok(imagem[0].nome === 'Read' && imagem[1].erro === false,
    'com nome Read e sem erro — `item_completed` não tem campo de falha a ler');

  // 29 — `item.id` ausente ⇒ id de reserva, e o par AINDA casa.
  const semId = ad.eventosDoObjeto(JSON.parse(itemFeito({
    type: 'CommandExecution', command: ['x'], exit_code: 0, aggregated_output: '',
  })), 77);
  ok(semId[0].id === 'codex-77' && semId[0].id === semId[1].id,
    `caso 29: sem \`item.id\`, o par usa \`codex-<ordinal>\` e continua casando (${semId[0]?.id})`);
});

grupo('14/15 — a emenda de linha e a linha ilegível', async () => {
  const ad = require('../lib/adaptador-codex');

  // 14 — a #11: um bloco de 64 KB cai NO MEIO de uma linha, e a emenda (`carry`) é o que
  // impede o evento daquela linha de sumir. As linhas do rollout chegam a 23,5 KB.
  const enorme = 'y'.repeat(18 * 1024);
  const linhas = [
    itemFeito({ id: 'u0', type: 'UserMessage', content: [{ type: 'text', text: 'a primeira de todas' }] }),
  ];
  // Enche o arquivo até passar de vários blocos de 64 KB, com uma linha gorda no meio de
  // cada um — é isso que garante que o corte caia dentro de uma delas.
  for (let i = 0; i < 12; i += 1) {
    linhas.push(JSON.stringify({
      timestamp: '2026-08-28T12:00:00.000Z', type: 'event_msg',
      payload: { type: 'thread_settings_applied', enchimento: enorme },
    }));
    linhas.push(itemFeito({ id: `a${i}`, type: 'AgentMessage', content: [{ type: 'text', text: `fala ${i}` }] }));
  }
  const arquivo = conversa(linhas);
  ok(fs.statSync(arquivo).size > 3 * 64 * 1024,
    `a fixture passa de três blocos de 64 KB (${Math.round(fs.statSync(arquivo).size / 1024)} KB)`);
  const r = await ad.lerConversa(arquivo, 0, {});
  const falas = r.eventos.filter((e) => e.tipo === 'texto').map((e) => e.texto);
  ok(falas.length === 12,
    `caso 14: as 12 falas atravessam a emenda de blocos, nenhuma se perde (${falas.length})`);
  ok(falas[0] === 'fala 0' && falas[11] === 'fala 11',
    `e elas saem na ORDEM do arquivo, do mais antigo para o mais novo (${falas[0]} … ${falas[11]})`);

  // 15 — linha ilegível no meio não derruba a leitura: pode ser escrita em curso.
  const torto = conversa([
    itemFeito({ id: 'u', type: 'UserMessage', content: [{ type: 'text', text: 'antes' }] }),
    '{"isto":"nao fecha',
    itemFeito({ id: 'a', type: 'AgentMessage', content: [{ type: 'text', text: 'depois' }] }),
  ]);
  const r15 = await ad.lerConversa(torto, 0, {});
  ok(r15 && r15.eventos.length === 2,
    `caso 15: a linha ilegível é pulada e as duas falas sobrevivem (${r15?.eventos?.length})`);
});

grupo('50/51 — o degrade de DOIS níveis, e eles não são a mesma coisa', async () => {
  const ad = require('../lib/adaptador-codex');

  // 50 — o esquema de 31/07 (`0.144.6`): 58 `agent_message`, ZERO `item_completed`. Ele não
  // é ilegível — as linhas parseiam. O que não se sabe é LER a fita dele. `[]` afirmaria
  // "não há mensagens" e é indistinguível de conversa nova; `null` é a abstenção.
  const velho = conversa([
    JSON.stringify({ timestamp: '2026-07-31T10:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'oi' } }),
    JSON.stringify({ timestamp: '2026-07-31T10:00:01.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'olá' } }),
    JSON.stringify({ timestamp: '2026-07-31T10:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'pronto' } }),
  ]);
  ok(await ad.lerConversa(velho, 0, {}) === null,
    'caso 50: rollout INTEIRO em esquema velho ⇒ null, não [] — a tela diz "não sei ler esta conversa"');

  // 51 — um `item.type` inventado NO MEIO de arquivo bom. A fita sai completa sem aquele
  // item, e NÃO devolve null: um tipo novo não pode derrubar a conversa inteira.
  const comEstranho = conversa([
    itemFeito({ id: 'u', type: 'UserMessage', content: [{ type: 'text', text: 'faz aí' }] }),
    itemFeito({ id: 'x', type: 'TipoQueNaoExisteAinda', payload_qualquer: 42 }),
    itemFeito({ id: 'a', type: 'AgentMessage', content: [{ type: 'text', text: 'feito' }] }),
  ]);
  const r51 = await ad.lerConversa(comEstranho, 0, {});
  ok(r51 !== null, 'caso 51: um item desconhecido no meio NÃO anula a conversa');
  ok(r51 && r51.eventos.length === 2 && r51.eventos.map((e) => e.texto).join('|') === 'faz aí|feito',
    `e a fita sai COMPLETA, sem aquele item (${JSON.stringify(r51?.eventos?.map((e) => e.texto))})`);

  // A distinção fina que separa os dois níveis: uma conversa que ainda não teve fala —
  // `task_started` e `token_count` e mais nada — é fita VAZIA, não abstenção. Sem isto, todo
  // turno recém-começado diria "não sei ler".
  const recemAberta = conversa([
    JSON.stringify({ timestamp: '2026-08-28T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } }),
    JSON.stringify({ timestamp: '2026-08-28T12:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: {} } }),
  ]);
  const rNova = await ad.lerConversa(recemAberta, 0, {});
  ok(rNova !== null && rNova.eventos.length === 0,
    'conversa que só tem task_started/token_count é fita VAZIA, não abstenção');
});

grupo('30b — `horaDaUltimaMensagem` DESPACHA de verdade, não só aceita o parâmetro', async () => {
  const abas = require('../lib/abas');
  // A fixture tem o `mtime` deslocado SEIS HORAS da última fala. Quem despacha devolve a
  // hora da fala; quem aceita o parâmetro e o IGNORA cai no leitor do Claude, não acha
  // evento nenhum, cai no `mtime` e erra por seis horas — que é exatamente a mentira de 13,8
  // horas que a mudança de 24/08 consertou, de volta por outra porta.
  const fala = '2026-08-28T12:00:00.000Z';
  const arquivo = conversa([
    itemFeito({ id: 'u', type: 'UserMessage', content: [{ type: 'text', text: 'oi' }] }, fala),
    itemFeito({ id: 'a', type: 'AgentMessage', content: [{ type: 'text', text: 'olá' }] }, fala),
  ], { mtime: Date.parse(fala) + 6 * 3600 * 1000 });

  const comDespacho = await abas.horaDaUltimaMensagem(arquivo, 'codex');
  ok(comDespacho === Date.parse(fala),
    `caso 30b: com agente 'codex', devolve a hora da FALA (${new Date(comDespacho).toISOString()})`);
  ok(comDespacho !== fs.statSync(arquivo).mtimeMs,
    `e NÃO o mtime, que está 6 h à frente (${new Date(fs.statSync(arquivo).mtimeMs).toISOString()})`);

  // A prova pelo avesso: o mesmo arquivo lido pelo leitor do CLAUDE não produz evento nenhum
  // e cai no mtime. Se o despacho não existisse, o valor acima seria este.
  const semDespacho = await abas.horaDaUltimaMensagem(arquivo, 'claude');
  ok(semDespacho === Math.round(fs.statSync(arquivo).mtimeMs),
    'e o leitor do Claude no mesmo arquivo cai no mtime — é a diferença que o despacho faz');
});

// ═════════════════════════════════════════════════════════════════════════════
//  FASES 4 e 4b — o medidor e o consumo do plano
// ═════════════════════════════════════════════════════════════════════════════

/** Uma linha `event_msg/token_count`, que é onde o medidor e o `rate_limits` moram. */
const contagem = ({ info = {}, limites, quando = '2026-08-28T18:22:22.669Z' } = {}) => JSON.stringify({
  timestamp: quando, type: 'event_msg',
  payload: { type: 'token_count', info, ...(limites === undefined ? {} : { rate_limits: limites }) },
});

const contexto = ({ modelo = 'gpt-5.6-sol', esforco = null } = {}) => JSON.stringify({
  timestamp: '2026-08-28T18:22:16.642Z', type: 'turn_context',
  payload: { model: modelo, collaboration_mode: { mode: 'default', settings: { model: modelo, reasoning_effort: esforco } } },
});

// Os números REAIS do rollout de 28/08, e é por isso que eles são o fixture do caso 7: com
// `total_token_usage` o medidor daria 2026%.
const INFO_REAL = {
  total_token_usage: {
    input_tokens: 5215333, cached_input_tokens: 4912512, cache_write_input_tokens: 0,
    output_tokens: 20671, reasoning_output_tokens: 1926, total_tokens: 5236004,
  },
  last_token_usage: {
    input_tokens: 128823, cached_input_tokens: 128000, cache_write_input_tokens: 0,
    output_tokens: 11, reasoning_output_tokens: 0, total_tokens: 128834,
  },
  model_context_window: 258400,
};

grupo('7/8/9/10 — o medidor lê `last_token_usage.input_tokens`, e só ele', async () => {
  const ad = require('../lib/adaptador-codex');

  // 7 — A PROVA DA CORREÇÃO 2. O briefing do card mandava `total_token_usage`, e isso teria
  // ido para o código: 5.236.004 numa janela de 258.400 é 2026% na tela do usuário.
  const real = await ad.doArquivo(conversa([contexto({}), contagem({ info: INFO_REAL })]));
  ok(real?.usados === 128823, `caso 7: usados = last_token_usage.input_tokens (${real?.usados})`);
  ok(real?.teto === 258400, `e o teto sai do model_context_window do ARQUIVO (${real?.teto})`);
  ok(real?.pct === 49.9, `caso 7: pct = 49,9% — não 2026% (${real?.pct})`);
  ok(real.pct > 0 && real.pct <= 100, 'e ele cabe em 0..100, que é o que a barra desenha');
  ok(real?.modelo === 'gpt-5.6-sol', `o modelo sai do último turn_context (${real?.modelo})`);
  ok(real?.esforco === null, 'e o esforço vem null — medido, o CLI publica null mesmo (R9)');

  // 8 — nenhum arquivo de CONFIG é lido. O teto do Codex vem do rollout; a heurística de
  // `[1m]`/200k/1M e o `janelaLongaConfigurada()` do Claude ficam de fora inteiros.
  const fspReal = require('node:fs/promises');
  const lerOriginal = fspReal.readFile;
  const lidos = [];
  fspReal.readFile = (c, ...r) => { lidos.push(String(c)); return lerOriginal(c, ...r); };
  try {
    await ad.doArquivo(conversa([contexto({}), contagem({ info: INFO_REAL })]));
  } finally {
    fspReal.readFile = lerOriginal;
  }
  ok(!lidos.some((c) => /settings\.json|config\.toml|\.claude|\.codex\//.test(c)),
    `caso 8: nenhum arquivo de config é aberto (${lidos.length} readFile: ${JSON.stringify(lidos.slice(0, 3))})`);

  // 9 — sem `token_count` na cauda ⇒ null, e a tela não mostra medidor.
  const semContagem = await ad.doArquivo(conversa([
    contexto({}),
    itemFeito({ id: 'u', type: 'UserMessage', content: [{ type: 'text', text: 'oi' }] }),
  ]));
  ok(semContagem === null, `caso 9: sem token_count ⇒ null, nunca um objeto com usados:0 (${JSON.stringify(semContagem)})`);
  ok(await ad.doArquivo(path.join(temporario('gate-codex-vazio-'), 'nao-existe.jsonl')) === null,
    'arquivo que não existe ⇒ null, sem estourar');

  // 10 — `model_context_window` ausente ⇒ os tokens saem, a porcentagem NÃO é chutada.
  const semTeto = await ad.doArquivo(conversa([contexto({}), contagem({
    info: { last_token_usage: { input_tokens: 1234 } },
  })]));
  ok(semTeto?.usados === 1234, `caso 10: sem teto, os tokens usados continuam saindo (${semTeto?.usados})`);
  ok(semTeto?.teto === null && semTeto?.pct === null,
    `e teto/pct saem NULL — teto chutado é número errado com cara de número certo (${semTeto?.teto}/${semTeto?.pct})`);

  // O ÚLTIMO token_count é quem manda: se o usuário troca de modelo com /model no meio da
  // conversa, o teto muda, e a leitura pega o valor ATUAL.
  const doisModelos = await ad.doArquivo(conversa([
    contexto({ modelo: 'gpt-antigo' }),
    contagem({ info: { last_token_usage: { input_tokens: 10 }, model_context_window: 1000 } }),
    contexto({ modelo: 'gpt-novo', esforco: 'high' }),
    contagem({ info: { last_token_usage: { input_tokens: 500 }, model_context_window: 2000 } }),
  ]));
  ok(doisModelos?.usados === 500 && doisModelos?.teto === 2000 && doisModelos?.modelo === 'gpt-novo',
    `o ÚLTIMO token_count e o ÚLTIMO turn_context é que valem (${doisModelos?.usados}/${doisModelos?.teto}/${doisModelos?.modelo})`);
  ok(doisModelos?.esforco === 'high', `e o esforço aparece quando o CLI o publica (${doisModelos?.esforco})`);
});

grupo('63-71 — o `rate_limits`: o consumo da assinatura OpenAI', async () => {
  const ad = require('../lib/adaptador-codex');
  const doArquivoCom = (limites, info = INFO_REAL) => ad.doArquivo(conversa([contexto({}), contagem({ info, limites })]));

  // 63 — o fixture real.
  const real = await doArquivoCom({
    limit_id: 'codex', limit_name: null,
    primary: { used_percent: 51.0, window_minutes: 300, resets_at: 1787991960 },
    secondary: { used_percent: 18.0, window_minutes: 10080, resets_at: 1788465820 },
    credits: { has_credits: true },
  });
  ok(real?.limites?.length === 2, `caso 63: saem os DOIS lados (${real?.limites?.length})`);
  ok(real?.limites?.[0]?.rotulo === 'Codex — 5h' && real.limites[0].usado === 51,
    `caso 63: primary = {Codex — 5h, 51} (${JSON.stringify(real?.limites?.[0])})`);
  ok(real?.limites?.[1]?.rotulo === 'Codex — semana' && real.limites[1].usado === 18,
    `caso 63: secondary = {Codex — semana, 18} (${JSON.stringify(real?.limites?.[1])})`);
  ok(real?.limites?.every((l) => l.reseta === null),
    'e `reseta` sai NULL, não undefined — undefined some do JSON e faz do "mesmo formato" uma mentira');

  // 64 — A PROVA DO ×1000. O campo vem em segundos; errar isso põe a data em 1970 sem uma
  // linha de erro na tela.
  ok(real?.limites?.[0]?.resetaEm === 1787991960000,
    `caso 64: resets_at 1787991960 vira resetaEm 1787991960000 (${real?.limites?.[0]?.resetaEm})`);
  ok(new Date(real.limites[0].resetaEm).getUTCFullYear() > 2020,
    `e a data faz sentido, não é 1970 (${new Date(real.limites[0].resetaEm).toISOString()})`);

  // 65 — `token_count` SEM `rate_limits` ⇒ null, e NÃO `[]`. `[]` afirmaria "sem limite" onde
  // não se sabe, que é o número inventado que a #10 proíbe.
  const sem = await doArquivoCom(undefined);
  ok(sem !== null && sem.limites === null,
    `caso 65: sem rate_limits ⇒ limites null (e o medidor continua saindo) (${JSON.stringify(sem?.limites)})`);
  ok(!Array.isArray(sem?.limites), 'e NÃO um array vazio — os dois significam coisas diferentes');

  // 66 — arquivo sem `token_count` na cauda ⇒ o retorno inteiro é null.
  const nada = await ad.doArquivo(conversa([contexto({})]));
  ok(nada === null, `caso 66: sem token_count, nem medidor nem limites (${JSON.stringify(nada)})`);

  // 67 — só `primary`. Aqui `[]` seria mentira, mas uma lista de 1 é a verdade.
  const soPrimary = await doArquivoCom({ primary: { used_percent: 33, window_minutes: 300, resets_at: 1787991960 } });
  ok(soPrimary?.limites?.length === 1 && soPrimary.limites[0].rotulo === 'Codex — 5h',
    `caso 67: só primary ⇒ lista de UM, sem buraco nem undefined (${JSON.stringify(soPrimary?.limites)})`);

  // 68 — `used_percent` fora de 0..100, não-numérico ou ausente: o item é DESCARTADO.
  for (const [rotulo, valor] of [['150', 150], ['-1', -1], ['"alto"', 'alto'], ['ausente', undefined]]) {
    const r = await doArquivoCom({
      primary: { used_percent: valor, window_minutes: 300, resets_at: 1 },
      secondary: { used_percent: 20, window_minutes: 10080, resets_at: 1787991960 },
    });
    ok(r?.limites?.length === 1 && r.limites[0].rotulo === 'Codex — semana',
      `caso 68: used_percent ${rotulo} é descartado, o outro lado sobrevive (${JSON.stringify(r?.limites)})`);
  }
  const zerou = await doArquivoCom({ primary: { used_percent: 150, window_minutes: 300 } });
  ok(zerou?.limites === null, `caso 68: sobrando ZERO itens válidos ⇒ null, não [] (${JSON.stringify(zerou?.limites)})`);

  // 69/70 — o rótulo é DERIVADO de `window_minutes`, nunca fixo.
  const nuncaVista = await doArquivoCom({ primary: { used_percent: 10, window_minutes: 2880, resets_at: 1787991960 } });
  ok(nuncaVista?.limites?.[0]?.rotulo === 'Codex — 48h',
    `caso 69: window_minutes 2880 (janela nunca vista) vira "Codex — 48h" (${nuncaVista?.limites?.[0]?.rotulo})`);
  for (const [minutos, esperado] of [[300, 'Codex — 5h'], [10080, 'Codex — semana'], [1440, 'Codex — dia']]) {
    ok(ad.rotuloDaJanela(minutos) === esperado, `caso 70: ${minutos} min ⇒ "${esperado}"`);
  }

  // 71 — `resets_at` ausente ou <= 0: a HORA some, a porcentagem fica. Perder as duas juntas
  // seria jogar fora o dado que se tem por causa do que falta.
  for (const [rotulo, valor] of [['ausente', undefined], ['zero', 0], ['negativo', -5]]) {
    const r = await doArquivoCom({ primary: { used_percent: 44, window_minutes: 300, resets_at: valor } });
    ok(r?.limites?.[0]?.resetaEm === null && r.limites[0].usado === 44,
      `caso 71: resets_at ${rotulo} ⇒ resetaEm null e usado PRESERVADO (${JSON.stringify(r?.limites?.[0])})`);
  }

  // O `medidoEm` sai do TIMESTAMP do evento, não do mtime do arquivo: é ele que decide, com
  // duas abas de Codex vivas, qual delas fala pelo plano (caso 72).
  ok(real?.medidoEm === Date.parse('2026-08-28T18:22:22.669Z'),
    `medidoEm sai do timestamp do próprio token_count (${new Date(real?.medidoEm || 0).toISOString()})`);
});

grupo('72 — com duas abas de Codex vivas, QUAL delas fala pelo plano', async () => {
  // O critério é o `timestamp` do próprio evento `token_count`, não o `mtime` do arquivo: o
  // `mtime` muda por qualquer escrita, inclusive de um turno que não emitiu `token_count`.
  const roll = temporario('gate-codex-consumo-');
  const limitesDe = (pct) => ({
    primary: { used_percent: pct, window_minutes: 300, resets_at: 1787991960 },
  });
  const corpoCom = (pct, quando) => [contexto({}), contagem({
    info: { last_token_usage: { input_tokens: 100 }, model_context_window: 1000 },
    limites: limitesDe(pct), quando,
  })];
  // A pane %71 mediu ANTES; a %72 mediu DEPOIS. Vence a %72 — mas o arquivo dela tem o
  // `mtime` MAIS VELHO, de propósito: quem escolhesse por mtime pegaria a errada.
  rollout(roll, {
    nome: 'da-71', cwd: '/home/y/projetos/a', sessaoId: 'da-71', mtime: PROC + 900_000,
    corpo: corpoCom(11, '2026-08-28T10:00:00.000Z'),
  });
  rollout(roll, {
    nome: 'da-72', cwd: '/home/y/projetos/b', sessaoId: 'da-72', mtime: PROC + 60_000,
    corpo: corpoCom(77, '2026-08-28T20:00:00.000Z'),
  });

  const proc = arvoreProc({
    10: { comm: 'bash', pgrp: 10, tpgid: 11, filhos: [11] },
    11: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 11, tpgid: 11, cwd: '/home/y/projetos/a', nascidoEm: PROC },
    20: { comm: 'bash', pgrp: 20, tpgid: 21, filhos: [21] },
    21: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 21, tpgid: 21, cwd: '/home/y/projetos/b', nascidoEm: PROC },
  });
  const consumo = await comEspiao(
    {
      COCKPIT_PROC_RAIZ: proc, COCKPIT_CODEX_RAIZ: roll,
      HOME: temporario('gate-codex-home-vazio-'),
      COCKPIT_TMUX_SOCKET: 'f', COCKPIT_TMUX_SESSAO: 'main',
    },
    [{ saida: linhaPane({ janela: '@5', nome: 'A', pane: '%71', pid: 10, cwd: '/home/y/projetos/a' })
      + linhaPane({ janela: '@6', indice: 1, nome: 'B', pane: '%72', pid: 20, cwd: '/home/y/projetos/b' }) }],
    async (mod) => mod.consumoDoCodex(),
  );

  ok(consumo?.limites?.[0]?.usado === 77,
    `caso 72: vence o token_count de TIMESTAMP maior, não o de mtime maior (${consumo?.limites?.[0]?.usado}%)`);
  ok(consumo?.titulo === 'B', `e o cabeçalho diz de qual aba o número veio (${consumo?.titulo})`);
  ok(consumo?.varias === true, 'com duas abas de Codex vivas, `varias` é true — a tela mostra o título');

  // Sem aba de Codex viva: AUSÊNCIA, não `0%`.
  const semNada = await comEspiao(
    {
      COCKPIT_PROC_RAIZ: arvoreProc({ 30: { comm: 'bash', argv: ['-bash'], pgrp: 30, tpgid: 30 } }),
      COCKPIT_CODEX_RAIZ: roll, HOME: temporario('gate-codex-home-vazio-'),
      COCKPIT_TMUX_SOCKET: 'f', COCKPIT_TMUX_SESSAO: 'main',
    },
    [{ saida: linhaPane({ janela: '@9', nome: 'sucata', pane: '%1', pid: 30 }) }],
    async (mod) => mod.consumoDoCodex(),
  );
  ok(semNada === null, `sem aba de Codex viva, o consumo é null — ausência, nunca 0% (${JSON.stringify(semNada)})`);
});

// ═════════════════════════════════════════════════════════════════════════════
//  FASE 5 — busy/idle
// ═════════════════════════════════════════════════════════════════════════════

const tarefa = (tipo, turno, quando = '2026-08-28T18:00:00.000Z') => JSON.stringify({
  timestamp: quando, type: 'event_msg', payload: { type: tipo, turn_id: turno, started_at: quando },
});

grupo('11/12/13 — as três travas da #4', async () => {
  const ad = require('../lib/adaptador-codex');
  const agora = new Date().toISOString();

  // 13 — o par completo fecha o turno; um `task_started` sozinho com processo vivo abre.
  const fechado = conversa([tarefa('task_started', 'T1'), tarefa('task_complete', 'T1')]);
  ok(await ad.estadoDoTurno(fechado, { processoVivo: true }) === false,
    'caso 13: par task_started → task_complete ⇒ rodando false');
  const interrompido = conversa([tarefa('task_started', 'T1'), tarefa('turn_aborted', 'T1')]);
  ok(await ad.estadoDoTurno(interrompido, { processoVivo: true }) === false,
    'caso 13: task_started → turn_aborted ⇒ rodando false');
  const aberto = conversa([tarefa('task_started', 'T1', agora)]);
  ok(await ad.estadoDoTurno(aberto, { processoVivo: true }) === true,
    'caso 13: task_started sem complete e processo VIVO ⇒ rodando true');

  // 11 — processo MORTO. Se o Codex cai no meio do turno, fica um `task_started` órfão para
  // sempre e a aba diria "trabalhando" até o fim dos tempos. A trava vence tudo.
  ok(await ad.estadoDoTurno(aberto, { processoVivo: false }) === false,
    'caso 11: task_started órfão + processo MORTO ⇒ false, sempre');

  // 12 — o mesmo órfão, mas de sete horas atrás. Turno que não fecha não fica pendurado.
  const velho = conversa([tarefa('task_started', 'T1', new Date(Date.now() - 7 * 3600 * 1000).toISOString())]);
  ok(await ad.estadoDoTurno(velho, { processoVivo: true }) === false,
    'caso 12: task_started de 7 h atrás ⇒ false — o mesmo remédio da #4');
  const recente = conversa([tarefa('task_started', 'T1', new Date(Date.now() - 5 * 3600 * 1000).toISOString())]);
  ok(await ad.estadoDoTurno(recente, { processoVivo: true }) === true,
    'e 5 h atrás ainda conta como turno vivo — o corte é 6 h, com folga sobre os 39,9 s medidos');

  // 13 pelo caminho de VERDADE: quem preenche `aba.rodando` é o `sessoesDoCodex()`, e sem
  // esta ligação a função existiria e ninguém a chamaria.
  const raiz = temporario('gate-codex-busy-');
  rollout(raiz, {
    nome: 'trabalhando', cwd: '/home/y/projetos/cockpit', mtime: PROC + 60_000,
    corpo: [tarefa('task_started', 'T9', agora)],
  });
  const mapa = await comAdaptador({ COCKPIT_CODEX_RAIZ: raiz }, (ad2) => ad2.sessoesDoCodex([pane()]));
  ok(mapa.get(chaveDe(pane()))?.rodando === true,
    `caso 13: o \`rodando\` chega pelo sessoesDoCodex(), não por um cálculo solto (${mapa.get(chaveDe(pane()))?.rodando})`);
});

grupo('44 — o task_complete COM erro vira bolha; sem erro, nada (o defeito de 02/09)', async () => {
  const ad = require('../lib/adaptador-codex');
  // O export é UMA asserção, não a fundação do grupo: sem ele (o código de hoje), o `P` de
  // reserva deixa cada caso abaixo nascer vermelho POR SI, em vez de o grupo estourar na 1ª linha.
  ok(typeof ad.PREFIXO_DO_ERRO === 'string' && ad.PREFIXO_DO_ERRO.startsWith('\n\n⚠️'),
    `o prefixo da bolha de erro é exportado e começa com quebra de parágrafo (${JSON.stringify(ad.PREFIXO_DO_ERRO)})`);
  const P = typeof ad.PREFIXO_DO_ERRO === 'string' ? ad.PREFIXO_DO_ERRO : '\n\n⚠️ O Codex não completou o turno: ';

  // A linha REAL do rollout de 2026-09-03T00-25-07 (ordinal 11), com o texto do usage limit.
  const USAGE_LIMIT = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), "
    + 'visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:58 AM.';
  const completo = (extra, quando = '2026-09-03T00:25:27.385Z') => JSON.stringify({
    timestamp: quando, ordinal: 11, type: 'event_msg',
    payload: {
      type: 'task_complete', turn_id: '01a064a7-fcad-7981-ba06-077195f1b639', last_agent_message: null,
      started_at: 1788395125, completed_at: 1788395127, duration_ms: 1404, ...extra,
    },
  });
  const real = completo({ error: { message: USAGE_LIMIT, codex_error_info: 'usage_limit_exceeded' } });

  // (a) a bolha existe, com a mensagem do CLI, como `texto`, com hora.
  const a = ad.eventosDoObjeto(JSON.parse(real), 11);
  ok(a.length === 1 && a[0].tipo === 'texto',
    `caso 44a: task_complete com error vira UM evento texto (${JSON.stringify(a).slice(0, 120)})`);
  ok(a[0]?.texto === P + USAGE_LIMIT, 'com o prefixo fixo e a mensagem do CLI inteira');
  ok(a[0]?.quando === '2026-09-03T00:25:27.385Z', 'e com `quando` — é fala, e é a hora que a lista mostra');

  // (b) sem erro legível, NENHUM evento — o caso normal e os formatos que não se reconhecem (#10).
  for (const [rotulo, extra] of [
    ['sem error', {}], ['error: null', { error: null }], ['message só espaços', { error: { message: '   ' } }],
    ['objeto sem message', { error: {} }], ['string vazia', { error: '' }], ['número', { error: 42 }],
    ['message não-string', { error: { message: 42 } }], ['array', { error: ['x'] }],
  ]) {
    const r = ad.eventosDoObjeto(JSON.parse(completo(extra)), 0);
    ok(r.length === 0, `caso 44b: task_complete ${rotulo} ⇒ nenhum evento (${r.length})`);
  }
  // (b') string direta não vazia é dado do CLI, não invenção.
  const direta = ad.eventosDoObjeto(JSON.parse(completo({ error: 'rede caiu' })), 0);
  ok(direta.length === 1 && direta[0].texto === `${P}rede caiu`,
    `caso 44b': error como string direta vira bolha (${JSON.stringify(direta[0]?.texto)})`);
  // O teto: o mesmo da saída de comando — e são os 4000 PRIMEIROS, não 4000 quaisquer.
  const enorme = ad.eventosDoObjeto(JSON.parse(completo({ error: { message: 'a' + 'z'.repeat(9000) } })), 0);
  ok(enorme[0]?.texto === P + 'a' + 'z'.repeat(3999),
    `a mensagem é cortada em 4000, como a saída de comando, mantendo o começo (${enorme[0]?.texto.length})`);
  // O `trim()`: só as pontas.
  const comEspacos = ad.eventosDoObjeto(JSON.parse(completo({ error: { message: '  rede  caiu \n' } })), 0);
  ok(comEspacos[0]?.texto === `${P}rede  caiu`,
    `espaços e quebras nas pontas saem; os de dentro ficam (${JSON.stringify(comEspacos[0]?.texto)})`);
  // Envelope sem `timestamp`: bolha SEM `quando`, como qualquer fala — nunca hora inventada.
  const semHora = JSON.parse(real); delete semHora.timestamp;
  const sh = ad.eventosDoObjeto(semHora, 0);
  ok(sh.length === 1 && !('quando' in sh[0]),
    `sem timestamp no envelope a bolha sai, mas sem \`quando\` (${JSON.stringify(Object.keys(sh[0] || {}))})`);

  // (c) o busy/idle NÃO regride: task_started → task_complete(erro) ⇒ rodando false.
  const arquivoC = conversa([tarefa('task_started', 'T1'), real]);
  ok(await ad.estadoDoTurno(arquivoC, { processoVivo: true }) === false,
    'caso 44c: task_started → task_complete(erro) ⇒ rodando false — o busy/idle não regride');

  // (d) o rollout do defeito, inteiro, via lerConversa: 2 falas, humano → texto, mensagem UMA vez.
  const arquivoD = conversa([
    tarefa('task_started', 'T1', '2026-09-03T00:25:25.000Z'),
    itemFeito({ id: 'u1', type: 'UserMessage', content: [{ type: 'text', text: 'Teste' }] }, '2026-09-03T00:25:25.500Z'),
    JSON.stringify({ timestamp: '2026-09-03T00:25:27.000Z', type: 'event_msg', payload: { type: 'token_count', info: {} } }),
    real,
  ]);
  const d = await ad.lerConversa(arquivoD, 0, {});
  const falasD = d.eventos.filter((e) => e.tipo === 'humano' || e.tipo === 'texto');
  ok(falasD.length === 2 && falasD[0].tipo === 'humano' && falasD[1].tipo === 'texto',
    `caso 44d: o rollout do defeito dá 2 falas, humano → texto (${falasD.map((e) => e.tipo).join(' → ')})`);
  ok(d.eventos.filter((e) => String(e.texto || '').includes('usage limit')).length === 1,
    'e a mensagem do erro aparece UMA vez');
  ok(falasD[1]?.quando === '2026-09-03T00:25:27.385Z',
    'a última fala (a que `horaDaUltimaMensagem` lê) é o erro, com a hora dele');

  // (e) turno com AgentMessage ANTES do erro: a fala sai UMA vez e a bolha do erro vem depois.
  const arquivoE = conversa([
    itemFeito({ id: 'u1', type: 'UserMessage', content: [{ type: 'text', text: 'Teste' }] }),
    itemFeito({ id: 'a1', type: 'AgentMessage', content: [{ type: 'text', text: 'Recebido.' }] }),
    completo({ last_agent_message: 'Recebido.', error: { message: 'rede caiu' } }),
  ]);
  const e = await ad.lerConversa(arquivoE, 0, {});
  const textosE = e.eventos.filter((x) => x.tipo === 'texto').map((x) => x.texto);
  ok(textosE.length === 2 && textosE[0] === 'Recebido.' && textosE[1] === `${P}rede caiu`,
    `caso 44e: a fala do agente sai UMA vez e a bolha do erro vem DEPOIS dela (${JSON.stringify(textosE)})`);

  // (f) o degrade de nível 2: um arquivo que só tem o erro (e um event_msg desconhecido) É legível.
  const arquivoF = conversa([
    JSON.stringify({ timestamp: '2026-09-03T00:25:25.000Z', type: 'event_msg', payload: { type: 'coisa_nova' } }),
    real,
  ]);
  const f = await ad.lerConversa(arquivoF, 0, {});
  ok(f !== null && f.eventos.length === 1,
    `caso 44f: rollout que só tem o erro é fita com 1 bolha, não abstenção (${f === null ? 'null' : f.eventos.length})`);
});

grupo('26b — a sequência decide, e o `turn_id` NÃO é pareado', async () => {
  const ad = require('../lib/adaptador-codex');
  const agora = new Date().toISOString();
  // As quatro linhas da tabela normativa, lidas de trás para frente. Parear `turn_id`
  // travaria num órfão antigo e a aba ficaria "trabalhando" para sempre.
  const casos = [
    ['task_complete(T2) … task_started(T2)', ['task_started:T2', 'task_complete:T2'], false, 'o turno fechou'],
    ['task_started(T2) … task_complete(T1)', ['task_complete:T1', 'task_started:T2'], true, 'T2 abriu e não fechou'],
    ['task_started(T2) … task_started(T1) órfão', ['task_started:T1', 'task_started:T2'], true, 'o primeiro achado decide; T1 não importa'],
    ['task_complete(T2) … task_started(T1) sem complete', ['task_started:T1', 'task_complete:T2'], false, 'idem, ao contrário'],
  ];
  for (const [rotulo, linhas, esperado, porque] of casos) {
    const arquivo = conversa(linhas.map((l) => {
      const [tipo, turno] = l.split(':');
      return tarefa(tipo, turno, agora);
    }));
    const r = await ad.estadoDoTurno(arquivo, { processoVivo: true });
    ok(r === esperado, `caso 26b: ${rotulo} ⇒ ${esperado} — ${porque} (${r})`);
  }
});

grupo('26a/26c — a string é FILTRO, não decisão; e o teto', async () => {
  const ad = require('../lib/adaptador-codex');
  const agora = new Date().toISOString();

  // 26c — as duas palavras aparecem no TEXTO de uma saída de comando. Este projeto mesmo,
  // que analisa o formato do Codex, tem as duas dentro de um `custom_tool_call_output`.
  const textoFalso = JSON.stringify({
    timestamp: agora, type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      output: 'o rollout tem task_started e depois task_complete, nesta ordem',
    },
  });
  const soTexto = conversa([
    itemFeito({ id: 'u', type: 'UserMessage', content: [{ type: 'text', text: 'oi' }] }),
    textoFalso,
  ]);
  ok(await ad.estadoDoTurno(soTexto, { processoVivo: true }) === null,
    'caso 26c: só a string num custom_tool_call_output, sem nada válido atrás ⇒ null');

  // O MESMO texto falso, com um `task_*` válido MAIS ATRÁS: a varredura pula o falso e
  // continua até achar o verdadeiro. É o que prova que a string filtra e não decide.
  const comValidoAtras = conversa([tarefa('task_started', 'T1', agora), textoFalso]);
  ok(await ad.estadoDoTurno(comValidoAtras, { processoVivo: true }) === true,
    'caso 26c: com um task_* VÁLIDO mais atrás, é ele quem decide — o texto foi descartado');
  const comCompleteAtras = conversa([tarefa('task_complete', 'T1', agora), textoFalso]);
  ok(await ad.estadoDoTurno(comCompleteAtras, { processoVivo: true }) === false,
    'e no outro sentido também: a varredura continua até um evento estruturalmente válido');

  // Um `task_started` que NÃO é `event_msg` (mesmo payload, envelope errado) é descartado.
  const envelopeErrado = conversa([JSON.stringify({
    timestamp: agora, type: 'response_item', payload: { type: 'task_started', turn_id: 'T1' },
  })]);
  ok(await ad.estadoDoTurno(envelopeErrado, { processoVivo: true }) === null,
    'e `payload.type: task_started` fora de um `event_msg` não conta — a validação é estrutural');

  // 26a — o teto de 32 MB estourado. O `task_started` fica no COMEÇO do arquivo, fora do
  // alcance da varredura: ela para no teto sem achar nada válido, e o desfecho é o mesmo de
  // "chegou ao fim sem achar" — `null`, nunca `false`. A aba não pode mentir "parada"
  // durante um turno gigante.
  const dir = temporario('gate-codex-teto-');
  const gigante = path.join(dir, 'rollout-gigante.jsonl');
  const alca = fs.openSync(gigante, 'w');
  try {
    fs.writeSync(alca, `${tarefa('task_started', 'T1', agora)}\n`);
    // 33 MB de enchimento SEM nenhuma das duas palavras, escritos em pedaços de 1 MB.
    const pedaco = Buffer.from(`${JSON.stringify({ type: 'response_item', payload: { type: 'ruido', texto: 'z'.repeat(900) } })}\n`.repeat(1000));
    for (let escrito = 0; escrito < 33 * 1024 * 1024; escrito += pedaco.length) fs.writeSync(alca, pedaco);
  } finally {
    fs.closeSync(alca);
  }
  const tamanho = fs.statSync(gigante).size;
  ok(tamanho > 32 * 1024 * 1024, `a fixture passa dos 32 MB do teto (${Math.round(tamanho / 1024 / 1024)} MB)`);
  ok(await ad.estadoDoTurno(gigante, { processoVivo: true }) === null,
    'caso 26a: teto estourado sem achar task_* ⇒ NULL, não false');
});

// ═════════════════════════════════════════════════════════════════════════════
//  FASE 8 — o campo `Agente` no diálogo de aba nova
// ═════════════════════════════════════════════════════════════════════════════

grupo('52/53/54 — o whitelist, o comando da aba e o id que não existe', async () => {
  const agentes = require('../lib/agentes');
  const abas = require('../lib/abas');

  // 52 — o whitelist É o registro, não uma lista solta em algum `if`. É esta função, e só
  // ela, que o `POST /api/abas` usa para recusar com 400.
  ok(agentes.existe('codex') === true && agentes.existe('claude') === true,
    'caso 52: os dois agentes do registro existem');
  ok(agentes.existe('cursor') === false,
    'caso 52: `cursor` NÃO existe — a lista é fechada, e o card dele vem depois');

  // 53 — aprovações são o padrão; bypass exige opt-in do instalador.
  const doCodex = abas.comandoDaAba('codex');
  ok(doCodex.includes('/usr/bin/codex'), `caso 53: o comando do Codex tem o binário (${doCodex})`);
  ok(!doCodex.includes('--dangerously') && !doCodex.includes('--yolo'), 'caso 53: aprovações por padrão');
  process.env.COCKPIT_CODEX_SEM_APROVACAO = '1';
  ok(abas.comandoDaAba('codex').includes('--dangerously-bypass-approvals-and-sandbox'), 'bypass exige opt-in');
  delete process.env.COCKPIT_CODEX_SEM_APROVACAO;
  const doClaude = abas.comandoDaAba('claude');
  ok(!doClaude.includes('--yolo'),
    `caso 53: e ele NÃO vazou para o Claude, que não pediu nada disso (${doClaude})`);
  ok(doClaude.includes('/usr/bin/claude') && doClaude.includes('exec'),
    'o do Claude continua sendo shell → agente → shell, como sempre foi');
  // `bin` e `args` SEPARADOS: é aqui que se prova que a validação do `criar()` (regex
  // fechada) roda sobre um caminho puro. Com as flags dentro do `bin`, `/usr/bin/codex
  // --yolo` reprovaria no espaço, na própria trava que existe para barrar injeção.
  ok(/^\/[A-Za-z0-9._/-]+$/.test(agentes.de('codex').bin()),
    `o \`bin\` do Codex passa na regex fechada do criar() (${agentes.de('codex').bin()})`);

  // 54 — id inválido ESTOURA. Cair no padrão calado faria um `agente: 'cursor'` que
  // escapasse da rota abrir uma aba de Claude sem ninguém entender por quê; devolver string
  // vazia faria a janela nascer com um `; exec bash` mudo.
  let estourou = null;
  try { abas.comandoDaAba('nao-existe'); } catch (e) { estourou = e; }
  ok(estourou instanceof Error, 'caso 54: comandoDaAba(<id inexistente>) LANÇA');
  ok(estourou?.codigo === 400, `e o erro é tipado com 400, não um genérico (${estourou?.codigo})`);
  ok(!/nao-existe.*exec|exec.*bash/.test(String(estourou?.message)),
    'e a mensagem não devolve comando nenhum — nada de `; exec bash` mudo');

  // E o `criar()` recusa o mesmo id antes de tocar no tmux.
  const recusou = await abas.criar({ cwd: '/tmp', nome: 'x', agente: 'cursor' }).then(() => null, (e) => e);
  ok(recusou?.codigo === 400, `criar() com agente fora do registro é 400 (${recusou?.codigo})`);

  // A OUTRA metade da regra do caso 56: `agente` AUSENTE não é erro — é o padrão. As duas
  // metades juntas são a regra inteira, e provar só a recusa deixaria passar um servidor que
  // exigisse o campo e quebrasse todo cliente antigo.
  //
  // Esta metade mora aqui, e não no `gate-ui.js parte 2`, por um motivo de dano: provar por
  // HTTP exigiria um POST que dá 201, e isso ABRIRIA UMA ABA DE VERDADE na sessão `main` do
  // usuário — lixo no terminal dele a cada rodada do gate. O que se afirma offline é o mesmo
  // contrato: sem `agente`, o comando montado é o do padrão.
  ok(abas.comandoDaAba() === abas.comandoDaAba(agentes.AGENTE_PADRAO),
    'caso 56 (2a metade): sem `agente`, o comando é o do AGENTE_PADRAO — ausente não é erro');
  const semAgente = await abas.criar({ cwd: '/nao/existe/em/lugar/nenhum', nome: 'x' })
    .then(() => null, (e) => e);
  ok(semAgente?.codigo === 409,
    `e criar() sem \`agente\` passa da validação de agente e para no cwd (409, não 400: ${semAgente?.codigo})`);
});

// ═════════════════════════════════════════════════════════════════════════════

/**
 * O guarda de rebase do campo `Agente` — as DUAS asserções offline dele.
 *
 * As outras duas (`GET /api/projetos` sem `cwd`, `POST /api/abas` com projeto inválido dando
 * 400) falam HTTP e vivem no `gate-ui.js parte 2`. Elas não cabem aqui, e fingir que cabem
 * era o defeito da versão anterior: o modo era passado, silenciosamente ignorado, e o gate
 * ficava verde sem rodar as asserções que existe para rodar.
 */
async function entradaFase7() {
  console.log('\n── Guarda de rebase do campo `Agente` (offline) ──\n');
  const abas = require('../lib/abas');
  ok(typeof abas.criar === 'function', 'asserção 1: `abas.criar` existe e é uma função chamável');
  const e = await abas.criar({ cwd: '/nao/existe/em/lugar/nenhum', nome: 'x' }).then(() => null, (x) => x);
  ok(e instanceof Error && e.codigo === 409,
    `asserção 2: criar() com cwd inexistente rejeita com codigo 409 (${e?.codigo})`);
  console.log(`\n${tudoOk ? '✅ guarda de rebase (offline): VERDE' : '❌ guarda de rebase: VERMELHO'}\n`);
  process.exit(tudoOk ? 0 : 1);
}

(async () => {
  // A trava do "offline", e ela existe porque o contrário já aconteceu: um `await` esquecido
  // no helper restaurava a raiz de fixtures cedo demais e a varredura caía no `~/.codex/`
  // REAL. Aqui isso vira vermelho na hora, com o caminho na tela, em vez de um caso que
  // passa lendo o disco do usuário.
  const CASA_DO_CODEX = path.join(os.homedir(), '.codex');
  const fspReal = require('node:fs/promises');
  const abrirDeVerdade = fspReal.open;
  fspReal.open = (caminho, ...resto) => {
    if (String(caminho).startsWith(CASA_DO_CODEX)) {
      ok(false, `um caso tentou ABRIR o ~/.codex/ real: ${caminho}`);
      throw new Error('gate offline: leitura do ~/.codex/ real bloqueada');
    }
    return abrirDeVerdade(caminho, ...resto);
  };
  try {
    if (process.argv.includes('--entrada-fase7')) return await entradaFase7();
    console.log('\n── Gate do Codex — offline, sem tmux, sem token ──');
    for (const { rotulo, fn } of grupos) {
      console.log(`\n  · ${rotulo}`);
      try {
        await fn();
      } catch (erro) {
        ok(false, `o grupo estourou — ${erro.message}`);
      }
    }
    console.log(`\n${tudoOk ? '✅ GATE VERDE — codex' : '❌ GATE VERMELHO — codex'}\n`);
    return process.exit(tudoOk ? 0 : 1);
  } finally {
    fspReal.open = abrirDeVerdade;
    for (const dir of paraApagar) fs.rmSync(dir, { recursive: true, force: true });
  }
})();
