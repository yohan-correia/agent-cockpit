'use strict';
// O MUNDO DE MENTIRA da tela "Arquivos" — compartilhado por `gate-arquivos.js` e pelo
// `smoke-navegador-arquivos.js`. Nada aqui encosta no Tailscale de verdade nem no
// `~/taildrop-inbox` do usuário: o inbox é um tmp FORA de /home (é o que faz o R29 provar
// alguma coisa), a CLI é um shell script que só registra os argumentos, e a localapi é um
// servidor unix do próprio teste.
//
// O estado que o binário falso e o socket falso compartilham é o DISCO (spec R28): o socket
// lista a fila lendo `<raiz>/fila-falsa/`, e o binário, em `file get`, move o que está lá
// para o diretório pedido. Depois de um `puxar`, a fila fica vazia sem nenhum canal combinado.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** Uma raiz temporária FORA de /home. `os.tmpdir()` por padrão; se apontar para /home, /tmp. */
function raizTemporaria(prefixo) {
  let base = os.tmpdir();
  if (base.startsWith('/home')) base = '/tmp';
  return fs.mkdtempSync(path.join(base, prefixo));
}

/** Repõe `<raiz>/fila-falsa/` com `a.pdf` (10 bytes) e `b.zip` (20 bytes). */
function reporFila(raiz) {
  const fila = path.join(raiz, 'fila-falsa');
  fs.mkdirSync(fila, { recursive: true });
  fs.writeFileSync(path.join(fila, 'a.pdf'), Buffer.alloc(10, 'a'));
  fs.writeFileSync(path.join(fila, 'b.zip'), Buffer.alloc(20, 'b'));
  return fila;
}

/**
 * Monta o inbox de mentira em `<raiz>/taildrop-inbox`, mais as duas outras raízes
 * (`projetos`, `.cockpit`), o `cofre` fora do inbox e os DOIS symlinks para fora que o R1 e o
 * R21 exercitam. NÃO cria `_triagem`: quem cria é o módulo (§3.1.1).
 */
function montarInbox(raiz) {
  const inbox = path.join(raiz, 'taildrop-inbox');
  for (const nome of ['projeto-a', 'projeto-b', '.escondido', 'node_modules']) {
    fs.mkdirSync(path.join(inbox, nome), { recursive: true });
  }
  fs.writeFileSync(path.join(inbox, 'x~parcial'), 'pela metade');
  fs.mkdirSync(path.join(raiz, 'cofre'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'cofre', 'segredo.txt'), 'SEGREDO');
  fs.symlinkSync(path.join(raiz, 'cofre', 'segredo.txt'), path.join(inbox, 'link-para-fora'));
  fs.symlinkSync(path.join(raiz, 'cofre'), path.join(inbox, 'pasta-link'));
  fs.mkdirSync(path.join(raiz, 'projetos', 'projeto-b'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'projetos', 'projeto-b', 'README.md'), '# projeto-b\n');
  fs.mkdirSync(path.join(raiz, '.cockpit', 'anexos'), { recursive: true });
  fs.writeFileSync(path.join(raiz, '.cockpit', 'anexos', 'foto.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  const fila = reporFila(raiz);
  return { inbox, fila, cofre: path.join(raiz, 'cofre') };
}

/**
 * O `tailscale` de mentira: registra cada chamada (uma linha, argumentos separados por TAB)
 * em `<raiz>/chamadas.log`; em `file get` move a fila falsa para o diretório pedido e imprime
 * dois caminhos absolutos no stderr (um sob $HOME, um sob o inbox) para o R23/R29; em
 * `file cp` para `caixa-offline:` sai 1 com "target offline" COLORIDO por ANSI (R38).
 * Dorme `${TAILSCALE_FALSO_DORMIR_MS:-500}` ms nos dois (R34/R39/R54); com
 * `TAILSCALE_FALSO_GRITAR=1` despeja 2 MiB no stdout do `get` (R53).
 */
function binarioFalso(raiz) {
  const caminho = path.join(raiz, 'tailscale-falso');
  const inboxReal = fs.realpathSync(path.join(raiz, 'taildrop-inbox'));
  const script = `#!/bin/sh
# tailscale FALSO do gate/smoke da tela Arquivos. Nunca fala com o tailnet.
LOG='${raiz}/chamadas.log'
FILA='${raiz}/fila-falsa'
INBOX_REAL='${inboxReal}'
primeiro=1
for a in "$@"; do
  if [ "$primeiro" = 1 ]; then printf '%s' "$a" >> "$LOG"; primeiro=0; else printf '\\t%s' "$a" >> "$LOG"; fi
done
printf '\\n' >> "$LOG"
dormir=$(awk "BEGIN{printf \\"%.3f\\", \${TAILSCALE_FALSO_DORMIR_MS:-500}/1000}")
if [ "$1" = file ] && [ "$2" = get ]; then
  sleep "$dormir"
  destino=''
  for a in "$@"; do destino="$a"; done
  if [ -d "$FILA" ]; then
    for f in "$FILA"/*; do [ -e "$f" ] && mv "$f" "$destino"/; done
  fi
  echo "movido para $HOME/x" >&2
  echo "e tambem $INBOX_REAL/y" >&2
  if [ -n "$TAILSCALE_FALSO_GRITAR" ]; then head -c 2097152 /dev/zero | tr '\\0' 'x'; fi
  exit 0
fi
if [ "$1" = file ] && [ "$2" = cp ]; then
  sleep "$dormir"
  destino=''
  for a in "$@"; do destino="$a"; done
  if [ "$destino" = 'caixa-offline:' ]; then
    printf '\\033[31mtarget offline\\033[0m: %s\\n' "$3" >&2
    exit 1
  fi
  exit 0
fi
exit 0
`;
  fs.writeFileSync(caminho, script, { mode: 0o755 });
  return caminho;
}

/**
 * A localapi do tailscaled de mentira, num unix socket. `estado` é mutável pelo teste: cada
 * chave liga um defeito que o R6/R37/R45/R55 exercita. Exige `Host: local-tailscaled.sock`
 * (R16 — medido na spec §5: sem ele o tailscaled real responde 403).
 */
function socketFalso(caminho, estado) {
  const padrao = {
    filaDir: null,
    filaNula: false,
    gigante: false,
    demora: 0,
    status: 200,
    lixo: false,
    semNome: false,
    duplicado: false,
    destinos: [
      { nome: 'galaxy-falso', online: true, so: 'android' },
      { nome: 'caixa-offline', online: false, so: 'linux' },
    ],
  };
  for (const [chave, valor] of Object.entries(padrao)) {
    if (estado[chave] === undefined) estado[chave] = valor;
  }
  const relogios = new Set();

  const fila = () => {
    if (estado.filaNula) return 'null';
    if (estado.lixo) return '{not json';
    if (estado.semNome) return JSON.stringify([{ Size: 3 }]);
    if (estado.gigante) return JSON.stringify([{ Name: 'a.pdf', Size: 10, Pad: 'x'.repeat(2 * 1024 * 1024) }]);
    const itens = [];
    if (estado.filaDir && fs.existsSync(estado.filaDir)) {
      for (const nome of fs.readdirSync(estado.filaDir).sort()) {
        const st = fs.statSync(path.join(estado.filaDir, nome));
        if (st.isFile()) itens.push({ Name: nome, Size: st.size });
      }
    }
    return JSON.stringify(itens);
  };
  const destinos = () => {
    const lista = estado.destinos.map((d, i) => ({
      Node: { ComputedName: d.nome, Online: d.online, Hostinfo: { OS: d.so, Hostname: d.nome } },
      PeerAPIURL: d.online ? `http://100.64.0.${i + 1}:1` : '',
    }));
    if (estado.duplicado) lista.push({ ...lista[0] });
    return JSON.stringify(lista);
  };

  const servidor = http.createServer((req, res) => {
    req.socket.on('error', () => {});
    const responder = () => {
      if (res.destroyed) return;
      if (req.headers.host !== 'local-tailscaled.sock') {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('invalid localapi request');
      }
      let corpo;
      if (req.url === '/localapi/v0/files/') corpo = fila();
      else if (req.url === '/localapi/v0/file-targets') corpo = destinos();
      else { res.writeHead(404); return res.end('not found'); }
      res.writeHead(estado.status, { 'content-type': 'application/json' });
      return res.end(corpo);
    };
    if (estado.demora > 0) {
      const t = setTimeout(() => { relogios.delete(t); responder(); }, estado.demora);
      relogios.add(t);
    } else {
      responder();
    }
  });
  try { fs.unlinkSync(caminho); } catch { /* não existia */ }
  const pronto = new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(caminho, () => resolve());
  });
  const fechar = () => {
    for (const t of relogios) clearTimeout(t);
    relogios.clear();
    try { servidor.closeAllConnections(); } catch { /* versão sem o método */ }
    servidor.close();
    try { fs.unlinkSync(caminho); } catch { /* já foi */ }
  };
  return { servidor, pronto, fechar };
}

/**
 * Sobe o `server.js` apontando para o mundo de mentira. Recusa o binário REAL (R13): o gate
 * e o smoke nunca podem mandar arquivo de verdade para o celular do usuário.
 * Devolve `{ processo, matar(), stderr() }` — `matar()` é pelo pid exato (#24) e resolve
 * quando o processo saiu, para a porta ficar livre para o próximo.
 */
async function subirServidor({ porta, home, socket, binario, extras = {} }) {
  if (!binario || path.resolve(binario) === '/usr/bin/tailscale' || /(^|\/)tailscale$/.test(binario)) {
    throw new Error(`recuso subir com o tailscale REAL (${binario}) — R13`);
  }
  const ambiente = { ...process.env };
  delete ambiente.COCKPIT_TOKEN;
  Object.assign(ambiente, {
    HOST: '127.0.0.1',
    PORT: String(porta),
    HOME: home,
    COCKPIT_CERT_DIR: '/dev/null',
    COCKPIT_TMUX_SOCKET: `cockpit-gate-arquivos-${process.pid}`,
    COCKPIT_INBOX: path.join(home, 'taildrop-inbox'),
    COCKPIT_TAILSCALE_SOCKET: socket,
    COCKPIT_BIN_TAILSCALE: binario,
    COCKPIT_JOBS_DIR: path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`), // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
    ...extras,
  });
  const processo = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: ambiente, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let erros = '';
  processo.stderr.on('data', (d) => { erros += d; if (erros.length > 65536) erros = erros.slice(-32768); });
  const saiu = new Promise((r) => processo.on('exit', r));

  const saude = () => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: porta, path: '/health', timeout: 1000, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
  let pronto = false;
  for (let i = 0; i < 60 && !pronto; i += 1) {
    if (processo.exitCode !== null) break;
    pronto = await saude();
    if (!pronto) await espera(200);
  }
  const matar = async () => {
    if (processo.exitCode === null) {
      try { process.kill(processo.pid); } catch { /* já morreu */ }
      await Promise.race([saiu, espera(5000)]);
      if (processo.exitCode === null) { try { process.kill(processo.pid, 'SIGKILL'); } catch { /* já morreu */ } await saiu; }
    }
    // A porta só fica livre quando o kernel solta o listener; um respiro curto evita o
    // EADDRINUSE do servidor seguinte na mesma porta.
    await espera(150);
  };
  if (!pronto) {
    await matar();
    const detalhe = erros.split('\n').slice(-30).join('\n');
    const e = new Error(`o servidor na ${porta} não respondeu /health em 12 s\n${detalhe}`);
    e.stderr = detalhe;
    throw e;
  }
  return { processo, matar, stderr: () => erros };
}

module.exports = { raizTemporaria, reporFila, montarInbox, binarioFalso, socketFalso, subirServidor, espera };
