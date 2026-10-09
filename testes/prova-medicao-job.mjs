// Prova de degrau 4 da /audita do card `contexto-da-sessao-do-job`.
//
// O fato do qual a segurança da mudança depende:
//   "Separar o `assistant` principal do subagente pelo VALOR truthy de `parent_tool_use_id`,
//    varrendo o `claude.log` para trás em blocos até `TETO_DURO`, devolve o número da sessão
//    PRINCIPAL — e nunca o do subagente."
//
// Este script roda `lib/adaptador-job.js:doArquivo` — o MÓDULO DE VERDADE, não um protótipo —
// contra TODOS os `claude.log` reais da pasta de jobs do orquestrador, e compara com uma varredura INGÊNUA
// do arquivo inteiro, linha a linha, do começo ao fim (a `referencia()` abaixo, que fica FORA
// do módulo de propósito: ela é o juiz independente, não pode compartilhar código com quem é
// julgado). Se as duas discordarem em qualquer arquivo, ele FALHA ALTO (exit 1) e imprime o par.
//
// 🔴 FICA FORA do `npm test` (não entra em `bin/testes.js`) porque lê a pasta de jobs do orquestrador — dado
// REAL desta máquina, que não existe num clone limpo do repo. `npm test` tem de passar em
// qualquer clone; esta prova é a alavanca que se roda de novo, à mão, quando alguém duvidar do
// fato acima — o mês que vem, ou depois de qualquer mudança em `lib/adaptador-job.js`.
//
// Roda com: node testes/prova-medicao-job.mjs

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import adaptadorJob from '../lib/adaptador-job.js';

function somaDoUso(uso) {
  if (!uso || typeof uso !== 'object') return 0;
  return Number(uso.input_tokens || 0)
    + Number(uso.cache_creation_input_tokens || 0)
    + Number(uso.cache_read_input_tokens || 0);
}

// ── A REFERÊNCIA INDEPENDENTE — arquivo inteiro, do começo ao fim, sem bloco nenhum ──
// De propósito SEM importar nada de `lib/adaptador-job.js`: se o módulo de verdade tiver um
// defeito sistemático, uma referência que reusasse código dele poderia herdar o mesmo defeito
// e nunca discordar.
//
// Também mede `distanciaDoFim`: quantos bytes separam o FIM do arquivo do fim da linha do
// último principal com `usage`. É o que distingue degradação LEGÍTIMA (o principal está mais
// longe do fim do que `TETO_DURO` — a varredura para trás nunca chegaria lá, por desenho) de
// um `doArquivo` simplesmente quebrado (ou ainda o stub): sem esta conta, qualquer `null`
// passaria como "degradação aceitável" e a prova nunca acusaria um stub que devolve `null`
// sempre — que é exatamente o estado do fim da Fase 0.
async function referencia(caminho) {
  const bruto = await fsp.readFile(caminho, 'utf8');
  let principal = null; let subagente = null;
  let offsetPrincipalFim = null;
  let acumulado = 0;
  const linhas = bruto.split('\n');
  for (let i = 0; i < linhas.length; i += 1) {
    const linha = linhas[i];
    acumulado += Buffer.byteLength(linha, 'utf8') + (i < linhas.length - 1 ? 1 : 0);
    if (!linha.trim()) continue;
    let o;
    try { o = JSON.parse(linha); } catch { continue; }
    if (o.type !== 'assistant') continue;
    const usados = somaDoUso(o.message?.usage);
    if (usados <= 0) continue;
    const alvo = { usados, modelo: o.message?.model || null };
    if (o.parent_tool_use_id) { subagente = alvo; } else { principal = alvo; offsetPrincipalFim = acumulado; }
  }
  const tamanhoTotal = Buffer.byteLength(bruto, 'utf8');
  const distanciaDoFim = offsetPrincipalFim === null ? null : tamanhoTotal - offsetPrincipalFim;
  return { principal, subagente, distanciaDoFim };
}

const raiz = process.env.COCKPIT_JOBS_DIR_REAL;
if (!raiz) { console.error('🟡 defina COCKPIT_JOBS_DIR_REAL=<pasta de jobs do orquestrador>'); process.exit(2); }
const ids = fs.readdirSync(raiz).filter((n) => !n.startsWith('.')).sort();
let casos = 0; let falhas = 0; let iguaisAoSub = 0; let nulos = 0;

for (const id of ids) {
  const log = path.join(raiz, id, 'claude.log');
  if (!fs.existsSync(log) || fs.statSync(log).size < 1024) continue;
  casos += 1;
  const [proto, ref] = await Promise.all([adaptadorJob.doArquivo(log), referencia(log)]);

  // 1. O módulo de verdade bate com a referência independente?
  const esperado = ref.principal ? ref.principal.usados : null;
  const obtido = proto ? proto.usados : null;
  if (esperado !== obtido) {
    if (obtido === null) {
      // Degradação além do teto é prevista SÓ quando o principal está mais longe do fim do
      // arquivo do que `TETO_DURO` — a varredura para trás nunca chegaria lá por desenho.
      // Fora disso, `null` é falha: o `doArquivo` deveria ter achado e não achou (ou é o
      // stub, que nunca acha nada).
      const legitimo = ref.distanciaDoFim !== null && ref.distanciaDoFim > adaptadorJob.TETO_DURO;
      if (legitimo) {
        nulos += 1;
        console.log(`  ~ ${id.slice(0, 46)}: doArquivo null (principal a ${ref.distanciaDoFim} B do fim, > TETO_DURO) — degradação legítima`);
      } else {
        falhas += 1;
        console.log(`  ✕ ${id.slice(0, 46)}: doArquivo null, mas referência achou ${esperado} a só ${ref.distanciaDoFim} B do fim (dentro do TETO_DURO)`);
      }
    } else {
      falhas += 1; console.log(`  ✕ ${id.slice(0, 46)}: doArquivo ${obtido} ≠ referência ${esperado}`);
    }
    continue;
  }
  // 2. A trava que importa: o número NUNCA pode ser o do subagente.
  if (proto && ref.subagente && proto.usados === ref.subagente.usados && ref.principal
      && ref.principal.usados !== ref.subagente.usados) {
    iguaisAoSub += 1; falhas += 1;
    console.log(`  ✕ ${id.slice(0, 46)}: o número é o do SUBAGENTE (${proto.usados})`);
    continue;
  }
  // 3. O modelo do principal é sempre o do principal.
  if (proto && ref.principal && proto.modelo !== ref.principal.modelo) {
    falhas += 1; console.log(`  ✕ ${id.slice(0, 46)}: modelo ${proto.modelo} ≠ ${ref.principal.modelo}`);
  }
}

console.log(`\n  logs conferidos: ${casos}`);
console.log(`  degradou para null (além do teto de 4 MB): ${nulos}`);
console.log(`  pegou o número do SUBAGENTE: ${iguaisAoSub}`);
console.log(falhas === 0 ? '\n  ✅ PROVA OK — lib/adaptador-job.js:doArquivo bate com a varredura completa em todos os logs'
  : `\n  🔴 PROVA FALHOU — ${falhas} divergência(s)`);
process.exit(falhas === 0 ? 0 : 1);
