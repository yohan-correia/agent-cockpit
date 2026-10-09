#!/usr/bin/env node
'use strict';
// GANCHO-PERGUNTA — o Claude Code chama este script (hook) quando o agente vai fazer uma pergunta
// (ferramenta AskUserQuestion). O cockpit precisa do TEXTO da pergunta para desenhar o cartão, e
// ele não está em lugar nenhum antes da resposta: o `.jsonl` só ganha o `tool_use` quando a
// pergunta é respondida ou recusada (medido em 08/10/2026). O hook roda ANTES do menu abrir.
//
// Dois modos, um arquivo, zero `require` do repo (só `node:*`): a cópia instalada vive sozinha
// num caminho estável, sem `lib/` ao lado (molde do bin/retoma-claude.js, D67).
//   (sem argumento)  o Claude Code chama, com o JSON do evento no stdin:
//                      PreToolUse  → grava <pasta>/<session_id>.json com a pergunta pendente
//                      PostToolUse → apaga esse arquivo, se for da MESMA pergunta
//   instalar         à mão, no deploy → copia o script e imprime o bloco do settings.json
//
// O modo gancho é MUDO (nada em stdout, nada em stderr) e sai SEMPRE com 0: o stdout de um
// PreToolUse pode virar decisão de permissão, e um erro aqui nunca pode atrapalhar a pergunta.
// Pasta: COCKPIT_PERGUNTAS_DIR ou ~/.cockpit/perguntas (lida em tempo de chamada).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TETO_STDIN = 1024 * 1024;
const PRAZO_STDIN_MS = 3000;
const TETO_ARQUIVO = 256 * 1024;
const IDADE_JSON_MS = 7 * 24 * 3600 * 1000;
const IDADE_TMP_MS = 3600 * 1000;
const MAX_ENTRADAS_LIMPEZA = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_FERRAMENTA = /^[A-Za-z0-9_-]{1,128}$/;

const dirPerguntas = () => process.env.COCKPIT_PERGUNTAS_DIR || path.join(os.homedir(), '.cockpit', 'perguntas');
const destinoInstalacao = () => process.env.COCKPIT_GANCHO_DESTINO
  || path.join(os.homedir(), '.local', 'share', 'cockpit-agentes', 'claude', 'gancho-pergunta.js');

// ---- modo gancho ------------------------------------------------------------------------------

/** O payload é o que o Claude Code manda? Devolve o objeto ou null (o gancho sai calado). */
function payloadValido(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (p.tool_name !== 'AskUserQuestion') return null;
  if (typeof p.session_id !== 'string' || !UUID.test(p.session_id)) return null;
  if (typeof p.tool_use_id !== 'string' || !ID_FERRAMENTA.test(p.tool_use_id)) return null;
  if (!p.tool_input || !Array.isArray(p.tool_input.questions)) return null;
  if (typeof p.transcript_path !== 'string' || !path.isAbsolute(p.transcript_path)) return null;
  return p;
}

/** Apaga o que já passou do prazo na pasta (no máximo 500 entradas lidas por chamada). */
function limpar(dir) {
  const agora = Date.now();
  let nomes = [];
  try { nomes = fs.readdirSync(dir); } catch { return; }
  for (const nome of nomes.slice(0, MAX_ENTRADAS_LIMPEZA)) {
    const ehJson = nome.endsWith('.json') && !nome.startsWith('.');
    const ehTmp = nome.startsWith('.') && nome.endsWith('.tmp');
    if (!ehJson && !ehTmp) continue;
    try {
      const idade = agora - fs.statSync(path.join(dir, nome)).mtimeMs;
      if (idade > (ehJson ? IDADE_JSON_MS : IDADE_TMP_MS)) fs.unlinkSync(path.join(dir, nome));
    } catch { /* sumiu no meio, ou sem permissão: segue */ }
  }
}

function gravar(p) {
  const dir = dirPerguntas();
  let offset = 0;
  try { offset = fs.statSync(p.transcript_path).size; } catch { /* .jsonl ainda não existe: offset 0 */ }
  const texto = JSON.stringify({
    versao: 1,
    sessionId: p.session_id,
    toolUseId: p.tool_use_id,
    transcript: p.transcript_path,
    offset,
    em: Date.now(),
    perguntas: p.tool_input.questions,
  });
  if (Buffer.byteLength(texto) > TETO_ARQUIVO) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = path.join(dir, `.${p.session_id}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, texto, { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, `${p.session_id}.json`));
  limpar(dir);
}

function apagar(p) {
  const arquivo = path.join(dirPerguntas(), `${p.session_id}.json`);
  let atual;
  try { atual = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return; }
  // Id diferente = arquivo de OUTRA pergunta (a nova já chegou): não toca.
  if (atual && atual.toolUseId === p.tool_use_id) fs.unlinkSync(arquivo);
}

function tratar(bruto) {
  let p;
  try { p = payloadValido(JSON.parse(bruto)); } catch { return; }
  if (!p) return;
  if (p.hook_event_name === 'PreToolUse') gravar(p);
  else if (p.hook_event_name === 'PostToolUse') apagar(p);
}

function gancho() {
  process.exitCode = 0;
  process.on('uncaughtException', () => process.exit(0));
  // stdin que nunca fecha não pode segurar a pergunta: o prazo encerra o processo.
  const prazo = setTimeout(() => process.exit(0), PRAZO_STDIN_MS);
  const partes = [];
  let total = 0;
  process.stdin.on('data', (d) => {
    total += d.length;
    if (total > TETO_STDIN) process.exit(0);
    partes.push(d);
  });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    clearTimeout(prazo);
    try { tratar(Buffer.concat(partes).toString('utf8')); } catch { /* mudo */ }
    process.exit(0);
  });
}

// ---- instalar ---------------------------------------------------------------------------------

/**
 * Copia ESTE arquivo para um caminho estável e imprime o bloco do ~/.claude/settings.json. O
 * checkout vive em branch de feature e `releases/<sha>/` muda a cada deploy: o settings.json não
 * pode apontar para nenhum dos dois. Reinstalar = atualizar. NÃO edita o settings.json.
 */
function instalar() {
  const destino = destinoInstalacao();
  const node = process.execPath;
  // O comando roda por shell: só entra caminho sem caractere especial.
  const SEGURO = /^[A-Za-z0-9._/-]+$/;
  if (!SEGURO.test(node) || !SEGURO.test(destino)) {
    process.stderr.write(`recusado: caminho com caractere fora de [A-Za-z0-9._/-] (${SEGURO.test(node) ? destino : node})\n`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const tmp = `${destino}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, fs.readFileSync(__filename), { mode: 0o644 });
  fs.renameSync(tmp, destino);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(destino)).digest('hex');
  const objeto = {
    matcher: 'AskUserQuestion',
    hooks: [{ type: 'command', command: `${node} ${destino} 2>/dev/null || true`, timeout: 5 }],
  };
  process.stdout.write([
    `instalado em ${destino}`,
    `sha256 ${sha}`,
    '',
    'No ~/.claude/settings.json, em "hooks": ACRESCENTE o objeto abaixo ao array "PreToolUse" que já existe',
    '(sem apagar o do freio-delegacao) e CRIE o array "PostToolUse" com o mesmo objeto:',
    '--- json ---',
    JSON.stringify({ PreToolUse: [objeto], PostToolUse: [objeto] }, null, 2),
    '--- fim ---',
    '',
    'Como desligar: tirar os dois objetos do settings.json.',
    '',
  ].join('\n'));
}

// ---- main -------------------------------------------------------------------------------------

function main() {
  const cmd = process.argv[2];
  if (cmd === undefined) { gancho(); return; }
  if (cmd === 'instalar') { instalar(); return; }
  process.stderr.write('uso: gancho-pergunta.js [instalar]\n');
  process.exitCode = 2;
}

main();
