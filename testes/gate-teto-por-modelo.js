#!/usr/bin/env node
'use strict';
// GATE — o teto do medidor de contexto por MODELO (card `medidor-teto-errado-com-haiku`, 06/10/2026).
//
// O defeito, nos dois sentidos:
//   - `claude -p` sem `--model` roda `claude-opus-5-5`, que JÁ NASCE com 1M. O `settings.json`
//     do dono não tem mais a chave `model` (desde 23/09), então `janelaLongaConfigurada()` diz
//     `false` e o painel de TODO job mostrava 200k — até a conversa passar de 200k e a rede de
//     segurança deduzir 1M. Medido nos `.jsonl` em 06/10: job `20261004-160536` (opus-5-5)
//     398.901 tokens; conversa de outro projeto (opus-5-5) 397.207; job `…-4dc4` (fable-5-1) 247.452.
//   - Aba aberta com `--model haiku` num CLI configurado em `[1m]` mostrava 1M; Haiku 4.5 é
//     200k. A rede só cobre o lado de cima (armadilha #27, adendo de 05/10).
//
// Nasceu VERMELHO na develop `4f5cab4` e ficou verde com a tabela de janela CONHECIDA por
// modelo em `lib/contexto.js:tetoDoModelo`. Só funções puras — nenhum `os.homedir()`, nenhum
// disco: o teto decidido pela config da máquina é assunto de `janelaLongaConfigurada()`, e
// este gate passa o `longa` na mão para provar que a tabela VENCE a config.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const contexto = require(path.join(__dirname, '..', 'lib', 'contexto'));
const adaptadorJob = require(path.join(__dirname, '..', 'lib', 'adaptador-job'));

let tudoOk = true;
const ok = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); tudoOk = tudoOk && Boolean(cond); return cond; };
const { tetoDoModelo } = contexto;
const linhaJsonl = (modelo, lidos) => JSON.stringify({
  type: 'assistant', parent_tool_use_id: null,
  message: { model: modelo, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: lidos } },
});

console.log('\n── Tabela de janela conhecida por modelo ──\n');
ok(tetoDoModelo('claude-opus-5-5', 10000) === 1000000,
  'claude-opus-5-5 com 10k e SEM [1m] na config → 1M (o modelo padrão dos jobs já nasce com 1M)');
ok(tetoDoModelo('claude-fable-5-1', 10000) === 1000000,
  'claude-fable-5-1 com 10k e SEM [1m] na config → 1M');
ok(tetoDoModelo('claude-haiku-4-5-20251001', 10000, { longa: true }) === 200000,
  'claude-haiku-4-5-20251001 com a config em [1m] → 200k (a tabela VENCE a config; é o conserto do Haiku)');
ok(tetoDoModelo('claude-haiku-4-5-20251001', 10000) === 200000,
  'claude-haiku-4-5-20251001 sem a config → 200k');

console.log('\n── A regra antiga continua valendo fora da tabela ──\n');
ok(tetoDoModelo('claude-opus-5', 10000) === 200000,
  'claude-opus-5 (antigo, fora da tabela) sem a config → 200k');
ok(tetoDoModelo('claude-opus-5', 10000, { longa: true }) === 1000000,
  'claude-opus-5 com a config em [1m] → 1M (precisava do [1m]: armadilha #27)');
ok(tetoDoModelo('claude-sonnet-5', 10000) === 200000 && tetoDoModelo('claude-sonnet-5', 10000, { longa: true }) === 1000000,
  'modelo Claude desconhecido da tabela → regra antiga (200k; 1M com a config)');
ok(tetoDoModelo('gpt-qualquer-coisa', 10000, { longa: true }) === null,
  'modelo fora da família Claude continua sem teto');

console.log('\n── O sufixo [1m] vence tudo ──\n');
ok(tetoDoModelo('claude-opus-5-5[1m]', 10000) === 1000000, 'claude-opus-5-5[1m] → 1M');
ok(tetoDoModelo('claude-haiku-4-5-20251001[1m]', 10000) === 1000000,
  'claude-haiku-4-5-20251001[1m] → 1M (o sufixo no id vem antes da tabela)');

console.log('\n── A rede de segurança vale também para os modelos da tabela ──\n');
ok(tetoDoModelo('claude-haiku-4-5-20251001', 250000) === 1000000,
  'haiku com 250k já ocupados → 1M, nunca 200k (o medidor não mostra 125%)');
ok(tetoDoModelo('claude-opus-5-5', 1200000) === null,
  'opus-5-5 acima de 1M → null (acima de 1M não há teto conhecido)');

console.log('\n── Os dois consumidores passam pela mesma tabela ──\n');
const aba = contexto.medir(linhaJsonl('claude-opus-5-5', 100000));
ok(aba && aba.teto === 1000000 && aba.pct === 10,
  `medidor da ABA (lib/contexto.js:medir): opus-5-5 com 100k e sem config → 1M, 10% (veio ${JSON.stringify(aba)})`);
const abaHaiku = contexto.medir(linhaJsonl('claude-haiku-4-5-20251001', 100000), { longa: true });
ok(abaHaiku && abaHaiku.teto === 200000 && abaHaiku.pct === 50,
  `medidor da ABA: haiku com 100k e config em [1m] → 200k, 50% (veio ${JSON.stringify(abaHaiku)})`);
// O medidor do job não expõe `medir()`: o caminho público é `lerConversa(..., {contexto:{longa}})`,
// que mede o PRINCIPAL do `claude.log` pelo mesmo `tetoDoModelo`. `longa:false` na mão =
// a máquina sem `[1m]` na config, que é o caso do dono desde 23/09.
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-teto-por-modelo-'));
  try {
    const logOpus = path.join(temp, 'opus.log');
    fs.writeFileSync(logOpus, `${linhaJsonl('claude-opus-5-5', 100000)}\n`);
    const job = (await adaptadorJob.lerConversa(logOpus, 0, { contexto: { longa: false } })).contexto;
    ok(job && job.teto === 1000000 && job.pct === 10,
      `medidor do JOB (lib/adaptador-job.js:lerConversa): opus-5-5 com 100k e sem config → 1M, 10% (veio ${JSON.stringify(job)})`);
    const logFable = path.join(temp, 'fable.log');
    fs.writeFileSync(logFable, `${linhaJsonl('claude-fable-5-1', 150000)}\n`);
    const jobFable = (await adaptadorJob.lerConversa(logFable, 0, { contexto: { longa: false } })).contexto;
    ok(jobFable && jobFable.teto === 1000000 && jobFable.pct === 15,
      `medidor do JOB: fable-5-1 com 150k e sem config → 1M, 15% (veio ${JSON.stringify(jobFable)})`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(tudoOk ? '\n✅ gate-teto-por-modelo: verde' : '\n❌ gate-teto-por-modelo: VERMELHO');
  process.exit(tudoOk ? 0 : 1);
})();
