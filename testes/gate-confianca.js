#!/usr/bin/env node
'use strict';
// GATE de `lib/confianca.js` — card `responder-confianca-do-cli-pelo-celular` (spec 2026-10-13, §4.1).
//
// Offline: HOME e CODEX_HOME de mentira em mkdtemp, nenhum tmux, nenhum CLI. O que se prova: a regra que o
// cockpit usa para dizer "esta pasta ainda não é confiável" é a mesma que os CLIs aplicam (medida no §2 da spec),
// e que na dúvida a resposta é `null` (não afirmar nada).
//
//   node testes/gate-confianca.js
//
// Inventário fechado: C1..C6 (Claude), X1..X7 (Codex), G1..G3 (cache, agente e cwd inválidos),
// M1..M4 (as frases de recusa com e sem `pedeConfianca`).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ_REPO = path.resolve(__dirname, '..');
const confianca = require(path.join(RAIZ_REPO, 'lib', 'confianca.js'));
const CASOS_ESPERADOS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'G1', 'G2', 'G3', 'M1', 'M2', 'M3', 'M4'];

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
function bloco(nome, fn) {
  const m = /^([A-Z]\d+)\./.exec(nome);
  if (m) CASOS.add(m[1]);
  console.log(`\n${nome}`);
  try { fn(); } catch (e) {
    vermelho = true;
    console.log(`  ❌ o bloco estourou — ${e && e.message}`);
  }
}

const HOME_ORIGINAL = process.env.HOME;
const CODEX_ORIGINAL = process.env.CODEX_HOME;

/** Um mundo novo: HOME e CODEX_HOME trocados juntos, cache limpo. */
function mundo() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-confianca-'));
  process.env.HOME = home;
  process.env.CODEX_HOME = path.join(home, '.codex');
  confianca.limparCache();
  return home;
}
const claudeJson = (home, projects) => fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects }));
const codexToml = (home, texto) => {
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), texto);
};
const tabela = (pasta, nivel = 'trusted') => `[projects."${pasta}"]\ntrust_level = "${nivel}"\n`;

const PASTA = '/home/quemquerque/projetos/exemplo';
const OUTRA = '/home/quemquerque/projetos/outro';

// ─── Claude ──────────────────────────────────────────────────────────────────

bloco('C1. pasta exata confiada → confiada', () => {
  const home = mundo();
  claudeJson(home, { [PASTA]: { hasTrustDialogAccepted: true } });
  ok(confianca.estadoDaPasta('claude', PASTA) === 'confiada', 'confiada');
});

bloco('C2. ancestral confiado → confiada (herança medida)', () => {
  const home = mundo();
  claudeJson(home, { '/home/quemquerque/projetos': { hasTrustDialogAccepted: true } });
  ok(confianca.estadoDaPasta('claude', `${PASTA}/sub/fundo`) === 'confiada', 'confiada pelo ancestral');
});

bloco('C3. sem entrada para a pasta nem ancestral → nao-confiada', () => {
  const home = mundo();
  claudeJson(home, { [OUTRA]: { hasTrustDialogAccepted: true } });
  ok(confianca.estadoDaPasta('claude', PASTA) === 'nao-confiada', 'nao-confiada');
});

bloco('C4. nenhum projeto com a chave (formato desconhecido) → null', () => {
  const home = mundo();
  claudeJson(home, { [OUTRA]: { allowedTools: [] } });
  ok(confianca.estadoDaPasta('claude', PASTA) === null, 'null');
});

bloco('C5. JSON inválido → null', () => {
  const home = mundo();
  fs.writeFileSync(path.join(home, '.claude.json'), '{ "projects": ');
  ok(confianca.estadoDaPasta('claude', PASTA) === null, 'null');
});

bloco('C6. sem arquivo → null', () => {
  mundo();
  ok(confianca.estadoDaPasta('claude', PASTA) === null, 'null');
});

// ─── Codex ───────────────────────────────────────────────────────────────────

bloco('X1. sem config.toml → nao-confiada (o Codex pergunta)', () => {
  mundo();
  ok(confianca.estadoDaPasta('codex', PASTA) === 'nao-confiada', 'nao-confiada');
});

bloco('X2. entrada exata trusted → confiada', () => {
  const home = mundo();
  codexToml(home, tabela(OUTRA) + '\n' + tabela(PASTA));
  ok(confianca.estadoDaPasta('codex', PASTA) === 'confiada', 'confiada');
});

bloco('X3. raiz git trusted e cwd numa subpasta → confiada', () => {
  const home = mundo();
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  codexToml(home, tabela(repo));
  ok(confianca.estadoDaPasta('codex', path.join(repo, 'sub')) === 'confiada', 'confiada pela raiz git');
});

bloco('X4. pai SEM .git trusted, cwd = filho → nao-confiada (o Codex não herda)', () => {
  const home = mundo();
  const pai = path.join(home, 'pai');
  fs.mkdirSync(path.join(pai, 'filho'), { recursive: true });
  codexToml(home, tabela(pai));
  ok(confianca.estadoDaPasta('codex', path.join(pai, 'filho')) === 'nao-confiada', 'nao-confiada');
});

bloco('X5. trust_level = "untrusted" → null', () => {
  const home = mundo();
  codexToml(home, tabela(PASTA, 'untrusted'));
  ok(confianca.estadoDaPasta('codex', PASTA) === null, 'null');
});

bloco('X6. tabela inline citando a pasta → null (formato não lido não vira afirmação)', () => {
  const home = mundo();
  codexToml(home, `projects = { "${PASTA}" = { trust_level = "trusted" } }\n`);
  ok(confianca.estadoDaPasta('codex', PASTA) === null, 'null');
});

bloco('X7. cabeçalho com aspas simples → confiada', () => {
  const home = mundo();
  codexToml(home, `[projects.'${PASTA}']\ntrust_level = "trusted"\n`);
  ok(confianca.estadoDaPasta('codex', PASTA) === 'confiada', 'confiada');
});

// ─── Cache, agente e cwd ─────────────────────────────────────────────────────

bloco('G1. cache: arquivo reescrito (mtime novo) muda a resposta', () => {
  const home = mundo();
  const arq = path.join(home, '.claude.json');
  claudeJson(home, { [PASTA]: { hasTrustDialogAccepted: true } });
  ok(confianca.estadoDaPasta('claude', PASTA) === 'confiada', 'primeira leitura: confiada');
  claudeJson(home, { [OUTRA]: { hasTrustDialogAccepted: true } });
  const futuro = new Date(Date.now() + 5000);
  fs.utimesSync(arq, futuro, futuro);
  ok(confianca.estadoDaPasta('claude', PASTA) === 'nao-confiada', 'depois da reescrita: nao-confiada');
});

bloco('G2. agente fora de claude/codex → null', () => {
  const home = mundo();
  claudeJson(home, { [PASTA]: { hasTrustDialogAccepted: true } });
  ok(confianca.estadoDaPasta('job', PASTA) === null, 'job → null');
  ok(confianca.estadoDaPasta(undefined, PASTA) === null, 'undefined → null');
});

bloco('G3. cwd relativo, vazio ou não-string → null', () => {
  const home = mundo();
  claudeJson(home, { [PASTA]: { hasTrustDialogAccepted: true } });
  ok(confianca.estadoDaPasta('claude', 'projetos/exemplo') === null, 'relativo → null');
  ok(confianca.estadoDaPasta('claude', '') === null, 'vazio → null');
  ok(confianca.estadoDaPasta('codex', null) === null, 'null → null');
});

// ─── As frases de recusa (lib/abas.js) ───────────────────────────────────────

const abas = require(path.join(RAIZ_REPO, 'lib', 'abas.js'));
const HOJE = 'o agente desta aba está pedindo uma confirmação no terminal; responda pelas setas antes de escrever';
const NOVA = (rotulo) => `esta pasta ainda não é confiável para o ${rotulo}; responda pelas setas o que ele está perguntando antes de escrever`;
const aba = (pedeConfianca) => ({ temAgente: true, agente: 'codex', titulo: 'x', preSessao: true, pedeConfianca, pane: '%1' });

bloco('M1. motivoDeRecusa com pedeConfianca → frase nova com o rótulo do agente', () => {
  ok(abas.motivoDeRecusa(aba(true)) === NOVA('Codex CLI'), 'diz "não é confiável para o Codex CLI"');
});

bloco('M2. motivoDeRecusa sem pedeConfianca → a frase de hoje, byte a byte', () => {
  ok(abas.motivoDeRecusa(aba(false)) === HOJE, 'texto de hoje intacto');
});

bloco('M3. motivoDeRecusaDeStatus com pedeConfianca → 409 e frase nova', () => {
  const r = abas.motivoDeRecusaDeStatus(aba(true));
  ok(r.codigo === 409 && r.mensagem === NOVA('Codex CLI'), `409 + frase nova (${r.codigo})`);
});

bloco('M4. motivoDeRecusaDeStatus sem pedeConfianca → 409 e a frase de hoje', () => {
  const r = abas.motivoDeRecusaDeStatus(aba(false));
  ok(r.codigo === 409 && r.mensagem === HOJE, `409 + texto de hoje (${r.codigo})`);
});

// ─── fechamento ──────────────────────────────────────────────────────────────

if (HOME_ORIGINAL === undefined) delete process.env.HOME; else process.env.HOME = HOME_ORIGINAL;
if (CODEX_ORIGINAL === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = CODEX_ORIGINAL;
const faltando = CASOS_ESPERADOS.filter((c) => !CASOS.has(c));
if (faltando.length) {
  vermelho = true;
  console.log(`\n❌ casos que NÃO rodaram: ${faltando.join(', ')}`);
}
console.log(`\n${passou}/${total} asserções · ${CASOS.size}/${CASOS_ESPERADOS.length} casos`);
console.log(vermelho ? '\n❌ GATE VERMELHO' : '\n✅ GATE VERDE — lib/confianca.js');
process.exit(vermelho ? 1 : 0);
