'use strict';
// Executa o envio real com fronteiras dubladas: não toca no tmux do usuário.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
// O módulo REAL, só para as constantes do contexto do `vm` — o valor sai de lá, não é
// retipado aqui (mesmo padrão de `gate-gesto-escape.js` com `RECUSA_PERGUNTA`).
const abasReal = require('../lib/abas');
const fonte = fs.readFileSync(path.join(__dirname, '../lib/abas.js'), 'utf8');
const inicio = fonte.indexOf('async function digitarNaAba(');
const codigo = fonte.slice(inicio, fonte.indexOf('\n}\n', inicio) + 2);
(async () => {
  for (const [agente, texto, esperado] of [
    ['codex', '$handoff', '$handoff '],
    ['codex', '$handoff ', '$handoff '],
    ['codex', '$handoff Teste', '$handoff Teste'],
    ['codex', 'Use $handoff', 'Use $handoff '],
    ['codex', '/compact', '/compact'],
    ['claude', '$handoff', '$handoff'],
    ['claude', '/handoff', '/handoff'],
    // F8 da spec (card escrever-texto-na-pergunta-aberta): bracketed paste no Claude,
    // medido no composer LIVRE, com acento e quebra de linha — o caso de 99% do uso.
    ['claude', 'primeira linha\nsegunda linha com acento ção', 'primeira linha\nsegunda linha com acento ção'],
  ]) {
    const chamadas = [];
    const contexto = { path, PASTA_ANEXOS: '/tmp', limpar: x => x,
      buscar: async () => ({ agente, pane: '%7', alvo: '@7', titulo: 'teste', panePid: 7, processoCodex: { pid: 7 } }),
      motivoDeRecusa: () => null, registrarPendente: (chave, dados) => dados,
      esquecerPendente: () => {}, espera: async () => {}, tmux: async args => chamadas.push(args), tmuxDoStatus: async args => chamadas.push(args),
      // O produto ainda não chama `autorizarEscrita()` (Fase 4, card menu-da-tui-do-codex-na-tela)
      // — este duble PERMISSIVO só evita que a Fase 4 quebre este gate com `ReferenceError` no
      // dia em que `digitarNaAba` passar a chamá-la. Vale para os DOIS agentes (`gate-envio-skill-codex.js`
      // tem casos de Claude também, `:17-18`).
      autorizarEscrita: async () => null, detectarAgente: async () => ({ agente, pid: 7 }),
      // As TRÊS do card escrever-texto-na-pergunta-aberta. Elas entram aqui mesmo nenhuma
      // fixture deste gate tendo `esperando: true` hoje — é a #53 em pessoa: o `vm` só
      // enxerga o RECORTE de `digitarNaAba`, então uma referência fora dele vira
      // `ReferenceError` no dia em que alguém acrescentar a primeira fixture com pergunta
      // aberta. Sem estas linhas o gate fica verde por acidente, e quebra por surpresa.
      estadoDoMenu: async () => 'livre', mesmaIdentidade: async () => null,
      RECUSA_PERGUNTA: 'o terminal está com uma pergunta aberta; responda pelas setas antes de escrever',
      // As TRÊS do Enter confirmado (23/09), pela MESMA razão da nota acima: o recorte do
      // `vm` não enxerga nada fora de `digitarNaAba`. A caixa devolve `null` ("não sei
      // ler") para este gate continuar medindo o que ele mede — UM Enter por envio.
      TENTATIVAS_DE_ENTER: abasReal.TENTATIVAS_DE_ENTER,
      ESPERA_CONFIRMACAO: abasReal.ESPERA_CONFIRMACAO,
      composerTemTexto: async () => null };
    vm.runInNewContext(codigo, contexto);
    const r = await contexto.digitarNaAba('aba-p7', texto);
    assert.equal(chamadas.length, 2, 'um envio literal e um único Enter');
    const nativo = agente === 'codex' && texto === '/compact';
    // Delimitado para os DOIS agentes (Fase 4, card escrever-texto-na-pergunta-aberta) —
    // menos o par texto+Enter dos comandos NATIVOS do Codex, que tem caminho próprio.
    assert.equal(chamadas[0].at(-1), !nativo
      ? `\x1b[200~${esperado}\x1b[201~` : esperado);
    assert.equal(chamadas[0][2], '%7');
    assert.equal(chamadas[1].at(-1), 'Enter');
    if (agente === 'codex' && texto === '/compact') {
      assert.equal(r.ficha, undefined, 'comando nativo não cria pendente');
      assert.equal(r.comando, texto);
      continue;
    }
    assert.equal(r.ficha.texto, texto.trim(), 'a bolha e a deduplicação mantêm o texto original');
    assert.equal(r.ficha.mensagem, texto.trim());
  }

  // `autorizarEscrita: async () => 'recusa'` — o caso que só passa a valer na Fase 4 (card
  // menu-da-tui-do-codex-na-tela): com ela recusando, ZERO `send-keys` saem, no envio normal
  // e no /compact. Sem este caso, a proteção do preflight ficaria sem prova aqui.
  for (const [agente, texto] of [['codex', 'oi, tudo bem?'], ['codex', '/compact']]) {
    const chamadas = [];
    const contexto = { path, PASTA_ANEXOS: '/tmp', limpar: x => x,
      buscar: async () => ({ agente, pane: '%7', alvo: '@7', titulo: 'teste', panePid: 7, processoCodex: { pid: 7 } }),
      motivoDeRecusa: () => null, registrarPendente: (chave, dados) => dados,
      esquecerPendente: () => {}, espera: async () => {}, tmux: async args => chamadas.push(args), tmuxDoStatus: async args => chamadas.push(args),
      autorizarEscrita: async () => 'recusa', detectarAgente: async () => ({ agente, pid: 7 }) };
    vm.runInNewContext(codigo, contexto);
    await assert.rejects(contexto.digitarNaAba('aba-p7', texto), /recusa/, `${texto}: rejeita`);
    assert.equal(chamadas.length, 0, `${texto}: autorizarEscrita recusando ⇒ ZERO send-keys (achei ${chamadas.length})`);
  }
  console.log('GATE VERDE — envio de skill Codex: 8 cenários + 2 de recusa (autorizarEscrita)');
})().catch(e => { console.error(e); process.exitCode = 1; });
