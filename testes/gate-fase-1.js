#!/usr/bin/env node
'use strict';
// GATE DA FASE 1 — a Prova 2, agora atrás da interface do adaptador.
//
//   (a) um turno cria um arquivo de verdade  -> prova que COCKPIT_SESSAO=1 está valendo
//   (b) um SEGUNDO processo com --resume lembra do primeiro -> prova a identidade de sessão
//
// Modelo haiku de propósito: isto prova mecanismo, não qualidade.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { iniciarTurno, novoId } = require('../lib/adaptador-claude');

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fase1-'));
const SESSAO = novoId();
const MODELO = 'haiku';

function rodar(texto, retomar) {
  return new Promise((resolve) => {
    const eventos = [];
    const turno = iniciarTurno({ texto, cwd: CWD, sessionId: SESSAO, retomar, modelo: MODELO });
    turno.on('evento', (e) => {
      eventos.push(e);
      if (e.tipo === 'ferramenta') console.log(`      · ferramenta: ${e.nome}`);
    });
    turno.on('fim', ({ codigo }) => resolve({ eventos, codigo }));
  });
}

const ok = (cond, texto) => {
  console.log(`  ${cond ? '✅' : '❌'} ${texto}`);
  return cond;
};

(async () => {
  console.log(`\nGATE FASE 1 — adaptador do Claude`);
  console.log(`  sessão: ${SESSAO}\n  cwd:    ${CWD}\n`);
  let tudoOk = true;

  console.log('[a] turno novo, que precisa ESCREVER:');
  const a = await rodar('Crie o arquivo prova.txt com exatamente o texto: adaptador ok. Depois responda so: feito', false);
  const fimA = a.eventos.find((e) => e.tipo === 'fim');
  const inicioA = a.eventos.find((e) => e.tipo === 'inicio');
  const arquivo = path.join(CWD, 'prova.txt');

  tudoOk &= ok(a.codigo === 0, `processo saiu 0 (saiu ${a.codigo})`);
  tudoOk &= ok(Boolean(inicioA), 'emitiu evento "inicio"');
  tudoOk &= ok(inicioA?.sessionId === SESSAO, 'o id da sessão é o que NÓS escolhemos');
  tudoOk &= ok(a.eventos.some((e) => e.tipo === 'ferramenta'), 'emitiu evento de ferramenta');
  tudoOk &= ok(fs.existsSync(arquivo), 'o arquivo foi criado no disco (COCKPIT_SESSAO valendo)');
  if (fs.existsSync(arquivo)) console.log(`      conteúdo: ${JSON.stringify(fs.readFileSync(arquivo, 'utf8').trim())}`);
  tudoOk &= ok((fimA?.negacoes || []).length === 0, `sem permissões negadas em silêncio (${(fimA?.negacoes || []).length})`);

  console.log('\n[b] MESMA sessão, processo NOVO, com --resume:');
  const b = await rodar('Sem usar ferramenta nenhuma, responda de memoria: qual arquivo voce criou e o que escreveu nele?', true);
  const fimB = b.eventos.find((e) => e.tipo === 'fim');
  const resposta = String(fimB?.resultado || '');
  console.log(`      resposta: ${resposta.replace(/\n/g, ' ').slice(0, 140)}`);

  tudoOk &= ok(b.codigo === 0, `processo saiu 0 (saiu ${b.codigo})`);
  tudoOk &= ok(/prova\.txt/i.test(resposta), 'a sessão retomada lembra o NOME do arquivo');
  tudoOk &= ok(/adaptador ok/i.test(resposta), 'a sessão retomada lembra o CONTEÚDO');

  console.log(`\n${tudoOk ? '✅ GATE DA FASE 1: VERDE' : '❌ GATE DA FASE 1: VERMELHO'}\n`);
  process.exit(tudoOk ? 0 : 1);
})();
