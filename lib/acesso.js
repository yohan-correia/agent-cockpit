'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');

const loopback = host => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);

function validarConfiguracao(host, token) {
  if (!loopback(host) && !token.trim()) {
    throw new Error('Defina COCKPIT_TOKEN antes de escutar fora de localhost.');
  }
}

function origemPermitida(req, token) {
  let destino;
  try { destino = new URL(`http://${req.headers.host}`); } catch { return false; }
  // Sem autenticação, não aceite um hostname que possa resolver para loopback por DNS.
  if (!token && !loopback(destino.hostname)) return false;
  if (!req.headers.origin) return true; // CLI e navegação local não enviam Origin.
  try {
    const origem = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(origem.protocol) && origem.host === destino.host;
  } catch { return false; }
}

function tokenIgual(recebido, esperado) {
  const hash = valor => createHash('sha256').update(String(valor || '')).digest();
  return timingSafeEqual(hash(recebido), hash(esperado));
}

module.exports = { validarConfiguracao, origemPermitida, tokenIgual };
