#!/usr/bin/env node
'use strict';
// GATE DO NOME POR PAINEL (card `nome-por-painel`, D66) — o ✎ de uma aba de janela DIVIDIDA muda
// só aquele painel.
//
// O pedido do dono (07/10/2026): "quando eu renomeio uma aba e tenho duas abas [numa janela com
// dois painéis], ele renomeia as duas". Era a armadilha #67: a chave é por PANE, o `rename-window`
// age na JANELA. Agora a janela dividida grava `@cockpit-nome` na pane (opção de pane do tmux) e o
// título da aba prefere essa opção; janela de 1 pane segue `rename-window`.
//
// Por que existe além do `smoke-abas-tmux.js`: o smoke não está no `npm test` (depende de `claude`
// real no bloco B e roda à mão). Gate que não roda no npm test não é gate, é documentação.
//
// Sem servidor e sem `/proc` falso: `lib/abas` em PROCESSO, tmux REAL em socket isolado (`-L`) e
// HOME falso. A pane-agente roda `bash -c 'exec -a claude sleep 600'` — o argv[0] é `claude` e o
// `detectarAgente()` casa no `/proc` real. Nunca o socket padrão do dono.
//
// Uso:  node testes/gate-nome-por-painel.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let falhas = 0;
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) falhas += 1; return c; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const SOCKET = `cockpit-smoke-nome-${process.pid}`;
const SESSAO = 'teste';
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
const MINHAS_SESSOES = new Set(['ancora', SESSAO]);

// Herdado fora de ^cockpit-(smoke|offline)- aborta (o npm test herda cockpit-offline-<pid>).
const herdado = process.env.COCKPIT_TMUX_SOCKET || '';
if (herdado && !/^cockpit-(smoke|offline)-/.test(herdado)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${herdado}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

// `-f /dev/null` em TODO comando: é opção do CLIENTE tmux, vem antes do subcomando, e só pesa no que
// inicia o servidor — sem ele o ~/.tmux.conf do dono roda o continuum-restore no socket de teste.
const t = (args, { tolerante = false } = {}) => {
  try {
    return execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
};
if (t(['ls'], { tolerante: true }).trim()) {
  console.error(`🔴 o socket ${SOCKET} JÁ EXISTE — não é meu. Abortando.`);
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-nome-por-painel-'));
// A ORDEM importa: `lib/abas` lê estas env no require.
process.env.HOME = path.join(scratch, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
process.env.COCKPIT_TMUX_SOCKET = SOCKET;
process.env.COCKPIT_TMUX_SESSAO = SESSAO;
// SÓ DEPOIS:
const abas = require('../lib/abas');

function limpar() {
  // Fail-closed (D35): o carimbo prova que EU criei o socket; a enumeração prova que não há
  // mais ninguém nele. Matar exige as duas respostas.
  const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
    .split('\n').some((n) => n.trim() === CARIMBO);
  const sessoesAgora = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
    .split('\n').map((n) => n.trim()).filter(Boolean);
  const intrusas = sessoesAgora.filter((n) => !MINHAS_SESSOES.has(n));
  let limpo = true;
  if (temCarimbo && !intrusas.length) {
    t(['kill-server'], { tolerante: true });
  } else if (temCarimbo) {
    for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
    limpo = false;
    console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
  } else {
    limpo = false;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  // O tmux não apaga o arquivo do socket no `kill-server`; só o meu, só se o servidor morreu.
  if (limpo && !t(['ls'], { tolerante: true }).trim()) {
    fs.rmSync(path.join(os.tmpdir(), `tmux-${os.userInfo().uid}`, SOCKET), { force: true });
  }
  return limpo;
}

// argv[0] = claude ⇒ `detectarAgente()` casa e a pane vira ABA.
const AGENTE = "bash -c 'exec -a claude sleep 600'";
const SEM_AGENTE = 'sleep 600';
const novaJanela = (nome, cmd) => t(['new-window', '-d', '-t', `${SESSAO}:`, '-n', nome, '-P', '-F', '#{window_id}', cmd]).trim();
const dividir = (janela, cmd) => t(['split-window', '-d', '-t', janela, '-P', '-F', '#{pane_id}', cmd]).trim();
const panesDe = (janela) => t(['list-panes', '-t', janela, '-F', '#{pane_id}']).split('\n').map((l) => l.trim()).filter(Boolean);
const opcao = (pane) => t(['display-message', '-p', '-t', pane, '#{@cockpit-nome}']).replace(/\n$/, '');
const nomeDaJanela = (janela) => t(['display-message', '-p', '-t', janela, '#{window_name}']).replace(/\n$/, '');
const chaveDaPane = (pane) => abas.chaveDaAba({ paneId: pane });
const tituloNaLista = async (chave) => ((await abas.listar()).find((a) => a.chave === chave) || {}).titulo;
const codigoDe = (p) => p.then(() => null, (e) => e.codigo ?? `sem-codigo:${e.message}`);

const janelasDeTeste = () => t(['list-windows', '-t', `${SESSAO}:`, '-F', '#{window_id}\t#{window_name}'], { tolerante: true })
  .split('\n').map((l) => l.split('\t')).filter(([id]) => id && id.trim());
/** Deixa a sessão `teste` só com a janela de ancoragem. Nenhum caso herda estado do anterior. */
function soAncora() {
  for (const [id, nome] of janelasDeTeste()) if (nome !== 'ancora-teste') t(['kill-window', '-t', id], { tolerante: true });
}

// Os 33 nomes hostis — cópia da lista de `testes/smoke-abas-tmux.js` (NOMES_HOSTIS, bloco r3):
// cada um tem de sair do tmux IGUAL ao digitado (aparado, que é o que `renomear()` grava).
const NOMES_HOSTIS = [
  'a#;', 'x;', ';', ';;', 'a;b;', '#', '##', '###', '#{session_name}', '#(id)', '##{x}',
  '#[fg=red]x', '##[x]', 'a #[b', 'Bug #12', 'a;b', '-k', '--', '100%', 'ação ✓ 日本 🚀', "it's",
  '"q"', '$(id)', '`id`', '  meio  espaço  ', '%1', '-t %0', '#W', '#S #I', '{}', ',', '#,', '#}',
];
// O condicional `#{?…}` do tmux trata "0" como falso (armadilha #88): num array à parte para ficar
// claro que o `0` é um caso próprio, não um nome hostil de expansão.
const NOMES_DA_OPCAO = [...NOMES_HOSTIS, '0'];

/** Janela dividida com DUAS panes-agente; devolve a janela, [cima, baixo] e as duas chaves. */
async function janelaDividida(nome) {
  const janela = novaJanela(nome, AGENTE);
  dividir(janela, AGENTE);
  await espera(300); // o `exec` tem de acontecer antes de o /proc ser lido
  const [cima, baixo] = panesDe(janela);
  return { janela, cima, baixo, chaveCima: chaveDaPane(cima), chaveBaixo: chaveDaPane(baixo) };
}

async function main() {
  // O servidor tmux nasce com a âncora carimbada; depois a sessão das abas, com uma janela que não é testada.
  t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, 'sleep', '600']);
  t(['new-session', '-d', '-s', SESSAO, '-n', 'ancora-teste', 'sleep', '600']);

  console.log('G0 pré-condição — a janela dividida vira DUAS abas');
  let prontoParaOResto = false;
  {
    soAncora();
    const d = await janelaDividida('dividida');
    const lista = await abas.listar();
    prontoParaOResto = ok(lista.some((a) => a.chave === d.chaveCima) && lista.some((a) => a.chave === d.chaveBaixo),
      'a janela dividida virou duas abas aba-p<n>');
    if (!prontoParaOResto) ok(false, 'a janela dividida não virou duas abas — o resto do gate não prova nada');
  }

  if (prontoParaOResto) {
    console.log('G1 janela dividida — o ✎ da de baixo muda SÓ ela');
    {
      soAncora();
      const d = await janelaDividida('dividida');
      const r = await abas.renomear(d.chaveBaixo, 'só a de baixo');
      ok(r && r.chave === d.chaveBaixo && r.titulo === 'só a de baixo', `devolve { chave, titulo } — veio ${JSON.stringify(r)}`);
      ok(opcao(d.baixo) === 'só a de baixo', `opção da de baixo = "só a de baixo" — veio "${opcao(d.baixo)}"`);
      ok(opcao(d.cima) === '', `opção da de cima vazia — veio "${opcao(d.cima)}"`);
      ok(nomeDaJanela(d.janela) === 'dividida', `a janela continua "dividida" — veio "${nomeDaJanela(d.janela)}"`);
      const tb = await tituloNaLista(d.chaveBaixo);
      const tc = await tituloNaLista(d.chaveCima);
      ok(tb === 'só a de baixo', `lista: título da de baixo = "só a de baixo" — veio "${tb}"`);
      ok(tc === 'dividida', `lista: título da de cima = "dividida" — veio "${tc}"`);
    }

    console.log(`G2 ${NOMES_DA_OPCAO.length} nomes (33 hostis + "0") pela opção`);
    {
      soAncora();
      const d = await janelaDividida('dividida');
      const errados = [];
      for (const nome of NOMES_DA_OPCAO) {
        let motivo = null;
        try {
          await abas.renomear(d.chaveBaixo, nome);
          const esperado = nome.trim();
          const naOpcao = opcao(d.baixo);
          const naLista = await tituloNaLista(d.chaveBaixo);
          if (naOpcao !== esperado) motivo = `opção "${naOpcao}"`;
          else if (naLista !== esperado) motivo = `lista "${naLista}"`;
        } catch (e) {
          motivo = `lançou ${e.codigo ?? ''} ${e.message}`;
        }
        if (motivo) errados.push(`${JSON.stringify(nome)} → ${motivo}`);
      }
      ok(errados.length === 0, errados.length ? `nomes errados: ${errados.join(' | ')}` : `os ${NOMES_DA_OPCAO.length} nomes saem literais na opção e no título`);
      ok(nomeDaJanela(d.janela) === 'dividida', `depois de ${NOMES_DA_OPCAO.length} renomes a janela continua "dividida" — veio "${nomeDaJanela(d.janela)}"`);
    }

    console.log('G3 janela de 1 pane segue rename-window');
    {
      soAncora();
      const janela = novaJanela('sozinha', AGENTE);
      await espera(300);
      const [pane] = panesDe(janela);
      const chave = chaveDaPane(pane);
      await abas.renomear(chave, 'nome novo');
      ok(nomeDaJanela(janela) === 'nome novo', `janela = "nome novo" — veio "${nomeDaJanela(janela)}"`);
      ok(opcao(pane) === '', `a pane fica sem a opção — veio "${opcao(pane)}"`);
      const tl = await tituloNaLista(chave);
      ok(tl === 'nome novo', `lista = "nome novo" — veio "${tl}"`);
    }

    console.log('G4 borda S3 — a irmã fecha, o nome da pane fica, o próximo ✎ renomeia a janela');
    {
      soAncora();
      const d = await janelaDividida('antes-da-borda');
      await abas.renomear(d.chaveBaixo, 'nome da pane');
      // Sem estes dois o G4 passaria no mundo velho, que renomeia a janela.
      ok(opcao(d.baixo) === 'nome da pane', `opção da de baixo = "nome da pane" — veio "${opcao(d.baixo)}"`);
      ok(nomeDaJanela(d.janela) === 'antes-da-borda', `a janela continua "antes-da-borda" — veio "${nomeDaJanela(d.janela)}"`);
      t(['kill-pane', '-t', d.cima]);
      await espera(200);
      const t1 = await tituloNaLista(d.chaveBaixo);
      ok(t1 === 'nome da pane', `a irmã fechou e o nome escolhido não some — veio "${t1}"`);
      await abas.renomear(d.chaveBaixo, 'nome depois');
      ok(nomeDaJanela(d.janela) === 'nome depois', `janela = "nome depois" — veio "${nomeDaJanela(d.janela)}"`);
      ok(opcao(d.baixo) === '', `a opção foi apagada — veio "${opcao(d.baixo)}"`);
      const t2 = await tituloNaLista(d.chaveBaixo);
      ok(t2 === 'nome depois', `lista = "nome depois" — veio "${t2}"`);
    }

    console.log('G5 S2 — aba de JANELA (sem agente, 2 panes) segue sendo a janela');
    {
      soAncora();
      const janela = novaJanela('sem-agente', SEM_AGENTE);
      dividir(janela, SEM_AGENTE);
      const [cima, baixo] = panesDe(janela);
      // Nas DUAS: a aba de janela usa `janela.panes[0]` (lib/abas.js:561); só na de baixo o teste
      // passaria verde mesmo sem a guarda `!pane.comoJanela`.
      for (const p of [cima, baixo]) t(['set-option', '-p', '-t', p, '--', '@cockpit-nome', 'gravado à mão']);
      const chave = abas.chaveDaAba({ janelaId: janela });
      const lista = await abas.listar();
      const daJanela = lista.filter((a) => a.chave === chave);
      ok(daJanela.length === 1, `UMA aba de janela ${chave} — vieram ${daJanela.length}`);
      ok(daJanela[0] && daJanela[0].titulo === 'sem-agente', `título = "sem-agente" (ignora a opção) — veio "${daJanela[0] && daJanela[0].titulo}"`);
      await abas.renomear(chave, 'janela renomeada');
      ok(nomeDaJanela(janela) === 'janela renomeada', `janela = "janela renomeada" — veio "${nomeDaJanela(janela)}"`);
      ok(opcao(baixo) === 'gravado à mão', `opção de baixo intacta — veio "${opcao(baixo)}"`);
      ok(opcao(cima) === 'gravado à mão', `opção de cima intacta — veio "${opcao(cima)}"`);
    }

    console.log('G6 chave de janela forjada numa janela de 1 pane');
    {
      soAncora();
      const janela = novaJanela('forjada', SEM_AGENTE);
      const [pane] = panesDe(janela);
      t(['set-option', '-p', '-t', pane, '--', '@cockpit-nome', 'escondido']);
      await abas.renomear(abas.chaveDaAba({ janelaId: janela }), 'visivel');
      ok(nomeDaJanela(janela) === 'visivel', `janela = "visivel" — veio "${nomeDaJanela(janela)}"`);
      ok(opcao(pane) === '', `a opção foi apagada — veio "${opcao(pane)}"`);
      const tl = await tituloNaLista(chaveDaPane(pane));
      ok(tl === 'visivel', `lista (chave de pane) = "visivel" — veio "${tl}"`);
    }

    console.log('G9 S5 — o caminho de 2+ panes não toca a janela (nem o automatic-rename)');
    {
      soAncora();
      const janela = t(['new-window', '-d', '-t', `${SESSAO}:`, '-P', '-F', '#{window_id}', AGENTE]).trim();
      dividir(janela, AGENTE);
      t(['set-option', '-w', '-t', janela, 'automatic-rename', 'on']);
      await espera(300);
      const [, baixo] = panesDe(janela);
      const chave = chaveDaPane(baixo);
      await abas.renomear(chave, 'nome fixo');
      ok(opcao(baixo) === 'nome fixo', `opção = "nome fixo" — veio "${opcao(baixo)}"`);
      const tl = await tituloNaLista(chave);
      ok(tl === 'nome fixo', `lista = "nome fixo" — veio "${tl}"`);
      const auto = t(['display-message', '-p', '-t', janela, '#{automatic-rename}']).trim();
      ok(auto === '1', `automatic-rename continua ligado — veio "${auto}"`);
    }

    console.log('G7 as recusas não mudaram');
    {
      soAncora();
      const d = await janelaDividida('dividida');
      const antes = nomeDaJanela(d.janela);
      const codigo = await codigoDe(abas.renomear(d.chaveBaixo, '   '));
      ok(codigo === 400, `nome em branco → 400 — veio ${codigo}`);
      ok(opcao(d.baixo) === '', `a opção não mudou — veio "${opcao(d.baixo)}"`);
      ok(nomeDaJanela(d.janela) === antes, `a janela não mudou — veio "${nomeDaJanela(d.janela)}"`);
    }
  }

  console.log('G2b a função pura nomeParaOpcaoDoTmux');
  if (typeof abas.nomeParaOpcaoDoTmux !== 'function') {
    ok(false, 'nomeParaOpcaoDoTmux não existe');
  } else {
    const f = abas.nomeParaOpcaoDoTmux;
    ok(f('x;') === 'x\\;', `'x;' → ${JSON.stringify(f('x;'))}`);
    ok(f(';') === '\\;', `';' → ${JSON.stringify(f(';'))}`);
    ok(f('#{session_name}') === '#{session_name}', `o # NÃO dobra — ${JSON.stringify(f('#{session_name}'))}`);
    ok(f('a;b') === 'a;b', `'a;b' → ${JSON.stringify(f('a;b'))}`);
  }

  console.log('G8 entrou na bateria do npm test');
  ok(fs.readFileSync(path.join(__dirname, '..', 'bin', 'testes.js'), 'utf8').includes("'gate-nome-por-painel.js'"),
    "bin/testes.js cita 'gate-nome-por-painel.js'");
}

(async () => {
  try {
    await main();
  } catch (e) {
    ok(false, `o gate quebrou: ${e && e.stack || e}`);
  } finally {
    if (!limpar()) { console.error('  ❌ limpeza incompleta'); falhas += 1; }
  }
  console.log(falhas ? '\n❌ GATE VERMELHO' : '\n✅ GATE VERDE');
  process.exit(falhas ? 1 : 0);
})();
