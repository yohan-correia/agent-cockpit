'use strict';
// /clear encerra a conversa antes de existir um rollout novo. Este registro guarda
// apenas essa transição confirmada; nunca apaga ou escolhe arquivos de conversa.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const status = require('./status-codex');
const filas = new Map();

function arquivo(processo) {
  if (!processo || !Number.isFinite(processo.pid) || !Number.isFinite(processo.inicio)) {
    throw new Error('não consegui confirmar o processo do Codex');
  }
  const chave = createHash('sha256').update(JSON.stringify(processo)).digest('hex');
  return path.join(process.env.COCKPIT_CLEAR_CODEX_DIR || path.join(os.homedir(), '.cockpit', 'clear-codex'), chave + '.json');
}

function serializar(alvo, tarefa) {
  const p = (filas.get(alvo) || Promise.resolve()).then(tarefa, tarefa);
  filas.set(alvo, p);
  const fim = () => { if (filas.get(alvo) === p) filas.delete(alvo); };
  p.then(fim, fim);
  return p;
}

async function ler(alvo) {
  try {
    const st = await fs.stat(alvo);
    if (st.size > 4096) throw new Error('registro de /clear inválido');
    const r = JSON.parse(await fs.readFile(alvo, 'utf8'));
    if (typeof r.sessaoId !== 'string' || typeof r.ativa !== 'boolean') throw new Error('registro de /clear inválido');
    return r;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function gravar(alvo, registro) {
  await fs.mkdir(path.dirname(alvo), { recursive: true });
  const tmp = `${alvo}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(registro), { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, alvo);
  } finally { await fs.unlink(tmp).catch(() => {}); }
}

async function registrar(processo, sessaoId, id) {
  const alvo = arquivo(processo);
  return serializar(alvo, () => gravar(alvo, { sessaoId, id, ativa: true, em: Date.now() }));
}

async function executado(processo, id) {
  if (!id) return false;
  const alvo = arquivo(processo);
  return serializar(alvo, async () => (await ler(alvo))?.id === id);
}

async function aplicar(aba, processo, observadoEm = Date.now()) {
  const alvo = arquivo(processo);
  return serializar(alvo, async () => {
    const r = await ler(alvo);
    if (!r?.ativa || aba.casamento === 'ambiguo') return aba;
    if (aba.sessaoId === r.sessaoId || observadoEm < r.em) {
      return { ...aba, arquivo: null, sessaoId: null, rodando: false, reiniciada: true, casamento: 'nenhum' };
    }
    // A conversa seguinte já nasceu. Desativar permite um /resume legítimo da antiga.
    // O mesmo lock protege contra uma listagem atrasada sobrescrever um /clear novo.
    if (aba.sessaoId && aba.arquivo) await gravar(alvo, { ...r, ativa: false });
    return aba;
  });
}

function confirmou(antes, depois, sessaoId) {
  if (!/^[0-9a-f-]{36}$/i.test(sessaoId || '') || !status.composerVazio(depois)) return false;
  // Fixture 0.153.4: o CLI publica a instrução de resume da sessão que ACABOU de
  // encerrar. Exigimos que ela seja nova, com o ID esperado e composer vazio.
  const tem = raw => {
    const texto = status.sanitizarTela(raw).replace(/\s+/g, ' ');
    const inicio = texto.lastIndexOf('To continue this session, run codex resume');
    return inicio >= 0 && texto.slice(inicio, inicio + 600).includes(`(${sessaoId})`);
  };
  return !tem(antes) && tem(depois);
}

module.exports = { registrar, aplicar, confirmou, arquivo, executado };
