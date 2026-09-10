'use strict';
// Quem recebe as notificações, e quando disparar.
//
// A parte de criptografia mora em lib/push.js. Aqui é a parte chata e necessária: guardar
// as inscrições dos aparelhos, decidir o texto do aviso e limpar o que morreu.
//
// Estado no disco, como todo o resto do cockpit: um restart do serviço não pode fazer o
// celular parar de receber.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const push = require('./push');

// Sobrescrito nos testes, para o gate não mexer nas inscrições de verdade do usuário.
const DIR = process.env.COCKPIT_PUSH_DIR || path.join(os.homedir(), '.cockpit', 'push');
const ARQ_VAPID = path.join(DIR, 'vapid.json');
const ARQ_INSCRICOES = path.join(DIR, 'inscricoes.json');
function contato() {
  const valor = (process.env.COCKPIT_CONTATO || '').trim();
  let valido = /^mailto:[^@\s]+@[^@\s]+$/.test(valor);
  try {
    const url = new URL(valor);
    valido ||= url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { /* a mensagem abaixo explica como configurar */ }
  if (!valido) throw Object.assign(new Error(
    'Configure COCKPIT_CONTATO com mailto:seu-email ou uma URL HTTPS de contato para ativar notificações.'
  ), { codigo: 503 });
  return valor;
}

/**
 * As chaves do servidor, criadas na primeira vez e nunca mais.
 *
 * Trocar esse par invalida TODAS as inscrições já feitas: o aparelho guarda a chave
 * pública no momento em que se inscreve, e o push server recusa um remetente diferente.
 * Por isso o arquivo é criado uma vez e só lido depois.
 */
function chaves() {
  try {
    return JSON.parse(fs.readFileSync(ARQ_VAPID, 'utf8'));
  } catch {
    fs.mkdirSync(DIR, { recursive: true });
    const novas = push.gerarVapid();
    fs.writeFileSync(ARQ_VAPID, JSON.stringify(novas, null, 2), { mode: 0o600 });
    return novas;
  }
}

async function inscricoes() {
  try {
    return JSON.parse(await fsp.readFile(ARQ_INSCRICOES, 'utf8'));
  } catch {
    return [];
  }
}

async function gravar(lista) {
  await fsp.mkdir(DIR, { recursive: true });
  await fsp.writeFile(ARQ_INSCRICOES, JSON.stringify(lista, null, 2), { mode: 0o600 });
}

/** O endpoint identifica o aparelho: reinscrever no mesmo celular atualiza, não duplica. */
async function inscrever(inscricao) {
  contato();
  if (!inscricao?.endpoint || !inscricao?.keys?.p256dh || !inscricao?.keys?.auth) {
    throw new Error('inscrição incompleta');
  }
  const lista = (await inscricoes()).filter((i) => i.endpoint !== inscricao.endpoint);
  lista.push({
    endpoint: inscricao.endpoint,
    keys: { p256dh: inscricao.keys.p256dh, auth: inscricao.keys.auth },
    aparelho: String(inscricao.aparelho || '').slice(0, 80),
    criadoEm: new Date().toISOString(),
  });
  await gravar(lista);
  return { inscritos: lista.length };
}

/**
 * O cockpit já conhece esta inscrição?
 *
 * Serve ao diagnóstico da tela: "permissão granted + sw ativo" não distingue um aparelho
 * que se inscreveu de um que assinou no PushManager e nunca conseguiu registrar aqui — e
 * era essa a dúvida que sobrava quando o botão falhava com "Failed to fetch".
 *
 * Só responde sim/não sobre um endpoint que o aparelho já tem: não devolve a lista, que é
 * credencial dos outros aparelhos.
 */
async function conhece(endpoint) {
  const lista = await inscricoes();
  return { conhecida: lista.some((i) => i.endpoint === endpoint), inscritos: lista.length };
}

async function descadastrar(endpoint) {
  const lista = await inscricoes();
  const restante = lista.filter((i) => i.endpoint !== endpoint);
  await gravar(restante);
  return { removidos: lista.length - restante.length, inscritos: restante.length };
}

/**
 * Manda o aviso para todos os aparelhos inscritos.
 *
 * 404 e 410 significam inscrição morta — app desinstalado, permissão revogada, navegador
 * limpo. Some da lista na hora: sem isso ela só cresce e cada turno vira uma rajada de
 * requisições para endpoints que não existem mais.
 */
async function avisar({ titulo, corpo, sessaoId, tag }) {
  const lista = await inscricoes();
  if (!lista.length) return { enviados: 0, removidos: 0 };

  const remetente = contato();
  const vapid = chaves();
  const texto = JSON.stringify({ titulo, corpo, sessaoId, tag: tag || sessaoId });
  const mortos = [];
  let enviados = 0;

  await Promise.all(lista.map(async (inscricao) => {
    try {
      const { status } = await push.enviar({ inscricao, texto, vapid, contato: remetente });
      if (status === 404 || status === 410) mortos.push(inscricao.endpoint);
      else if (status >= 200 && status < 300) enviados += 1;
      else console.error(`push devolveu ${status} para ${new URL(inscricao.endpoint).hostname}`);
    } catch (erro) {
      console.error('push falhou:', erro.message);
    }
  }));

  if (mortos.length) await gravar(lista.filter((i) => !mortos.includes(i.endpoint)));
  return { enviados, removidos: mortos.length };
}

/** Só o que o aparelho precisa saber para se inscrever. A chave privada não sai daqui. */
const chavePublica = () => { contato(); return chaves().publica; };

module.exports = { chavePublica, inscrever, descadastrar, inscricoes, avisar, conhece };
