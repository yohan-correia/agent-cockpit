#!/usr/bin/env node
// Cockpit de Agentes — HTTP puro, zero dependência (mesmo padrão do painel-externo).
//
// O que ele é: a casca de conversa por cima das CLIs oficiais, para falar com os agentes
// do celular e do desktop. As CLIs continuam sendo quem roda — é o login delas que carrega
// a assinatura do usuário (docs/arquitetura.md, D2).
//
// O que ele NÃO é: o painel de jobs. Aquele é o `painel-externo` na 7878, só leitura, e
// continua intocado. Porta própria aqui para que um bug deste lado não derrube aquela tela.
//
// Transporte: SSE para receber, POST para enviar. O tráfego é assimétrico (muitos eventos
// descendo, uma frase subindo de vez em quando) e SSE reconecta sozinho no navegador —
// WebSocket traria handshake e reconexão manual sem ganho.
//
// Escuta em localhost por padrão. Acesso remoto depende da configuração da instância.

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { X509Certificate, randomUUID } = require('node:crypto');
const sessoes = require('./lib/sessoes');
const catalogo = require('./lib/catalogo');
const limite = require('./lib/limite');
const avisos = require('./lib/avisos');
const vigiaAbas = require('./lib/vigia-abas');
const abas = require('./lib/abas');
const agentes = require('./lib/agentes');
const externo = require('./lib/externo');
const contexto = require('./lib/contexto');
const statusCodex = require('./lib/status-codex');
const arquivos = require('./lib/arquivos');
const uso = require('./lib/uso');
const jobs = require('./lib/jobs');
const acesso = require('./lib/acesso');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 7879);
const HOST = process.env.HOST || '127.0.0.1';
// Obrigatório fora de localhost: /api exige "Authorization: Bearer <token>" ou ?token=.
// Sem token, o acesso fica restrito a localhost com validação de origem e Host.
const TOKEN = process.env.COCKPIT_TOKEN || '';
acesso.validarConfiguracao(HOST, TOKEN);
const RAIZ_PROJETOS = process.env.COCKPIT_PROJETOS_DIR || path.join(os.homedir(), 'projetos');
if (!path.isAbsolute(RAIZ_PROJETOS)) throw new Error('COCKPIT_PROJETOS_DIR precisa ser um caminho absoluto.');
// Whitelist FECHADA de `/api/uso?dias=`, não `Number()` livre (plano §2.1). Sem ela,
// `?dias=99999` faz o servidor somar 274 anos de agregado por request — mesma disciplina do
// whitelist de `projeto` em POST /api/abas.
const DIAS_ACEITOS = new Set([1, 7, 30]);

// HTTPS não é enfeite aqui: o navegador só libera service worker, instalação do app e
// notificação em contexto seguro (HTTPS ou localhost). Em `http://<ip>` o cockpit nunca
// vai passar de uma aba — o sw.js estava lá desde o início e jamais chegou a registrar.
//
// HTTPS pode terminar no proxy ou usar certificado e chave configurados nesta instância.
// Um par explicitamente configurado precisa ser válido; sem TLS configurado, usa HTTP.
const DIR_CERT = process.env.COCKPIT_CERT_DIR || path.join(os.homedir(), '.cockpit', 'cert');
if (Boolean(process.env.COCKPIT_TLS_CERT) !== Boolean(process.env.COCKPIT_TLS_KEY)) {
  throw new Error('Configure COCKPIT_TLS_CERT e COCKPIT_TLS_KEY juntos.');
}

function lerCertificado() {
  try {
    const cert = fs.readFileSync(process.env.COCKPIT_TLS_CERT || path.join(DIR_CERT, 'servidor.crt'));
    const key = fs.readFileSync(process.env.COCKPIT_TLS_KEY || path.join(DIR_CERT, 'servidor.key'));
    const nome = new X509Certificate(cert).subject.replace(/^CN=/, '').trim();
    return { cert, key, nome };
  } catch (e) {
    if (process.env.COCKPIT_TLS_CERT || process.env.COCKPIT_TLS_KEY) throw e;
    return null;
  }
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

function enviarJson(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(texto),
    'cache-control': 'no-store',
  });
  res.end(texto);
}

/**
 * Recusa ANTES de consumir o corpo (R58/R36): o cliente pode já estar mandando 2 GB quando
 * o 400/413/429/507 sai, e drenar isso tudo para manter o keep-alive seria pagar o upload
 * inteiro para dizer não. `connection: close`, o JSON, e o socket destruído no callback do
 * `res.end` — depois do flush, para o JSON ter chance de chegar antes do reset.
 */
function recusar(req, res, codigo, mensagem) {
  // É o SOCKET da resposta que diz se há para quem responder — não `req.destroyed`: depois
  // de um `pipeline` que terminou, o `IncomingMessage` já está destruído (autoDestroy) com o
  // socket vivo, e olhar o `req` deixaria a conexão pendurada sem resposta (visto no gate).
  const socket = res.socket;
  if (res.headersSent || res.destroyed || !socket || socket.destroyed) {
    if (socket && !socket.destroyed) socket.destroy();
    return;
  }
  const texto = JSON.stringify({ erro: mensagem });
  res.writeHead(codigo, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(texto),
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(texto, () => socket.destroy());
}

async function enviarArquivo(res, arquivo) {
  try {
    const dados = await fsp.readFile(arquivo);
    res.writeHead(200, {
      'content-type': TIPOS[path.extname(arquivo)] || 'application/octet-stream',
      'content-length': dados.length,
      'cache-control': 'no-cache',
    });
    res.end(dados);
  } catch {
    enviarJson(res, 404, { erro: 'nao encontrado' });
  }
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let bruto = '';
    req.on('data', (b) => {
      bruto += b;
      if (bruto.length > 1e6) {
        // `destroy` não é detalhe: sem ele a promessa rejeita mas o socket continua
        // despejando na memória até o cliente cansar.
        req.destroy();
        reject(new Error('corpo grande demais'));
      }
    });
    req.on('end', () => {
      try { resolve(bruto ? JSON.parse(bruto) : {}); } catch { reject(new Error('json inválido')); }
    });
  });
}

// Imagem de celular passa de 1 MB com folga, e o corpo do turno é JSON. Anexo vem cru,
// num caminho próprio, direto para o disco.
const TETO_ANEXO = 20 * 1024 * 1024;
const TIPOS_ANEXO = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

function lerBinario(req, teto) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let total = 0;
    req.on('data', (b) => {
      total += b.length;
      if (total > teto) {
        req.destroy();
        return reject(new Error(`arquivo maior que ${Math.round(teto / 1e6)} MB`));
      }
      pedacos.push(b);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(pedacos)));
  });
}

/** Projetos disponíveis para abrir sessão. Conveniência: evita digitar caminho no celular. */
async function listarProjetos() {
  const raiz = RAIZ_PROJETOS;
  try {
    const nomes = await fsp.readdir(raiz, { withFileTypes: true });
    return nomes
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ nome: d.name, cwd: path.join(raiz, d.name) }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  } catch {
    return [];
  }
}

// Jobs do orquestrador. Até 2026-09-10 quem sabia o estado de um job era o `painel-externo`
// (um serviço à parte, na 7878), e esta rota só fazia um `http.get` nele — o que deixava um
// recurso do cockpit dependendo de um programa que não está neste repositório. Quem clonasse
// não tinha o painel, `COCKPIT_PAINEL_JOBS` ficava vazia e o grupo de jobs nunca aparecia.
// Agora quem lê o disco é `lib/jobs.js`, aqui dentro. `COCKPIT_PAINEL_JOBS` não é mais lida
// por ninguém: virar fallback manteria de pé exatamente a dependência que esta entrega existe
// para matar.

// `?tudo=1` (spec 2026-09-08, §4.2) — quanto tempo um job ENCERRADO continua na lista depois
// de terminar. Medido contra os 169 jobs do disco em 08/09: 24h traz 11 encerrados (48h traria
// 14; 6h traria só 1). Trocável numa linha se o usuário quiser outro número — não é desenho novo.
const JANELA_ENCERRADOS_MS = 24 * 60 * 60 * 1000;
// §4.1.2 — teto de segurança do `?tudo=1`, e ele CEDE para quem exige ação: `running`,
// `blocked`, `orfao` e estado desconhecido nunca são cortados, só os encerrados (do mais
// antigo). Com os dados de hoje (16 linhas) o teto nem encosta — é rede, não regra do dia a dia.
const TETO_JOBS = 40;
// Os sete estados que o painel hoje emite (spec §2). Fora daqui é "desconhecido" — e
// desconhecido conta como PROTEGIDO (§4.2): o cockpit não sabe se ele exige ação, e no
// escuro se mostra, em vez de sumir ou fingir que sabe o que ele é.
const ESTADOS_CONHECIDOS = new Set(['running', 'done', 'teardown', 'failed', 'merged', 'blocked', 'orfao']);
// ALLOWLIST, não denylist (§4.1): `kind: null` (a linha do `status.log` que não bateu o
// formato esperado, `lib/jobs.js:97`) passaria por uma denylist `kind !== 'working'`
// carregando o TEXTO CRU do disco — medido: 1 job de 179 tem isso hoje. Allowlist protege do
// que o orquestrador inventar depois, sem avisar o cockpit.
const KINDS_DE_DESFECHO = new Set(['done', 'failed', 'blocked']);

// ─── SSE ─────────────────────────────────────────────────────────────────────

/**
 * Fluxo de eventos de uma sessão: primeiro o histórico inteiro (do disco), depois o ao vivo.
 * O cliente pode cair e voltar quando quiser — a verdade nunca esteve nele.
 */
async function abrirFluxo(req, res, id) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const mandar = (evento) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(evento)}\n\n`);
  };

  let acompanhando = null;
  try {
    const { meta, eventos } = await sessoes.historico(id);
    mandar({ tipo: 'sessao', meta });
    for (const evento of eventos) mandar(evento);

    const emAndamento = await sessoes.turnoEmAndamento(id);
    mandar({ tipo: 'sincronizado', turnoEmAndamento: emAndamento });

    if (emAndamento) {
      // Turno já rodando (o cliente chegou no meio): acompanha do início do arquivo.
      const arq = sessoes.arquivosDoTurno(id, emAndamento);
      acompanhando = sessoes.acompanhar(arq.saida, arq.codigo);
      acompanhando.on('evento', (e) => mandar({ ...e, turno: emAndamento }));
      acompanhando.on('fim', (f) => mandar({ tipo: 'turno_fim', ...f }));
    }
  } catch (erro) {
    mandar({ tipo: 'erro', mensagem: erro.message });
    return res.end();
  }

  // Novos turnos disparados enquanto este cliente está conectado.
  const aoTurno = ({ sessaoId, turno, arquivo, codigo }) => {
    if (sessaoId !== id) return;
    acompanhando?.parar?.();
    acompanhando = sessoes.acompanhar(arquivo, codigo);
    acompanhando.on('evento', (e) => mandar({ ...e, turno }));
    acompanhando.on('fim', (f) => mandar({ tipo: 'turno_fim', ...f }));
  };
  barramento.on('turno', aoTurno);

  // Sessão excluída embaixo dos pés deste cliente: sem isto, `acompanhar` ficaria
  // reagendando a cada 250ms para sempre, esperando um arquivo .code que nunca virá.
  const aoRemover = ({ sessaoId }) => {
    if (sessaoId !== id) return;
    acompanhando?.parar?.();
    mandar({ tipo: 'removida', id });
    res.end();
  };
  barramento.on('removida', aoRemover);

  const batida = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20000);
  req.on('close', () => {
    clearInterval(batida);
    barramento.off('turno', aoTurno);
    barramento.off('removida', aoRemover);
    acompanhando?.parar?.();
  });
}

/**
 * Acompanha o turno DO LADO DO SERVIDOR só para notificar no fim.
 *
 * Não dá para pendurar isso no fluxo SSE: o ponto da notificação é justamente o usuário
 * NÃO estar com a tela aberta. Sem um vigia próprio, o único caso em que o aviso sairia
 * seria aquele em que ele não é necessário.
 */
function vigiarParaAvisar(id, turno, arquivo, codigo) {
  const vigia = sessoes.acompanhar(arquivo, codigo);
  vigia.on('fim', async () => {
    vigia.parar?.();
    try {
      const meta = await sessoes.lerMeta(id);
      if (!meta) return;
      const { pergunta } = await sessoes.estado(meta, await sessoes.janelasPorSessao());
      const fecho = await sessoes.ultimoTextoDoTurno(id, turno);
      await avisos.avisar({
        titulo: pergunta ? `${meta.titulo} precisa de você` : `${meta.titulo}: terminou`,
        corpo: (fecho || '').replace(/\s+/g, ' ').trim().slice(0, 180) || 'Turno concluído.',
        sessaoId: id,
      });
    } catch (erro) {
      console.error('não deu para avisar:', erro.message);
    }
  });
}

/**
 * O fluxo de uma ABA do terminal.
 *
 * Diferente do fluxo de sessão do cockpit em dois pontos: a fonte é o arquivo do CLI (o
 * cockpit não gerou turno nenhum aqui, então não há `.ndjson` dele para acompanhar), e o
 * fim do turno não é um arquivo `.code` aparecendo — é a linha de status da TUI parando de
 * dizer "esc to interrupt". Por isso o par de relógios: um lê o que cresceu no arquivo,
 * outro pergunta se ainda está rodando.
 */
/**
 * Acompanha UMA aba. Não abre HTTP nenhum — `mandar(evento)` é quem entrega, `aoEncerrar()`
 * é quem avisa que esta aba morreu (o cano continua vivo para as outras, R5). Retorno
 * SÍNCRONO: `{ parar, bater }`. A inicialização (o `sessao` inicial, a leitura da cauda do
 * arquivo, os relógios) roda num runner assíncrono por dentro, e `parar()` já existe antes de
 * qualquer `await` — fechar a página no primeiro segundo não pode deixar relógio órfão.
 */
function acompanharAba(chave, mandar, aoEncerrar) {
  let morto = false;
  // Limpezas registradas conforme a inicialização avança — o que existe é encerrado, o que
  // ainda não existe (a página fechou antes do primeiro `await` terminar) não precisa de nada.
  const aoParar = [];
  const parar = () => {
    if (morto) return;
    morto = true;
    aoParar.forEach((fn) => fn());
  };
  // `bater(linha)` é o corpo do relogioEstado de hoje, recebendo a linha da aba em vez de ir
  // buscá-la — quem tem o `setInterval` de 2 s agora é o CANO (um por cano, não um por aba,
  // R22). Antes de o runner terminar, é no-op: o estado inicial ainda está sendo montado.
  let bater = () => {};
  const alvo = { parar, bater: (linha) => bater(linha) };

  (async () => {
    const aba = await abas.buscar(chave);
    if (morto) return;
    if (!aba) {
      mandar({ tipo: 'erro', mensagem: 'essa aba não está mais aberta no terminal' });
      return aoEncerrar();
    }

    // QUEM lê esta aba, resolvido UMA vez no topo do fluxo. O `server.js` deixa de saber de
    // qual CLI se trata: quem sabe é o registro, e as assinaturas casam de propósito (o
    // adaptador do Codex é espelho de `lib/externo.js` + `lib/contexto.js`, não do
    // `adaptador-claude.js`). Aba sem agente, ou com um id que não existe, cai no padrão — é o
    // fail-safe que mantém o duble do `gate-troca-arquivo.js` funcionando.
    const { leitor, medidor } = agentes.de(aba.agente);

    // Quanto da janela do agente já está ocupado. Sai junto do `sessao` porque é a mesma
    // identidade da conversa que o topo do chat desenha — título, pasta e "quanto ainda cabe".
    // Vem `null` quando a cauda do arquivo não tem `usage` reconhecível, e aí a tela
    // simplesmente não mostra o medidor. Ver lib/contexto.js.
    const ctxInicial = await medidor.doArquivo(aba.arquivo);
    if (morto) return;
    // A régua do "mudou" do relógio de baixo: uma STRING, não o objeto. Ela nasce com o
    // contexto que este `sessao` acabou de mandar — nunca `undefined`, nunca a chave de um
    // arquivo que não é o da tela. Sem isto, depois de um `/clear` a conversa nova herdaria a
    // chave da velha e o primeiro contexto de verdade seria engolido (armadilha #33).
    let ultimoContexto = contexto.chaveDoContexto(ctxInicial);
    mandar({
      tipo: 'sessao',
      // `sessaoId` viaja aqui e em toda troca de arquivo (ver `bater` abaixo): é o que o
      // cliente guarda para recusar `status_codex` de outra sessão (a guarda de identidade
      // do /status, spec `2026-09-08-resposta-status-codex-design.md`).
      meta: { titulo: aba.titulo, cwd: aba.cwd, contexto: ctxInicial, sessaoId: aba.sessaoId || null,
        reiniciada: Boolean(aba.reiniciada) },
    });

    // A janela longa é config do CLI, e config é I/O. Lida UMA vez por fluxo, aqui, onde já
    // nascem as outras coisas de vida longa do SSE: ler isso a cada 700 ms seria I/O novo pela
    // porta dos fundos, e ela não muda entre uma batida e outra.
    //
    // E só para o CLAUDE: o teto do Codex vem dentro do próprio rollout
    // (`model_context_window`), então toda a heurística de `[1m]`/200k/1M fica de fora — ler o
    // `settings.json` do Claude para desenhar o medidor de outro CLI seria a #40.
    const longa = aba.agente === 'claude' ? await contexto.janelaLongaConfigurada() : false;
    if (morto) return;

    let lido = 0;
    if (aba.arquivo) {
      // Leitura inicial é a CAUDA do arquivo, cortada por NÚMERO DE MENSAGENS, não por byte
      // (ver lib/externo.js). O maior .jsonl do disco tem 44 MB: despejar tudo fazia a
      // conversa inteira passar na tela do celular antes de dar para digitar. `cortado`
      // avisa a tela de que o começo ficou de fora — sem isso o usuário veria o histórico
      // começar no meio de um assunto sem saber por quê.
      const lida = await leitor.lerConversa(aba.arquivo, 0);
      if (morto) return;
      // `null` é a ABSTENÇÃO do leitor: o arquivo existe, as linhas parseiam, e o esquema é um
      // que ele não sabe ler (o Codex trocou o da fita inteiro em quatro semanas). Fita vazia
      // seria indistinguível de conversa nova, e mentiria; dizer que não sabe, não.
      if (lida === null) {
        mandar({ tipo: 'erro', mensagem: 'não sei ler esta conversa — o formato do CLI mudou' });
      } else {
        const { eventos, tamanho, cortado } = lida;
        if (cortado) mandar({ tipo: 'historico_cortado' });
        // D-b: a leitura inicial despeja a cauda inteira do histórico. Um `humano` que voltou
        // do disco é o servidor sabendo que aquele texto já saiu da fila — a pendente daquela
        // aba que casar com ele (por texto E por tempo) é consumida ANTES de reemitir nada.
        for (const evento of eventos) {
          if (evento.tipo === 'humano') abas.consumirPendente(chave, evento.texto, evento.quando);
          mandar(evento);
        }
        lido = tamanho;
      }
    } else {
      // Sem arquivo, a razão importa: a aba pode ter acabado de nascer (o CLI leva ~1,6 s
      // para escrever `~/.claude/sessions/<pid>.json`) ou o claude pode ter falhado em subir
      // nela. Texto fixo aqui é a #40 — descrever com uma frase só um estado que passou a ser
      // transitório. Continua `tipo: 'erro'`, que é o único tipo que o cliente sabe desenhar —
      // mas este ramo manda o evento DEPOIS do `sessao`, então ele SOBREVIVE ao `limparFita()`
      // do cliente (ao contrário do que este comentário dizia até 02/09: a bolha NÃO some
      // sozinha). É por isso que o servidor marca `nivel: 'aviso'` — estado, não falha —, e o
      // cliente aprende a diferença em vez de pintar tudo de vermelho (spec 2026-09-02,
      // Achado B). O campo é ADITIVO: cliente que não conhece `nivel` continua desenhando a
      // bolha de sempre.
      mandar({
        tipo: 'erro',
        nivel: 'aviso',
        mensagem: aba.nascendo
          ? 'o agente ainda está subindo nesta aba — o histórico aparece assim que ele abrir'
          : (aba.falhou
            ? 'o agente não subiu nesta aba, então não há histórico para mostrar'
            // As duas frases do casamento do Codex são DIFERENTES de propósito: "não achei
            // ainda" some sozinha nos ~5 s que o rollout leva para nascer; "não sei qual" não
            // some, e é o ponto. Colapsá-las numa só é a #40.
            : (aba.casamento === 'ambiguo'
              ? 'não deu para saber qual conversa é desta aba (duas abas de Codex no mesmo projeto)'
              : (aba.agente === 'codex'
                ? (aba.reiniciada ? 'Conversa limpa. Envie uma mensagem para começar.' : 'ainda não achei a conversa desta aba de Codex')
                : 'não achei o histórico desta aba no disco do CLI'))),
      });
    }
    let rodando = Boolean(aba.rodando);
    mandar({ tipo: 'sincronizado', turnoEmAndamento: rodando });

    // A pendente que sobrevive à reconexão (D-a/D-m). DEPOIS do `sincronizado`: o cliente
    // segura a fita num fragmento até ele (`public/app.js:863`, `despejarFita`) — emitido
    // antes, a bolha entraria no meio do histórico.
    //
    // Daqui até o fim do laço NÃO há `await`: o Node é uma thread só, então nenhum
    // `barramento.emit` de outro pedido consegue se intercalar entre registrar o ouvinte e ler
    // o registro. É isso que garante "nem perdido, nem duplicado" — sem fila de espera, sem
    // flag. Pôr um `await` no meio deste bloco reabre o buraco (R2).
    const aoPendente = (p) => { if (p.chave === chave) mandar({ tipo: 'pendente', ...p }); };
    barramento.on('pendente', aoPendente);
    aoParar.push(() => barramento.off('pendente', aoPendente));
    for (const p of abas.pendentesDe(chave)) mandar({ tipo: 'pendente', ...p });

    // O resultado de `/status`, publicado por sessão (nunca por aba: a mesma sessão pode ser
    // olhada de outra aba/aparelho reconectando). `aba.sessaoId` é lido no MOMENTO do evento,
    // não capturado agora — é o mesmo objeto que `bater` atualiza numa troca de arquivo,
    // então a guarda acompanha a identidade atual, nunca a velha. O listener registra ANTES
    // do replay assíncrono: um `status_codex` publicado durante a leitura do disco chega
    // pelos dois caminhos, e o cliente deduplica por `id` — perder é pior que duplicar aqui.
    const aoStatusCodex = (p) => {
      if (!morto && aba.agente === 'codex' && aba.sessaoId && p.sessaoId === aba.sessaoId) {
        mandar({ tipo: 'status_codex', ...p });
      }
    };
    barramento.on('status_codex', aoStatusCodex);
    aoParar.push(() => barramento.off('status_codex', aoStatusCodex));
    if (aba.agente === 'codex' && aba.sessaoId) {
      for (const snap of await statusCodex.snapshotsDe(aba.sessaoId)) {
        if (morto) return;
        mandar({ tipo: 'status_codex', id: snap.id, sessaoId: snap.sessaoId, quando: snap.quando, texto: snap.texto });
      }
    }
    if (morto) return;

    // Pergunta aberta na TUI: o `.jsonl` não sabe disto (o menu vive só na tela), então sem
    // este evento a fita fica muda e o cockpit dá a entender que não há nada acontecendo.
    //
    // Desde 09/09 o mesmo evento carrega o `preSessao` (o prompt de confiança de pasta nova),
    // porque o que o CLIENTE precisa fazer é idêntico nos dois: mostrar a tela da pane e
    // travar o Enviar. O que muda é só o TEXTO, e para isso vai o `motivo`. Canal novo aqui
    // seria um segundo relógio dizendo quase a mesma coisa — a D21 no servidor.
    let esperando = abas.podeVerTela(aba);
    let motivo = abas.motivoDaTela(aba);
    mandar({ tipo: 'esperando', valor: esperando, motivo });

    // Sobe de 1 toda vez que a aba passa a gravar em outro `.jsonl` (ver o `bater` abaixo).
    // Serve para o relógio de baixo saber que a leitura que ele tinha no ar é de um arquivo
    // que não é mais o da tela.
    let geracao = 0;

    // O arquivo é a conversa; olhar rápido nele é o que faz a resposta aparecer no celular
    // enquanto o agente ainda está escrevendo.
    const relogioArquivo = setInterval(async () => {
      if (morto || !aba.arquivo) return;
      const minha = geracao;
      try {
        const parcial = await leitor.lerConversa(aba.arquivo, lido, { contexto: { longa } });
        // No incremental o leitor não se abstém — o pedaço novo pode ser só um `token_count`, e
        // apagar a fita que já está na tela por causa disso seria pior que o silêncio.
        if (!parcial) return;
        const { eventos, tamanho, contexto: ctx } = parcial;
        // A leitura é assíncrona: o arquivo pode ter trocado enquanto ela estava no ar. Aí
        // tanto os eventos quanto o `tamanho` são do arquivo VELHO — gravar esse tamanho em
        // `lido` faria a conversa nova começar no meio, e mandar os eventos encheria de fala
        // antiga uma fita que o `sessao` acabou de limpar. Descartar a leitura inteira.
        if (minha !== geracao) return;
        lido = tamanho;
        // D-b, DENTRO do guarda de geração (R6/#33): consumir ANTES dele comeria a pendente
        // mesmo quando a leitura é de um arquivo velho que um `/clear` já descartou — a bolha
        // nunca teria sido desenhada e a mensagem sumiria de novo.
        for (const evento of eventos) {
          if (evento.tipo === 'humano') abas.consumirPendente(chave, evento.texto, evento.quando);
          mandar(evento);
        }
        // Daqui até o fim do bloco é SÍNCRONO, de propósito e por regra: ler a régua, decidir,
        // mandar e reescrever a régua são quatro passos sem um único `await` no meio. O
        // `setInterval` async já pode reentrar hoje (isso é de antes e não regride aqui); o que
        // impede duas batidas de intercalar "eu li a chave" com "o outro escreveu a chave" é
        // não haver ponto de suspensão entre elas. E tudo isto vive DEPOIS do guarda acima.
        //
        // `ctx` nulo nunca vira evento: um pedaço só com ferramenta não tem `usage`, e mandar
        // `null` esconderia o medidor no meio do turno para ele voltar no `turno_fim` —
        // pisca-pisca justo quando o usuário está olhando. Sem número novo, o topo continua com
        // o último conhecido, que é verdade.
        if (ctx) {
          const chaveCtx = contexto.chaveDoContexto(ctx);
          if (chaveCtx !== ultimoContexto) {
            mandar({ tipo: 'contexto', contexto: ctx });
            ultimoContexto = chaveCtx;
          }
        }
      } catch { /* arquivo sumiu ou está sendo reescrito: a próxima batida pega */ }
    }, 700);
    aoParar.push(() => clearInterval(relogioArquivo));

    // Já a TUI é cara de ler e muda devagar: 2s bastam para o "trabalhando" sumir na hora
    // certa sem ficar capturando tela o tempo todo. Quem chama `bater` de 2 em 2 segundos
    // agora é o CANO — uma `abas.listar()` só, para todas as abas dele (R22).
    bater = async (linha) => {
      if (morto) return;
      if (!linha) {
        mandar({ tipo: 'removida', id: chave });
        return aoEncerrar();
      }
      // `/clear` não mata a sessão do CLI: o processo continua o mesmo, mas ele passa a gravar
      // num sessionId novo — logo, em OUTRO `.jsonl`. O caminho resolvido na abertura do fluxo
      // para de crescer e a tela congela; sair da conversa e voltar "resolvia" só porque reabrir
      // o fluxo re-resolvia o arquivo. Reemitir `sessao` é o conserto: o cliente já limpa a fita
      // nesse evento, que é o mesmo que ele recebe ao abrir e ao reconectar.
      // O `&&` não é zelo à toa: quando o claude daquela aba morre, a aba continua na lista
      // mas sem arquivo nenhum (`arquivo: null`). Sem o guarda, isso contaria como troca e a
      // conversa que o usuário estava LENDO sumiria da tela — pior do que o defeito consertado.
      // Um `/clear` no Codex CONFIRMA-se por outro caminho: a aba fica sem arquivo e marcada
      // `reiniciada`. Sem este ramo, a troca não seria detectada e a guarda de identidade do
      // `/status` continuaria escopada na sessão velha (#33 pela porta do status).
      const clearConfirmado = linha.agente === 'codex' && linha.reiniciada
        && !linha.arquivo && Boolean(aba.arquivo || aba.sessaoId);
      if (clearConfirmado || (linha.arquivo && linha.arquivo !== aba.arquivo)) {
        // O contexto vem ANTES de mexer em qualquer estado, porque ele tem `await`: com a
        // troca no meio, o relógio do arquivo se intercalaria entre o reset e o `sessao` e a
        // tela ficaria com bolha órfã. Daqui para baixo é tudo síncrono, de uma vez.
        const ctx = await medidor.doArquivo(linha.arquivo);
        if (morto) return;
        geracao += 1;
        aba.arquivo = linha.arquivo;
        // A identidade que a guarda de `/status` compara.
        aba.sessaoId = linha.sessaoId || null;
        aba.agente = linha.agente;
        lido = 0;
        // O RESET da régua: a conversa nova começa com a chave do contexto DELA. Herdar a chave
        // da conversa velha faria o primeiro `contexto` de verdade ser engolido (#33).
        ultimoContexto = contexto.chaveDoContexto(ctx);
        mandar({
          tipo: 'sessao',
          meta: { titulo: linha.titulo, cwd: linha.cwd, contexto: ctx, sessaoId: aba.sessaoId,
            reiniciada: Boolean(linha.reiniciada) },
        });
        // D-j: sem isto a fita ficava MUDA depois de um `/clear` — `despejarFita()` só existe
        // no `case 'sincronizado'` (public/app.js:1658), e o cliente chama `segurarFita()` em
        // TODO `sessao` (public/app.js:770). É também o que deixa a pendente reemitida logo
        // abaixo cair na fita VIVA, e não presa no fragmento que o `sessao` acabou de segurar.
        rodando = Boolean(linha.rodando);
        mandar({ tipo: 'sincronizado', turnoEmAndamento: rodando });
        for (const p of abas.pendentesDe(chave)) mandar({ tipo: 'pendente', ...p });
        const sessaoReplay = aba.sessaoId;
        const geracaoReplay = geracao;
        if (aba.agente === 'codex' && sessaoReplay) {
          const snapshots = await statusCodex.snapshotsDe(sessaoReplay);
          if (!morto && geracaoReplay === geracao && aba.sessaoId === sessaoReplay) {
            for (const snapshot of snapshots) mandar({ tipo: 'status_codex', ...snapshot });
          }
        }
        // Nada mais neste tique: `esperando`/`turno_fim` falariam do arquivo que acabou de sair.
        return;
      }
      // O `motivo` entra na comparação de propósito: a aba SAI do `preSessao` e ENTRA no
      // `waiting` sem passar por falso no meio (o CLI publica a sessão já com um menu aberto),
      // e sem isto o cliente ficaria com o texto do prompt de confiança numa pergunta de
      // permissão. Estado igual com motivo diferente é estado diferente.
      const perguntando = abas.podeVerTela(linha);
      const motivoAgora = abas.motivoDaTela(linha);
      if (perguntando !== esperando || (perguntando && motivoAgora !== motivo)) {
        esperando = perguntando;
        motivo = motivoAgora;
        mandar({ tipo: 'esperando', valor: esperando, motivo });
      }
      const agora = Boolean(linha.rodando);
      if (agora === rodando) return;
      rodando = agora;
      // Turno acabou: o cliente fecha os cartões de ferramenta que ficaram abertos e volta a
      // deixar enviar. Começou: acende o "trabalhando".
      if (agora) {
        mandar({ tipo: 'sincronizado', turnoEmAndamento: true });
        return;
      }
      // Fim de turno é o único instante em que o número do contexto muda de verdade, e o
      // cliente JÁ recebe este evento: o medidor pega carona nele em vez de ganhar um relógio
      // próprio — dois relógios discordando entre si é problema que esta tela já teve (D21).
      mandar({ tipo: 'turno_fim', aba: chave, contexto: await medidor.doArquivo(linha.arquivo) });
    };
  })().catch((e) => {
    // R23: `parar()` calado deixaria o painel conectado e mudo para sempre. O cliente
    // precisa saber que ESTA aba morreu — o cano continua vivo para as outras.
    //
    // R34/#47: o `sessao` já pode ter saído ANTES desta exceção, então o cliente está com a
    // fita segura num fragmento fora da página. Só o `sincronizado` a despeja. Mandar só o
    // `erro` faria a bolha cair no fragmento invisível — quem segura tem que soltar no MESMO
    // caminho, inclusive no caminho da falha.
    mandar({ tipo: 'erro', mensagem: `não deu para acompanhar esta aba: ${e.message}` });
    mandar({ tipo: 'sincronizado', turnoEmAndamento: false });
    parar();
    console.error('acompanharAba', chave, e.message);
  });

  return alvo;
}

// Avisa os fluxos abertos que um turno novo começou.
const barramento = new (require('node:events').EventEmitter)();
barramento.setMaxListeners(0);

// ─── Rotas ───────────────────────────────────────────────────────────────────

async function api(req, res, rota, url) {
  if (TOKEN) {
    const enviado = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('token');
    if (!acesso.tokenIgual(enviado, TOKEN)) return enviarJson(res, 401, { erro: 'token inválido' });
  }

  // Rota MORTA desde a D17 — ninguém consumia. Ela ressuscita para o diálogo de abrir aba,
  // e volta no hábito da casa: só o NOME sai daqui. Quem resolve nome → caminho é o
  // servidor, e o navegador nunca vê `~/projetos/<x>`. É a #22 outra vez, e ela não
  // precisa ser reaprendida.
  if (rota === '/api/projetos' && req.method === 'GET') {
    return enviarJson(res, 200, { projetos: (await listarProjetos()).map(({ nome }) => ({ nome })) });
  }

  // A faixa de "tem job rodando" no topo do chat, e (com `?tudo=1`) o grupo JOBS da lista
  // lateral (spec 2026-09-08, §4.1/§4.2). Só os disparados pelo capitão: telegram e cli não
  // são trabalho que o usuário mandou desta tela e só fariam ruído — filtro mantido de propósito,
  // a decisão sobre alargá-lo continua em aberto (ver docs/arquitetura.md).
  //
  // Nada de `worktree`, `branch` ou `source_repo` em NENHUM dos dois ramos: mesmo hábito da
  // rota de arquivos — a árvore do disco não vai para o navegador.
  if (rota === '/api/jobs' && req.method === 'GET') {
    const dados = await jobs.listar();
    // Pasta de jobs inexistente é o estado NORMAL de quem clonou este repositório e não usa
    // orquestrador nenhum: `habilitado: false` é o mesmo contrato que a variável de ambiente
    // vazia produzia antes, e a tela desenha "nenhum job" em vez de um erro.
    if (dados && dados.ausente) return enviarJson(res, 200, { jobs: [], painel: null, habilitado: false });
    // `null` é a ABSTENÇÃO do leitor (a raiz existe e não deu para lê-la). Não é falha do
    // cockpit e não pode virar erro na tela — mesma resposta que o painel fora do ar dava.
    if (!dados || !Array.isArray(dados.jobs)) return enviarJson(res, 200, { jobs: [], painel: false });
    // Quem casa job com aba é o SERVIDOR: o casamento precisa do `cwd` de cada aba, e cwd
    // é caminho de disco — exatamente o que nunca sai daqui. O cliente recebe só a chave.
    const abertas = await abas.listar();
    const tudo = url.searchParams.get('tudo') === '1';
    const comArquivados = url.searchParams.get('arquivados') === '1';
    const doOrigin = dados.jobs.filter((j) => j && j.origin === 'capitao');
    // 🔴 A contagem é ANTES de esconder e DEPOIS de filtrar por origem: contar antes do filtro
    // somaria jobs que esta rota nunca mostra, e contar depois de esconder daria sempre zero.
    const nArquivados = doOrigin.filter((j) => j.arquivado).length;
    // Daqui para baixo ninguém mais lê `doOrigin`: quem foi arquivado só volta com
    // `?arquivados=1`, e um consumidor esquecido lá atrás é um vazamento silencioso.
    const visiveis = comArquivados ? doOrigin : doOrigin.filter((j) => !j.arquivado);

    // SEM `?tudo=1`: o caminho de HOJE, intocado — mesmo filtro, mesmos sete campos, mesma
    // ordem de chaves (o J1 do gate prova byte a byte). Só os que estão RODANDO: a faixa nunca
    // usou o resto, e o resto é quase tudo — com 70 jobs no histórico isto ia de 17 KB para
    // algumas centenas de bytes, a cada 15s, em celular, por tailnet.
    //
    // Depois desta entrega `atualizarFaixaJobs()` só pede `?tudo=1` — este ramo fica
    // PRESERVADO SEM CONSUMIDOR INTERNO, e é de propósito, não esquecido: a regra da casa
    // manda sinalizar código sem chamador em vez de apagar, a Fase 0 do card já tinha decidido
    // que a resposta de hoje não regride, e é o contrato que qualquer `curl` do usuário já
    // conhece.
    if (!tudo) {
      return enviarJson(res, 200, {
        jobs: visiveis
          .filter((j) => j.state === 'running')
          .map((j) => ({
            id: j.id, titulo: j.title, projeto: j.project, estado: j.state,
            // `etapa` é a última ação do agente, que o painel tira do fim do log do job.
            // Vem null quando o job ainda não agiu ou quando o log não diz nada — a faixa
            // trata os dois como "sem sinal" em vez de sumir.
            etapa: j.etapa || null,
            desde: j.created_at || null,
            // As abas do terminal cujo projeto é o deste job. Vazio = ele não é de nenhuma
            // conversa aberta e não aparece na faixa; quem mostra tudo é o painel /jobs.
            abas: abas.abasDoProjeto(j.project, abertas),
          })),
        painel: true,
      });
    }

    // `?tudo=1` — os sete estados do painel, e o que o cockpit não conhece também (§4.2):
    //   running, blocked, orfao          → sempre, SEM janela (são os que exigem AÇÃO)
    //   done, failed, merged, teardown   → só se terminaram dentro da JANELA
    //   estado fora dos sete             → entra sempre, como protegido — não dá para saber
    //                                       se exige ação, e no escuro se mostra
    const agora = Date.now();
    const comFim = visiveis.map((j) => {
      const protegido = j.state === 'running' || j.state === 'blocked' || j.state === 'orfao'
        || !ESTADOS_CONHECIDOS.has(j.state);
      return { j, fim: j.event?.at || null, protegido };
    });
    // 🔴 `j.arquivado` isenta da JANELA sem virar `protegido`: quem pediu `?arquivados=1`
    // quer ver justamente os velhos, e a janela de 24 h os cortaria na entrada. Mas mexer em
    // `protegido` mudaria o `rank` lá embaixo e faria um job arquivado subir na frente de um
    // `running` — a urgência não é a mesma coisa que a visibilidade.
    const naJanela = comFim.filter(({ j, fim, protegido }) => (
      protegido || j.arquivado || (fim && agora - new Date(fim).getTime() <= JANELA_ENCERRADOS_MS)
    ));

    const protegidos = naJanela.filter((x) => x.protegido);
    // O terceiro balde: pedidos explicitamente por `?arquivados=1`. Isento do teto pelo mesmo
    // motivo da janela — cortá-los devolveria uma lista incompleta a quem pediu a lista
    // completa, e sem dizer que cortou.
    const desarquivados = naJanela.filter((x) => !x.protegido && x.j.arquivado);
    // Mais novo primeiro — é o que deixa o corte do teto, abaixo, tirar sempre do FIM da lista.
    const encerrados = naJanela.filter((x) => !x.protegido && !x.j.arquivado)
      .sort((a, b) => new Date(b.fim).getTime() - new Date(a.fim).getTime());

    // O teto corta SÓ encerrados, do mais antigo, e CEDE se os protegidos já passarem dele
    // sozinhos (§4.1.2) — cortar quem exige ação recriaria a cegueira que a entrega existe
    // para matar.
    const vagas = Math.max(0, TETO_JOBS - protegidos.length - desarquivados.length);
    const selecionados = [...protegidos, ...desarquivados, ...encerrados.slice(0, vagas)];

    // Ordem por urgência (§4.2): running primeiro, depois blocked/orfao/desconhecido, depois
    // os encerrados por término decrescente. A lista de CONVERSAS não reordena — mas jobs não
    // têm ordem que o usuário saiba de cor, e aqui ordenar por urgência é o que serve.
    const rank = (x) => (x.j.state === 'running' ? 0 : x.protegido ? 1 : 2);
    selecionados.sort((a, b) => {
      const diferenca = rank(a) - rank(b);
      if (diferenca !== 0) return diferenca;
      if (rank(a) < 2) return 0; // dentro de running/protegido, mantém a ordem do painel
      return new Date(b.fim).getTime() - new Date(a.fim).getTime();
    });

    return enviarJson(res, 200, {
      jobs: selecionados.map(({ j, fim }) => ({
        id: j.id, titulo: j.title, projeto: j.project, estado: j.state,
        // `tipo` é o NOME da linha na tela (`ataca`, `ship`, …).
        tipo: j.type || null,
        etapa: j.etapa || null,
        desde: j.created_at || null,
        // Hora do TÉRMINO — é o que a janela dos encerrados mede. `null` para quem ainda não
        // terminou, ou cujo `status.log` não registrou um evento final legível.
        fim,
        // Substitui a `etapa` nula dos encerrados — só para os kinds da allowlist (ver a
        // constante). Chave SEMPRE presente, com valor `null`: ausente e vazio são a mesma
        // coisa (§4.1). O `?? null` importa — `JSON.stringify` APAGA chave com valor
        // `undefined` (`j.event.text` ausente viraria a chave sumindo, não `desfecho: null`).
        desfecho: KINDS_DE_DESFECHO.has(j.event?.kind) ? (j.event.text ?? null) : null,
        abas: abas.abasDoProjeto(j.project, abertas),
      })),
      painel: true,
      // Quantos ficaram de fora por idade — o número que a tela usa para oferecer
      // `?arquivados=1` sem ter de adivinhar se há algo escondido. SÓ neste ramo: o de cima é
      // comparado por `JSON.stringify` do objeto inteiro, e uma chave a mais lá quebra o
      // contrato que qualquer `curl` já conhece.
      arquivados: nArquivados,
    });
  }

  // As conversas que rodam nas abas do terminal do usuário, fora do cockpit. Leitura vem do
  // arquivo do CLI; escrita é `send-keys` na aba viva, sem criar processo. Ver lib/abas.js.
  if (rota === '/api/abas' && req.method === 'GET') {
    return enviarJson(res, 200, { abas: (await abas.listar()).map(abas.paraCliente) });
  }

  /**
   * Abrir uma aba nova no terminal do usuário.
   *
   * A rota LÊ `projeto` e IGNORA o resto do corpo — regra uniforme, e ela é a fronteira de
   * segurança inteira: o navegador manda o NOME, o servidor resolve o CAMINHO pelo
   * whitelist de `~/projetos`. `cwd` junto de um `projeto` válido é ignorado (a janela
   * nasce no caminho do projeto); `cwd` SEM `projeto` válido é 400 — não porque o `cwd`
   * incomoda, mas porque o `projeto` faltou. Caminho de disco vindo do cliente é a #22, e
   * o anexo já pagou esse preço uma vez.
   *
   * O casamento é por igualdade EXATA de string, sem normalizar: a lista vem de um
   * `readdir` de um diretório só, e o sistema de arquivos já garante nome único ali.
   * Normalizar criaria empate onde não há — `Projeto-a` e `projeto-a` seriam duas pastas
   * legítimas e diferentes.
   */
  if (rota === '/api/abas' && req.method === 'POST') {
    const corpo = await lerCorpo(req);
    const pedido = corpo && typeof corpo.projeto === 'string' ? corpo.projeto : '';
    const escolhido = (await listarProjetos()).find((p) => p.nome === pedido);
    if (!escolhido) return enviarJson(res, 400, { erro: 'escolha um projeto da lista' });
    // O agente segue a MESMA regra do projeto: ausente cai no padrão, fora da lista é 400.
    // A lista é o registro, e `existe()` é a função de validação — `de()` nunca devolve null
    // e serve para quem quer LER, não para quem quer saber a verdade.
    const agente = corpo && typeof corpo.agente === 'string' && corpo.agente
      ? corpo.agente : agentes.AGENTE_PADRAO;
    if (!agentes.existe(agente)) return enviarJson(res, 400, { erro: 'escolha um agente da lista' });
    try {
      return enviarJson(res, 201, await abas.criar({ cwd: escolhido.cwd, nome: escolhido.nome, agente }));
    } catch (erro) {
      // O `codigo` que o módulo pendura no erro é o que se traduz aqui — sem `regex` em
      // cima de mensagem. Erro SEM código é falha operacional de verdade: 500, e nunca
      // estado do mundo disfarçado.
      return enviarJson(res, erro.codigo || 500, { erro: erro.message });
    }
  }

  /**
   * Quais agentes o campo `Agente` oferece. Só `{id, rotulo}`.
   *
   * O caminho do binário NUNCA sai daqui — mesmo hábito da `/api/projetos`, que manda o
   * nome do projeto e nunca o `cwd` (#22). O navegador não precisa saber onde o `codex`
   * mora, e o dia em que precisar é o dia em que alguém pode escolher outro.
   */
  if (rota === '/api/agentes' && req.method === 'GET') {
    return enviarJson(res, 200, {
      agentes: agentes.ids().map((id) => ({ id, rotulo: agentes.de(id).rotulo })),
      padrao: agentes.AGENTE_PADRAO,
    });
  }

  /**
   * ── Arquivos: a porta de QUALQUER tipo até 2 GB, direto em ~/taildrop-inbox/<pasta>/ ──
   *
   * O clipe (`/api/abas/:chave/anexos`, logo abaixo) NÃO muda: continua nos 6 tipos e 20 MB,
   * com `lerBinario` — decisão do projeto ("não quero mudar o clip não"). Esta é outra porta,
   * com outra pasta e outro contrato: o corpo vai por stream para o disco (`lib/arquivos.js`),
   * a pasta é um NOME da lista que o servidor monta (R2), o nome do arquivo é lavado com a
   * extensão preservada (R7), e toda recusa antes do corpo fecha a conexão (R58).
   *
   * A ordem 429 → 413 → 507 vive inteira em `receber` (R44): a rota só mapeia a pasta e o
   * nome; não olha `content-length`. Erro com `codigo` vira status; sem código é 500 genérico
   * com o detalhe só no log (R42); cliente que sumiu não recebe resposta nenhuma.
   */
  if (rota === '/api/arquivos/pastas' && req.method === 'GET') {
    try {
      await arquivos.garantirTriagem();
    } catch (erro) {
      // O `mkdir -p` de `_triagem` falhou: permissão, disco só leitura, ou `_triagem` que não
      // é diretório (R50/R60). Sem ela a lista mente — melhor dizer.
      return enviarJson(res, erro.codigo || 500, { erro: erro.message });
    }
    try {
      return enviarJson(res, 200, { pastas: await arquivos.pastasDoInbox(), teto: arquivos.tetoDoUpload() });
    } catch (erro) {
      console.error('arquivos: inbox ilegível —', erro.message);
      return enviarJson(res, 500, { erro: 'não consegui ler o inbox' });
    }
  }

  if (rota === '/api/arquivos' && req.method === 'POST') {
    const nome = url.searchParams.get('nome') || '';
    if (!nome) return recusar(req, res, 400, 'falta o nome do arquivo');
    if (nome.length > 1024) return recusar(req, res, 400, 'nome grande demais');
    let pasta = null;
    try {
      pasta = await arquivos.pastaDeDestino(url.searchParams.get('pasta'));
    } catch (erro) {
      return recusar(req, res, erro.codigo || 500, erro.message);
    }
    if (!pasta) return recusar(req, res, 400, 'escolha uma pasta da lista');
    try {
      // 201 { nome, bytes, pasta } — `pasta` é o NOME, nunca o caminho (#22).
      return enviarJson(res, 201, await arquivos.receber({ req, pasta, nome }));
    } catch (erro) {
      // Cliente que sumiu (queda, silêncio, reset): não há para quem responder — só a
      // limpeza do módulo rodou. Pelo socket da RESPOSTA (ver `recusar`).
      if (res.destroyed || !res.socket || res.socket.destroyed) return undefined;
      if (!erro.codigo) console.error('arquivos: upload falhou —', erro);
      return recusar(req, res, erro.codigo || 500, erro.codigo ? erro.message : 'não consegui gravar o arquivo');
    }
  }

  // Um nível por vez, dentro de três raízes FECHADAS por id (R1). `caminho` ausente = a raiz.
  if (rota === '/api/arquivos/lista' && req.method === 'GET') {
    try {
      return enviarJson(res, 200, await arquivos.listar(url.searchParams.get('raiz') || '', url.searchParams.get('caminho') || ''));
    } catch (erro) {
      if (!erro.codigo) console.error('arquivos: lista falhou —', erro.message);
      return enviarJson(res, erro.codigo || 500, { erro: erro.codigo ? erro.message : 'não consegui listar' });
    }
  }

  /**
   * A localapi do tailscaled NÃO é contrato público (#10): o formato pode mudar numa
   * atualização do Tailscale. Por isso `fila` e `destinos` respondem 200 com `null` + `erro`
   * em vez de 5xx — a tela degrada SÓ aquele bloco, e o upload continua funcionando (R6).
   */
  if (rota === '/api/taildrop/fila' && req.method === 'GET') return enviarJson(res, 200, await arquivos.lerFila());
  if (rota === '/api/taildrop/destinos' && req.method === 'GET') return enviarJson(res, 200, await arquivos.destinos());

  if (rota === '/api/taildrop/puxar' && req.method === 'POST') {
    // Silêncio DESLIGADO logo antes de esperar a CLI (R39): enquanto o `file get` roda não
    // passa byte nenhum no socket. O limite aqui é o `timeout` do execFile e a trava de um por vez.
    req.setTimeout(0);
    try {
      return enviarJson(res, 200, await arquivos.puxar());
    } catch (erro) {
      if (!erro.codigo) console.error('arquivos: puxar falhou —', erro.message);
      return enviarJson(res, erro.codigo || 500, { erro: erro.codigo ? erro.message : 'não consegui puxar a fila' });
    }
  }

  if (rota === '/api/taildrop/enviar' && req.method === 'POST') {
    const corpo = await lerCorpo(req);
    const { raiz, caminho, destino } = corpo || {};
    if (typeof raiz !== 'string' || typeof caminho !== 'string' || typeof destino !== 'string') {
      return enviarJson(res, 400, { erro: 'raiz, caminho e destino têm que ser texto' });
    }
    // Só DEPOIS de ler o corpo e validar os três campos (R39): um JSON pela metade continua
    // caindo no silêncio geral — é o que o gate R31 prova justamente nesta rota.
    req.setTimeout(0);
    try {
      return enviarJson(res, 200, await arquivos.enviarParaFora({ raiz, caminho, destino }));
    } catch (erro) {
      if (!erro.codigo) console.error('arquivos: enviar falhou —', erro.message);
      return enviarJson(res, erro.codigo || 500, { erro: erro.codigo ? erro.message : 'não consegui enviar' });
    }
  }

  // UM cano de SSE, N abas — `?abas=a,b,c`. É o caminho do desktop (várias abas) e do
  // celular (uma só) ao mesmo tempo: um contrato, um decodificador (D29 — nada de rota viva
  // só para o celular enquanto o cliente de verdade abre outra).
  if (rota === '/api/eventos' && req.method === 'GET') {
    const chaves = [...new Set(
      (url.searchParams.get('abas') || '').split(',').map((s) => s.trim()).filter(Boolean),
    )];
    if (chaves.length === 0) return enviarJson(res, 400, { erro: 'abas= é obrigatório' });
    for (const chave of chaves) {
      if (!/^[\w-]+$/.test(chave)) return enviarJson(res, 400, { erro: `chave inválida: ${chave}` });
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const mandar = (envelope) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(envelope)}\n\n`);
    };
    const paradas = new Map();
    for (const chave of chaves) {
      paradas.set(chave, acompanharAba(
        chave,
        (e) => mandar({ aba: chave, evento: e }),
        () => paradas.get(chave)?.parar(),
      ));
    }
    // Um relógio de estado só para o cano inteiro (R22): `abas.listar()` varre o tmux UMA
    // vez por batida, não N — N `acompanharAba` liam a MESMA tabela N vezes por segundo.
    //
    // O `try` não é zelo à toa, e ele é NOVO: com um relógio por aba, uma exceção derrubava
    // um fluxo; consolidados num só, ela derruba os N painéis do cano — e, em Node 22,
    // rejeição não tratada dentro de um `setInterval(async …)` mata o PROCESSO. Consolidar
    // relógio aumenta o raio da falha, então o guarda entra junto. Batida que estourou é
    // batida perdida, e a próxima vem em 2 s.
    const relogioEstado = setInterval(async () => {
      if (res.writableEnded) return;
      try {
        const linhas = await abas.listar();
        if (res.writableEnded) return;
        for (const chave of chaves) {
          paradas.get(chave)?.bater(linhas.find((l) => l.chave === chave) || null);
        }
      } catch (e) {
        console.error('relógio de estado do cano:', e.message);
      }
    }, 2000);
    const batida = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20000);
    req.on('close', () => {
      clearInterval(relogioEstado);
      clearInterval(batida);
      for (const p of paradas.values()) p.parar();
    });
    return;
  }

  // A tela da pane — a ÚNICA leitura de TUI do projeto, e só com a aba em `waiting`.
  //
  // Por que ela existe: o menu de múltipla escolha do CLI não passa pelo `.jsonl`, então a
  // fita fica muda e a lista diz "no terminal", igual a uma aba livre (visto em 22/08). Por
  // que ela é travada: sem o 409, esta rota viraria um espelho geral do terminal na web, que
  // é exatamente o que a D4 e a D6 recusaram.
  /**
   * `/status` nativo do Codex, sem turno de modelo — rota DEDICADA, separada de
   * `/turnos`: nunca registra pendente, nunca marca a aba ocupada, e o corpo só aceita
   * `id` (dedupe). Anexo, comando ou cwd/sessão livres no corpo são 400 — o cliente nunca
   * escolhe QUAL comando roda aqui, só se pergunta ou não.
   *
   * Dedupe, captura e gravação acontecem dentro da mesma fila em abas.consultarStatus.
   */
  const mAbaStatus = rota.match(/^\/api\/abas\/([\w-]+)\/status$/);
  if (mAbaStatus && req.method === 'POST') {
    const chave = mAbaStatus[1];
    let corpo;
    try {
      corpo = await lerCorpo(req);
    } catch (erro) {
      return enviarJson(res, 400, { erro: erro.message });
    }
    if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return enviarJson(res, 400, { erro: 'corpo deve ser um objeto' });
    const camposExtras = Object.keys(corpo).filter((k) => k !== 'id');
    if (camposExtras.length) {
      return enviarJson(res, 400, { erro: 'este pedido só aceita o campo id' });
    }
    let { id } = corpo || {};
    if (id !== undefined && (typeof id !== 'string' || !abas.idValido(id))) {
      return enviarJson(res, 400, { erro: 'id de envio inválido' });
    }
    if (id === undefined) id = randomUUID();

    const aba = await abas.buscar(chave);
    if (!aba) return enviarJson(res, 404, { erro: 'aba não encontrada' });

    try {
      const snapshot = await abas.consultarStatus(chave, id);
      const atual = await abas.buscar(chave);
      if (!atual || atual.agente !== 'codex' || atual.sessaoId !== snapshot.sessaoId
        || atual.pane !== aba.pane || atual.arquivo !== aba.arquivo || atual.casamento === 'ambiguo') {
        return enviarJson(res, 409, { erro: 'a sessão mudou durante a consulta' });
      }
      barramento.emit('status_codex', {
        id: snapshot.id, sessaoId: snapshot.sessaoId, quando: snapshot.quando, texto: snapshot.texto,
      });
      return enviarJson(res, 200, {
        id: snapshot.id, sessaoId: snapshot.sessaoId, quando: snapshot.quando, texto: snapshot.texto,
      });
    } catch (erro) {
      if (!erro.codigo) console.error('status codex: falhou —', erro.message);
      return enviarJson(res, erro.codigo || 500, { erro: erro.codigo ? erro.message : 'não consegui consultar o status' });
    }
  }

  const mAbaTela = rota.match(/^\/api\/abas\/([\w-]+)\/tela$/);
  if (mAbaTela && req.method === 'GET') {
    const alvo = await abas.buscar(mAbaTela[1]);
    if (!alvo) return enviarJson(res, 404, { erro: 'aba não encontrada' });
    try {
      return enviarJson(res, 200, await abas.tela(alvo));
    } catch (erro) {
      // 409: estado do mundo ("não está esperando resposta"), não bug daqui.
      return enviarJson(res, 409, { erro: erro.message });
    }
  }

  // Responder o menu da TUI pelo celular: seta, Enter e Esc — e mais nada.
  //
  // A lista de teclas é FECHADA no módulo (lib/abas.js). Tecla livre vinda do navegador
  // seria teclado remoto, que é o que a D4 e a D6 recusaram; seta + Enter responde qualquer
  // menu sem o cockpit ter que ler o que está escrito na tela. Os dois códigos de recusa
  // dizem coisas diferentes de propósito: 400 é pedido malformado (tecla que não existe
  // aqui), 409 é estado do mundo (a aba não está com pergunta aberta).
  const mAbaTecla = rota.match(/^\/api\/abas\/([\w-]+)\/teclas$/);
  if (mAbaTecla && req.method === 'POST') {
    const { tecla } = await lerCorpo(req);
    if (!abas.teclaValida(tecla)) {
      return enviarJson(res, 400, { erro: `tecla não permitida: ${String(tecla).slice(0, 20)}` });
    }
    try {
      // A resposta traz a tela JÁ repintada: sem ela o usuário aperta a seta e não vê nada
      // mudar até a próxima batida da lista.
      return enviarJson(res, 200, await abas.tecla(mAbaTecla[1], tecla));
    } catch (erro) {
      const codigo = /aba não encontrada/.test(erro.message) ? 404 : 409;
      return enviarJson(res, codigo, { erro: erro.message });
    }
  }

  // Anexo do navegador para uma aba: corpo binário cru, tipo no content-type, nome na query.
  // Fica em ~/.cockpit/anexos/ e a mensagem recebe só o CAMINHO — o CLI abre com o Read.
  const mAbaAnexo = rota.match(/^\/api\/abas\/([\w-]+)\/anexos$/);
  if (mAbaAnexo && req.method === 'POST') {
    // A aba precisa existir: sem isto a rota seria um upload aberto para qualquer chave.
    if (!await abas.buscar(mAbaAnexo[1])) return enviarJson(res, 404, { erro: 'aba não encontrada' });
    const tipo = String(req.headers['content-type'] || '').split(';')[0].trim();
    const extensao = TIPOS_ANEXO[tipo];
    if (!extensao) return enviarJson(res, 415, { erro: `tipo não aceito: ${tipo || 'sem content-type'}` });
    const dados = await lerBinario(req, TETO_ANEXO);
    if (!dados.length) return enviarJson(res, 400, { erro: 'arquivo vazio' });
    const guardado = await abas.guardarAnexo({ nome: url.searchParams.get('nome'), extensao, dados });
    return enviarJson(res, 201, guardado);
  }

  const mAbaTurno = rota.match(/^\/api\/abas\/([\w-]+)\/turnos$/);
  if (mAbaTurno && req.method === 'POST') {
    const chave = mAbaTurno[1];
    const { texto, anexos, id } = await lerCorpo(req);
    // FORA do try: lá dentro o catch viraria isto em 409, que é "estado do mundo". Forma
    // errada de campo é pedido errado, e isso é 400. Dois significados no mesmo status
    // tiram do cliente a capacidade de mostrar o recado certo (D-n).
    if (id !== undefined && !abas.idValido(id)) {
      return enviarJson(res, 400, { erro: 'id de envio inválido' });
    }
    try {
      const { ficha, ...publico } = await abas.enviar(chave, texto, anexos || [], id);
      // Só avisa se a ficha AINDA estiver registrada: entre o `await` acima e esta linha o
      // relógio de 700ms pode ter lido o prompt do disco e consumido a ficha. Avisar depois
      // disso pintaria, nos outros aparelhos, a bolha "na fila" de uma mensagem que já está
      // na fita (D-m).
      if (abas.pendenteViva(chave, ficha)) barramento.emit('pendente', { chave, ...ficha });
      return enviarJson(res, 202, { ...publico, id: ficha?.id || publico.id });
    } catch (erro) {
      // 409 e não 500: "a aba não está rodando claude" é estado do mundo, não bug daqui —
      // e é o que o cliente precisa distinguir para mostrar o recado certo.
      return enviarJson(res, 409, { erro: erro.message });
    }
  }

  /**
   * Fechar uma aba do terminal — a primeira rota do cockpit que DESTRÓI trabalho.
   *
   * Casa `[\w-]+` como as outras (#17) e não colide com
   * `/api/abas/:chave/turnos/atual`: outro regex, outro método.
   *
   * As travas que importam moram no módulo (`lib/abas.js`): a última janela da sessão é
   * recusada com 409 — `kill-window` nela destrói a SESSÃO INTEIRA, medido em 27/08 —, e o
   * alvo é conferido contra `list-windows -t <SESSAO_DAS_ABAS>:`, então chave forjada só
   * alcança janela daquela sessão. Não há trava por ESTADO: matar aba `rodando` é
   * permitido, com aviso na tela, porque a D13 é explícita.
   */
  const mAbaMatar = rota.match(/^\/api\/abas\/([\w-]+)$/);
  if (mAbaMatar && req.method === 'DELETE') {
    try {
      return enviarJson(res, 200, await abas.matar(mAbaMatar[1]));
    } catch (erro) {
      return enviarJson(res, erro.codigo || 500, { erro: erro.message });
    }
  }

  // Parar o turno da aba: Escape na pane, que é a tecla que a própria TUI anuncia.
  const mAbaParar = rota.match(/^\/api\/abas\/([\w-]+)\/turnos\/atual$/);
  if (mAbaParar && req.method === 'DELETE') {
    try {
      return enviarJson(res, 200, await abas.interromper(mAbaParar[1]));
    } catch (erro) {
      return enviarJson(res, 409, { erro: erro.message });
    }
  }

  // Catálogo do autocomplete de "/". O cwd vem do meta.json da sessão (ou da aba do tmux),
  // NUNCA do cliente: caminho vindo do navegador é caminho que alguém escolhe.
  //
  // Duas origens porque são dois mundos. Numa SESSÃO do cockpit os nomes vêm do
  // `slash_commands` que o CLI publicou no init — é de lá que saem /clear e /context, que
  // não existem no disco. Numa ABA do terminal esse init não existe (o cockpit não criou
  // processo nenhum ali), então só o cwd é conhecido e os embutidos entram pela legenda do
  // lib/catalogo.js. Chave de aba que não existe mais responde o catálogo sem cwd, não 500:
  // aba fechada no terminal é estado do mundo, não erro daqui.
  if (rota === '/api/catalogo' && req.method === 'GET') {
    const idSessao = url.searchParams.get('sessao');
    const chaveAba = url.searchParams.get('aba');
    let cwd = null;
    let comandos = null;
    let agente = 'claude';
    if (idSessao) {
      const dados = await sessoes.uso(idSessao).catch(() => null);
      cwd = dados?.cwd || null;
      comandos = dados?.comandos || null;
    } else if (chaveAba) {
      const aba = await abas.buscar(chaveAba).catch(() => null);
      cwd = aba?.cwd || null;
      agente = aba?.agente || 'claude';
    }
    try {
      return enviarJson(res, 200, { itens: await catalogo.listar(cwd, comandos, agente) });
    } catch {
      return enviarJson(res, 503, { erro: 'Não consegui carregar o catálogo. Tente novamente.' });
    }
  }

  // Consumo do plano. `janelas` (Claude, do rate_limit_event) e `codex` são DE GRAÇA — leitura
  // de cauda de arquivo, nunca um turno. O `/usage` é a exceção: CUSTA UM TURNO, e por isso
  // só roda com `?forcar=1` (o botão "atualizar"); sem isso, no máximo se aproveita um cache
  // que já foi pago. É a lição do caso 73 (testes/gate-ui.js:7443) aplicada aos DOIS lados de
  // graça: os dois saem ANTES do try, e por isso vão nos dois ramos — o dado grátis não pode
  // sumir justo quando a Anthropic falha.
  if (rota === '/api/limite' && req.method === 'GET') {
    const codex = await abas.consumoDoCodex().catch(() => null);
    const janelas = await limite.dasJanelas().catch(() => null);
    const forcar = url.searchParams.get('forcar') === '1';
    if (!forcar) {
      const guardado = limite.emCache();
      return enviarJson(res, 200, { ...(guardado || { itens: [] }), janelas, codex });
    }
    try {
      const daAnthropic = await limite.consultar(true);
      return enviarJson(res, 200, { ...daAnthropic, janelas, codex });
    } catch (erro) {
      // Falhar aqui não pode derrubar o painel: ele ainda tem contexto e custo para mostrar.
      return enviarJson(res, 200, { itens: [], erro: String(erro.message).slice(0, 200), janelas, codex });
    }
  }

  // Para onde vão os tokens — quanto cada projeto/worktree gastou (card
  // `para-onde-vao-meus-tokens`). Vizinho temático de /api/limite: os dois falam de consumo,
  // um da assinatura como um todo, este do recorte por projeto. `DIAS_ACEITOS` é whitelist
  // fechada (topo do arquivo) — nunca `Number()` livre. Nenhum caminho de disco no corpo
  // (armadilha #22): `uso.relatorio()` já garante isso (G26).
  if (rota === '/api/uso' && req.method === 'GET') {
    const pedido = Number(url.searchParams.get('dias'));
    const dias = DIAS_ACEITOS.has(pedido) ? pedido : 1;
    return enviarJson(res, 200, await uso.relatorio({ dias }));
  }

  // O nível de esforço GLOBAL do CLI, para o painel de Configuração. É LEITURA e só: quem
  // escreve `effortLevel` é o próprio CLI, quando recebe um `/effort` (D14/D-c) — o cockpit
  // continua sem encostar na config viva dele.
  //
  // 200 SEMPRE, no padrão da /api/limite logo acima: falhar aqui não pode derrubar o painel
  // de Configuração, que ainda tem tema, link de acesso e consumo do plano para mostrar. Sem
  // o nível, a tela diz que não sabe (D22) em vez de sumir. Nenhum caminho de arquivo sai na
  // resposta, e nada aqui vem do cliente.
  if (rota === '/api/effort' && req.method === 'GET') {
    try {
      return enviarJson(res, 200, { nivel: await contexto.effortConfigurado() });
    } catch {
      return enviarJson(res, 200, { nivel: null });
    }
  }

  // Notificação no celular. A chave pública é o que o aparelho precisa para se inscrever;
  // a privada nunca sai do servidor.
  if (rota === '/api/push/chave' && req.method === 'GET') {
    try { return enviarJson(res, 200, { chave: avisos.chavePublica() }); }
    catch (erro) {
      if (erro.codigo === 503) return enviarJson(res, 503, { erro: erro.message });
      throw erro;
    }
  }
  if (rota === '/api/push/inscricao' && req.method === 'POST') {
    // O log é o que prova, do lado de cá, que o aparelho realmente chegou a pedir. Sem
    // ele a única evidência era a existência do arquivo — e "não existe" não distingue
    // "o POST nunca veio" de "veio e falhou".
    const corpo = await lerCorpo(req);
    try {
      const r = await avisos.inscrever(corpo);
      console.log(`push: inscrito ${new URL(corpo.endpoint).hostname} (${r.inscritos} no total)`);
      return enviarJson(res, 201, r);
    } catch (erro) {
      console.error('push: inscrição recusada:', erro.message);
      if (erro.codigo === 503) return enviarJson(res, 503, { erro: erro.message });
      throw erro;
    }
  }
  // "O cockpit conhece a inscrição que este aparelho tem?" — só isto, sim ou não. É a
  // pergunta que faltava no diagnóstico: permissão concedida e service worker ativo não
  // distinguem quem se inscreveu de quem assinou no navegador e nunca chegou a registrar
  // aqui. O endpoint vai no CORPO, não na query: ele é credencial e não pode virar linha
  // de log de acesso.
  if (rota === '/api/push/inscricao/consulta' && req.method === 'POST') {
    const { endpoint } = await lerCorpo(req);
    if (!endpoint) return enviarJson(res, 400, { erro: 'endpoint ausente' });
    return enviarJson(res, 200, await avisos.conhece(endpoint));
  }
  if (rota === '/api/push/inscricao' && req.method === 'DELETE') {
    const { endpoint } = await lerCorpo(req);
    return enviarJson(res, 200, await avisos.descadastrar(endpoint));
  }
  // Botão "testar" do cliente: prova o caminho inteiro sem precisar rodar um turno.
  if (rota === '/api/push/teste' && req.method === 'POST') {
    return enviarJson(res, 200, await avisos.avisar({
      titulo: 'Cockpit de Agentes',
      corpo: 'Se você está lendo isto no celular, a notificação funciona.',
      sessaoId: null,
      tag: 'teste',
    }));
  }

  if (rota === '/api/sessoes' && req.method === 'GET') {
    return enviarJson(res, 200, { sessoes: await sessoes.listar() });
  }

  if (rota === '/api/sessoes' && req.method === 'POST') {
    const { cwd, titulo } = await lerCorpo(req);
    return enviarJson(res, 201, await sessoes.criar({ cwd, titulo }));
  }

  // Anexo do navegador: corpo binário cru, tipo no content-type, nome na query. Fica em
  // ~/.cockpit/sessoes/<id>/anexos/ e o turno recebe só o CAMINHO.
  const mAnexo = rota.match(/^\/api\/sessoes\/([\w-]+)\/anexos$/);
  if (mAnexo && req.method === 'POST') {
    const tipo = String(req.headers['content-type'] || '').split(';')[0].trim();
    const extensao = TIPOS_ANEXO[tipo];
    if (!extensao) return enviarJson(res, 415, { erro: `tipo não aceito: ${tipo || 'sem content-type'}` });
    const dados = await lerBinario(req, TETO_ANEXO);
    if (!dados.length) return enviarJson(res, 400, { erro: 'arquivo vazio' });
    const guardado = await sessoes.guardarAnexo({
      id: mAnexo[1], nome: url.searchParams.get('nome'), extensao, dados,
    });
    return enviarJson(res, 201, guardado);
  }

  const mTurno = rota.match(/^\/api\/sessoes\/([\w-]+)\/turnos$/);
  if (mTurno && req.method === 'POST') {
    const { texto, modelo, anexos } = await lerCorpo(req);
    const id = mTurno[1];
    const emAndamento = await sessoes.turnoEmAndamento(id);
    if (emAndamento) return enviarJson(res, 409, { erro: 'já existe turno em andamento', turno: emAndamento });
    const { turno, arquivo, ressuscitada } = await sessoes.rodarTurno({ id, texto, modelo, anexos });
    const { codigo } = sessoes.arquivosDoTurno(id, turno);
    barramento.emit('turno', { sessaoId: id, turno, arquivo, codigo });
    vigiarParaAvisar(id, turno, arquivo, codigo);
    return enviarJson(res, 202, { turno, ressuscitada });
  }

  // Parar o turno no meio. Só a janela do turno morre; a conversa continua de pé e o
  // estado dela vira `interrompida`, que é o mesmo de um turno que morreu sozinho.
  const mCancelar = rota.match(/^\/api\/sessoes\/([\w-]+)\/turnos\/atual$/);
  if (mCancelar && req.method === 'DELETE') {
    const cancelado = await sessoes.cancelarTurno(mCancelar[1]);
    if (!cancelado) return enviarJson(res, 404, { erro: 'nenhum turno em andamento' });
    return enviarJson(res, 200, cancelado);
  }

  // Contexto, custo e modelo desta conversa. Relido do disco a cada pedido.
  const mUso = rota.match(/^\/api\/sessoes\/([\w-]+)\/uso$/);
  if (mUso && req.method === 'GET') {
    const dados = await sessoes.uso(mUso[1]);
    // A lista de comandos é do autocomplete, não do painel: 150 nomes por pedido à toa.
    const { comandos, ...resumo } = dados;
    return enviarJson(res, 200, resumo);
  }

  // Arquivos que o agente escreveu nesta conversa. A lista É a autorização do download.
  const mArquivos = rota.match(/^\/api\/sessoes\/([\w-]+)\/arquivos$/);
  if (mArquivos && req.method === 'GET') {
    const lista = await sessoes.arquivos(mArquivos[1]);
    // O caminho absoluto não sai daqui: o cliente só precisa do relativo, que é o que
    // ele devolve no download. Menos superfície, e nada de expor a árvore do disco.
    return enviarJson(res, 200, {
      arquivos: lista.map(({ caminho, ...resto }) => resto),
    });
  }

  const mBaixar = rota.match(/^\/api\/sessoes\/([\w-]+)\/arquivos\/baixar$/);
  if (mBaixar && req.method === 'GET') {
    const relativo = url.searchParams.get('caminho');
    if (!relativo) return enviarJson(res, 400, { erro: 'falta o caminho' });
    const achado = await sessoes.arquivoParaBaixar(mBaixar[1], relativo);
    const dados = await fsp.readFile(achado.caminho);
    res.writeHead(200, {
      'content-type': TIPOS[path.extname(achado.caminho)] || 'application/octet-stream',
      'content-length': dados.length,
      // attachment sempre: nunca renderizar no mesmo domínio arquivo escrito pelo agente.
      'content-disposition': `attachment; filename="${path.basename(achado.caminho).replace(/["\\]/g, '')}"`,
      'cache-control': 'no-store',
    });
    return res.end(dados);
  }

  const mEventos = rota.match(/^\/api\/sessoes\/([\w-]+)\/eventos$/);
  if (mEventos && req.method === 'GET') return abrirFluxo(req, res, mEventos[1]);

  const mSessao = rota.match(/^\/api\/sessoes\/([\w-]+)$/);
  if (mSessao && req.method === 'DELETE') {
    const id = mSessao[1];
    // Sem `?apagar=1` continua sendo só encerrar — a semântica antiga, que o gate 3 usa.
    if (url.searchParams.get('apagar') !== '1') {
      return enviarJson(res, 200, await sessoes.encerrar(id));
    }
    const resposta = await sessoes.excluir(id);
    barramento.emit('removida', { sessaoId: id });
    return enviarJson(res, 200, resposta);
  }

  return enviarJson(res, 404, { erro: 'rota desconhecida' });
}

const atender = async (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (!acesso.origemPermitida(req, TOKEN)) return enviarJson(res, 403, { erro: 'origem não permitida' });
  // Silêncio de 5 min por requisição (R31): substitui o `requestTimeout` de 5 min do Node —
  // que media DURAÇÃO total e matava um upload de 2 GB por 4G — por INATIVIDADE. `lerCorpo` e
  // `lerBinario` ficam cobertos sem uma linha neles; o SSE manda `: ping` a cada 20 s.
  req.setTimeout(arquivos.silencioGeral(), () => req.destroy());
  // O Tailscale publica isto sob um path (/cockpit), então o pathname chega com prefixo —
  // mesma armadilha que o painel-externo levou e corrigiu no commit a84cc96.
  const url = new URL(req.url, 'http://localhost');
  const rota = url.pathname.replace(/^\/cockpit(?=\/|$)/, '') || '/';

  try {
    // `requestTimeout` do Server VIVO (R48): é como o gate prova por comportamento, no servidor
    // que ele mesmo subiu, que o 0 do R3 está no objeto e não só no fonte.
    if (rota === '/health') {
      return enviarJson(res, 200, {
        ok: true, servico: 'cockpit-agentes', porta: PORT,
        requestTimeout: req.socket && req.socket.server ? req.socket.server.requestTimeout : null,
      });
    }
    if (rota.startsWith('/api/')) return await api(req, res, rota, url);
    if (rota === '/' || rota === '/index.html') return enviarArquivo(res, path.join(PUBLIC_DIR, 'index.html'));

    // Estático, preso ao public/: sem isso, "/../.." leria qualquer arquivo do usuário.
    const pedido = path.resolve(path.join(PUBLIC_DIR, rota));
    // Com separador: sem ele, "/home/x/publicoutro" passa por "/home/x/public".
    if (pedido !== path.resolve(PUBLIC_DIR) && !pedido.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
      return enviarJson(res, 403, { erro: 'fora do public' });
    }
    return enviarArquivo(res, pedido);
  } catch (erro) {
    if (!res.headersSent) return enviarJson(res, 500, { erro: String(erro && erro.message) });
    res.end();
  }
};

const certificado = lerCertificado();

/**
 * `requestTimeout = 0` (R3): o padrão do Node 22 é 5 min do primeiro byte ao último, e ele
 * derruba com 408 SEM LOG qualquer requisição mais longa — um upload de 2 GB por 4G morre no
 * meio e o cliente vê "falha de rede". Zero desliga o limite de DURAÇÃO; o que segura a porta
 * é o silêncio de `atender()` (inatividade) e os tetos de `lib/arquivos.js`. Tem que ser
 * escrito DEPOIS do `createServer`: `{ requestTimeout: 0 }` na opção cai no `|| 300000`.
 * `headersTimeout` (60 s) fica — ele mede só os cabeçalhos.
 */
function semTimeoutDeRequisicao(servidor) {
  servidor.requestTimeout = 0;
  return servidor;
}

if (!certificado) {
  semTimeoutDeRequisicao(http.createServer(atender)).listen(PORT, HOST, () => {
    console.log(`cockpit-agentes em http://${HOST}:${PORT}${TOKEN ? ' (token exigido)' : ''}`);
    console.log('HTTP local; para acesso remoto e PWA, configure HTTPS no servidor ou no proxy.');
    // O vigia das abas: quem manda a notificação de fim de turno e de pedido de intervenção.
    // Vive AQUI e não no fluxo SSE de propósito — o ponto da notificação é o usuário NÃO
    // estar com a tela aberta (o mesmo raciocínio de `vigiarParaAvisar`, :300).
    //
    // A posição NÃO protege teste nenhum: `server.js` sobe o `listen` no próprio `require`
    // (testes/gate-ui.js registra isso). Quem protege é a trava de `COCKPIT_CONTATO` do módulo.
    vigiaAbas.iniciar();
  });
} else {
  // Uma porta, dois esquemas. O primeiro byte de um handshake TLS é sempre 0x16; qualquer
  // outra coisa é HTTP em texto. Assim o link antigo (http://<ip>:7879) continua abrindo:
  // em vez de um erro ilegível de "conexão foi resetada", ele leva um redirect para o
  // endereço novo. Sem isso, todo bookmark e todo atalho salvo morreria calado.
  const seguro = semTimeoutDeRequisicao(https.createServer({ cert: certificado.cert, key: certificado.key }, atender));
  const redirecionador = semTimeoutDeRequisicao(http.createServer((req, res) => {
    res.writeHead(301, { location: `https://${certificado.nome}:${PORT}${req.url}` });
    res.end();
  }));

  net.createServer((socket) => {
    socket.once('data', (primeiro) => {
      socket.pause();
      socket.unshift(primeiro);
      (primeiro[0] === 0x16 ? seguro : redirecionador).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  }).listen(PORT, HOST, () => {
    console.log(`cockpit-agentes em https://${certificado.nome}:${PORT}${TOKEN ? ' (token exigido)' : ''}`);
    console.log(`http na mesma porta redireciona para o endereço seguro`);
    // Ver o comentário do ramo sem TLS acima. Produção roda ESTE ramo (30-caminhos.conf traz
    // COCKPIT_TLS_CERT/KEY), então fiar só o `if` deixaria a feature morta em produção.
    vigiaAbas.iniciar();
  });
}
