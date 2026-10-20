#!/usr/bin/env node
'use strict';
// GATE da régua `lib/menu-claude.js` (`classificarTela`) — offline, Node puro, sem tmux, sem
// porta. Card `mensagem-some-no-menu-do-auto-mode`, D85a. Spec:
// docs/superpowers/specs/2026-10-16-mensagem-some-no-menu-do-auto-mode-design.md
//
// Afirma o veredito de TODA fixture `.txt` (exceto `.ansi.txt`) de `testes/fixtures/menu-auto-mode/`
// E de `testes/fixtures/menu-claude/` (2.1.258) contra uma tabela declarada à mão — fixture nova
// sem veredito na tabela é vermelho (não passa calado), e entrada na tabela sem arquivo também.
// Mais um punhado de casos de borda inline, pelos sinais estruturais da D85a.

const fs = require('node:fs');
const path = require('node:path');
const { classificarTela } = require('../lib/menu-claude');

let tudoOk = true;
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) tudoOk = false; return c; };

// ── fixtures de testes/fixtures/menu-auto-mode/ — pelo NOME literal (a sintética também tem
//    "dialogo" no nome; não dá para distinguir por padrão) ──────────────────────────────────
const VEREDITOS_AUTO_MODE = {
  '2.1.280-dialogo-120x40': 'menu',
  '2.1.280-dialogo-60x30': 'menu',
  '2.1.295-dialogo-120x40': 'menu',
  '2.1.280-dialogo-com-sugestao-no-composer': 'menu',
  '2.1.280-dialogo-com-rascunho-do-dono': 'menu',
  '2.1.280-livre-com-conversa': 'livre',
  '2.1.280-livre-depois-do-esc': 'livre',
  '2.1.280-livre-rascunho-depois-de-um-esc': 'livre',
  '2.1.280-ocupado': 'livre',
  'sintetico-livre-com-dialogo-citado-na-conversa': 'livre',
  '2.1.280-assistente-depois-do-yes': 'desconhecido',
};

// ── fixtures de testes/fixtures/menu-claude/ (2.1.258) — nenhuma delas é diálogo do auto mode ─
const VEREDITOS_MENU_CLAUDE = {
  '2.1.258-02-livre': 'livre',
  '2.1.258-00-inicial': 'desconhecido',
  '2.1.258-01-confianca-down': 'desconhecido',
  '2.1.258-03-menu-model': 'desconhecido',
};

function conferirPasta(dir, tabela) {
  const arquivos = fs.readdirSync(dir).filter((n) => n.endsWith('.txt') && !n.endsWith('.ansi.txt'));
  const nomes = new Set(arquivos.map((n) => n.slice(0, -4)));
  for (const nome of nomes) {
    if (!(nome in tabela)) { ok(false, `fixture nova sem veredito declarado: ${nome}`); continue; }
  }
  for (const [nome, esperado] of Object.entries(tabela)) {
    if (!nomes.has(nome)) { ok(false, `veredito declarado sem arquivo: ${nome}`); continue; }
    const tela = fs.readFileSync(path.join(dir, `${nome}.txt`), 'utf8');
    const achado = classificarTela(tela);
    ok(achado === esperado, `${nome} → ${esperado} (achei ${achado})`);
  }
}

conferirPasta(path.join(__dirname, 'fixtures', 'menu-auto-mode'), VEREDITOS_AUTO_MODE);
conferirPasta(path.join(__dirname, 'fixtures', 'menu-claude'), VEREDITOS_MENU_CLAUDE);

// ── casos de borda inline ───────────────────────────────────────────────────────────────────
ok(classificarTela('') === 'desconhecido', "string vazia → desconhecido");
ok(classificarTela('❯ oi') === 'desconhecido', "❯ sem borda acima → desconhecido");
ok(classificarTela('─ texto\n❯ ') === 'desconhecido',
  "linha que só COMEÇA com ─ não é borda → desconhecido");
ok(classificarTela('────────\n  Titulo\n  Enter to confirm · Esc to cancel\n────────\n❯ ') === 'livre',
  "rodapé sem item marcado → livre");
ok(classificarTela('  ❯ 1. Yes\n  Enter to confirm · Esc to cancel\n────────\n❯ ') === 'livre',
  "item marcado sem borda de cima → livre");
ok(classificarTela('────────\n  ❯ 1. Yes\n    2. No\n  Enter to confirm · Esc to cancel\n────────\n❯ ') === 'menu',
  "os três sinais juntos → menu");

console.log(tudoOk ? '✅ gate-menu-claude-dialogo: todas as fixtures e casos de borda bateram' : '❌ gate-menu-claude-dialogo: falhou');
process.exit(tudoOk ? 0 : 1);
