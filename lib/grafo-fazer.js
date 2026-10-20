'use strict';
/**
 * `POST /api/grafos/fazer`: o servidor do Cockpit gera o grafo com o gerador determinístico
 * (`bin/grafo.js gerar`, sem IA) e instala o hook do git do projeto — spec/plano
 * `2026-10-17-grafo-botao-fazer-grafo`, T3/T4. `server.js` só liga a rota; toda a lógica mora aqui.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const gitlib = require('./grafo-git.js');
const loja = require('./grafo-loja.js');
const hooklib = require('./grafo-hook.js');

const MENSAGENS = {
  nomeInvalido: 'nome de projeto inválido',
  naoEncontrado: 'projeto não encontrado',
  naoGit: 'não é repositório git',
  naoRaiz: 'a pasta não é a raiz de um repositório',
  semDevelop: 'sem develop',
  trava: 'outro processo está gerando este grafo — tente de novo',
  prazo: 'a geração demorou demais',
  falhou: 'não consegui gerar o grafo (detalhe no log do grafo)',
  hookParcial: 'hook parcial: um hook do repositório ficou intocado',
  hookHooksPath: 'hook não instalado: o repositório usa core.hooksPath',
  hookErro: 'hook não instalado (detalhe no log do grafo)',
};
const BIN_GRAFO = path.join(__dirname, '..', 'bin', 'grafo.js');
const emCurso = new Map(); // nome -> Promise<{status, corpo}>

function prazoMs() {
  const n = Number(process.env.COCKPIT_GRAFO_FAZER_PRAZO_MS);
  return Number.isInteger(n) && n > 0 ? n : 240000;
}

function gerando(nome) {
  return emCurso.has(nome);
}

/** Promise que SEMPRE resolve: `rc`, `prazo` (estourou o prazo) e as últimas linhas do stderr. */
function rodarGerar(repo) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN_GRAFO, 'gerar', repo], { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
    let stderr = '';
    let resolvido = false;
    const prazo = setTimeout(() => {
      if (resolvido) return;
      resolvido = true;
      child.kill('SIGKILL');
      resolve({ rc: null, prazo: true, stderr: stderr.slice(-2000).replace(/\s+/g, ' ') });
    }, prazoMs());
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('close', (code) => {
      if (resolvido) return;
      resolvido = true;
      clearTimeout(prazo);
      resolve({ rc: code, prazo: false, stderr: stderr.slice(-2000).replace(/\s+/g, ' ') });
    });
    child.on('error', (e) => {
      if (resolvido) return;
      resolvido = true;
      clearTimeout(prazo);
      resolve({ rc: -1, prazo: false, stderr: (e && e.message || '').replace(/\s+/g, ' ') });
    });
  });
}

/** `projeto = { nome, cwd }` — SEMPRE da `listarProjetos()` do servidor, nunca do cliente. */
async function executar({ nome, cwd }) {
  try {
    const repo = await gitlib.repoPrincipal(cwd);
    if (!repo) return { status: 404, corpo: { erro: MENSAGENS.naoGit } };
    if (fs.realpathSync(repo) !== fs.realpathSync(cwd)) return { status: 409, corpo: { erro: MENSAGENS.naoRaiz } };
    if (!(await gitlib.refDaDevelop(repo))) return { status: 409, corpo: { erro: MENSAGENS.semDevelop } };

    const pasta = loja.pastaDo(nome);
    if (loja.resumoDoGrafo(pasta)) return { status: 200, corpo: { ok: true } };

    // Hook primeiro (T4): um commit entre a conferência da develop acima e a instalação dispara o
    // `atualizar`, que acha a trava com o `gerar` e marca `.pendente` — o ciclo do `gerar` reconfere
    // a develop e gera de novo. A instalação nunca impede a geração: falhou/recusada → vira aviso.
    let aviso = null;
    try {
      const grafoAbs = hooklib.publicarCopia();
      const lojaAbs = process.env.COCKPIT_GRAFOS_DIR ? path.resolve(process.env.COCKPIT_GRAFOS_DIR) : null;
      const r = await hooklib.instalar(repo, { grafoAbs, lojaAbs });
      if (r.recusado) {
        aviso = /core\.hooksPath/.test(r.recusado) ? MENSAGENS.hookHooksPath : MENSAGENS.hookErro;
        loja.registrar(pasta, `fazer: hook recusado — ${r.recusado}`);
      } else if (r.pulados.length) {
        aviso = MENSAGENS.hookParcial;
        loja.registrar(pasta, `fazer: hook parcial — ${r.pulados.map((x) => x.hook).join(', ')}`);
      }
    } catch (e) {
      aviso = MENSAGENS.hookErro;
      loja.registrar(pasta, `fazer: hook erro — ${e && e.message}`);
    }

    loja.registrar(pasta, 'fazer: início');
    const { rc, prazo, stderr } = await rodarGerar(repo);
    loja.registrar(pasta, `fazer: fim rc=${prazo ? 'prazo' : rc}${rc !== 0 && stderr ? ` — ${stderr}` : ''}`);

    if (prazo) return { status: 500, corpo: { erro: MENSAGENS.prazo } };
    if (rc === 0) return { status: 200, corpo: aviso ? { ok: true, aviso } : { ok: true } };
    if (rc === 3) return { status: 409, corpo: { erro: MENSAGENS.semDevelop } };
    if (rc === 4) return { status: 409, corpo: { erro: MENSAGENS.trava } };
    return { status: 500, corpo: { erro: MENSAGENS.falhou } };
  } catch (e) {
    try { loja.registrar(loja.pastaDo(nome), `fazer: erro — ${e && e.message}`); } catch { /* nem o log deu */ }
    return { status: 500, corpo: { erro: MENSAGENS.falhou } };
  }
}

/** O segundo pedido pro mesmo projeto entra na MESMA promessa — um processo só. */
function fazer(projeto) {
  const corrente = emCurso.get(projeto.nome);
  if (corrente) return corrente;
  const p = executar(projeto).finally(() => emCurso.delete(projeto.nome));
  emCurso.set(projeto.nome, p);
  return p;
}

module.exports = { MENSAGENS, fazer, gerando };
