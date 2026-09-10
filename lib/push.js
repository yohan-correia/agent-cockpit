'use strict';
// Web Push — notificação no celular quando o agente termina ou pergunta algo.
//
// Escrito com o `crypto` do Node, sem dependência, como o resto do projeto. Não é
// teimosia: a alternativa seria arrastar uma árvore de node_modules para dentro de um
// serviço que hoje se instala copiando uma pasta.
//
// São duas criptografias diferentes, e confundir as duas é o erro clássico aqui:
//
//  1. VAPID (RFC 8292) — prova ao servidor de push (FCM, Mozilla) QUEM está mandando.
//     Um JWT ES256 assinado com a chave privada do cockpit.
//
//  2. Payload (RFC 8291) — cifra o conteúdo para que só o CELULAR leia. Nem o Google nem
//     a Mozilla veem o texto: a chave sai de um ECDH com a chave pública do aparelho.
//
// A implementação do item 2 é conferida contra o vetor de teste oficial do RFC 8291 §5,
// passo a passo (PRK_key, IKM, PRK, CEK, NONCE e corpo final). Sem isso seria fé.

const crypto = require('node:crypto');
const https = require('node:https');

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const deB64 = (txt) => Buffer.from(String(txt), 'base64url');

const hmac = (chave, dados) => crypto.createHmac('sha256', chave).update(dados).digest();

/** HKDF do RFC 5869 com uma única iteração — é tudo que o Web Push usa. */
const derivar = (prk, info, tamanho) =>
  hmac(prk, Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, tamanho);

/** Par de chaves do servidor de aplicação. Gerado uma vez e guardado no disco. */
function gerarVapid() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publica: b64(publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)),
    privada: b64(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(36, 68)),
  };
}

/** Objeto de chave privada EC a partir dos 32 bytes crus. */
function chavePrivadaDe(privadaCrua) {
  const ec = crypto.createECDH('prime256v1');
  ec.setPrivateKey(deB64(privadaCrua));
  return crypto.createPrivateKey({
    key: Buffer.concat([
      // Cabeçalho PKCS#8 de uma chave EC P-256: constante, e é o jeito de entrar no
      // mundo de objetos de chave do Node partindo de 32 bytes soltos.
      Buffer.from('308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'),
      // O cabeçalho acima termina em `0420`: "seguem 32 bytes". Mas o OpenSSL devolve o
      // valor SEM zeros à esquerda, então uma chave que começa com zero volta com 31 bytes
      // e o DER passa a mentir sobre o próprio tamanho. É ~1 em cada 256 chaves geradas:
      // raro o bastante para nunca cair num teste, frequente o bastante para acontecer —
      // e o estrago seria uma instalação de push nascida morta, sem erro nenhum na tela.
      Buffer.concat([Buffer.alloc(32), ec.getPrivateKey()]).subarray(-32),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * Cifra o payload para um aparelho (RFC 8291, content-encoding aes128gcm).
 *
 * `efemera` e `salt` só são passados nos testes: em produção são sempre novos, e reusar
 * qualquer um dos dois quebraria o sigilo.
 */
function cifrar({ p256dh, auth, texto, efemera = null, salt = null }) {
  const uaPublica = deB64(p256dh);
  const segredoAuth = deB64(auth);

  const ec = crypto.createECDH('prime256v1');
  if (efemera) ec.setPrivateKey(deB64(efemera));
  else ec.generateKeys();
  const asPublica = ec.getPublicKey();
  const compartilhado = ec.computeSecret(uaPublica);

  const semente = salt ? deB64(salt) : crypto.randomBytes(16);

  // A ordem aqui é do RFC e não é intuitiva: primeiro o auth do aparelho vira a chave do
  // HMAC, e o segredo do ECDH vira a mensagem. Trocar os dois "funciona" e produz lixo.
  const prkChave = hmac(segredoAuth, compartilhado);
  const infoChave = Buffer.concat([
    Buffer.from('WebPush: info\0'), uaPublica, asPublica,
  ]);
  const ikm = derivar(prkChave, infoChave, 32);
  const prk = hmac(semente, ikm);
  const cek = derivar(prk, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = derivar(prk, 'Content-Encoding: nonce\0', 12);

  // 0x02 marca o último (e único) registro. Sem esse byte o aparelho descarta a mensagem.
  const claro = Buffer.concat([Buffer.from(texto, 'utf8'), Buffer.from([2])]);
  const cifra = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const cifrado = Buffer.concat([cifra.update(claro), cifra.final(), cifra.getAuthTag()]);

  const cabecalho = Buffer.alloc(5);
  cabecalho.writeUInt32BE(4096, 0);   // tamanho de registro
  cabecalho.writeUInt8(asPublica.length, 4);
  return Buffer.concat([semente, cabecalho, asPublica, cifrado]);
}

/** JWT ES256 do VAPID: diz ao servidor de push quem manda, e vale por 12 horas. */
function jwtVapid({ audiencia, contato, privada }) {
  const cabecalho = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const corpo = b64(JSON.stringify({
    aud: audiencia,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: contato,
  }));
  const assinado = `${cabecalho}.${corpo}`;
  // ieee-p1363 é obrigatório: o padrão do Node é DER, e JWT quer r||s cru. Com DER o
  // push server responde 401 sem dizer por quê.
  const assinatura = crypto.sign('sha256', Buffer.from(assinado), {
    key: chavePrivadaDe(privada),
    dsaEncoding: 'ieee-p1363',
  });
  return `${assinado}.${b64(assinatura)}`;
}

/**
 * Manda a notificação. Devolve o status HTTP do servidor de push.
 *
 * 404 e 410 querem dizer que o aparelho descadastrou (app desinstalado, permissão
 * revogada). Quem chama deve apagar a inscrição nesses casos, senão a lista só cresce.
 */
function enviar({ inscricao, texto, vapid, contato, ttl = 3600 }) {
  const alvo = new URL(inscricao.endpoint);
  const corpo = cifrar({ p256dh: inscricao.keys.p256dh, auth: inscricao.keys.auth, texto });
  const jwt = jwtVapid({ audiencia: alvo.origin, contato, privada: vapid.privada });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: alvo.hostname,
      port: alvo.port || 443,
      path: alvo.pathname + alvo.search,
      method: 'POST',
      timeout: 15000,
      headers: {
        authorization: `vapid t=${jwt}, k=${vapid.publica}`,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        'content-length': corpo.length,
        ttl: String(ttl),
        urgency: 'normal',
      },
    }, (res) => {
      let resposta = '';
      res.on('data', (d) => { resposta += d; });
      res.on('end', () => resolve({ status: res.statusCode, corpo: resposta.slice(0, 300) }));
    });
    req.on('timeout', () => { req.destroy(new Error('o servidor de push não respondeu')); });
    req.on('error', reject);
    req.end(corpo);
  });
}

module.exports = { gerarVapid, cifrar, jwtVapid, enviar, chavePrivadaDe };
