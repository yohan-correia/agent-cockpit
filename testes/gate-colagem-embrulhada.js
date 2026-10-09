'use strict';
// GATE — colagem com linha em branco prende a fila para sempre (armadilha #84, achada em
// 24/09/2026 pelo dono, reproduzida com o CLI real na spec deste card).
//
// O DEFEITO: desde o Claude Code 2.1.280, uma colagem de VÁRIAS linhas que tenha alguma linha em
// branco e caia na caixa de digitação VAZIA volta gravada no `.jsonl` embrulhada em
// `<pasted_content id="X">…</pasted_content id="X">` (o mesmo `id` nas duas pontas). `textoDoHumano`
// (lib/externo.js:135-145) só sabia desfazer `<bash-input>` e o envelope de comando (#58) — o
// texto com a casca volta inteiro, `consumirPendente` (lib/abas.js:1077) nunca acha a pendente
// (nem por `===`, nem por `endsWith`) e a bolha fica "na fila" até o teto de 30 min.
//
// SEGUNDA CAMADA do mesmo defeito: quando a colagem vem junto de uma foto, o PRÓPRIO CLI apaga
// as linhas em branco do corpo colado (dentro do embrulho e sem ele) — `alfa\n\nbeta` vira
// `alfa\nbeta` no disco. Por isso desembrulhar não basta: o casamento pendente↔disco também
// precisa ignorar linha em branco, com grau (exato → sem linha em branco → termina igual),
// igual nos dois lados (servidor `lib/abas.js` e navegador `public/app.js` — paridade trancada
// em `testes/gate-ui.js`).
//
// Molde: testes/gate-eco-comando.js e testes/gate-eco-mid-turn.js (mesma família — o desembrulho
// de um envelope que o CLI grava por cima da fala do humano). `quando` é RELATIVO ao agora, nunca
// cravado: data fixa envelhece e `podarVencidas` come a fixture (foi o que derrubou o
// gate-eco-bash entre 08/09 e 10/09).
//
// SEM `assert/strict` (achado dos dois avaliadores do painel do plano, #2): `assert` morre no
// primeiro erro, e as Fases 3 e 4 deste plano precisam ver QUAIS casos já passam com o conserto
// parcial. Acumulador `ok()`/`caso()` em vez disso — cada `ok()` grava um ❌/✅ e conta a falha,
// sem interromper os casos seguintes.
const externo = require('../lib/externo');
const abas = require('../lib/abas');

let falhas = 0;
const ok = (c, t) => { if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };
const caso = (rotulo, fn) => { try { fn(); } catch (e) { ok(false, `${rotulo}: estourou — ${e.message}`); } };

// RELATIVO ao agora — mesmo motivo do comentário acima.
const quando = new Date(Date.now() - 1000).toISOString();
const chave = 'fixture-colagem-embrulhada';

const linhaUser = (texto) => ({ type: 'user', timestamp: quando, message: { content: texto } });
const linhaMidTurn = (content) => ({
  type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: quando, content,
});
const eventos = (obj) => externo.eventosDoObjeto(obj);
const textoDoEvento = (obj) => { const e = eventos(obj); return e.length ? e[0].texto : null; };

// Fixtures — textos EXATOS do `.jsonl` real (spec §2), copiados byte a byte. `\n` é literal.
const C = '\n\n<pasted_content id="c8ac">\nresponda so ok\n\nalfa\n\nbeta\n\ngama\n</pasted_content id="c8ac">\n';
const C_ENVIADO = 'responda so ok\n\nalfa\n\nbeta\n\ngama';

const D = '[Image #2][anexo]\nOs arquivos acima foram enviados pelo usuário junto desta mensagem. Abra o que precisar.\nresponda so ok sem abrir';
const D_ENVIADO = 'responda so ok sem abrir';

const E1 = '[Image #3]\n\n<pasted_content id="c8ac">\n[anexo]\nOs arquivos acima foram enviados pelo usuário junto desta mensagem. Abra o que precisar.\nresponda so ok sem abrir\nsegunda linha\nterceira\n</pasted_content id="c8ac">\n';
const E1_ENVIADO = 'responda so ok sem abrir\n\nsegunda linha\n\nterceira';
const E1_DESEMBRULHADO = '[Image #3]\n\n[anexo]\nOs arquivos acima foram enviados pelo usuário junto desta mensagem. Abra o que precisar.\nresponda so ok sem abrir\nsegunda linha\nterceira';

// E4 — o caso real do dono (spec §2, 4 fotos, `id="abae"`). SUPOSIÇÃO declarada (plano §2.1): o
// cockpit mandou com linha em branco entre os parágrafos — o disco não guarda isso; o gate cobre
// também a variante SEM linha em branco, que tem que casar igual.
const E4 = '[Image #4] [Image #5] [Image #6] [Image #7]\n\n<pasted_content id="abae">\n[anexo]\n[anexo]\n[anexo]\n[anexo]\nOs arquivos acima foram enviados pelo usuário junto desta mensagem. Abra o que precisar.\nVendas ta quebrada quando a tela fica pequena\nExames tambem\nna conciliacao deve ter a opcao para ser pagamento ou transferencia na linha e nao nos 3 pontos ou em cima da pagina \nNa imagem 4 eu deveria conseguir conciliar parcial\n</pasted_content id="abae">\n';
const E4_ENVIADO_COM_LINHA_EM_BRANCO = 'Vendas ta quebrada quando a tela fica pequena\n\nExames tambem\n\nna conciliacao deve ter a opcao para ser pagamento ou transferencia na linha e nao nos 3 pontos ou em cima da pagina \n\nNa imagem 4 eu deveria conseguir conciliar parcial';
const E4_ENVIADO_SEM_LINHA_EM_BRANCO = 'Vendas ta quebrada quando a tela fica pequena\nExames tambem\nna conciliacao deve ter a opcao para ser pagamento ou transferencia na linha e nao nos 3 pontos ou em cima da pagina \nNa imagem 4 eu deveria conseguir conciliar parcial';

const F_CONTENT = '<pasted_content id="c8ac">\nmeio do turno B\n\nsegundo paragrafo\n\nterceiro\n</pasted_content id="c8ac">';
const F_ENVIADO = 'meio do turno B\n\nsegundo paragrafo\n\nterceiro';

// G — rascunho na caixa NÃO-vazia + colagem: a prova de que não existe prefixo livre para o
// regex do desembrulho cobrir (spec §2, linha G). Tem que voltar INTACTO.
const G = 'rascunho solto responda so ok R\n\nparagrafo dois';

const H_CONTENT = '[Image #7]\n\n<pasted_content id="c8ac">\n[anexo]\nOs arquivos acima foram enviados pelo usuário junto desta mensagem. Abra o que precisar.\nfoto no meio H\nsegundo paragrafo\nterceiro\n</pasted_content id="c8ac">';
const H_ENVIADO = 'foto no meio H\n\nsegundo paragrafo\n\nterceiro';
const H_DESEMBRULHADO_PREFIXO = '[Image #7]\n\n[anexo]\n';

// I — colagem que CITA a própria tag (07/10/2026, um handoff sobre esta armadilha). Ao embrulhar,
// o CLI escapa a tag de dentro do corpo pondo `\` depois do `<`: `<pasted_content` vira
// `<\pasted_content` e `</pasted_content` vira `<\/pasted_content`. Medido nas 73 colagens
// embrulhadas do disco: só essas duas — `<script`, `<id`, `<branch` passam cruas. Trechos EXATOS
// dos dois `.jsonl` reais (I1: 2.1.291, `id="99d5"`; I2: 2.1.280, `id="b0c8"`), cortados no meio.
const I1 = '\n\n<pasted_content id="99d5">\n# Handoff\n\n- **#84**: o CLI ≥2.1.280 embrulha colagem com linha em branco em\n  `<\\pasted_content id=…>` e, com foto, apaga as linhas em branco.\n</pasted_content id="99d5">\n';
const I1_ENVIADO = '# Handoff\n\n- **#84**: o CLI ≥2.1.280 embrulha colagem com linha em branco em\n  `<pasted_content id=…>` e, com foto, apaga as linhas em branco.';
const I2 = '\n\n<pasted_content id="b0c8">\n# Handoff\n\nEle grava texto\n  colado de várias linhas embrulhado em <\\pasted_content id="X">…<\\/pasted_content id="X">, e com foto a linha\n  em branco some.\n</pasted_content id="b0c8">\n';
const I2_ENVIADO = '# Handoff\n\nEle grava texto\n  colado de várias linhas embrulhado em <pasted_content id="X">…</pasted_content id="X">, e com foto a linha\n  em branco some.';

try {
  // 1. Desembrulho via `externo.eventosDoObjeto` (o mesmo caminho de `gate-eco-bash.js`).
  caso('1', () => {
    ok(textoDoEvento(linhaUser(C)) === C_ENVIADO, '1C: colagem sem foto desembrulha e mantém linha em branco');
    ok(textoDoEvento(linhaUser(E1)) === E1_DESEMBRULHADO, '1E1: colagem com 1 foto desembrulha só a casca, prefixo [Image #N] intacto');
    ok(textoDoEvento(linhaMidTurn(F_CONTENT)) === F_ENVIADO, '1F: mid-turn (absorbed_mid_turn) desembrulha igual ao user');
    const h = textoDoEvento(linhaMidTurn(H_CONTENT));
    ok(typeof h === 'string' && h.startsWith(H_DESEMBRULHADO_PREFIXO), '1H: mid-turn com foto começa com [Image #7]\\n\\n[anexo]\\n');
    ok(typeof h === 'string' && !h.includes('pasted_content'), '1H: mid-turn com foto não contém pasted_content');
    const e4 = textoDoEvento(linhaUser(E4));
    ok(typeof e4 === 'string' && !e4.includes('pasted_content'), '1E4: caso real do dono (4 fotos) não contém pasted_content');
    ok(textoDoEvento(linhaUser(D)) === D, '1D: sem embrulho (só 1 foto, sem linha em branco fora da tag) passa intacto');
    ok(textoDoEvento(linhaUser(G)) === G, '1G: rascunho + colagem sem prefixo livre não embrulha — prova que não há casca de graça');
  });

  // 2. A fila sai — cada par (fixture, enviado) casa e some da lista de pendentes.
  caso('2', () => {
    const pares = [
      ['C', C_ENVIADO, textoDoEvento(linhaUser(C))],
      ['D', D_ENVIADO, textoDoEvento(linhaUser(D))],
      ['E1', E1_ENVIADO, textoDoEvento(linhaUser(E1))],
      ['E4-com-linha-em-branco', E4_ENVIADO_COM_LINHA_EM_BRANCO, textoDoEvento(linhaUser(E4))],
      ['E4-sem-linha-em-branco', E4_ENVIADO_SEM_LINHA_EM_BRANCO, textoDoEvento(linhaUser(E4))],
      ['F', F_ENVIADO, textoDoEvento(linhaMidTurn(F_CONTENT))],
      ['H', H_ENVIADO, textoDoEvento(linhaMidTurn(H_CONTENT))],
    ];
    for (const [rotulo, enviado, doDisco] of pares) {
      abas.esquecerPendentes(chave);
      const ficha = abas.registrarPendente(chave, { id: `pend-${rotulo}`, texto: enviado, mensagem: enviado }, Date.parse(quando) - 200);
      const consumida = abas.consumirPendente(chave, doDisco, quando);
      ok(consumida === ficha, `2${rotulo}: consumirPendente devolve a ficha registrada`);
      ok(abas.pendentesDe(chave).length === 0, `2${rotulo}: nada sobra na fila depois de consumir`);
    }
  });

  // 3. FALSO POSITIVO — fala de verdade que CITA a tag, ou colagem sem `id`/com `id` divergente,
  // continua sendo a fala (mesma trava estrutural da #58, achado do painel).
  caso('3', () => {
    const inline = 'Explique <pasted_content id="x">exemplo</pasted_content id="x">';
    ok(textoDoEvento(linhaUser(inline)) === inline, '3: citação inline (não começa só com [Image #N] + a tag) não desembrulha');

    const multilinha = 'Explique\n<pasted_content id="x">\nexemplo\n</pasted_content id="x">';
    ok(textoDoEvento(linhaUser(multilinha)) === multilinha, '3: citação multilinha (prefixo "Explique\\n" não é [Image #N]) não desembrulha');

    const semId = '<pasted_content>\na\n\nb\n</pasted_content>';
    ok(textoDoEvento(linhaUser(semId)) === semId, '3: colagem sem id não desembrulha (spec §5)');

    const idDiferente = '<pasted_content id="a">\nx\n</pasted_content id="b">';
    ok(textoDoEvento(linhaUser(idDiferente)) === idDiferente, '3: fechamento com id diferente do de abertura não desembrulha');
  });

  // 4. Envelope de sistema não engole a colagem: F produz UM evento humano (não zero) —
  // `ehEnvelopeDeSistema` exige abertura SEM atributo (`^<tag>`), e `<pasted_content id="…">`
  // tem atributo, então não pode ser confundida com `<task-notification>`.
  caso('4', () => {
    ok(eventos(linhaMidTurn(F_CONTENT)).length === 1, '4: mid-turn com colagem embrulhada produz 1 evento humano');
  });

  // 5. Colisão — exato primeiro (spec §4.2, dois pares em ordem de chegada).
  caso('5', () => {
    abas.esquecerPendentes(chave);
    const p1 = abas.registrarPendente(chave, { id: 'p1', texto: 'alfa\n\nbeta', mensagem: 'alfa\n\nbeta' }, Date.parse(quando) - 200);
    const p2 = abas.registrarPendente(chave, { id: 'p2', texto: 'alfa\nbeta', mensagem: 'alfa\nbeta' }, Date.parse(quando) - 100);
    const consumida = abas.consumirPendente(chave, 'alfa\nbeta', quando);
    ok(consumida === p2, '5a: disco exato "alfa\\nbeta" consome a pendente IDÊNTICA (P2)');
    ok(abas.pendentesDe(chave).length === 1 && abas.pendentesDe(chave)[0] === p1, '5a: P1 continua pendente');

    abas.esquecerPendentes(chave);
    const p1b = abas.registrarPendente(chave, { id: 'p1b', texto: 'alfa\n\nbeta', mensagem: 'alfa\n\nbeta' }, Date.parse(quando) - 200);
    const p2b = abas.registrarPendente(chave, { id: 'p2b', texto: 'alfa\nbeta', mensagem: 'alfa\nbeta' }, Date.parse(quando) - 100);
    const discoComFoto = '[Image #1]\n\n[anexo]\nOs arquivos acima foram enviados pelo usuário junto desta mensagem. Abra o que precisar.\nalfa\nbeta';
    const consumida2 = abas.consumirPendente(chave, discoComFoto, quando);
    ok(consumida2 === p1b, '5b: foto colapsou a linha em branco de P1 — consome P1 (a mais antiga da fila), não P2');
    ok(abas.pendentesDe(chave).length === 1 && abas.pendentesDe(chave)[0] === p2b, '5b: P2 continua pendente');
  });

  // 6. Guarda de tempo intacta: pendente registrada DEPOIS de `quando` não é roubada pelo eco.
  caso('6', () => {
    abas.esquecerPendentes(chave);
    abas.registrarPendente(chave, { id: 'futura', texto: C_ENVIADO, mensagem: C_ENVIADO }, Date.parse(quando) + 1000);
    const consumida = abas.consumirPendente(chave, textoDoEvento(linhaUser(C)), quando);
    ok(consumida === null, '6: pendente registrada DEPOIS de quando não é consumida');
    ok(abas.pendentesDe(chave).length === 1, '6: a pendente futura continua na fila');
  });

  // 7. Não afrouxa o que não casa.
  caso('7', () => {
    abas.esquecerPendentes(chave);
    abas.registrarPendente(chave, { id: 'naocasa', texto: 'meu texto', mensagem: 'meu texto' }, Date.parse(quando) - 200);
    const consumida = abas.consumirPendente(chave, 'outra coisa', quando);
    ok(consumida === null, '7: texto que não casa nunca consome');
  });

  // 8. `casaComEnviado` exportado (spec §4.2) — função inexistente não pode estourar o resto do
  // gate (achado do painel): registra UM ❌ e pula a tabela.
  caso('8', () => {
    if (typeof abas.casaComEnviado !== 'function') {
      ok(false, '8: abas.casaComEnviado não é função (ainda não exportada)');
      return;
    }
    const tabela = [
      ['a', 'a', 1],
      ['a\nb', 'a\n\nb', 2],
      ['x\na\nb', 'a\n\nb', 3],
      ['a', 'b', 0],
      ['', 'a', 0],
      ['a', '', 0],
    ];
    for (const [doDisco, enviadoTabela, esperado] of tabela) {
      const grau = abas.casaComEnviado(doDisco, enviadoTabela);
      ok(grau === esperado, `8: casaComEnviado(${JSON.stringify(doDisco)}, ${JSON.stringify(enviadoTabela)}) === ${esperado} (veio ${grau})`);
    }
  });

  // 9. O escape da tag citada (fixture I): desembrulhar sem desfazê-lo deixa o disco diferente
  // do enviado em TODOS os graus, e a bolha fica na fila até o teto de 30 min.
  caso('9', () => {
    ok(textoDoEvento(linhaUser(I1)) === I1_ENVIADO, '9I1: colagem que cita <pasted_content> volta igual ao enviado');
    ok(textoDoEvento(linhaUser(I2)) === I2_ENVIADO, '9I2: colagem que cita abertura E fechamento volta igual ao enviado');
    for (const [rotulo, enviado, cru] of [['I1', I1_ENVIADO, I1], ['I2', I2_ENVIADO, I2]]) {
      abas.esquecerPendentes(chave);
      const ficha = abas.registrarPendente(chave, { id: `pend-${rotulo}`, texto: enviado, mensagem: enviado }, Date.parse(quando) - 200);
      ok(abas.consumirPendente(chave, textoDoEvento(linhaUser(cru)), quando) === ficha, `9${rotulo}: a pendente sai da fila`);
    }
    // O escape só existe DENTRO do embrulho: fora dele, `<\pasted_content` é o que o humano digitou.
    const solto = 'o CLI grava <\\pasted_content id="x"> quando escapa';
    ok(textoDoEvento(linhaUser(solto)) === solto, '9: fala sem embrulho que contém <\\pasted_content passa intacta');
  });

  console.log(falhas ? `❌ GATE VERMELHO (${falhas})` : 'GATE VERDE — colagem embrulhada não prende mais a fila');
  process.exit(falhas ? 1 : 0);
} finally { abas.esquecerPendentes(chave); }
