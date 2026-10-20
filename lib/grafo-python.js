'use strict';
/**
 * `analisarPython(arquivos)` — um único `python3` para o lote inteiro de `.py`, JSON pelo
 * stdin/stdout (ver `lib/grafo-python.py`). `arquivos`: array `{ caminho, texto }`.
 *
 * Sem `python3` no PATH (`ENOENT`) → resolve `{ indisponivel: true, motivo }`, nunca rejeita —
 * quem chama transforma isso num aviso (os `.py` ficam só como nó `file`, sem arestas).
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'grafo-python.py');

function analisarPython(arquivos) {
  return new Promise((resolve) => {
    if (!arquivos || arquivos.length === 0) { resolve([]); return; }

    const python = process.env.COCKPIT_GRAFO_PYTHON || 'python3';
    let proc;
    try {
      proc = spawn(python, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ indisponivel: true, motivo: `spawn de ${python} falhou: ${e && e.message}` });
      return;
    }

    const pedacosOut = [];
    const pedacosErr = [];
    let terminou = false;

    proc.on('error', (e) => {
      if (terminou) return;
      terminou = true;
      resolve({ indisponivel: true, motivo: `spawn de ${python} falhou: ${e && e.message}` });
    });
    proc.stdout.on('data', (d) => pedacosOut.push(d));
    proc.stderr.on('data', (d) => pedacosErr.push(d));
    proc.on('close', (codigo) => {
      if (terminou) return;
      terminou = true;
      if (codigo !== 0) {
        resolve({ indisponivel: true, motivo: `${python} saiu com código ${codigo}: ${Buffer.concat(pedacosErr).toString('utf8').slice(0, 500)}` });
        return;
      }
      try {
        const saida = JSON.parse(Buffer.concat(pedacosOut).toString('utf8'));
        resolve(saida);
      } catch (e) {
        resolve({ indisponivel: true, motivo: `saída de ${python} não é JSON válido: ${e && e.message}` });
      }
    });

    proc.stdin.write(JSON.stringify(arquivos));
    proc.stdin.end();
  });
}

module.exports = { analisarPython };
