#!/usr/bin/env python3
# Fase 6 do plano `docs/superpowers/plans/2026-09-10-menu-da-tui-do-codex-na-tela-plano.md`:
# smoke ISOLADO da TUI do Codex + os prints, no MESMO ciclo de vida — a TUI só morre no
# `finally`, DEPOIS dos prints (achado 5 do painel do plano: fundir as duas evitava a versão
# anterior, que prometia prints "com a TUI ainda no ar" numa fase que já a tinha matado).
#
# TUI real, CODEX_HOME/cwd/socket isolados, provider HTTP local — molde exato de
# `testes/smoke-clear-codex.py`. Com a MESMA TUI viva e o menu aberto, sobe DOIS cockpits de
# teste apontados para o socket dela: o "depois" (código real, com a mudança) e o "antes" (a
# régua de `lib/menu-codex.js` forçada para `'livre'` em memória — NUNCA o arquivo é tocado —,
# reproduzindo o comportamento de antes desta entrega, em que o Codex saía sempre
# `esperando: false`). Os quatro prints (celular 390×844 + desktop 1600×1000, nos dois
# estados) saem com puppeteer/docker — viewport de `testes/smoke-celular-split.js:79-86`,
# esqueleto de servidor de `testes/smoke-navegador-abas.js`.
#
# Portas: 7897 (cockpit "depois") e 7898 (cockpit "antes"). NUNCA 7879 (produção), 7899
# (jobs), 7896/7893 (outros smokes).
#
# Não entra no `bin/testes.js` (roda à mão, contra Codex real — offline demais para o
# `npm test`). Evidências (PNGs) ficam em /tmp/cockpit-menu-codex-prints-<pid>, impresso ao
# final; a pasta de trabalho da TUI (CODEX_HOME/cwd/sessões) fica em /tmp/cockpit-menu-codex-*
# e NÃO é apagada, para inspeção — mesmo hábito de `smoke-clear-codex.py`.
#
# Códigos de saída: 0 = tudo verde · 1 = defeito · 2 = ambiente indisponível.

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

repo = Path(__file__).resolve().parents[1]
IMAGEM = os.environ.get('IMAGEM', 'cockpit-smoke:latest')
PORTA_DEPOIS = 7897
PORTA_ANTES = 7898

falhas = []


def ok(cond, texto):
    print(f"  {'✅' if cond else '❌'} {texto}", flush=True)
    if not cond:
        falhas.append(texto)
    return cond


def porta_livre(porta):
    r = subprocess.run(['ss', '-lptn', f'sport = :{porta}'], capture_output=True, text=True)
    return not re.search(rf':{porta}\s', r.stdout)


# ─── Checagens de ambiente, ANTES de criar qualquer coisa ────────────────────

try:
    subprocess.run(['docker', 'image', 'inspect', IMAGEM],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
except Exception:
    print(f'🟡 ambiente indisponível: a imagem docker {IMAGEM} não existe.')
    sys.exit(2)

codex_bin = os.environ.get('COCKPIT_BIN_CODEX') or shutil.which('codex')
if not codex_bin:
    print('🟡 ambiente indisponível: instale Codex CLI ou defina COCKPIT_BIN_CODEX.')
    sys.exit(2)

for porta in (PORTA_DEPOIS, PORTA_ANTES):
    if not porta_livre(porta):
        print(f'🔴 a porta {porta} já está em uso — abortando antes de tocar em nada.')
        sys.exit(1)

# ─── O provider HTTP local — zero token real, molde de smoke-clear-codex.py ──

root = Path(tempfile.mkdtemp(prefix='cockpit-menu-codex-'))
home = root / 'home'
cwd = root / 'cwd'
home.mkdir()
cwd.mkdir()
calls = []


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body_len = int(self.headers.get('Content-Length', '0'))
        self.rfile.read(body_len)
        calls.append(self.path)
        item = {'id': 'msg_fixture', 'type': 'message', 'role': 'assistant', 'status': 'completed',
                 'content': [{'type': 'output_text', 'text': 'OK', 'annotations': []}]}
        resp = {'id': 'resp_fixture', 'object': 'response', 'created_at': int(time.time()),
                'status': 'completed', 'model': 'mock', 'output': [item],
                'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}
        events = [
            {'type': 'response.created', 'response': {**resp, 'status': 'in_progress', 'output': []}},
            {'type': 'response.output_item.added', 'output_index': 0,
             'item': {**item, 'status': 'in_progress', 'content': []}},
            {'type': 'response.output_text.delta', 'item_id': 'msg_fixture', 'output_index': 0,
             'content_index': 0, 'delta': 'OK'},
            {'type': 'response.output_text.done', 'item_id': 'msg_fixture', 'output_index': 0,
             'content_index': 0, 'text': 'OK'},
            {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
            {'type': 'response.completed', 'response': resp},
        ]
        data = ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
(home / 'config.toml').write_text(
    f'model="mock"\nmodel_provider="mock"\n[projects."{cwd}"]\ntrust_level="trusted"\n'
    f'[model_providers.mock]\nname="Fixture local"\nbase_url="http://127.0.0.1:{srv.server_port}/v1"\n'
    f'env_key="COCKPIT_TEST_API_KEY"\nwire_api="responses"\n'
)

# Passo 1b do plano — pré-gravar version.json ANTES de subir a TUI: sem isto o prompt
# "Update available" toma a tela, e já causou um `npm install -g` acidental numa medição
# anterior (o CLI não sai dele com Escape).
(home / 'version.json').write_text(json.dumps({
    'latest_version': '0.153.4',
    'last_checked_at': '2099-01-01T00:00:00Z',
    'dismissed_version': '0.154.0',
}))

sock = 'cockpit-menu-codex-' + str(os.getpid())
base = ['tmux', '-L', sock, '-f', '/dev/null']


def tm(*a):
    return subprocess.check_output(base + list(a), text=True)


# Os PNGs NÃO vão para /tmp: a limpeza da máquina os come, e prova que some não é prova.
# `~/.cockpit/smoke-shots/` é a pasta da casa para print de smoke; SMOKE_SHOTS a sobrescreve.
SAIDA = Path(os.environ.get('SMOKE_SHOTS')
             or (Path.home() / '.cockpit' / 'smoke-shots')) / f'menu-codex-{os.getpid()}'
s3_depois = None
s3_antes = None
saida_codigo = 1


def aguardar_saude(porta, processo, tentativas=60):
    for _ in range(tentativas):
        if processo.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{porta}/health', timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def rodar_no(env, js, rotulo, timeout):
    try:
        p = subprocess.run(['node', '-e', js], cwd=repo, env=env, text=True,
                            capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        print(e.stdout or '', e.stderr or '', flush=True)
        ok(False, f'{rotulo} (estourou o timeout de {timeout}s)')
        raise SystemExit(1)
    print(p.stdout, p.stderr, flush=True)
    if not ok(p.returncode == 0, rotulo):
        raise SystemExit(1)
    return p


# ─── O roteiro do puppeteer, rodado DENTRO do container (STATE=antes|depois) ─

ROTEIRO_JS = r"""'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const STATE = process.env.STATE;
const VIEWPORTS = [
  { nome: '390x844', largura: 390, altura: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { nome: '1600x1000', largura: 1600, altura: 1000, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
];
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const problemas = [];

  for (const vp of VIEWPORTS) {
    const pagina = await navegador.newPage();
    const erros = [];
    pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
    pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
    try {
      await pagina.setViewport({
        width: vp.largura, height: vp.altura, isMobile: vp.isMobile,
        hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor,
      });
      // O Chromium da imagem anuncia `en` em `navigator.language`, e `public/i18n.js:6-11`
      // só cai nele quando NÃO há escolha em `localStorage['cockpit-idioma']` — sem esta
      // linha o print sai em inglês, que não é o app do dono. Molde de `smoke-idioma.js:39`:
      // `evaluateOnNewDocument` roda ANTES do primeiro script da página, então vale já no
      // `goto` abaixo (setar depois exigiria um reload).
      await pagina.evaluateOnNewDocument(() => {
        try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch (e) { /* sem storage */ }
      });
      await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
      await pagina.waitForSelector('#abas', { timeout: 15000 });
      await espera(500);

      const clicou = await pagina.evaluate(() => {
        const chip = document.querySelector('.conversa-agente[data-agente="codex"]');
        const botao = chip && chip.closest('.conversa');
        if (botao) botao.click();
        return Boolean(botao);
      });
      if (!clicou) {
        problemas.push(STATE + '/' + vp.nome + ': não achei a aba de Codex na lista (.conversa-agente[data-agente="codex"])');
        await pagina.close().catch(() => {});
        continue;
      }

      // SSE ('esperando' no connect) + o relógio de estado do cano (2s de batida) precisam
      // de tempo para pintar a pergunta — folga generosa de propósito.
      await espera(3500);

      const medidas = await pagina.evaluate(() => {
        const visivel = (el) => Boolean(el) && !el.hidden
          && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
        const pergunta = document.querySelector('.pergunta');
        const telaEl = document.querySelector('.pergunta-tela');
        const setas = ['tecla-up', 'tecla-down', 'tecla-left', 'tecla-right', 'tecla-enter', 'tecla-esc']
          .map((c) => document.querySelector('.' + c));
        const pino = document.querySelector('.conversa-pino');
        return {
          perguntaVisivel: visivel(pergunta),
          telaTexto: telaEl ? telaEl.textContent.slice(0, 500) : null,
          setasVisiveis: setas.every(visivel),
          pinoTexto: pino ? pino.textContent.trim() : null,
        };
      });

      if (STATE === 'depois') {
        if (!medidas.perguntaVisivel) problemas.push(STATE + '/' + vp.nome + ': .pergunta NÃO está visível com o menu aberto na TUI');
        if (!medidas.setasVisiveis) problemas.push(STATE + '/' + vp.nome + ': os controles de seta/Enter/Esc não estão todos visíveis');
        if (!medidas.telaTexto || !medidas.telaTexto.trim()) problemas.push(STATE + '/' + vp.nome + ': a tela da pane veio vazia no print');
        if (medidas.pinoTexto !== '?') problemas.push(STATE + '/' + vp.nome + ': o pino da lista não é "?" (' + medidas.pinoTexto + ')');
      } else {
        if (medidas.perguntaVisivel) problemas.push(STATE + '/' + vp.nome + ': .pergunta apareceu no "antes" — deveria estar oculta (a aba parecendo livre)');
        if (medidas.pinoTexto === '?') problemas.push(STATE + '/' + vp.nome + ': o pino mostrou "?" no "antes" — a régua não deveria estar ligada');
      }
      if (erros.length) problemas.push(STATE + '/' + vp.nome + ': ' + erros.length + ' erro(s) de console: ' + erros.slice(0, 3).join(' | '));

      console.log(STATE + '/' + vp.nome + ': ' + JSON.stringify(medidas));
      await pagina.screenshot({ path: '/out/' + STATE + '-' + vp.nome + '.png' }).catch(() => {});
    } catch (e) {
      problemas.push(STATE + '/' + vp.nome + ': o roteiro estourou — ' + String(e && e.message).slice(0, 300));
    } finally {
      await pagina.close().catch(() => {});
    }
  }

  await navegador.close();
  console.log('@@MEDIDAS-MENU-CODEX@@' + JSON.stringify({ problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e);
  process.exit(1);
});
"""

try:
    cmd = ('env CODEX_HOME=' + shlex.quote(str(home)) + ' COCKPIT_TEST_API_KEY=fixture-only '
           + shlex.quote(codex_bin) + ' --no-alt-screen --dangerously-bypass-approvals-and-sandbox')
    pane = tm('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'fixture',
              '-x', '120', '-y', '45', '-c', str(cwd), cmd).strip()
    time.sleep(2)

    tela_inicial = tm('capture-pane', '-p', '-t', pane)
    if 'update available' in tela_inicial.lower():
        print('🔴 o prompt de update apareceu mesmo com version.json pré-gravado — '
              'abortando (fail-closed), sem digitar nada nele.')
        raise SystemExit(1)
    ok(True, 'version.json pré-gravado antes de subir a TUI: sem prompt de update na tela inicial')

    # Passo 2 do plano — preparo obrigatório: uma TUI recém-subida está em `preSessao`, e
    # medir contra isso não provaria nada (o envio já era recusado antes da mudança).
    tm('send-keys', '-t', pane, '-l', '--', 'Responda OK')
    time.sleep(.2)
    tm('send-keys', '-t', pane, 'Enter')
    for _ in range(50):
        arquivos = list((home / 'sessions').rglob('*.jsonl')) if (home / 'sessions').exists() else []
        if any('task_complete' in f.read_text() for f in arquivos):
            break
        time.sleep(.2)

    env = {**os.environ, 'CODEX_HOME': str(home), 'COCKPIT_CODEX_RAIZ': str(home / 'sessions'),
           'COCKPIT_TMUX_SOCKET': sock, 'COCKPIT_TMUX_SESSAO': 'fixture'}
    time.sleep(2)

    js_preparo = r"""
const assert = require('node:assert/strict');
const a = require('./lib/abas');
(async () => {
  const lista = await a.listar();
  const x = lista.find((ab) => ab.agente === 'codex');
  assert.ok(x, 'nenhuma aba de Codex apareceu em listar()');
  assert.ok(x.sessaoId, 'sessaoId ainda vazio — a TUI não publicou o rollout');
  assert.equal(x.preSessao, false, 'preSessao continua true — ainda no degrau antes da sessão');
  console.log('PREPARO: sessaoId=' + x.sessaoId + ' preSessao=' + x.preSessao + ' esperando=' + x.esperando);
})().catch((e) => { console.error(e); process.exitCode = 1; });
"""
    rodar_no(env, js_preparo, 'preparo: sessaoId preenchido E preSessao === false', 30)

    # Passo 3 do plano — o roteiro: as transições contra a TUI real.
    js_roteiro = r"""
const assert = require('node:assert/strict');
const a = require('./lib/abas');
const adaptadorCodex = require('./lib/adaptador-codex');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let x = (await a.listar()).find((ab) => ab.agente === 'codex');
  assert.equal(x.esperando, false, 'TRANSIÇÃO 0: esperando deveria começar false');
  assert.equal(x.preSessao, false, 'TRANSIÇÃO 0: preSessao deveria continuar false');
  console.log('TRANSIÇÃO 0 — estado inicial: esperando=false preSessao=false');

  await a.enviar(x.chave, '/model');
  let aberto = null;
  for (let i = 0; i < 40 && !aberto; i += 1) {
    x = await a.buscar(x.chave);
    if (x.esperando === true && x.menuCodex === 'menu') aberto = x;
    else await espera(250);
  }
  assert.ok(aberto, 'TRANSIÇÃO 1: /model não abriu o menu (esperando/menuCodex) em 10s');
  console.log('TRANSIÇÃO 1 — /model abriu o menu: esperando=true menuCodex=menu');

  const capturada = await a.tela(x);
  assert.ok(capturada.tela && capturada.tela.trim().length > 0, 'TRANSIÇÃO 1: tela() veio vazia com o menu aberto');
  assert.equal(a.motivoDaTela(x), 'menu', 'TRANSIÇÃO 1: motivoDaTela deveria ser "menu", não "pre-sessao"');
  console.log('TRANSIÇÃO 1 — tela() com ' + capturada.linhas + ' linha(s); motivoDaTela=menu (precedência provada contra a TUI real)');

  await assert.rejects(
    a.enviar(x.chave, 'isto tem que ser recusado'),
    /pergunta aberta/,
    'TRANSIÇÃO 2: enviar() deveria recusar com "pergunta aberta" enquanto o menu está aberto',
  );
  console.log('TRANSIÇÃO 2 — enviar() recusado com /pergunta aberta/, como esperado');

  await a.tecla(x.chave, 'Escape');
  let fechou = null;
  for (let i = 0; i < 40 && !fechou; i += 1) {
    x = await a.buscar(x.chave);
    if (x.esperando === false) fechou = x;
    else await espera(250);
  }
  assert.ok(fechou, 'TRANSIÇÃO 3: o Escape não fechou o menu (esperando continua true) em 10s');
  console.log('TRANSIÇÃO 3 — Escape (via tecla()) fechou o menu: esperando=false');

  const longo = 'De volta depois do Escape.\n' + Array.from({ length: 20 }, (_, i) => 'linha de teste ' + i).join(' ');
  await a.enviar(x.chave, longo, [], 'menu-codex-roteiro-fixture');
  const prazo = Date.now() + 15000;
  let achou = false;
  while (Date.now() < prazo && !achou) {
    x = await a.buscar(x.chave);
    if (x.arquivo) {
      const r = await adaptadorCodex.lerConversa(x.arquivo, 0);
      const humanos = r.eventos.filter((e) => e.tipo === 'humano' && e.texto === longo);
      if (humanos.length) {
        assert.equal(humanos.length, 1, 'TRANSIÇÃO 4: a mensagem chegou mais de uma vez ao rollout');
        achou = true;
        break;
      }
    }
    if (!achou) await espera(200);
  }
  assert.ok(achou, 'TRANSIÇÃO 4: o envio pós-Escape não chegou inteiro ao rollout em 15s');
  console.log('TRANSIÇÃO 4 — envio voltou a ser aceito: texto multilinha chegou inteiro, uma única vez');
})().catch((e) => { console.error(e); process.exitCode = 1; });
"""
    rodar_no(env, js_roteiro, 'roteiro: as transições do menu contra a TUI real (abre, tela, recusa, Escape, envio volta)', 60)

    # Reabre o menu — a Fase 6 funde smoke + prints no MESMO ciclo de vida, e para os prints
    # o menu precisa estar aberto DE NOVO (o roteiro acima fechou com Escape).
    js_reabrir = r"""
const assert = require('node:assert/strict');
const a = require('./lib/abas');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let x = (await a.listar()).find((ab) => ab.agente === 'codex');
  assert.equal(x.esperando, false, 'esperando deveria estar false antes de reabrir o menu para os prints');
  await a.enviar(x.chave, '/model');
  let aberto = null;
  for (let i = 0; i < 40 && !aberto; i += 1) {
    x = await a.buscar(x.chave);
    if (x.esperando === true && x.menuCodex === 'menu') aberto = x;
    else await espera(250);
  }
  assert.ok(aberto, 'não consegui reabrir o menu para os prints');
  console.log('MENU REABERTO para os prints: chave=' + x.chave + ' esperando=true menuCodex=menu');
})().catch((e) => { console.error(e); process.exitCode = 1; });
"""
    rodar_no(env, js_reabrir, 'menu reaberto (/model) para os prints, com a TUI ainda viva', 30)

    # ─── Passo 6 do plano — com a TUI viva e o menu aberto, os dois cockpits de teste ───

    SAIDA.mkdir(parents=True, exist_ok=True)
    jobs_dir_inexistente = str(root / 'sem-jobs')  # nunca criada: painel de jobs desligado

    def ambiente_servidor(porta):
        amb = {**os.environ}
        amb.pop('COCKPIT_TOKEN', None)
        amb.update({
            'HOST': '127.0.0.1', 'PORT': str(porta), 'COCKPIT_CERT_DIR': '/dev/null',
            'COCKPIT_TMUX_SOCKET': sock, 'COCKPIT_TMUX_SESSAO': 'fixture',
            'COCKPIT_CODEX_RAIZ': str(home / 'sessions'),
            'COCKPIT_JOBS_DIR': jobs_dir_inexistente,
            'COCKPIT_MONITOR_MS': '0',  # o amostrador do monitor escreve desde o boot (#82)
        })
        return amb

    s3_depois = subprocess.Popen(['node', str(repo / 'server.js')], cwd=repo,
                                  env=ambiente_servidor(PORTA_DEPOIS),
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if not ok(aguardar_saude(PORTA_DEPOIS, s3_depois),
              f'cockpit "depois" (código real, com a mudança) no ar em :{PORTA_DEPOIS} (pid {s3_depois.pid})'):
        raise SystemExit(1)

    # O "antes": a régua fica DESLIGADA EM MEMÓRIA (nunca o arquivo `lib/menu-codex.js`),
    # reproduzindo `esperando: false` sempre — o comportamento de antes desta entrega.
    wrapper_antes = root / 'servidor-antes.js'
    wrapper_antes.write_text(
        "'use strict';\n"
        f"const menuCodex = require({json.dumps(str(repo / 'lib' / 'menu-codex'))});\n"
        "// ANTES da mudança: a régua nunca reconhecia 'menu' — reproduz o comportamento\n"
        "// pré-mudança em que o Codex sempre saía com `esperando: false` (a aba parecendo\n"
        "// livre mesmo com um menu aberto na TUI). Só em memória deste processo — o arquivo\n"
        "// real nunca é tocado.\n"
        "menuCodex.classificarTela = () => 'livre';\n"
        f"require({json.dumps(str(repo / 'server.js'))});\n"
    )
    s3_antes = subprocess.Popen(['node', str(wrapper_antes)], cwd=repo,
                                 env=ambiente_servidor(PORTA_ANTES),
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if not ok(aguardar_saude(PORTA_ANTES, s3_antes),
              f'cockpit "antes" (régua desligada em memória) no ar em :{PORTA_ANTES} (pid {s3_antes.pid})'):
        raise SystemExit(1)

    roteiro_arquivo = root / 'pane.js'
    roteiro_arquivo.write_text(ROTEIRO_JS)

    for estado, porta in (('depois', PORTA_DEPOIS), ('antes', PORTA_ANTES)):
        docker = subprocess.run([
            'docker', 'run', '--rm', '--network', 'host', '--entrypoint', 'node',
            '-e', f'BASE=http://127.0.0.1:{porta}',
            '-e', f'STATE={estado}',
            '-v', f'{root}:/w:ro', '-v', f'{SAIDA}:/out',
            IMAGEM, '/w/pane.js',
        ], capture_output=True, text=True, timeout=180)
        print(docker.stdout, docker.stderr, flush=True)
        marcador = '@@MEDIDAS-MENU-CODEX@@'
        idx = docker.stdout.find(marcador)
        relatorio = None
        if idx >= 0:
            try:
                relatorio = json.loads(docker.stdout[idx + len(marcador):])
            except Exception:
                relatorio = None
        problemas = relatorio['problemas'] if relatorio else [
            f'{estado}: o roteiro não devolveu JSON (código {docker.returncode})']
        ok(not problemas, f'prints "{estado}": ' + (
            ', '.join(problemas) if problemas
            else 'menu visível com os controles no celular e no desktop (ou aba livre, no "antes")'))

    for estado in ('antes', 'depois'):
        for nome in ('390x844', '1600x1000'):
            arquivo = SAIDA / f'{estado}-{nome}.png'
            ok(arquivo.exists() and arquivo.stat().st_size > 1000, f'{arquivo} gerado')

    saida_codigo = 1 if falhas else 0

except SystemExit as e:
    saida_codigo = e.code if isinstance(e.code, int) else 1
except Exception as e:
    print(f'🔴 o smoke estourou: {e}')
    saida_codigo = 1
finally:
    for nome, proc in (('depois', s3_depois), ('antes', s3_antes)):
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            print(f'  · cockpit "{nome}" (pid {proc.pid}) derrubado pelo pid exato')
    # Só o socket QUE ESTE SCRIPT criou (`sock`, carimbado com o próprio pid) — nunca o
    # socket padrão nem o `cockpit` de produção.
    subprocess.run(base + ['kill-session', '-t', 'fixture'], capture_output=True)
    srv.shutdown()
    print(f"\n{'❌ SMOKE DO MENU DO CODEX VERMELHO' if saida_codigo else '✅ SMOKE DO MENU DO CODEX VERDE'}"
          f" — raiz da TUI: {root}\n")
    if saida_codigo == 0:
        print(f'PNGs em {SAIDA} — abrir cada um e OLHAR antes de reportar pronto (regra de 25/08).')

sys.exit(saida_codigo)
