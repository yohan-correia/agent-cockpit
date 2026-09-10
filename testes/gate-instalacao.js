'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-install-'));
const projects = path.join(temp, 'workspace');
fs.mkdirSync(path.join(projects, 'exemplo'), { recursive: true });
fs.mkdirSync(path.join(projects, '.oculto'));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(COCKPIT_|CODEX_|CLAUDE|ANTHROPIC_|OPENAI_)/.test(key)) delete env[key];
Object.assign(env, { HOME: temp, HOST: '127.0.0.1', COCKPIT_PROJETOS_DIR: projects,
  COCKPIT_CERT_DIR: '/dev/null', COCKPIT_TMUX_SOCKET: `cockpit-install-${process.pid}`,
  COCKPIT_JOBS_DIR: path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`) }); // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
function request(p, route, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: p, path: route, headers }, res => {
      let text = ''; res.on('data', x => text += x); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    }).on('error', reject);
  });
}
async function withServer(extra, test) {
  const p = await port();
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...env, PORT: String(p), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout servidor')), 10000);
      child.stdout.on('data', data => { if (String(data).includes('cockpit-agentes em')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`servidor saiu ${code}`)); });
    });
    await test(p);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
  }
}
(async () => {
  for (const extra of [{ HOST: '0.0.0.0' }, { HOST: '0.0.0.0', COCKPIT_TOKEN: ' ' }, { COCKPIT_TLS_CERT: '/nao-existe' }, { COCKPIT_PROJETOS_DIR: './relativo' }, { COCKPIT_TLS_CERT: '/nao-existe', COCKPIT_TLS_KEY: '/nao-existe' }]) {
    const r = spawnSync(process.execPath, ['server.js'], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(r.status, 0, 'configuração insegura/inválida precisa falhar');
    assert.equal(r.signal, null, 'falha é validação, não timeout');
  }
  await withServer({}, async p => {
    const r = await request(p, '/api/projetos');
    assert.equal(r.status, 200);
    const semContato = await request(p, '/api/push/chave');
    assert.equal(semContato.status, 503);
    assert.match(semContato.text, /COCKPIT_CONTATO/);
    assert.equal(fs.existsSync(path.join(temp, '.cockpit/push/vapid.json')), false);
    assert.deepEqual(JSON.parse(r.text), { projetos: [{ nome: 'exemplo' }] });
    assert.deepEqual(JSON.parse((await request(p, '/api/jobs?tudo=1')).text), { jobs: [], painel: null, habilitado: false });
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal((await request(p, '/health', { Host: 'rebinding.example' })).status, 403);
    assert.equal((await request(p, '/api/projetos', { Origin: 'https://outro.example' })).status, 403);
    assert.equal((await request(p, '/', { Origin: `http://127.0.0.1:${p}` })).status, 200);
  });
  await withServer({ COCKPIT_TOKEN: 'fixture-token' }, async p => {
    assert.equal((await request(p, '/api/projetos')).status, 401);
    assert.equal((await request(p, '/api/projetos', { Authorization: 'Bearer errado' })).status, 401);
    assert.equal((await request(p, '/api/projetos', { Authorization: 'Bearer fixture-token' })).status, 200);
    assert.equal((await request(p, '/api/projetos?token=fixture-token')).status, 200, 'SSE pode usar query');
    assert.equal((await request(p, '/api/projetos', { Host: 'cockpit.example', Origin: 'https://cockpit.example', Authorization: 'Bearer fixture-token' })).status, 200, 'proxy preservando Host funciona');
    assert.equal((await request(p, '/api/projetos', { Origin: 'https://outro.example', Authorization: 'Bearer fixture-token' })).status, 403);
  });
  await withServer({ COCKPIT_CONTATO: 'mailto:teste@example.com' }, async p => {
    const resposta = await request(p, '/api/push/chave');
    assert.equal(resposta.status, 200);
    assert.ok(JSON.parse(resposta.text).chave);
    assert.equal(Object.hasOwn(JSON.parse(resposta.text), 'privada'), false);
  });
  const copy = path.join(temp, 'instalacao');
  fs.mkdirSync(path.join(copy, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(root, 'bin/instala-servico.js'), path.join(copy, 'bin/instala-servico.js'));
  fs.writeFileSync(path.join(copy, '.env'), 'HOST=127.0.0.1\n');
  const install = () => spawnSync(process.execPath, ['bin/instala-servico.js'], { cwd: copy, env, encoding: 'utf8' });
  assert.equal(install().status, 0);
  const unit = fs.readFileSync(path.join(temp, '.config/systemd/user/cockpit-agentes.service'), 'utf8');
  assert.ok(unit.includes(copy));
  assert.ok(unit.includes('--env-file=.env'));
  assert.notEqual(install().status, 0, 'não sobrescreve unit existente');
  console.log('GATE VERDE — instalação isolada, projetos configuráveis, token, origem e unit');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
