#!/usr/bin/env node
'use strict';
// GATE de `confiarNaPasta()` (lib/abas.js) — card `trust-automatico-ao-criar-aba`.
//
// Offline: HOME de mentira em mkdtemp, nenhum tmux, nenhum turno da assinatura (#20). O que
// se prova aqui é o caminho PERIGOSO da função — ela escreve no `~/.claude.json`, que fora
// do teste é a configuração de todos os projetos do usuário.
//
//   node testes/gate-trust.js
//
// Inventário fechado — 8 casos: T1 confia, T2 idempotente, T3 formato estranho,
// T4 JSON corrompido, T5 sem arquivo, T6 preserva o resto, T7 modo 0600, T8 sem sobra de
// temporário, T9 a frase que avisa antes do clique.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ_REPO = path.resolve(__dirname, '..');
const LIB_ABAS = path.join(RAIZ_REPO, 'lib', 'abas.js');
const CASOS_ESPERADOS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'];

let passou = 0;
let total = 0;
let vermelho = false;
const CASOS = new Set();

function ok(condicao, mensagem) {
  total += 1;
  if (condicao) { passou += 1; console.log(`  ✅ ${mensagem}`); return true; }
  vermelho = true;
  console.log(`  ❌ ${mensagem}`);
  return false;
}
function titulo(t) {
  const m = /^(T\d+)\./.exec(t);
  if (m) CASOS.add(m[1]);
  console.log(`\n${t}`);
}
async function bloco(nome, fn) {
  titulo(nome);
  try { await fn(); } catch (e) {
    vermelho = true;
    console.log(`  ❌ o bloco estourou — ${e && e.message}`);
  }
}

// ─── o mundo de mentira ──────────────────────────────────────────────────────
//
// HOME entra no ambiente ANTES do require: `CONFIG_DO_CLI` é resolvido no topo do módulo.
// Cada caso recarrega `lib/abas.js` porque o caminho é constante de módulo — um HOME novo
// sem recarregar apontaria para o HOME do caso anterior.

const PASTA = '/home/quemquerque/projetos/exemplo';

function homeNovo() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-trust-home-'));
  process.env.HOME = home;
  delete require.cache[LIB_ABAS];
  return home;
}
function escrever(home, objeto, modo = 0o600) {
  const alvo = path.join(home, '.claude.json');
  fs.writeFileSync(alvo, JSON.stringify(objeto, null, 2), { mode: modo });
  fs.chmodSync(alvo, modo);
  return alvo;
}
function ler(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
}
/** Um `~/.claude.json` no formato de verdade: topo com lixo do CLI e `projects` com a chave. */
function configDeVerdade() {
  return {
    numStartups: 186,
    userID: 'abc',
    projects: {
      '/home/quemquerque/projetos/outro': {
        allowedTools: [],
        hasTrustDialogAccepted: true,
        lastCost: 1.23,
      },
    },
  };
}

(async () => {
  await bloco('T1. pasta nova ganha o trust', async () => {
    const home = homeNovo();
    escrever(home, configDeVerdade());
    const abas = require(LIB_ABAS);
    const confiou = await abas.confiarNaPasta(PASTA);
    ok(confiou === true, 'devolve true quando confiou agora');
    const depois = ler(home);
    ok(depois.projects[PASTA] && depois.projects[PASTA].hasTrustDialogAccepted === true,
      'a chave ficou gravada na pasta pedida');
    ok(depois.projects['/home/quemquerque/projetos/outro'].hasTrustDialogAccepted === true,
      'o outro projeto continua confiado');
  });

  await bloco('T2. já confiado NÃO reescreve o arquivo', async () => {
    const home = homeNovo();
    const cfg = configDeVerdade();
    cfg.projects[PASTA] = { hasTrustDialogAccepted: true };
    const alvo = escrever(home, cfg);
    const antes = fs.readFileSync(alvo, 'utf8');
    const abas = require(LIB_ABAS);
    const confiou = await abas.confiarNaPasta(PASTA);
    ok(confiou === false, 'devolve false — não confiou nada AGORA');
    ok(fs.readFileSync(alvo, 'utf8') === antes, 'o arquivo saiu byte a byte igual');
  });

  await bloco('T3. formato estranho: nenhum projeto tem a chave (#10)', async () => {
    const home = homeNovo();
    const alvo = escrever(home, { projects: { '/x': { allowedTools: [] } } });
    const antes = fs.readFileSync(alvo, 'utf8');
    const abas = require(LIB_ABAS);
    ok(await abas.confiarNaPasta(PASTA) === false, 'devolve false em vez de gravar no escuro');
    ok(fs.readFileSync(alvo, 'utf8') === antes, 'não tocou no arquivo');
  });

  await bloco('T4. JSON corrompido não vira arquivo pela metade', async () => {
    const home = homeNovo();
    const alvo = path.join(home, '.claude.json');
    fs.writeFileSync(alvo, '{"projects": {"/x": {"hasTrust', { mode: 0o600 });
    const antes = fs.readFileSync(alvo, 'utf8');
    const abas = require(LIB_ABAS);
    ok(await abas.confiarNaPasta(PASTA) === false, 'devolve false com JSON quebrado');
    ok(fs.readFileSync(alvo, 'utf8') === antes, 'deixou o arquivo exatamente como estava');
  });

  await bloco('T5. sem arquivo nenhum', async () => {
    homeNovo();
    const abas = require(LIB_ABAS);
    ok(await abas.confiarNaPasta(PASTA) === false, 'devolve false sem estourar');
  });

  await bloco('T6. preserva o topo e as outras chaves do projeto', async () => {
    const home = homeNovo();
    const cfg = configDeVerdade();
    cfg.projects[PASTA] = { allowedTools: ['Bash'], lastCost: 9.99, hasTrustDialogAccepted: false };
    escrever(home, cfg);
    const abas = require(LIB_ABAS);
    ok(await abas.confiarNaPasta(PASTA) === true, 'trust false vira true');
    const depois = ler(home);
    ok(depois.numStartups === 186 && depois.userID === 'abc', 'o topo do arquivo sobreviveu');
    ok(depois.projects[PASTA].lastCost === 9.99, 'lastCost do projeto sobreviveu');
    ok(Array.isArray(depois.projects[PASTA].allowedTools)
      && depois.projects[PASTA].allowedTools[0] === 'Bash', 'allowedTools sobreviveu');
  });

  await bloco('T7. o modo 0600 do original é preservado', async () => {
    const home = homeNovo();
    const alvo = escrever(home, configDeVerdade(), 0o600);
    const abas = require(LIB_ABAS);
    ok(await abas.confiarNaPasta(PASTA) === true, 'confiou');
    const modo = fs.statSync(alvo).mode & 0o777;
    ok(modo === 0o600, `o arquivo continua 0600 (veio ${modo.toString(8)}) — 0644 vazaria a config`);
  });

  await bloco('T8. não sobra temporário ao lado do alvo', async () => {
    const home = homeNovo();
    escrever(home, configDeVerdade());
    const abas = require(LIB_ABAS);
    await abas.confiarNaPasta(PASTA);
    const sobras = fs.readdirSync(home).filter((n) => n.startsWith('.claude.json.'));
    ok(sobras.length === 0, `nenhum temporário sobrou (achei ${sobras.join(', ') || 'nada'})`);
  });

  await bloco('T9. o diálogo avisa ANTES, e a criação devolve `confiou`', async () => {
    const html = fs.readFileSync(path.join(RAIZ_REPO, 'public', 'index.html'), 'utf8');
    const bloco = /<small class="config-nota" id="nota-trust-nova-aba">([\s\S]*?)<\/small>/.exec(html);
    ok(Boolean(bloco), 'a nota existe dentro do #dialogo-nova-aba');
    const texto = bloco ? bloco[1].replace(/\s+/g, ' ') : '';
    ok(/confi&aacute;vel para o agente/.test(texto),
      'a frase diz que a pasta vira confiável — o aviso chega antes do clique, não depois');
    // O contrato do módulo: `criar()` devolve o booleano, e NUNCA o caminho de disco (#22).
    const fonte = fs.readFileSync(LIB_ABAS, 'utf8');
    ok(/return \{ chave, titulo: String\(nome\), confiou \};/.test(fonte),
      'criar() devolve `confiou` como booleano, sem caminho de disco junto');
  });

  // ─── fechamento ────────────────────────────────────────────────────────────
  const faltando = CASOS_ESPERADOS.filter((c) => !CASOS.has(c));
  if (faltando.length) {
    vermelho = true;
    console.log(`\n❌ casos que NÃO rodaram: ${faltando.join(', ')}`);
  }
  console.log(`\n${passou}/${total} asserções · ${CASOS.size}/${CASOS_ESPERADOS.length} casos`);
  console.log(vermelho ? '\n❌ GATE VERMELHO' : '\n✅ GATE VERDE — confiarNaPasta()');
  process.exit(vermelho ? 1 : 0);
})();
