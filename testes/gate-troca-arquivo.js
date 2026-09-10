#!/usr/bin/env node
'use strict';
// GATE DA TROCA DE ARQUIVO — o que o `/clear` faz com o fluxo de uma aba.
//
// `/clear` não mata a sessão do CLI: o processo é o mesmo, mas passa a gravar num
// `.jsonl` NOVO. O fluxo SSE resolvia o caminho UMA vez, na abertura, e ficava fazendo
// tail num arquivo que parou de crescer — a tela congelava até sair da conversa e voltar.
//
// Aqui o tmux não entra: `lib/abas` é trocado por um duble no `require.cache` antes de o
// servidor subir, e é o teste quem decide em qual arquivo a aba está gravando. Assim a
// troca acontece na hora exata em que se quer testá-la, sem depender de aba viva nem de
// gastar token da assinatura.
//
// Uso:  node testes/gate-troca-arquivo.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };
const PORTA = Number(process.env.PORT || 7898);

// ─── o duble de lib/abas ─────────────────────────────────────────────────────
// Só o que o fluxo SSE encosta. O resto do módulo não é chamado por este caminho.

const estado = { arquivo: null, titulo: 'Aba de teste', cwd: '/tmp' };
const CHAVE = 'aba-9';

// `...real` espalhado: o dublê é PARCIAL (só listar/buscar/paraCliente/abasDoProjeto falam
// com o tmux do usuário, e é isto que o teste precisa substituir), mas tudo que `lib/abas.js`
// ganhar depois — o registro de pendentes, por exemplo — chega aqui de graça. Sem isto,
// `server.js` precisaria de `?.` toda vez que chamasse uma função nova do módulo só porque
// ESTE dublê ainda não a conhecia — código de produção se defendendo de um teste incompleto.
const duble = {
  ...require(path.join(__dirname, '..', 'lib', 'abas.js')),
  listar: async () => [aba()],
  buscar: async (chave) => (chave === CHAVE ? aba() : null),
  paraCliente: (a) => a,
  abasDoProjeto: () => [],
};
// Cópia a cada chamada, como o módulo de verdade faz (ele remonta a lista do tmux): sem
// isso o fluxo mutaria o mesmo objeto que o duble devolve e a troca nunca seria vista.
function aba() {
  return { chave: CHAVE, titulo: estado.titulo, cwd: estado.cwd, arquivo: estado.arquivo, rodando: false, esperando: false,
    agente: estado.agente, sessaoId: estado.sessaoId, reiniciada: estado.reiniciada };
}

require.cache[require.resolve(path.join(__dirname, '..', 'lib', 'abas.js'))] = {
  id: require.resolve(path.join(__dirname, '..', 'lib', 'abas.js')),
  filename: require.resolve(path.join(__dirname, '..', 'lib', 'abas.js')),
  loaded: true,
  exports: duble,
};

// ─── conversa de mentira no disco ────────────────────────────────────────────

function linha(texto) {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-23T12:00:00.000Z',
    message: { content: [{ type: 'text', text: texto }] },
  })}\n`;
}

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-troca-'));
const ARQUIVO_A = path.join(pasta, 'antigo.jsonl');
const ARQUIVO_B = path.join(pasta, 'novo.jsonl');
// O arquivo NOVO é maior que o velho de propósito: se `lido` não voltasse a zero, a
// leitura começaria no offset do arquivo velho e a PRIMEIRA fala do novo sumiria — que é
// exatamente o defeito que este gate precisa enxergar.
fs.writeFileSync(ARQUIVO_A, linha('fala do arquivo velho'));
fs.writeFileSync(ARQUIVO_B, linha('primeira fala depois do clear') + linha('segunda fala depois do clear'));
estado.arquivo = ARQUIVO_A;

// ─── o fluxo ─────────────────────────────────────────────────────────────────

// O cano manda `{ aba, evento }` — o envelope do multiplex. Aqui só há uma aba, então
// desembrulhar é tirar a casca; nenhuma asserção abaixo muda, é isso que prova que a
// extração para `acompanharAba` não mexeu no comportamento por aba.
const desembrulhar = (obj) => obj.evento;

function abrirFluxo(recebido) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORTA, path: `/api/eventos?abas=${CHAVE}`, headers: { accept: 'text/event-stream' } },
      (res) => {
        let sobra = '';
        res.setEncoding('utf8');
        res.on('data', (pedaco) => {
          sobra += pedaco;
          const partes = sobra.split('\n\n');
          sobra = partes.pop();
          for (const parte of partes) {
            const dado = parte.split('\n').find((l) => l.startsWith('data: '));
            if (dado) recebido.push(desembrulhar(JSON.parse(dado.slice(6))));
          }
        });
        resolve(req);
      },
    );
    req.on('error', reject);
  });
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  process.env.PORT = String(PORTA);
  process.env.HOST = '127.0.0.1';
  process.env.COCKPIT_CERT_DIR = '/dev/null';  // senão sobe TLS e o teste fala HTTP
  process.env.COCKPIT_TOKEN = '';
  process.env.COCKPIT_JOBS_DIR = path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`); // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
  require(path.join(__dirname, '..', 'server.js'));
  await espera(400);

  const recebido = [];
  const req = await abrirFluxo(recebido);
  await espera(900);

  let tudoOk = 1;
  const sessoesAntes = recebido.filter((e) => e.tipo === 'sessao').length;
  tudoOk &= ok(sessoesAntes === 1, 'abrir a aba manda um `sessao` (o evento que limpa a fita)');
  tudoOk &= ok(
    recebido.some((e) => e.tipo === 'texto' && e.texto === 'fala do arquivo velho'),
    'e a fita recebe a conversa do arquivo em que a aba estava',
  );

  // O `/clear`: mesmo processo, mesma aba, outro `.jsonl`.
  const corte = recebido.length;
  estado.arquivo = ARQUIVO_B;
  await espera(3000);  // o relógio de estado bate de 2 em 2 segundos

  const depois = recebido.slice(corte);
  const iSessao = depois.findIndex((e) => e.tipo === 'sessao');
  tudoOk &= ok(iSessao >= 0, 'trocar o arquivo reemite `sessao` sem precisar reabrir a conversa');

  const falas = depois.filter((e) => e.tipo === 'texto').map((e) => e.texto);
  tudoOk &= ok(
    falas.includes('primeira fala depois do clear'),
    '`lido` voltou a zero: a conversa nova chega desde a primeira linha',
  );
  tudoOk &= ok(falas.includes('segunda fala depois do clear'), 'e segue até o fim dela');
  tudoOk &= ok(
    !falas.includes('fala do arquivo velho'),
    'nada do arquivo velho volta depois do reset — a fita limpa não ganha bolha órfã',
  );
  const iPrimeiraFala = depois.findIndex((e) => e.tipo === 'texto');
  tudoOk &= ok(
    iSessao >= 0 && iPrimeiraFala > iSessao,
    'e a fala nova chega DEPOIS do `sessao`, nunca antes (senão a limpeza a apagaria)',
  );

  // Fim de linha da aba: o claude morreu e ela fica sem arquivo. NÃO é troca de conversa —
  // limpar a fita aqui apagaria da tela o histórico que o usuário ainda está lendo.
  const corteMorte = recebido.length;
  estado.arquivo = null;
  await espera(3000);
  tudoOk &= ok(
    !recebido.slice(corteMorte).some((e) => e.tipo === 'sessao'),
    'aba que perdeu o claude não conta como troca: a fita não é limpa',
  );

  // Codex: /clear confirmado antes de nascer o arquivo seguinte. O null agora tem
  // prova de reset; morte/desconhecimento acima continua preservando a fita.
  estado.agente = 'codex';
  estado.arquivo = ARQUIVO_A;
  estado.sessaoId = 'codex-antiga';
  await espera(2300);
  const corteClear = recebido.length;
  estado.arquivo = null;
  estado.sessaoId = null;
  estado.reiniciada = true;
  await espera(2300);
  const limpos = recebido.slice(corteClear);
  tudoOk &= ok(limpos.some(e => e.tipo === 'sessao' && e.meta.sessaoId === null && e.meta.reiniciada),
    'Codex sem rollout novo: clear confirmado emite sessão vazia');
  tudoOk &= ok(limpos.some(e => e.tipo === 'sincronizado' && !e.turnoEmAndamento),
    'clear solta a fita vazia e não inventa trabalho');
  const reconectados = [];
  const req2 = await abrirFluxo(reconectados);
  await espera(500);
  tudoOk &= ok(!reconectados.some(e => e.tipo === 'texto'), 'reconexão após clear não lê arquivo antigo');
  req2.destroy();
  req.destroy();
  fs.rmSync(pasta, { recursive: true, force: true });
  console.log(`\n${tudoOk ? '✅ GATE VERDE' : '❌ GATE VERMELHO'} — troca de arquivo\n`);
  process.exit(tudoOk ? 0 : 1);
})().catch((erro) => {
  console.error('\n❌ o gate quebrou:', erro.message, '\n');
  process.exit(1);
});
