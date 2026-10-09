#!/usr/bin/env node
'use strict';
// GATE do menu aberto do Codex — offline, zero dependência npm, zero rede, zero provider.
//
// Card `menu-da-tui-do-codex-na-tela`. Spec:
// docs/superpowers/specs/2026-09-10-menu-da-tui-do-codex-na-tela-design.md
// Plano: docs/superpowers/plans/2026-09-10-menu-da-tui-do-codex-na-tela-plano.md
//
// Nasce VERMELHO de propósito (Fase 1 do plano): `lib/menu-codex.js` ainda não existe.
// O `require` abaixo é TOLERANTE — não de topo — para o processo rodar até o fim e cada
// asserção falhar com a própria mensagem, em vez de `Cannot find module` matar tudo na
// primeira linha (achado 7 do avaliador Claude, citado no plano).
//
// Evidência (se algum caso precisar salvar algo) vai para `/tmp/cockpit-menu-codex-*`,
// NUNCA no repo.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execSync } = require('node:child_process');
// Só as constantes do Enter confirmado (23/09), para os contextos de `vm` deste arquivo —
// o valor sai do módulo, nunca retipado aqui (a #40). `require` direto e não tolerante:
// se `lib/abas.js` não carrega, nenhum caso deste gate tem o que medir.
const abasDoEnter = require('../lib/abas');

let tudoOk = true;
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) tudoOk = false; return c; };

/**
 * Roda um GRUPO de asserções isolando o estouro dele — mesmo molde de `gate-codex.js`.
 * Sem isto, a primeira chamada a uma função que ainda não existe (`autorizarEscrita`, por
 * exemplo) derrubaria o gate inteiro e esconderia o vermelho dos outros grupos.
 */
const grupos = [];
const grupo = (rotulo, fn) => grupos.push({ rotulo, fn });

let menuCodex = null;
try { menuCodex = require('../lib/menu-codex'); } catch { /* Fase 3 ainda não chegou */ }
const classificar = (t) => (menuCodex ? menuCodex.classificarTela(t) : '(módulo ausente)');

const paraApagar = [];
const temporario = (prefixo) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
  paraApagar.push(dir);
  return dir;
};

// ═════════════════════════════════════════════════════════════════════════════
//  Infra compartilhada — árvore /proc de mentira, espião do execFile, linha de list-panes
// ═════════════════════════════════════════════════════════════════════════════
//
// Assinaturas COPIADAS de propósito de `testes/gate-codex.js` — mock inventado por gate é
// como dois testes passam a discordar sobre o mesmo módulo.

/** Monta uma `/proc` falsa e devolve o caminho dela — molde de `gate-codex.js:63`. */
function arvoreProc(processos) {
  const raiz = temporario('gate-menu-codex-proc-');
  for (const [pid, p] of Object.entries(processos)) {
    const dir = path.join(raiz, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    const campos = new Array(52).fill('0');
    campos[0] = String(pid);
    campos[1] = `(${p.comm ?? 'proc'})`;
    campos[2] = p.estado ?? 'S';
    campos[3] = String(p.ppid ?? 1);
    campos[4] = String(p.pgrp ?? pid);
    campos[5] = String(p.sessao ?? pid);
    campos[6] = '34816';
    campos[7] = String(p.tpgid ?? -1);
    campos[21] = String(p.starttime ?? 1000);
    fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
    fs.writeFileSync(path.join(dir, 'cmdline'), `${(p.argv || ['proc']).join('\0')}\0`);
    if (p.cwd) {
      try { fs.symlinkSync(p.cwd, path.join(dir, 'cwd')); } catch { /* já existe */ }
    }
    const tarefa = path.join(dir, 'task', String(pid));
    fs.mkdirSync(tarefa, { recursive: true });
    fs.writeFileSync(path.join(tarefa, 'children'), `${(p.filhos || []).join(' ')}${p.filhos?.length ? ' ' : ''}`);
    if (p.nascidoEm) fs.utimesSync(dir, new Date(p.nascidoEm), new Date(p.nascidoEm));
  }
  return raiz;
}

/** Uma linha do `list-panes -a` com os sete campos que `listar()` pede. */
const linhaPane = ({
  janela, sessao = 'main', indice = 0, nome = 'janela', cwd = '/home/y/projetos/x', pane, pid,
}) => `${janela}\t${sessao}\t${indice}\t${nome}\t${cwd}\t${pane}\t${pid}\n`;

/** Planta um `~/.claude/sessions/<pid>.json` — molde de `gate-codex.js:148`. */
function casaComSessao({
  pid, janela, pane, sessaoId = 'sess-menu-codex', cwd = '/home/y/projetos/x',
  starttime = 1000, status = 'idle',
}) {
  const raiz = temporario('gate-menu-codex-home-');
  fs.mkdirSync(path.join(raiz, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(raiz, '.claude', 'sessions', `${pid}.json`), JSON.stringify({
    kind: 'interactive', sessionId: sessaoId, cwd, status, updatedAt: Date.now(),
    pid, procStart: starttime, tmux: `main:${janela}.${pane}`,
  }));
  return raiz;
}

/**
 * Espiona `execFile`, requer `lib/abas.js` FRESCO e roda `corpo(mod, chamadas)`.
 *
 * `aoChamar(indice, args)` — quando dado — roda ANTES de o mock responder cada chamada
 * QUE CONSOME roteiro (list-panes, send-keys). É o gancho que a Parte 6 usa para trocar
 * `COCKPIT_PROC_RAIZ` NO MEIO de uma sequência, sem depender de tempo. Precedente:
 * `gate-fila-pendente.js:861`.
 *
 * `capturaPane(args, contagem)` — quando dado — decide a SAÍDA de cada `capture-pane`
 * (a régua de `listar()`, Fase 4, e o `autorizarEscrita()` da Parte 6 chamam `capture-pane`
 * de verdade). Sem ele, `capture-pane` continua o bypass de sempre (devolve `''`, NÃO
 * consome posição do roteiro — mesmo desenho de gate-ui.js/gate-codex.js/gate-fila-pendente.js,
 * Fase 2, passo 1/1b): é o caso da Parte 1c, que prova o bypass em si. `args` traz o `-t
 * <pane>` de verdade, então o duble pode responder DIFERENTE por pane-alvo — é o que a
 * Parte 6 usa para provar que `autorizarEscrita()` captura a pane CERTA, não uma stale de
 * outra pane ou do `listar()`.
 *
 * `capturaPane` pode devolver uma **Promise PENDENTE** em vez de uma string: é o que as
 * corridas entre panes (Parte 6b em diante) usam para simular "a captura da OUTRA pane
 * ainda não voltou", sem depender de tempo — o `cb` do `execFile` mockado só dispara quando
 * o próprio teste resolve a promessa (a mesma ideia do `aoChamar` de
 * `gate-fila-pendente.js:861`, adaptada para o `capture-pane`, que não consome roteiro).
 */
async function comEspiaoAbas(env, roteiro, corpo, { aoChamar, capturaPane } = {}) {
  const cp = require('node:child_process');
  const original = cp.execFile;
  const antesEnv = { ...process.env };
  const chamadas = [];
  let i = 0;
  let contagemCaptura = 0;
  cp.execFile = (bin, args, opts, cb) => {
    chamadas.push([bin, args]);
    const cmd = args && args[0] === '-L' ? args[2] : args && args[0];
    if (cmd === 'capture-pane') {
      const n = contagemCaptura;
      contagemCaptura += 1;
      const pronto = cb || opts;
      const saida = capturaPane ? capturaPane(args, n) : '';
      // Thenable ⇒ PENDENTE: só respondemos quando o teste resolver. String/`undefined` ⇒
      // comportamento de sempre, síncrono.
      if (saida && typeof saida.then === 'function') {
        saida.then((s) => pronto(null, s ?? '', ''));
        return undefined;
      }
      return pronto(null, saida ?? '', '');
    }
    const indice = i;
    const r = roteiro[i] || { saida: '' };
    i += 1;
    if (aoChamar) aoChamar(indice, args);
    const pronto = cb || opts;
    if (!r.erro) return pronto(null, r.saida ?? '', '');
    const e = new Error(r.erro.stderr || 'tmux falhou');
    e.killed = Boolean(r.erro.killed);
    return pronto(e, '', r.erro.stderr || '');
  };
  Object.assign(process.env, env);
  const limparCache = () => {
    for (const m of ['../lib/abas', '../lib/agentes', '../lib/adaptador-codex', '../lib/menu-codex']) {
      try { delete require.cache[require.resolve(m)]; } catch { /* menu-codex pode não existir ainda (Fase 1/2) */ }
    }
  };
  limparCache();
  try {
    const mod = require('../lib/abas');
    return await corpo(mod, chamadas);
  } finally {
    cp.execFile = original;
    for (const k of Object.keys(process.env)) if (!(k in antesEnv)) delete process.env[k];
    Object.assign(process.env, antesEnv);
    limparCache();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Parte 1 — a régua contra as 42 fixtures
// ═════════════════════════════════════════════════════════════════════════════

const DIR_FIXTURES = path.join(__dirname, 'fixtures', 'menu-codex');

// Duas fixtures reaproveitadas pela Parte 3 e pela Parte 6 (autorizarEscrita): uma tela de
// menu de verdade e uma tela livre de verdade — nunca texto inventado, a régua real decide.
const TXT_MENU = fs.readFileSync(path.join(DIR_FIXTURES, '0.153.4-menu-model.txt'), 'utf8');
const TXT_LIVRE = fs.readFileSync(path.join(DIR_FIXTURES, '0.153.4-livre-sem-conversa.txt'), 'utf8');

/** A fonte de uma função de `lib/abas.js`, do `async function NOME(` até o `}` de coluna 0. */
function sliceFn(nome) {
  const fonte = fs.readFileSync(path.join(__dirname, '../lib/abas.js'), 'utf8');
  const marca = `async function ${nome}(`;
  const inicio = fonte.indexOf(marca);
  if (inicio < 0) throw new Error(`não achei '${marca}' em lib/abas.js`);
  return fonte.slice(inicio, fonte.indexOf('\n}\n', inicio) + 2);
}

grupo('Parte 1 — a régua contra as 42 fixtures', async () => {
  // A lista é DERIVADA do diretório, não escrita à mão: fixture nova que ninguém classifica
  // tem que reprovar o gate, não passar despercebida.
  const arquivos = fs.readdirSync(DIR_FIXTURES).filter((f) => f.endsWith('.txt')).sort();
  const doPrefixo = (prefixo) => arquivos.filter((f) => f.startsWith(`0.153.4-${prefixo}-`));
  const menus = doPrefixo('menu');
  const livres = doPrefixo('livre');
  const naopega = doPrefixo('naopega');

  ok(menus.length >= 15, `pelo menos 15 fixtures 'menu-' no diretório (achei ${menus.length})`);
  ok(livres.length >= 26, `pelo menos 26 fixtures 'livre-' no diretório (achei ${livres.length})`);
  ok(naopega.length >= 1, `pelo menos 1 fixture 'naopega-' no diretório (achei ${naopega.length})`);
  // Travado nos dois sentidos: arquivo apagado por engano não pode deixar o gate verde com
  // dois casos, e prefixo novo sem classe não pode passar despercebido.
  ok(arquivos.length === menus.length + livres.length + naopega.length,
    `todo arquivo do diretório cai em 'menu-', 'livre-' ou 'naopega-' (${arquivos.length} arquivos, `
    + `${menus.length}+${livres.length}+${naopega.length}=${menus.length + livres.length + naopega.length})`);

  for (const nome of menus) {
    const r = classificar(fs.readFileSync(path.join(DIR_FIXTURES, nome), 'utf8'));
    ok(r === 'menu', `${nome} ⇒ 'menu' (saiu ${r})`);
  }
  for (const nome of livres) {
    const r = classificar(fs.readFileSync(path.join(DIR_FIXTURES, nome), 'utf8'));
    ok(r === 'livre', `${nome} ⇒ 'livre' (saiu ${r})`);
  }
  // A terceira classe — asserção PRÓPRIA, travada nos dois sentidos: se alguém "consertar"
  // a lacuna sem querer, o gate avisa; se ela piorar para 'menu', o gate avisa também.
  for (const nome of naopega) {
    const r = classificar(fs.readFileSync(path.join(DIR_FIXTURES, nome), 'utf8'));
    ok(r === 'livre',
      `${nome}: a LACUNA DOCUMENTADA — sai 'livre' sendo uma tela bloqueante (falso negativo de `
      + `propósito; travar aqui seria pior que não prevenir, D13). Saiu '${r}'`);
  }

  // Os QUATRO que derrubaram a régua v2: rodapé de menu TRUNCADO (40/50 col) não é rodapé
  // de trabalho — nomeados, não só cobertos pelo loop acima.
  for (const nome of [
    '0.153.4-menu-keymap-40col.txt', '0.153.4-menu-keymap-50col.txt',
    '0.153.4-menu-plugins-40col.txt', '0.153.4-menu-plugins-50col.txt',
  ]) {
    ok(arquivos.includes(nome), `fixture da régua v2 presente: ${nome}`);
    const r = classificar(fs.readFileSync(path.join(DIR_FIXTURES, nome), 'utf8'));
    ok(r === 'menu', `${nome}: rodapé de menu TRUNCADO ainda é 'menu' — não é rodapé de trabalho (saiu ${r})`);
  }

  // Os CINCO que derrubaram a régua v1: rascunho MULTILINHA não é menu. A "multilinha" da
  // fixture original (`livre-rascunho-multilinha`) ganhou quatro variações medidas depois
  // (com linha vazia no meio, rodapé personalizado, rodapé sem `·`, e o rascunho longo com
  // wrap) — as cinco nomeadas aqui, não só cobertas pelo loop de `livres` acima.
  for (const nome of [
    '0.153.4-livre-rascunho-multilinha.txt',
    '0.153.4-livre-rascunho-multilinha-com-vazia.txt',
    '0.153.4-livre-rascunho-multilinha-rodape-personalizado.txt',
    '0.153.4-livre-rascunho-multilinha-rodape-vazio.txt',
    '0.153.4-livre-rascunho-longo-com-wrap.txt',
  ]) {
    ok(arquivos.includes(nome), `fixture da régua v1 presente: ${nome}`);
    const r = classificar(fs.readFileSync(path.join(DIR_FIXTURES, nome), 'utf8'));
    ok(r === 'livre', `${nome}: rascunho MULTILINHA não é menu (saiu ${r})`);
  }

  // Os `.ansi.txt` classificam IGUAL aos irmãos sem ANSI — é o que prova que a limpeza de
  // escape roda ANTES da régua.
  for (const nome of arquivos.filter((f) => f.endsWith('.ansi.txt'))) {
    const irmao = nome.replace('.ansi.txt', '.txt');
    if (!ok(arquivos.includes(irmao), `${nome} tem irmão sem ANSI (${irmao})`)) continue;
    const comAnsi = classificar(fs.readFileSync(path.join(DIR_FIXTURES, nome), 'utf8'));
    const semAnsi = classificar(fs.readFileSync(path.join(DIR_FIXTURES, irmao), 'utf8'));
    ok(comAnsi === semAnsi, `${nome} classifica igual a ${irmao} (${comAnsi} === ${semAnsi})`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  Parte 2 — o R2 da spec: falha de captura NUNCA é 'livre'
// ═════════════════════════════════════════════════════════════════════════════

grupo("Parte 2 — R2: '', '   ', '\\n\\n' e tela sem '›' ⇒ 'desconhecido', nunca 'livre'", async () => {
  const casos = [
    ['string vazia', ''],
    ['só espaços', '   '],
    ['só quebras de linha', '\n\n'],
    ['tela sem nenhuma linha ›', 'gpt-6-astra medium · ~/projetos/x\nworking...\n'],
  ];
  for (const [rotulo, bruto] of casos) {
    const r = classificar(bruto);
    ok(r === 'desconhecido',
      `${rotulo} ⇒ 'desconhecido' (saiu '${r}') — falha de captura não pode virar autorização de escrita por engano`);
    ok(r !== 'livre', `${rotulo}: nunca 'livre' por ausência de sinal (saiu '${r}')`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  Parte 1c — prova de que o bypass do capture-pane (Fase 2, passo 1/1b) dispara de verdade
// ═════════════════════════════════════════════════════════════════════════════
//
// Sem este caso, `args[0]` errado (em vez do comando de verdade, atrás do `-L <socket>`)
// passaria despercebido — foi exatamente o que aconteceu na primeira redação do plano.

grupo('Parte 1c — o bypass do capture-pane não consome posição do roteiro', async () => {
  const proc = arvoreProc({
    10: { comm: 'bash', pgrp: 10, tpgid: 11, filhos: [11] },
    11: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 11, tpgid: 11, starttime: 1000 },
  });
  const r = await comEspiaoAbas(
    {
      COCKPIT_PROC_RAIZ: proc, HOME: temporario('gate-menu-codex-home-'),
      COCKPIT_TMUX_SOCKET: 'gate-menu-codex-fake', COCKPIT_TMUX_SESSAO: 'main',
    },
    [
      { saida: linhaPane({ janela: '@7', pane: '%7', pid: 10 }) },   // 1ª listar()
      { saida: linhaPane({ janela: '@8', pane: '%8', pid: 10 }) },   // 2ª listar()
    ],
    async (mod, chamadas) => {
      const lista1 = await mod.listar();
      const aba = lista1.find((a) => a.agente === 'codex');
      // `preSessao` sai `true` aqui (nenhum rollout casado) — é o que deixa `tela()` passar
      // e disparar um `capture-pane` DE VERDADE no meio, entre as duas chamadas de listar().
      await mod.tela(aba);
      const lista2 = await mod.listar();
      return { lista1, lista2, chamadas };
    },
  );
  // Desde a Fase 4, `listar()` TAMBÉM captura (a régua, para cada pane de Codex) — então as
  // DUAS chamadas de `listar()` somam 1 capture-pane cada, mais a de `tela()` no meio: 3 no
  // total. O que importa aqui não é a CONTAGEM crua, é que nenhuma delas consumiu posição do
  // roteiro — provado pelas duas asserções seguintes.
  const captures = r.chamadas.filter((c) => c[1].includes('capture-pane'));
  ok(captures.length === 3,
    `3 capture-pane no total — o de listar()#1 (régua), o de tela() no meio, o de listar()#2 (régua) (achei ${captures.length})`);
  ok(r.lista1.some((a) => a.chave === 'aba-p7'), 'a 1ª listar() usou a 1ª entrada do roteiro (aba-p7)');
  ok(r.lista2.some((a) => a.chave === 'aba-p8'),
    'a 2ª listar() AINDA recebeu a 2ª entrada do roteiro (aba-p8) — o capture-pane do meio não a consumiu');
});

// ═════════════════════════════════════════════════════════════════════════════
//  Parte 3 — o campo `esperando`, via listar()
// ═════════════════════════════════════════════════════════════════════════════

grupo("Parte 3 — esperando acompanha a régua (exige a captura ligada em listar(), Fase 4)", async () => {
  const menuTxt = fs.readFileSync(path.join(DIR_FIXTURES, '0.153.4-menu-model.txt'), 'utf8');
  const livreTxt = fs.readFileSync(path.join(DIR_FIXTURES, '0.153.4-livre-sem-conversa.txt'), 'utf8');

  const procComCodex = arvoreProc({
    10: { comm: 'bash', pgrp: 10, tpgid: 11, filhos: [11] },
    11: { comm: 'codex', argv: ['/usr/bin/codex', '--yolo'], pgrp: 11, tpgid: 11 },
  });

  for (const [rotulo, capturaBruta, esperado] of [
    ['captura de menu', menuTxt, true],
    ['captura livre', livreTxt, false],
    ['captura vazia', '', false],
  ]) {
    // `capturaPane` responde ao `capture-pane` REAL que a régua de `listar()` dispara (Fase
    // 4, passo 2) — o `capture-pane` NÃO consome posição do roteiro (Fase 2), então a
    // resposta vem por este gancho, não por uma 2ª entrada do roteiro.
    const lista = await comEspiaoAbas(
      {
        COCKPIT_PROC_RAIZ: procComCodex, HOME: temporario('gate-menu-codex-home-'),
        COCKPIT_TMUX_SOCKET: 'gate-menu-codex-fake', COCKPIT_TMUX_SESSAO: 'main',
      },
      [
        { saida: linhaPane({ janela: '@7', pane: '%11', pid: 10 }) },
      ],
      async (mod) => mod.listar(),
      { capturaPane: () => capturaBruta },
    );
    const aba = lista.find((a) => a.agente === 'codex');
    if (ok(Boolean(aba), `${rotulo}: a aba de Codex apareceu na lista`)) {
      ok(aba.esperando === esperado,
        `${rotulo}: esperando === ${esperado} (saiu ${aba.esperando})`);
    }
  }

  // A pane de CLAUDE, no MESMO roteiro: esperando continua saindo de cli.status, e nenhuma
  // captura é disparada naquela pane (o Claude não tem `menuCodex`).
  const procComClaude = arvoreProc({
    20: { comm: 'bash', pgrp: 20, tpgid: 21, filhos: [21] },
    21: { comm: 'claude', argv: ['claude'], pgrp: 21, tpgid: 21, starttime: 4242 },
  });
  const home = casaComSessao({
    pid: 21, janela: '@6', pane: '%21', sessaoId: 'sess-claude-menu-codex', starttime: 4242, status: 'waiting',
  });
  const listaClaude = await comEspiaoAbas(
    { COCKPIT_PROC_RAIZ: procComClaude, HOME: home, COCKPIT_TMUX_SOCKET: 'gate-menu-codex-fake', COCKPIT_TMUX_SESSAO: 'main' },
    [{ saida: linhaPane({ janela: '@6', pane: '%21', pid: 20 }) }],
    async (mod, chamadas) => ({ lista: await mod.listar(), chamadas }),
  );
  const abaClaude = listaClaude.lista.find((a) => a.agente === 'claude');
  ok(abaClaude?.esperando === true, `Claude: esperando sai de cli.status ('waiting' ⇒ true) — não muda com este card`);
  ok(listaClaude.chamadas.length === 1,
    `Claude: só a chamada de list-panes — nenhum capture-pane disparado numa pane que não é Codex (${listaClaude.chamadas.length})`);
});

// ═════════════════════════════════════════════════════════════════════════════
//  Parte 4 — as guardas que passam a valer com esperando:true numa aba de Codex
// ═════════════════════════════════════════════════════════════════════════════

grupo('Parte 4 — podeVerTela / motivoDeRecusa / motivoDeRecusaDeTecla / motivoDeRecusaDeStatus (R18)', async () => {
  const abas = require('../lib/abas');
  const base = { chave: 'aba-p7', agente: 'codex', temAgente: true, pane: '%7', alvo: '@7', titulo: 'codex-teste' };
  const comMenu = { ...base, esperando: true };
  const semMenu = { ...base, esperando: false };

  ok(abas.podeVerTela(comMenu) === true, 'com esperando:true, podeVerTela ⇒ true');
  ok(abas.motivoDeRecusaDeTecla(comMenu, 'Down') === null, "com esperando:true, motivoDeRecusaDeTecla(aba,'Down') ⇒ null (a tecla PASSA)");
  // A recusa por `esperando` SAIU de `motivoDeRecusa` (card escrever-texto-na-pergunta-aberta):
  // digitarNaAba() agora faz o gesto (Escape → reconfere → cola → Enter) em vez de recusar
  // de cara. `preSessao` CONTINUA recusando — é ela quem `motivoDeRecusaDeStatus` acima
  // ainda testa, sem mudar.
  ok(abas.motivoDeRecusa(comMenu) === null, 'com esperando:true (sem preSessao), motivoDeRecusa ⇒ null — o gesto cuida disso em digitarNaAba');
  const statusComMenu = abas.motivoDeRecusaDeStatus(comMenu);
  ok(statusComMenu?.codigo === 409 && /pergunta aberta/.test(statusComMenu.mensagem || ''),
    `com esperando:true, motivoDeRecusaDeStatus ⇒ 409 /pergunta aberta/ (R18) (saiu ${JSON.stringify(statusComMenu)})`);

  ok(abas.podeVerTela(semMenu) === false, 'com esperando:false, podeVerTela ⇒ false (o de hoje)');
  ok(abas.motivoDeRecusaDeTecla(semMenu, 'Down') !== null, 'com esperando:false, motivoDeRecusaDeTecla recusa (o de hoje)');
  ok(!/pergunta aberta/.test(abas.motivoDeRecusa(semMenu) || ''), 'com esperando:false, motivoDeRecusa não menciona pergunta aberta');
});

// ═════════════════════════════════════════════════════════════════════════════
//  Parte 4b — a precedência de motivoDaTela (R20)
// ═════════════════════════════════════════════════════════════════════════════

grupo('Parte 4b — motivoDaTela dá precedência a preSessao (R20)', async () => {
  const abas = require('../lib/abas');
  const combos = [
    [{ esperando: true, preSessao: false }, 'menu'],
    [{ esperando: false, preSessao: true }, 'pre-sessao'],
    // É a que MUDA: o prompt de confiança do Codex É um menu para a régua, e sem a
    // precedência o cliente ofereceria "Cancelar pergunta" onde o Esc ENCERRA o agente.
    [{ esperando: true, preSessao: true }, 'pre-sessao'],
  ];
  for (const [campos, esperado] of combos) {
    const r = abas.motivoDaTela({ agente: 'codex', ...campos });
    ok(r === esperado,
      `{esperando:${campos.esperando},preSessao:${campos.preSessao}} ⇒ '${esperado}' (saiu '${r}')`);
  }
  // {0,0} nunca chega lá: podeVerTela já barrou antes.
  ok(abas.podeVerTela({ agente: 'codex', esperando: false, preSessao: false }) === false,
    '{esperando:false,preSessao:false}: podeVerTela já recusa — motivoDaTela nem é chamado');

  // E o Claude não muda.
  ok(abas.motivoDaTela({ agente: 'claude', esperando: null, preSessao: true }) === 'pre-sessao',
    "Claude em preSessao continua 'pre-sessao', como hoje (inversão é no-op para ele)");
});

// ═════════════════════════════════════════════════════════════════════════════
//  Parte 5 — contrato de rede, campo a campo (achado 4 do painel: paraCliente não vaza pid)
// ═════════════════════════════════════════════════════════════════════════════

grupo('Parte 5 — paraCliente não deixa vazar menuCodex/panePid/agentePid/alvo/arquivo/pane/processoCodex', async () => {
  const abas = require('../lib/abas');
  // Lista de PROIBIDOS, não igualdade de chaves: campo novo legítimo não pode reprovar o
  // gate, mas campo interno vazando tem que reprovar.
  const proibidos = ['menuCodex', 'panePid', 'agentePid', 'alvo', 'arquivo', 'pane', 'processoCodex'];
  const casos = [
    ['codex', {
      chave: 'aba-p7', agente: 'codex', esperando: true, alvo: '@7', arquivo: '/x/rollout.jsonl',
      pane: '%7', processoCodex: { pid: 1, inicio: 2 }, panePid: 10, agentePid: 11, menuCodex: 'menu',
    }],
    ['claude', {
      chave: 'aba-5', agente: 'claude', esperando: false, alvo: '@5', arquivo: '/x/sess.jsonl',
      pane: '%5', panePid: 20, agentePid: 21,
    }],
  ];
  for (const [rotulo, aba] of casos) {
    const saida = abas.paraCliente(aba);
    for (const campo of proibidos) {
      ok(!(campo in saida), `${rotulo}: paraCliente() não expõe '${campo}' (panePid/agentePid valem para os DOIS agentes)`);
    }
    ok(typeof saida.esperando === 'boolean', `${rotulo}: esperando continua boolean`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  Parte 6 — autorizarEscrita() (produto da Fase 4): a matriz completa do passo 8
// ═════════════════════════════════════════════════════════════════════════════
//
// `autorizarEscrita()` é a reconferência barata IMEDIATAMENTE ANTES de cada `send-keys` —
// os cinco pontos de escrita chamam-na, um a um. Aqui ela é exercitada de verdade: nada de
// duble no lugar dela — o que os casos abaixo dublam é só o `tmux`/`tmuxDoStatus` LOCAL das
// funções fatiadas (que gravam os `send-keys` num array), e o `buscar`/`motivoDeRecusa`
// necessários para pular a complexidade de `listar()`. `autorizarEscrita` em si é a função
// REAL de `lib/abas.js`, tirada do módulo fresco (`mod.autorizarEscrita`) — ela usa o `tmux`
// e o `detectarAgente` DO MÓDULO, que passam pelo espião de `execFile` e pela árvore de
// `/proc` de verdade (`COCKPIT_PROC_RAIZ`).
//
// ⚠️ Simulado pela árvore de `/proc`, NUNCA pelo `list-panes`: `autorizarEscrita()` lê
// `aba.pane`/`aba.panePid` da aba que já tem em mãos e chama `detectarAgente(panePid)` — ela
// NÃO relê o `list-panes`. O que muda entre os passos de cada caso é `COCKPIT_PROC_RAIZ`
// (trocado no MEIO da sequência, de dentro do duble de `tmux`/`tmuxDoStatus` que grava os
// `send-keys`) e a resposta do `capture-pane` (via `capturaPane` do espião — nunca a 2ª
// resposta de um roteiro de `list-panes`, que sequer seria consumida).

grupo('Parte 6a — troca de processo ENTRE o texto e o Enter (envio normal e /compact): zero Enter', async () => {
  const procAntes = arvoreProc({
    10: { comm: 'bash', pgrp: 10, tpgid: 11, filhos: [11] },
    11: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 11, tpgid: 11 },
  });
  const procTrocado = arvoreProc({
    // pid 11 sumiu; um OUTRO processo (pid 12, também codex) ocupa a pane — outra
    // identidade, mesmo binário. `agentePid` não bate mais.
    10: { comm: 'bash', pgrp: 10, tpgid: 11, filhos: [12] },
    12: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 11, tpgid: 11 },
  });
  const procSemAgente = arvoreProc({
    // o codex sumiu de vez — #6: sem revalidação, o Enter iria para o `bash`.
    10: { comm: 'bash', pgrp: 10, tpgid: 10, filhos: [] },
  });
  for (const [rotuloProc, procDepois] of [['outro pid', procTrocado], ['agente sumiu', procSemAgente]]) {
    await comEspiaoAbas(
      {
        COCKPIT_PROC_RAIZ: procAntes, HOME: temporario('gate-menu-codex-home-'),
        COCKPIT_TMUX_SOCKET: 'gate-menu-codex-fake', COCKPIT_TMUX_SESSAO: 'main',
      },
      [],
      async (mod) => {
        const codigoDigitar = sliceFn('digitarNaAba');
        const abaCodex = {
          chave: 'aba-p7', agente: 'codex', temAgente: true, esperando: false, preSessao: false,
          pane: '%7', alvo: '@7', titulo: 'codex-teste', panePid: 10, agentePid: 11,
        };
        for (const [rotulo, texto] of [['envio normal', 'oi, tudo bem?'], ['/compact', '/compact']]) {
          process.env.COCKPIT_PROC_RAIZ = procAntes;   // reseta a cada rodada do loop interno
          const chamadas = [];
          let trocou = false;
          const dubleEscrita = (args) => {
            chamadas.push(args);
            // O PRIMEIRO send-keys é sempre o texto (`-l --`) — é ENTRE ele e o Enter que o
            // processo troca, como no comentário de `autorizarEscrita()` (armadilha #6).
            if (!trocou && args.includes('-l')) { trocou = true; process.env.COCKPIT_PROC_RAIZ = procDepois; }
            return '';
          };
          const ctx = {
            path, PASTA_ANEXOS: '/tmp', limpar: (x) => String(x || '').trim(),
            // As TRES do Enter confirmado (23/09): o recorte do `vm` nao enxerga nada fora de
            // `digitarNaAba`, entao sem elas o fatiado estoura `ReferenceError`. A caixa devolve
            // `null` ("nao sei ler") — este gate mede o menu do Codex, nao a conferencia do Enter.
            TENTATIVAS_DE_ENTER: abasDoEnter.TENTATIVAS_DE_ENTER,
            ESPERA_CONFIRMACAO: abasDoEnter.ESPERA_CONFIRMACAO,
            composerTemTexto: async () => null,

            buscar: async () => abaCodex,
            motivoDeRecusa: () => null,
            registrarPendente: (chave, dados) => dados,
            esquecerPendente: () => {},
            espera: async () => {},
            autorizarEscrita: mod.autorizarEscrita,
            tmux: async (args) => dubleEscrita(args),
            tmuxDoStatus: async (args) => dubleEscrita(args),
          };
          require('node:vm').runInNewContext(codigoDigitar, ctx);
          let rejeitou = null;
          try { await ctx.digitarNaAba('aba-p7', texto); } catch (e) { rejeitou = e; }
          const comTexto = chamadas.filter((a) => a.includes('-l'));
          const comEnter = chamadas.filter((a) => a.includes('Enter'));
          ok(Boolean(rejeitou),
            `${rotuloProc}/${rotulo}: a promessa REJEITA quando o processo troca entre o texto e o Enter`);
          ok(rejeitou && rejeitou.colado === true,
            `${rotuloProc}/${rotulo}: o erro leva colado === true — o texto já está no composer`);
          ok(comTexto.length === 1,
            `${rotuloProc}/${rotulo}: o texto/comando SAIU (1 send-keys de colagem) antes da troca ser detectada (achei ${comTexto.length})`);
          ok(comEnter.length === 0,
            `${rotuloProc}/${rotulo}: ZERO send-keys com Enter — a troca de processo barrou (achei ${comEnter.length})`);
        }
      },
      // Captura sempre 'livre': isola a causa da recusa no CHECK DE PROCESSO, não na tela.
      { capturaPane: () => TXT_LIVRE },
    );
  }
});

grupo('Parte 6a-controle — identidade ESTÁVEL: os dois send-keys saem, na ordem', async () => {
  const proc = arvoreProc({
    10: { comm: 'bash', pgrp: 10, tpgid: 11, filhos: [11] },
    11: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 11, tpgid: 11 },
  });
  await comEspiaoAbas(
    {
      COCKPIT_PROC_RAIZ: proc, HOME: temporario('gate-menu-codex-home-'),
      COCKPIT_TMUX_SOCKET: 'gate-menu-codex-fake', COCKPIT_TMUX_SESSAO: 'main',
    },
    [],
    async (mod) => {
      const codigoDigitar = sliceFn('digitarNaAba');
      const abaCodex = {
        chave: 'aba-p7', agente: 'codex', temAgente: true, esperando: false, preSessao: false,
        pane: '%7', alvo: '@7', titulo: 'codex-teste', panePid: 10, agentePid: 11,
      };
      const chamadas = [];
      const ctx = {
        path, PASTA_ANEXOS: '/tmp', limpar: (x) => String(x || '').trim(),
        // As TRES do Enter confirmado (23/09): o recorte do `vm` nao enxerga nada fora de
        // `digitarNaAba`, entao sem elas o fatiado estoura `ReferenceError`. A caixa devolve
        // `null` ("nao sei ler") — este gate mede o menu do Codex, nao a conferencia do Enter.
        TENTATIVAS_DE_ENTER: abasDoEnter.TENTATIVAS_DE_ENTER,
        ESPERA_CONFIRMACAO: abasDoEnter.ESPERA_CONFIRMACAO,
        composerTemTexto: async () => null,

        buscar: async () => abaCodex,
        motivoDeRecusa: () => null,
        registrarPendente: (chave, dados) => dados,
        esquecerPendente: () => {},
        espera: async () => {},
        autorizarEscrita: mod.autorizarEscrita,
        tmux: async (args) => { chamadas.push(args); return ''; },
        tmuxDoStatus: async (args) => { chamadas.push(args); return ''; },
      };
      require('node:vm').runInNewContext(codigoDigitar, ctx);
      await ctx.digitarNaAba('aba-p7', 'oi, tudo bem?');
      ok(chamadas.length === 2, `identidade estável: os DOIS send-keys saem (achei ${chamadas.length})`);
      ok(chamadas[0].includes('-l') && chamadas[1].includes('Enter'),
        'e saem NA ORDEM: texto primeiro, Enter depois');
    },
    { capturaPane: () => TXT_LIVRE },
  );
});

grupo('Parte 6b — duas panes de Codex: a captura de B fica PENDENTE de verdade; a decisão de A usa a captura FRESCA de A', async () => {
  const proc = arvoreProc({
    10: { comm: 'bash', pgrp: 10, tpgid: 11, filhos: [11] },
    11: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 11, tpgid: 11 },
    20: { comm: 'bash', pgrp: 20, tpgid: 21, filhos: [21] },
    21: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 21, tpgid: 21 },
  });
  // A captura de B é uma Promise que só resolve quando ESTE teste mandar (`resolverB`) —
  // não uma resposta "atrasada" por ordem de chamada. Enquanto ela não resolve, B está
  // genuinamente pendurada em `await tmux(['capture-pane', …])`.
  let resolverB;
  const capturaB = new Promise((r) => { resolverB = r; });
  await comEspiaoAbas(
    {
      COCKPIT_PROC_RAIZ: proc, HOME: temporario('gate-menu-codex-home-'),
      COCKPIT_TMUX_SOCKET: 'gate-menu-codex-fake', COCKPIT_TMUX_SESSAO: 'main',
    },
    [],
    async (mod, chamadas) => {
      const abaA = { agente: 'codex', pane: '%7', alvo: '@7', panePid: 10, agentePid: 11 };
      const abaB = { agente: 'codex', pane: '%8', alvo: '@8', panePid: 20, agentePid: 21 };
      // B "autoriza" primeiro — a chamada dispara e fica pendurada na própria captura dela.
      const promessaB = mod.autorizarEscrita(abaB, 'texto');
      // A resolve ANTES de B: a captura dela é imediata, e o veredito não pode depender do
      // que está pendurado em outra pane nem de um `listar()` que nem chega a ser chamado.
      const negaA = await mod.autorizarEscrita(abaA, 'texto');
      ok(negaA === null,
        'A (livre) é AUTORIZADA com a captura FRESCA dela, mesmo com B ainda pendurada na captura — nunca a de B, nunca a do listar()');
      ok(!chamadas.some((c) => c[1].includes('list-panes')),
        'nenhum list-panes foi chamado — autorizarEscrita() não relê listar()');
      // Só agora B libera, em 'menu': prova que quando ela finalmente resolve usa a PRÓPRIA
      // captura, não a de A nem um valor emprestado da corrida.
      resolverB(TXT_MENU);
      const negaB = await promessaB;
      ok(negaB !== null, 'B, ao resolver, recusa com base na PRÓPRIA captura (menu) — é o que separa "reusei a captura de exibição" de "capturei para autorizar"');
    },
    { capturaPane: (args) => (args.includes('%8') ? capturaB : TXT_LIVRE) },
  );
});

grupo('Parte 6b2 — captura de B pendente + o Codex da pane A morre no intervalo: zero send-keys em A (5e)', async () => {
  const procAntes = arvoreProc({
    10: { comm: 'bash', pgrp: 10, tpgid: 11, filhos: [11] },
    11: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 11, tpgid: 11 },
    20: { comm: 'bash', pgrp: 20, tpgid: 21, filhos: [21] },
    21: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 21, tpgid: 21 },
  });
  const procDepois = arvoreProc({
    // O Codex da pane A (11) sumiu; a pane B (20/21) segue intacta — ela é só o pretexto
    // para haver uma captura pendurada em OUTRA pane enquanto A morre.
    10: { comm: 'bash', pgrp: 10, tpgid: 10, filhos: [] },
    20: { comm: 'bash', pgrp: 20, tpgid: 21, filhos: [21] },
    21: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 21, tpgid: 21 },
  });
  let resolverB;
  const capturaB = new Promise((r) => { resolverB = r; });
  await comEspiaoAbas(
    {
      COCKPIT_PROC_RAIZ: procAntes, HOME: temporario('gate-menu-codex-home-'),
      COCKPIT_TMUX_SOCKET: 'gate-menu-codex-fake', COCKPIT_TMUX_SESSAO: 'main',
    },
    [],
    async (mod) => {
      const abaB = { agente: 'codex', pane: '%8', alvo: '@8', panePid: 20, agentePid: 21 };
      // B fica pendurada na captura — como a de `listar()` deixaria a OUTRA pane enquanto
      // termina o Promise.all. Com B ainda pendurada, o Codex da pane-ALVO (A) morre.
      const promessaB = mod.autorizarEscrita(abaB, 'texto');
      process.env.COCKPIT_PROC_RAIZ = procDepois;

      const codigoDigitar = sliceFn('digitarNaAba');
      const abaCodexA = {
        chave: 'aba-p7', agente: 'codex', temAgente: true, esperando: false, preSessao: false,
        pane: '%7', alvo: '@7', titulo: 'codex-teste', panePid: 10, agentePid: 11,
      };
      const chamadas = [];
      const ctx = {
        path, PASTA_ANEXOS: '/tmp', limpar: (x) => String(x || '').trim(),
        // As TRES do Enter confirmado (23/09): o recorte do `vm` nao enxerga nada fora de
        // `digitarNaAba`, entao sem elas o fatiado estoura `ReferenceError`. A caixa devolve
        // `null` ("nao sei ler") — este gate mede o menu do Codex, nao a conferencia do Enter.
        TENTATIVAS_DE_ENTER: abasDoEnter.TENTATIVAS_DE_ENTER,
        ESPERA_CONFIRMACAO: abasDoEnter.ESPERA_CONFIRMACAO,
        composerTemTexto: async () => null,

        buscar: async () => abaCodexA,
        motivoDeRecusa: () => null,
        registrarPendente: (chave, dados) => dados,
        esquecerPendente: () => {},
        espera: async () => {},
        autorizarEscrita: mod.autorizarEscrita,
        tmux: async (args) => { chamadas.push(args); return ''; },
        tmuxDoStatus: async (args) => { chamadas.push(args); return ''; },
      };
      require('node:vm').runInNewContext(codigoDigitar, ctx);
      let rejeitou = null;
      try { await ctx.digitarNaAba('aba-p7', 'oi, tudo bem?'); } catch (e) { rejeitou = e; }
      ok(Boolean(rejeitou), 'com o Codex de A morto no intervalo, a promessa REJEITA — é a #6: sem isto o texto do dono vira comando de shell');
      ok(chamadas.length === 0, `ZERO send-keys na pane A — nem o texto saiu (achei ${chamadas.length})`);

      resolverB(TXT_LIVRE);   // libera B para não deixar promessa pendurada
      await promessaB;
    },
    { capturaPane: (args) => (args.includes('%8') ? capturaB : TXT_LIVRE) },
  );
});

grupo('Parte 6d0 — Claude esperando: captura de OUTRA pane (Codex) pendente, o Claude some ⇒ tecla() zero send-keys (5e)', async () => {
  const procAntes = arvoreProc({
    20: { comm: 'bash', pgrp: 20, tpgid: 21, filhos: [21] },
    21: { comm: 'claude', argv: ['claude'], pgrp: 21, tpgid: 21 },
    30: { comm: 'bash', pgrp: 30, tpgid: 31, filhos: [31] },
    31: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 31, tpgid: 31 },
  });
  const procDepois = arvoreProc({
    // O Claude sumiu da pane %6; a pane de Codex (30/31), cuja captura está pendurada,
    // segue intacta.
    20: { comm: 'bash', pgrp: 20, tpgid: 20, filhos: [] },
    30: { comm: 'bash', pgrp: 30, tpgid: 31, filhos: [31] },
    31: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 31, tpgid: 31 },
  });
  let resolverCodex;
  const capturaCodex = new Promise((r) => { resolverCodex = r; });
  await comEspiaoAbas(
    {
      COCKPIT_PROC_RAIZ: procAntes, HOME: temporario('gate-menu-codex-home-'),
      COCKPIT_TMUX_SOCKET: 'gate-menu-codex-fake', COCKPIT_TMUX_SESSAO: 'main',
    },
    [],
    async (mod) => {
      const abaCodex = { agente: 'codex', pane: '%8', alvo: '@8', panePid: 30, agentePid: 31 };
      const promessaCodex = mod.autorizarEscrita(abaCodex, 'texto');   // pendurada
      process.env.COCKPIT_PROC_RAIZ = procDepois;   // o Claude morre AGORA, com a de Codex ainda pendurada

      const codigoApertar = sliceFn('apertarNaAba');
      const abaClaude = {
        chave: 'aba-claude', agente: 'claude', temAgente: true, esperando: true, preSessao: false,
        pane: '%6', alvo: '@6', titulo: 'claude-teste', panePid: 20, agentePid: 21,
      };
      const chamadas = [];
      const ctx = {
        buscar: async () => abaClaude,
        motivoDeRecusaDeTecla: mod.motivoDeRecusaDeTecla,
        TECLAS: mod.TECLAS,
        podeVerTela: mod.podeVerTela,
        motivoDaTela: mod.motivoDaTela,
        moldarTela: mod.moldarTela,
        autorizarEscrita: mod.autorizarEscrita,
        espera: async () => {},
        ESPERA_REPINTAR: 250,
        tmux: async (args) => { chamadas.push(args); return ''; },
      };
      require('node:vm').runInNewContext(codigoApertar, ctx);
      let rejeitou = null;
      try { await ctx.apertarNaAba('aba-claude', 'Down'); } catch (e) { rejeitou = e; }
      const comSendKeys = chamadas.filter((a) => a[0] === 'send-keys').length;
      ok(Boolean(rejeitou), 'com o Claude morto no intervalo, tecla() REJEITA');
      ok(comSendKeys === 0, `ZERO send-keys na pane do Claude (achei ${comSendKeys})`);

      resolverCodex(TXT_LIVRE);
      await promessaCodex;
    },
    { capturaPane: (args) => (args.includes('%8') ? capturaCodex : TXT_LIVRE) },
  );
});

grupo('Parte 6d1 — sessão MISTA (Claude+Codex): captura da pane de Codex pendente, o Claude morre no intervalo ⇒ envio normal zero send-keys em Claude (5e)', async () => {
  const procAntes = arvoreProc({
    20: { comm: 'bash', pgrp: 20, tpgid: 21, filhos: [21] },
    21: { comm: 'claude', argv: ['claude'], pgrp: 21, tpgid: 21 },
    30: { comm: 'bash', pgrp: 30, tpgid: 31, filhos: [31] },
    31: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 31, tpgid: 31 },
  });
  const procDepois = arvoreProc({
    20: { comm: 'bash', pgrp: 20, tpgid: 20, filhos: [] },   // Claude sumiu
    30: { comm: 'bash', pgrp: 30, tpgid: 31, filhos: [31] },
    31: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 31, tpgid: 31 },
  });
  let resolverCodex;
  const capturaCodex = new Promise((r) => { resolverCodex = r; });
  await comEspiaoAbas(
    {
      COCKPIT_PROC_RAIZ: procAntes, HOME: temporario('gate-menu-codex-home-'),
      COCKPIT_TMUX_SOCKET: 'gate-menu-codex-fake', COCKPIT_TMUX_SESSAO: 'main',
    },
    [],
    async (mod) => {
      const abaCodex = { agente: 'codex', pane: '%8', alvo: '@8', panePid: 30, agentePid: 31 };
      const promessaCodex = mod.autorizarEscrita(abaCodex, 'texto');   // pendurada
      process.env.COCKPIT_PROC_RAIZ = procDepois;   // o Claude morre AGORA, com a de Codex ainda pendurada

      const codigoDigitar = sliceFn('digitarNaAba');
      const abaClaude = {
        chave: 'aba-claude', agente: 'claude', temAgente: true, esperando: false, preSessao: false,
        pane: '%6', alvo: '@6', titulo: 'claude-teste', panePid: 20, agentePid: 21,
      };
      const chamadas = [];
      const ctx = {
        path, PASTA_ANEXOS: '/tmp', limpar: (x) => String(x || '').trim(),
        // As TRES do Enter confirmado (23/09): o recorte do `vm` nao enxerga nada fora de
        // `digitarNaAba`, entao sem elas o fatiado estoura `ReferenceError`. A caixa devolve
        // `null` ("nao sei ler") — este gate mede o menu do Codex, nao a conferencia do Enter.
        TENTATIVAS_DE_ENTER: abasDoEnter.TENTATIVAS_DE_ENTER,
        ESPERA_CONFIRMACAO: abasDoEnter.ESPERA_CONFIRMACAO,
        composerTemTexto: async () => null,

        buscar: async () => abaClaude,
        motivoDeRecusa: () => null,
        registrarPendente: (chave, dados) => dados,
        esquecerPendente: () => {},
        espera: async () => {},
        autorizarEscrita: mod.autorizarEscrita,
        tmux: async (args) => { chamadas.push(args); return ''; },
        tmuxDoStatus: async (args) => { chamadas.push(args); return ''; },
      };
      require('node:vm').runInNewContext(codigoDigitar, ctx);
      let rejeitou = null;
      try { await ctx.digitarNaAba('aba-claude', 'oi, tudo bem?'); } catch (e) { rejeitou = e; }
      ok(Boolean(rejeitou),
        'sessão mista: o Claude morto no intervalo faz a promessa REJEITAR — a melhoria do Codex não pode custar uma regressão no Claude');
      ok(chamadas.length === 0, `ZERO send-keys na pane do Claude (achei ${chamadas.length})`);

      resolverCodex(TXT_LIVRE);
      await promessaCodex;
    },
    { capturaPane: (args) => (args.includes('%8') ? capturaCodex : TXT_LIVRE) },
  );
});

grupo("Parte 6c — a assimetria 'texto' × 'enter' do desconhecido (revisão da rodada 21)", async () => {
  const proc = arvoreProc({
    10: { comm: 'bash', pgrp: 10, tpgid: 11, filhos: [11] },
    11: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 11, tpgid: 11 },
  });
  const abaCodex = {
    chave: 'aba-p7', agente: 'codex', temAgente: true, esperando: false, preSessao: false,
    pane: '%7', alvo: '@7', titulo: 'codex-teste', panePid: 10, agentePid: 11,
  };
  const casos = [
    ['captura "" no preflight: o texto SAI (o cockpit não fica mudo)', ['', ''], { texto: 1, enter: 0, rejeita: true }],
    ["preflight bom, '' entre a colagem e o Enter: 1 texto, ZERO Enter", [TXT_LIVRE, ''], { texto: 1, enter: 0, rejeita: true }],
    ["preflight bom, régua virando 'menu' entre a colagem e o Enter: idem", [TXT_LIVRE, TXT_MENU], { texto: 1, enter: 0, rejeita: true }],
    ["controle: 'livre' nas duas capturas: os DOIS send-keys saem, na ordem", [TXT_LIVRE, TXT_LIVRE], { texto: 1, enter: 1, rejeita: false }],
  ];
  for (const [rotulo, sequenciaCaptura, esperado] of casos) {
    await comEspiaoAbas(
      {
        COCKPIT_PROC_RAIZ: proc, HOME: temporario('gate-menu-codex-home-'),
        COCKPIT_TMUX_SOCKET: 'gate-menu-codex-fake', COCKPIT_TMUX_SESSAO: 'main',
      },
      [],
      async (mod) => {
        const codigoDigitar = sliceFn('digitarNaAba');
        const chamadas = [];
        const ctx = {
          path, PASTA_ANEXOS: '/tmp', limpar: (x) => String(x || '').trim(),
          // As TRES do Enter confirmado (23/09): o recorte do `vm` nao enxerga nada fora de
          // `digitarNaAba`, entao sem elas o fatiado estoura `ReferenceError`. A caixa devolve
          // `null` ("nao sei ler") — este gate mede o menu do Codex, nao a conferencia do Enter.
          TENTATIVAS_DE_ENTER: abasDoEnter.TENTATIVAS_DE_ENTER,
          ESPERA_CONFIRMACAO: abasDoEnter.ESPERA_CONFIRMACAO,
          composerTemTexto: async () => null,

          buscar: async () => abaCodex,
          motivoDeRecusa: () => null,
          registrarPendente: (chave, dados) => dados,
          esquecerPendente: () => {},
          espera: async () => {},
          autorizarEscrita: mod.autorizarEscrita,
          tmux: async (args) => { chamadas.push(args); return ''; },
          tmuxDoStatus: async (args) => { chamadas.push(args); return ''; },
        };
        require('node:vm').runInNewContext(codigoDigitar, ctx);
        let rejeitou = null;
        try { await ctx.digitarNaAba('aba-p7', 'oi, tudo bem?'); } catch (e) { rejeitou = e; }
        ok(Boolean(rejeitou) === esperado.rejeita, `${rotulo} — rejeição ${esperado.rejeita ? 'esperada' : 'inesperada'} (rejeitou=${Boolean(rejeitou)})`);
        if (esperado.rejeita) {
          ok(rejeitou.colado === true, `${rotulo} — colado === true`);
        }
        ok(chamadas.filter((a) => a.includes('-l')).length === esperado.texto,
          `${rotulo} — send-keys de texto: ${esperado.texto} (achei ${chamadas.filter((a) => a.includes('-l')).length})`);
        ok(chamadas.filter((a) => a.includes('Enter')).length === esperado.enter,
          `${rotulo} — send-keys com Enter: ${esperado.enter} (achei ${chamadas.filter((a) => a.includes('Enter')).length})`);
      },
      { capturaPane: (args, n) => sequenciaCaptura[n] ?? '' },
    );
  }
});

grupo("Parte 6d — apertarNaAba() (tecla()): o veredito é o OPOSTO do texto", async () => {
  const codigoApertar = sliceFn('apertarNaAba');
  const procComAgente = arvoreProc({
    10: { comm: 'bash', pgrp: 10, tpgid: 11, filhos: [11] },
    11: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 11, tpgid: 11 },
  });
  const procSemAgente = arvoreProc({
    10: { comm: 'bash', pgrp: 10, tpgid: 10, filhos: [] },
  });
  const casos = [
    ['captura fresca "menu": a tecla PASSA', procComAgente, false, TXT_MENU, { chamadas: 1 }],
    ['captura fresca "livre": a tecla RECUSA (seta sem menu é teclado remoto)', procComAgente, false, TXT_LIVRE, { chamadas: 0 }],
    // O menu FECHOU enquanto outra pane atrasava: mesmo com `aba.esperando` (stale) dizendo
    // true, a captura FRESCA vence — é o mesmo caso que separa "reusei a captura antiga" de
    // "capturei agora".
    ['aba.esperando (stale) = true, captura fresca "livre": ainda RECUSA', procComAgente, false, TXT_LIVRE, { chamadas: 0, esperandoStale: true }],
    ['agente sumiu da pane: RECUSA (zero send-keys) — #6', procSemAgente, false, TXT_MENU, { chamadas: 0 }],
    // preSessao é a exceção de hoje, preservada: com o prompt de confiança a tela pode estar
    // 'livre' (fixture livre-sem-conversa) e mesmo assim a tecla é a forma de responder.
    ['preSessao=true, captura "livre": PASSA (exceção preservada)', procComAgente, true, TXT_LIVRE, { chamadas: 1 }],
  ];
  for (const [rotulo, proc, preSessao, captura, esperado] of casos) {
    await comEspiaoAbas(
      {
        COCKPIT_PROC_RAIZ: proc, HOME: temporario('gate-menu-codex-home-'),
        COCKPIT_TMUX_SOCKET: 'gate-menu-codex-fake', COCKPIT_TMUX_SESSAO: 'main',
      },
      [],
      async (mod) => {
        // `esperando: true` (STALE, do `listar()` de antes) em TODOS os casos: é o que faz
        // `motivoDeRecusaDeTecla` (checado ANTES de `autorizarEscrita`, em `apertarNaAba`)
        // deixar o fluxo chegar até a reconferência — sem isto o teste recusaria pelo motivo
        // ERRADO (podeVerTela da aba stale), nunca exercitando a captura FRESCA.
        const abaCodex = {
          chave: 'aba-p7', agente: 'codex', temAgente: true,
          esperando: true, preSessao,
          pane: '%7', alvo: '@7', titulo: 'codex-teste', panePid: 10, agentePid: 11,
        };
        const chamadas = [];
        const ctx = {
          buscar: async () => abaCodex,
          motivoDeRecusaDeTecla: mod.motivoDeRecusaDeTecla,
          TECLAS: mod.TECLAS,
          podeVerTela: mod.podeVerTela,
          motivoDaTela: mod.motivoDaTela,
          moldarTela: mod.moldarTela,
          autorizarEscrita: mod.autorizarEscrita,
          espera: async () => {},
          ESPERA_REPINTAR: 250,
          tmux: async (args) => { chamadas.push(args); return ''; },
        };
        require('node:vm').runInNewContext(codigoApertar, ctx);
        let rejeitou = null;
        try { await ctx.apertarNaAba('aba-p7', 'Down'); } catch (e) { rejeitou = e; }
        // Conta só os `send-keys` (o `args[0]`): o repintar de depois (`capture-pane`, quando
        // `podeVerTela` continua `true` — caso do `preSessao`) usa o MESMO `tmux` local, mas
        // não é a tecla em si.
        const comSendKeys = chamadas.filter((a) => a[0] === 'send-keys').length;
        ok(comSendKeys === esperado.chamadas,
          `${rotulo}: ${esperado.chamadas} send-keys (achei ${comSendKeys})`);
        ok((esperado.chamadas === 0) === Boolean(rejeitou), `${rotulo}: rejeição ${esperado.chamadas === 0 ? 'esperada' : 'inesperada'}`);
      },
      { capturaPane: () => captura },
    );
  }
});

grupo('Parte 6e — os cinco pontos de escrita, com menu aberto na captura fresca', async () => {
  const proc = arvoreProc({
    10: { comm: 'bash', pgrp: 10, tpgid: 11, filhos: [11] },
    11: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 11, tpgid: 11 },
  });
  const abaCodex = {
    chave: 'aba-p7', agente: 'codex', temAgente: true, esperando: false, preSessao: false,
    pane: '%7', alvo: '@7', titulo: 'codex-teste', panePid: 10, agentePid: 11,
  };
  // 1 e 2 — digitarNaAba: envio normal e /compact. Com menu aberto na captura fresca, o
  // PREFLIGHT ('texto') já recusa — zero send-keys, nem o primeiro.
  for (const [rotulo, texto] of [['envio normal', 'oi, tudo bem?'], ['/compact', '/compact']]) {
    await comEspiaoAbas(
      {
        COCKPIT_PROC_RAIZ: proc, HOME: temporario('gate-menu-codex-home-'),
        COCKPIT_TMUX_SOCKET: 'gate-menu-codex-fake', COCKPIT_TMUX_SESSAO: 'main',
      },
      [],
      async (mod) => {
        const codigoDigitar = sliceFn('digitarNaAba');
        const chamadas = [];
        const ctx = {
          path, PASTA_ANEXOS: '/tmp', limpar: (x) => String(x || '').trim(),
          // As TRES do Enter confirmado (23/09): o recorte do `vm` nao enxerga nada fora de
          // `digitarNaAba`, entao sem elas o fatiado estoura `ReferenceError`. A caixa devolve
          // `null` ("nao sei ler") — este gate mede o menu do Codex, nao a conferencia do Enter.
          TENTATIVAS_DE_ENTER: abasDoEnter.TENTATIVAS_DE_ENTER,
          ESPERA_CONFIRMACAO: abasDoEnter.ESPERA_CONFIRMACAO,
          composerTemTexto: async () => null,

          buscar: async () => abaCodex,
          motivoDeRecusa: () => null,
          registrarPendente: (chave, dados) => dados,
          esquecerPendente: () => {},
          espera: async () => {},
          autorizarEscrita: mod.autorizarEscrita,
          tmux: async (args) => { chamadas.push(args); return ''; },
          tmuxDoStatus: async (args) => { chamadas.push(args); return ''; },
        };
        require('node:vm').runInNewContext(codigoDigitar, ctx);
        let rejeitou = null;
        try { await ctx.digitarNaAba('aba-p7', texto); } catch (e) { rejeitou = e; }
        ok(Boolean(rejeitou), `${rotulo}: com menu aberto, a promessa REJEITA no preflight`);
        ok(chamadas.length === 0, `${rotulo}: ZERO send-keys — nem o texto saiu (achei ${chamadas.length})`);
      },
      { capturaPane: () => TXT_MENU },
    );
  }
  // 3 — tecla(): com menu aberto na captura fresca, a tecla PASSA (é para isto que ela existe).
  await comEspiaoAbas(
    {
      COCKPIT_PROC_RAIZ: proc, HOME: temporario('gate-menu-codex-home-'),
      COCKPIT_TMUX_SOCKET: 'gate-menu-codex-fake', COCKPIT_TMUX_SESSAO: 'main',
    },
    [],
    async (mod) => {
      const codigoApertar = sliceFn('apertarNaAba');
      // `esperando: true` (stale): é o que deixa `motivoDeRecusaDeTecla` (checado ANTES de
      // `autorizarEscrita`) passar o fluxo adiante — a decisão de verdade é a captura fresca.
      const abaCodexTecla = { ...abaCodex, esperando: true };
      const chamadas = [];
      const ctx = {
        buscar: async () => abaCodexTecla,
        motivoDeRecusaDeTecla: mod.motivoDeRecusaDeTecla,
        TECLAS: mod.TECLAS,
        podeVerTela: mod.podeVerTela,
        motivoDaTela: mod.motivoDaTela,
        moldarTela: mod.moldarTela,
        autorizarEscrita: mod.autorizarEscrita,
        espera: async () => {},
        ESPERA_REPINTAR: 250,
        tmux: async (args) => { chamadas.push(args); return ''; },
      };
      require('node:vm').runInNewContext(codigoApertar, ctx);
      await ctx.apertarNaAba('aba-p7', 'Down');
      // Só os `send-keys`: com `esperando` stale continuando `true`, o repintar de depois
      // (`capture-pane`) também passa pelo `tmux` local, mas não é a tecla em si.
      const comSendKeys = chamadas.filter((a) => a[0] === 'send-keys').length;
      ok(comSendKeys === 1, `tecla(): com menu aberto, o send-keys da tecla SAI (achei ${comSendKeys})`);
    },
    { capturaPane: () => TXT_MENU },
  );
  // 4 e 5 — /clear e /status: a proteção deles é provada pelos gates que fatiam
  // `reiniciarCodex`/`executarConsultaStatus` (Fase 2, passo 3) — `gate-clear-codex.js` e
  // `gate-status-codex.js`, cada um com um caso `autorizarEscrita: async () => 'recusa'`
  // que só passa a valer agora que a Fase 4 os chama de verdade. A redação anterior deste
  // plano dizia que eles estavam protegidos "de graça"; não estavam — por isso os dois
  // gates externos ganharam o caso, e não só uma nota aqui.
  ok(true, "/clear e /status: cobertos em gate-clear-codex.js e gate-status-codex.js (autorizarEscrita: async () => 'recusa')");
});

// ═════════════════════════════════════════════════════════════════════════════
//  Parte C (Fase 5) — o contrato do `colado`, ponta a ponta: servidor de VERDADE
// ═════════════════════════════════════════════════════════════════════════════
//
// As Partes A e B da Fase 5 (o selo e a gaveta) vivem em `testes/gate-ui.js` — é lá que
// mora o `carregarCliente({ aoBuscar })` que roda `public/app.js` num DOM de mentira. Esta
// Parte C é a que falta: provar que o `colado` atravessa a REDE de verdade, do `throw` de
// `lib/abas.js` até o JSON das DUAS rotas (`/turnos` e `/status`).
//
// Dois andares, cada um provando uma coisa DIFERENTE — molde de `gate-status-codex.js`:
//
//   1) O MOTOR real: `digitarNaAba` fatiado (mesma técnica da Parte 6, sliceFn+vm) com o
//      `autorizarEscrita` REAL (do módulo fresco, via `comEspiaoAbas`) — não um duble que
//      devolve `{colado:true}` de propósito. É aqui que nascem os `falha` de verdade para
//      os casos p/q/r: zero `send-keys` antes da colagem, um antes do Enter, e um erro
//      genérico (não-autorização) depois dela.
//   2) A ROTA de verdade: `server.js` sobe por `require` em processo (molde de
//      `gate-jobs-rota.js:5-10` e `gate-troca-arquivo.js`) com `lib/abas` dublado no
//      `require.cache` — só `buscar`/`enviar`/`consultarStatus`, o resto do módulo é REAL.
//      Os dubles de `enviar`/`consultarStatus` re-lançam os MESMOS objetos `falha` do andar
//      1 — nada fabricado aqui: o `colado` que a rota serializa é o que o motor real
//      produziu. O que este andar prova é a SERIALIZAÇÃO (`server.js:1143` e `:1071-1074`),
//      não o motor — o motor já foi provado no andar 1 (e nas Partes 6a/6c, para
//      `digitarNaAba` em si).
//
// p2 reaproveita os MESMOS `falha` de p/q (não os de `executarConsultaStatus`, que tem
// storage e fila próprios — fora do escopo desta fase): o que p2 prova é que a rota de
// `/status` (`server.js:1068`), que tem `catch` PRÓPRIO e não passa pela de `/turnos`,
// também respeita "ausente ou `true`, nunca `false`". Por não carregar `.codigo`, esses
// `falha` chegam como 500 nesta rota (o `erro.codigo || 500` de sempre) — não 409; a
// asserção confere isso explicitamente, para não fingir um código que o cenário não tem.

/** Uma pane + processo de Codex mínimos, iguais nas três chamadas do andar 1. */
function procDeCodexParaPartC() {
  return arvoreProc({
    10: { comm: 'bash', pgrp: 10, tpgid: 11, filhos: [11] },
    11: { comm: 'codex', argv: ['/usr/bin/codex'], pgrp: 11, tpgid: 11 },
  });
}

/**
 * Roda `digitarNaAba` fatiado, com o `autorizarEscrita` REAL (`mod.autorizarEscrita`, que
 * passa pelo espião de `execFile`/`/proc` de `comEspiaoAbas`) e um `tmux`/`tmuxDoStatus`
 * LOCAIS (contam os `send-keys` da própria função, como na Parte 6). `sequenciaCaptura`
 * decide a resposta de cada `capture-pane` que `autorizarEscrita` dispara, na ordem.
 */
async function motorDigitarNaAbaPartC(chave, texto, sequenciaCaptura, { enterFalha = false } = {}) {
  return comEspiaoAbas(
    {
      COCKPIT_PROC_RAIZ: procDeCodexParaPartC(), HOME: temporario('gate-menu-codex-home-'),
      COCKPIT_TMUX_SOCKET: 'gate-menu-codex-fake', COCKPIT_TMUX_SESSAO: 'main',
    },
    [],
    async (mod) => {
      const codigoDigitar = sliceFn('digitarNaAba');
      const abaCodex = {
        chave, agente: 'codex', temAgente: true, esperando: false, preSessao: false,
        pane: '%7', alvo: '@7', titulo: 'codex-teste', panePid: 10, agentePid: 11,
      };
      const chamadas = [];
      const ctx = {
        path, PASTA_ANEXOS: '/tmp', limpar: (x) => String(x || '').trim(),
        // As TRES do Enter confirmado (23/09): o recorte do `vm` nao enxerga nada fora de
        // `digitarNaAba`, entao sem elas o fatiado estoura `ReferenceError`. A caixa devolve
        // `null` ("nao sei ler") — este gate mede o menu do Codex, nao a conferencia do Enter.
        TENTATIVAS_DE_ENTER: abasDoEnter.TENTATIVAS_DE_ENTER,
        ESPERA_CONFIRMACAO: abasDoEnter.ESPERA_CONFIRMACAO,
        composerTemTexto: async () => null,

        buscar: async () => abaCodex,
        motivoDeRecusa: () => null,
        registrarPendente: (c, dados) => dados,
        esquecerPendente: () => {},
        espera: async () => {},
        autorizarEscrita: mod.autorizarEscrita,
        tmux: async (args) => { chamadas.push(args); return ''; },
        // `enterFalha` é o cenário "r": um erro GENÉRICO (não de autorização) no Enter do
        // `/compact` — a única coisa que ainda leva `jaColouCompact` a `true` sem passar
        // pela recusa de `autorizarEscrita` (armadilha #3: `tmux()` leniente nunca rejeita;
        // `tmuxDoStatus()` sim, e é o par texto+Enter que `/compact` usa).
        tmuxDoStatus: async (args) => {
          chamadas.push(args);
          if (enterFalha && args.includes('Enter')) {
            throw new Error('não consegui consultar o terminal; confira o terminal antes de tentar novamente');
          }
          return '';
        },
      };
      require('node:vm').runInNewContext(codigoDigitar, ctx);
      let rejeitou = null;
      try { await ctx.digitarNaAba(chave, texto); } catch (e) { rejeitou = e; }
      return { rejeitou, chamadas };
    },
    { capturaPane: (args, n) => sequenciaCaptura[n] ?? sequenciaCaptura.at(-1) ?? '' },
  );
}

grupo('Parte C — o contrato do colado, ponta a ponta (Fase 5, servidor de VERDADE)', async () => {
  // ── Andar 1: o motor real produz os `falha` — p, q e r ──────────────────────────────
  const p = await motorDigitarNaAbaPartC('aba-p', 'oi, tudo bem?', [TXT_MENU]);
  ok(Boolean(p.rejeitou), 'p (motor): autorização recusa ANTES da colagem — a promessa rejeita');
  ok(!('colado' in (p.rejeitou || {})), "p (motor): 'colado' in falha === false — nada saiu ainda");
  ok(p.chamadas.filter((a) => a.includes('-l')).length === 0 && p.chamadas.filter((a) => a.includes('Enter')).length === 0,
    `p (motor): ZERO send-keys (achei ${p.chamadas.length})`);

  const q = await motorDigitarNaAbaPartC('aba-q', 'oi, tudo bem?', [TXT_LIVRE, TXT_MENU]);
  ok(Boolean(q.rejeitou), 'q (motor): autorização recusa DEPOIS da colagem, antes do Enter');
  ok(q.rejeitou?.colado === true, 'q (motor): falha.colado === true');
  ok(q.chamadas.filter((a) => a.includes('-l')).length === 1 && q.chamadas.filter((a) => a.includes('Enter')).length === 0,
    `q (motor): 1 send-keys de texto, ZERO Enter (achei ${JSON.stringify(q.chamadas)})`);

  const r = await motorDigitarNaAbaPartC('aba-r', '/compact', [TXT_LIVRE, TXT_LIVRE], { enterFalha: true });
  ok(Boolean(r.rejeitou), 'r (motor): erro GENÉRICO (não de autorização) depois da colagem — a promessa rejeita');
  ok(r.rejeitou?.colado === true, 'r (motor): colado === true mesmo sem ser autorizarEscrita — a flag é do ESCOPO, não da autorização');

  // ── Andar 2: a rota HTTP de verdade — server.js por require em processo ─────────────
  // Ao contrário de `gate-jobs-rota.js`, um `COCKPIT_TMUX_SOCKET` herdado (o runner —
  // `bin/testes.js:13` — sempre define um) não é um risco aqui: `buscar`/`enviar`/
  // `consultarStatus` estão TODOS dublados abaixo, então nenhum tmux real (nem o do socket
  // herdado) chega a ser chamado por este andar. Abortar por causa dele seria proteção
  // contra um perigo que este teste não tem.
  const PORTA_PARTE_C = Number(process.env.COCKPIT_GATE_MENU_CODEX_PORTA || 7931);
  if (PORTA_PARTE_C === 7879 || PORTA_PARTE_C === 7899) {
    throw new Error(`porta ${PORTA_PARTE_C} proibida (produção ou jobs, #24) — abortando.`);
  }
  const jaOcupada = (() => {
    try {
      const saida = execSync(`ss -H -lptn 'sport = :${PORTA_PARTE_C}'`, { encoding: 'utf8' });
      return saida.trim().length > 0;
    } catch { return false; } // `ss` indisponível — o `listen()` denuncia se estiver ocupada
  })();
  if (jaOcupada) throw new Error(`porta ${PORTA_PARTE_C} já ocupada (conferido com ss -H -lptn) — tente outra.`);

  const path2 = (p2) => path.join(__dirname, '..', p2);
  const caminhoAbas = require.resolve(path2('lib/abas.js'));
  delete require.cache[caminhoAbas];   // require FRESCO, sem mock nenhum de execFile no ar
  const abasReal = require(caminhoAbas);

  const abasFalsas = new Map([
    ['aba-p2-p', { chave: 'aba-p2-p', agente: 'codex' }],
    ['aba-p2-q', { chave: 'aba-p2-q', agente: 'codex' }],
  ]);
  const respostasEnviar = new Map([
    ['aba-p', () => { throw p.rejeitou; }],
    ['aba-q', () => { throw q.rejeitou; }],
    ['aba-r', () => { throw r.rejeitou; }],
  ]);
  const respostasStatus = new Map([
    ['aba-p2-p', () => { throw p.rejeitou; }],
    ['aba-p2-q', () => { throw q.rejeitou; }],
  ]);
  const dubleAbas = {
    ...abasReal,
    buscar: async (chave) => abasFalsas.get(chave) || null,
    enviar: async (chave) => {
      const fn = respostasEnviar.get(chave);
      if (!fn) throw Object.assign(new Error('sem resposta configurada'), {});
      return fn();
    },
    consultarStatus: async (chave) => {
      const fn = respostasStatus.get(chave);
      if (!fn) throw Object.assign(new Error('sem resposta configurada'), {});
      return fn();
    },
  };
  require.cache[caminhoAbas] = { id: caminhoAbas, filename: caminhoAbas, loaded: true, exports: dubleAbas };

  const antesEnv = { ...process.env };
  process.env.PORT = String(PORTA_PARTE_C);
  process.env.HOST = '127.0.0.1';
  process.env.COCKPIT_CERT_DIR = '/dev/null';   // sem isto sobe TLS, e o teste fala HTTP puro
  process.env.COCKPIT_TOKEN = '';
  process.env.COCKPIT_JOBS_DIR = path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}-menu-codex-partec`);

  const criarServerOriginal = http.createServer;
  let servidor = null;
  http.createServer = (...args) => { servidor = criarServerOriginal(...args); return servidor; };
  try {
    require(path2('server.js'));
  } finally {
    http.createServer = criarServerOriginal;
  }
  if (!servidor.listening) await new Promise((res) => servidor.once('listening', res));

  function pedir(metodo, rota, corpo) {
    return new Promise((resolve, reject) => {
      const dados = corpo === undefined ? null : JSON.stringify(corpo);
      const req = http.request({
        host: '127.0.0.1', port: PORTA_PARTE_C, method: metodo, path: rota,
        headers: dados ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) } : {},
      }, (res) => {
        let bruto = '';
        res.on('data', (b) => { bruto += b; });
        res.on('end', () => {
          let parseado = null;
          try { parseado = bruto ? JSON.parse(bruto) : null; } catch { /* corpo não-JSON */ }
          resolve({ status: res.statusCode, corpo: parseado });
        });
      });
      req.on('error', reject);
      if (dados) req.write(dados);
      req.end();
    });
  }

  try {
    // p/q/r pela rota `/turnos` (`server.js:1143`).
    const rp = await pedir('POST', '/api/abas/aba-p/turnos', { texto: 'oi, tudo bem?' });
    ok(rp.status === 409, `p (rota /turnos): HTTP 409 (recebi ${rp.status})`);
    ok(rp.corpo && !('colado' in rp.corpo), "p (rota /turnos): o JSON NÃO tem a chave colado");

    const rq = await pedir('POST', '/api/abas/aba-q/turnos', { texto: 'oi, tudo bem?' });
    ok(rq.status === 409, `q (rota /turnos): HTTP 409 (recebi ${rq.status})`);
    ok(rq.corpo?.colado === true, 'q (rota /turnos): o JSON tem colado: true');

    const rr = await pedir('POST', '/api/abas/aba-r/turnos', { texto: '/compact' });
    ok(rr.status === 409, `r (rota /turnos): HTTP 409 (recebi ${rr.status})`);
    ok(rr.corpo?.colado === true, 'r (rota /turnos): colado: true mesmo com erro genérico — a flag é do escopo, não da autorização');

    // p2 — o MESMO marcador, pela rota `/api/abas/:chave/status` (`server.js:1068`), que NÃO
    // é a de `/turnos` e tem `catch` próprio. Os `falha` de p/q não carregam `.codigo`
    // (nasceram de `digitarNaAba`, não de `executarConsultaStatus`), então esta rota devolve
    // 500 (`erro.codigo || 500`) — não 409. A asserção confere o 500 de propósito, para não
    // fingir um código que este cenário não tem; o que importa aqui é só o `colado`.
    const rp2p = await pedir('POST', '/api/abas/aba-p2-p/status', {});
    ok(rp2p.status === 500, `p2/p (rota /status): HTTP 500 — sem .codigo, cai no genérico (recebi ${rp2p.status})`);
    ok(rp2p.corpo && !('colado' in rp2p.corpo), 'p2/p (rota /status): o JSON NÃO tem a chave colado — o marcador atravessa esta rota também');

    const rp2q = await pedir('POST', '/api/abas/aba-p2-q/status', {});
    ok(rp2q.status === 500, `p2/q (rota /status): HTTP 500 (recebi ${rp2q.status})`);
    ok(rp2q.corpo?.colado === true, 'p2/q (rota /status): o JSON tem colado: true — o marcador atravessa esta rota também');
  } finally {
    // Derruba o servidor deste gate — nada mais nasceu (D35): sem tmux real no ar
    // (COCKPIT_TMUX_SOCKET aponta para um socket que este servidor nunca chamou, já que
    // buscar/enviar/consultarStatus estão dublados).
    await new Promise((res) => servidor.close(() => res()));
    delete require.cache[caminhoAbas];
    for (const k of Object.keys(process.env)) if (!(k in antesEnv)) delete process.env[k];
    Object.assign(process.env, antesEnv);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  Execução
// ═════════════════════════════════════════════════════════════════════════════

(async () => {
  try {
    console.log('\n── Gate do menu aberto do Codex — offline, sem tmux, sem token ──');
    if (!menuCodex) {
      ok(false, "lib/menu-codex.js ainda não existe (require tolerante) — produto ausente, Fase 3 não chegou");
    }
    for (const { rotulo, fn } of grupos) {
      console.log(`\n  · ${rotulo}`);
      try {
        await fn();
      } catch (erro) {
        ok(false, `o grupo estourou — ${erro.stack || erro.message}`);
      }
    }
    console.log(`\n${tudoOk ? '✅ GATE VERDE — menu-codex' : '❌ GATE VERMELHO — menu-codex'}\n`);
    process.exit(tudoOk ? 0 : 1);
  } finally {
    for (const dir of paraApagar) fs.rmSync(dir, { recursive: true, force: true });
  }
})();
