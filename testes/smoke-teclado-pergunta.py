#!/usr/bin/env python3
# Fase 6 do plano `docs/superpowers/plans/2026-09-18-responder-a-pergunta-pelo-teclado-plano.md`:
# a PROVA DE TELA do card `responder-a-pergunta-pelo-teclado`, contra a TUI real do Codex.
#
# IRMÃO de `testes/smoke-menu-codex.py`, não um remendo nele. Reusa o molde (TUI isolada,
# provider HTTP local, dois cockpits, roteiro puppeteer nos dois viewports) e muda as três
# coisas que o painel de avaliação apontou:
#
#   (i)   O "ANTES" é a ÁRVORE DA BASE, não a régua desligada. O "antes" do irmão desliga
#         `menuCodex.classificarTela` e deixa a `.pergunta` OCULTA — um "antes" sem o menu na
#         tela não compara nada do que esta entrega muda. E extrair só `public/app.js` para um
#         tmp não adiantaria: `server.js:43` fixa `PUBLIC_DIR = path.join(__dirname, 'public')`,
#         sem env que redirecione. Por isso: `git archive <base> | tar -x` e `node <tmp>/server.js`.
#   (ii)  AMBIENTE ISOLADO nos dois servidores. O irmão faz `{**os.environ}` e NÃO define `HOME`
#         nem `COCKPIT_LIDAS_DIR` — e o default é `os.homedir()/.cockpit` (`lib/lidas.js:17`).
#         Abrir uma aba chama `marcarLido` (`public/app.js`) → `POST api/lidas` → escreve no
#         `~/.cockpit/lidas.json` DE PRODUÇÃO. Aqui os dois ganham HOME e LIDAS_DIR em tmp.
#   (iii) TODA TECLA MANDADA É DESFEITA. Há UM socket tmux e UMA TUI para os dois cockpits: um
#         `Enter` responderia o menu de verdade e as capturas seguintes sairiam sem o menu — a
#         falha de 24/08 por um caminho novo. Então a prova usa `ArrowDown` (move a seleção sem
#         fechar o menu) seguido de `ArrowUp`, e o "antes" roda ANTES do "depois", porque o
#         "antes" é o único que não consegue mexer na TUI.
#
# O que os prints têm de CONTER (senão não são prova):
#   antes/depois 1600×1000  — o menu na tela, e a seta física mudando (ou não) a seleção
#   depois-luz 1600×1000    — o botão ↓ com o anel aceso, congelado por interceptação de rede
#   antes/depois  390×844   — a MESMA pergunta, com a cor da tela da pane diferente entre elas
#
# Não entra no `bin/testes.js`: roda à mão, contra Codex real (offline demais para o `npm test`).
#
# Uso:  SAIDA=~/.cockpit/smoke-shots/teclado-pergunta-$$ python3 testes/smoke-teclado-pergunta.py
#
# Códigos de saída: 0 = verde · 1 = defeito · 2 = ambiente indisponível (NÃO é verde: é
# inconclusivo, e inconclusivo se reporta como inconclusivo).

import json
import os
import re
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
# 7879 é PRODUÇÃO, 7899 é dos jobs, 7893/7894 são de gates, 7897/7898 são do smoke irmão.
PORTA_DEPOIS = 7891
PORTA_ANTES = 7892

falhas = []


def ok(cond, texto):
    print(f"  {'✅' if cond else '❌'} {texto}", flush=True)
    if not cond:
        falhas.append(texto)
    return cond


def porta_livre(porta):
    r = subprocess.run(['ss', '-lptn', f'sport = :{porta}'], capture_output=True, text=True)
    return not re.search(rf':{porta}\s', r.stdout)


# ─── Ambiente, ANTES de criar qualquer coisa ────────────────────────────────

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

# A base deste trabalho. O "antes" é a árvore DELA.
BASE_REF = os.environ.get('BASE_REF', '').strip()
if not BASE_REF:
    print('🟡 ambiente indisponível: falta BASE_REF=<commit de antes do teclado físico> para montar o "antes".')
    sys.exit(2)

# ─── Provider HTTP local (molde do irmão) — zero token real ─────────────────

root = Path(tempfile.mkdtemp(prefix='cockpit-teclado-pergunta-'))
home = root / 'home'
cwd = root / 'cwd'
base_tree = root / 'base'
home.mkdir()
cwd.mkdir()
base_tree.mkdir()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
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
# O prompt de "Update available" toma a tela e o CLI não sai dele com Escape — já causou um
# `npm install -g` acidental numa medição anterior. Pré-gravado, como no irmão.
(home / 'version.json').write_text(json.dumps({
    'latest_version': '0.153.4', 'last_checked_at': '2099-01-01T00:00:00Z',
    'dismissed_version': '0.154.0',
}))

sock = 'cockpit-teclado-pergunta-' + str(os.getpid())
base_tmux = ['tmux', '-L', sock, '-f', '/dev/null']

SAIDA = Path(os.environ.get('SAIDA') or os.environ.get('SMOKE_SHOTS')
             or (Path.home() / '.cockpit' / 'smoke-shots' / f'teclado-pergunta-{os.getpid()}'))

s_depois = None
s_antes = None
saida_codigo = 1


def tm(*a):
    return subprocess.check_output(base_tmux + list(a), text=True)


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


def rodar_no(env, js, rotulo, timeout, diretorio=None):
    try:
        p = subprocess.run(['node', '-e', js], cwd=diretorio or repo, env=env, text=True,
                           capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        print(e.stdout or '', e.stderr or '', flush=True)
        ok(False, f'{rotulo} (estourou o timeout de {timeout}s)')
        raise SystemExit(1)
    print(p.stdout, p.stderr, flush=True)
    if not ok(p.returncode == 0, rotulo):
        raise SystemExit(1)
    return p


# ─── O roteiro do puppeteer (STATE=antes|depois), rodado DENTRO do container ─

ROTEIRO_JS = r"""'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const STATE = process.env.STATE;
const VIEWPORTS = [
  { nome: '1600x1000', largura: 1600, altura: 1000, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  { nome: '390x844', largura: 390, altura: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
];
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// A pergunta aberta, medida do jeito que importa para ESTE card.
const MEDIR = () => {
  const visivel = (el) => Boolean(el) && !el.hidden
    && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  const pergunta = document.querySelector('.pergunta');
  const tela = document.querySelector('.pergunta-tela');
  const texto = tela ? tela.textContent : '';
  const colunas = texto.split('\n').reduce((m, l) => Math.max(m, l.length), 0);
  return {
    perguntaVisivel: visivel(pergunta),
    cor: tela ? getComputedStyle(tela).color : null,
    scrollW: tela ? tela.scrollWidth : 0,
    clientW: tela ? tela.clientWidth : 0,
    colunas,
    // A régua de "a tela mudou" é a LINHA DO MARCADOR, não o texto solto: a primeira versão
    // comparava `texto.slice(-400)` e a opção selecionada (`› 1.` → `› 2.`) fica FORA dessa
    // janela num menu de 6 itens — o smoke reprovava um teclado que estava funcionando.
    // Índice da linha marcada: `›` (Codex, U+203A) ou `❯` (Claude, U+276F), o catálogo do
    // §4.1 da spec. `-1` quando não há marcador na captura.
    // ...e é a linha do ITEM DE MENU marcado, não do primeiro `›` da captura: o `›` também
    // abre cada fala do histórico na TUI do Codex (`› Responda OK`), e o primeiro deles nunca
    // muda — o smoke reprovou duas vezes um teclado que funcionava por causa disso. Forma de
    // item numerado, a mesma que `lib/menu-codex.js` já usa (ITEM_DE_MENU).
    linhaMarcada: texto.split('\n').reduce(
      (achado, l, i) => (/^\s{0,3}[\u203a\u276f]\s+\d+\.\s/.test(l) ? i : achado), -1),
    texto: texto.slice(-400),
    acesos: [...document.querySelectorAll('.pergunta-teclas [data-apertada]')].map((b) => b.dataset.tecla),
    // DIAGNÓSTICO: onde o cursor está, e o que o app acha do estado da tela.
    focoTag: document.activeElement ? document.activeElement.tagName : null,
    focoClasse: document.activeElement ? String(document.activeElement.className).slice(0, 40) : null,
    vista: document.getElementById('app') ? document.getElementById('app').dataset.vista : null,
  };
};

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const problemas = [];
  const medidas = {};

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
      // O Chromium da imagem anuncia `en`, e `public/i18n.js:6-11` só cai nele sem escolha
      // em localStorage. Sem esta linha o print sai em inglês, que não é o app do dono.
      await pagina.evaluateOnNewDocument(() => {
        try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch (e) { /* sem storage */ }
        // `rose-pine-dawn` NÃO é decoração: é o único dos doze temas em que a cor antiga
        // REPROVAVA 4,5:1 (4,23). No tema claro padrão a troca --texto-2 → --texto é sutil
        // demais para um humano ver no PNG, e print que não contém o que mudou não é prova
        // (regra de 25/08). Aqui a diferença fica visível, e é no tema do defeito.
        try { localStorage.setItem('cockpit-tema', 'rose-pine-dawn'); } catch (e) { /* sem storage */ }
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
        problemas.push(STATE + '/' + vp.nome + ': não achei a aba de Codex na lista');
        await pagina.close().catch(() => {});
        continue;
      }
      // SSE + o relógio de estado do cano precisam de tempo para pintar a pergunta.
      await espera(3500);

      const antesDaTecla = await pagina.evaluate(MEDIR);
      medidas[STATE + '/' + vp.nome] = antesDaTecla;

      // 🔴 Cenário não montado não vira prova: sem o menu na tela, o print provaria só que a
      // página subiu. Vale para os DOIS estados — é esta a diferença para o smoke irmão.
      if (!antesDaTecla.perguntaVisivel) {
        problemas.push(STATE + '/' + vp.nome + ': a .pergunta NÃO está visível — print não seria prova');
        await pagina.screenshot({ path: '/out/FALHOU-' + STATE + '-' + vp.nome + '.png' }).catch(() => {});
        await pagina.close().catch(() => {});
        continue;
      }
      if (!antesDaTecla.texto.trim()) {
        problemas.push(STATE + '/' + vp.nome + ': a tela da pane veio vazia');
      }

      // ── A tecla FÍSICA, e ela é desfeita em seguida (iii) ────────────────
      // ArrowDown move a seleção do menu sem fechá-lo; ArrowUp devolve a TUI ao estado
      // anterior, para a próxima captura ver a MESMA pergunta.
      await pagina.keyboard.press('ArrowDown');
      await espera(1200);
      const depoisDaTecla = await pagina.evaluate(MEDIR);
      const mudou = depoisDaTecla.linhaMarcada !== antesDaTecla.linhaMarcada;
      medidas[STATE + '/' + vp.nome + '/tecla'] = { mudou };

      if (antesDaTecla.linhaMarcada < 0) {
        problemas.push(STATE + '/' + vp.nome + ': PRÉ-CONDIÇÃO — nenhuma linha marcada (› ou ❯) na captura; '
          + 'sem marcador não dá para julgar se a seta moveu a seleção');
      }
      if (STATE === 'depois' && !mudou) {
        problemas.push(STATE + '/' + vp.nome + ': ArrowDown NÃO moveu a opção marcada (linha '
          + antesDaTecla.linhaMarcada + ' → ' + depoisDaTecla.linhaMarcada + ') — o teclado não respondeu');
      }
      if (STATE === 'antes' && mudou) {
        problemas.push(STATE + '/' + vp.nome + ': ArrowDown moveu a opção no "antes" — a base não deveria ouvir o teclado');
      }
      if (mudou) {
        await pagina.keyboard.press('ArrowUp');   // desfaz
        await espera(1200);
      }
      await pagina.screenshot({ path: '/out/' + STATE + '-' + vp.nome + '.png' }).catch(() => {});

      // ── O print da LUZ: só no "depois", só no desktop ────────────────────
      // A chamada dura milissegundos; `keyboard.press` + `screenshot` fotografaria o botão já
      // apagado. Segurar a resposta do POST /teclas é o equivalente, no navegador, ao "fetch
      // pendurado" que o gate usa.
      if (STATE === 'depois' && vp.nome === '1600x1000') {
        await pagina.setRequestInterception(true);
        let presa = null;
        const aoPedir = (req) => {
          if (/\/teclas$/.test(req.url())) { presa = req; return; }   // segura, não continua
          req.continue().catch(() => {});
        };
        pagina.on('request', aoPedir);
        await pagina.keyboard.press('ArrowDown');
        for (let i = 0; i < 40 && !presa; i += 1) await espera(50);

        const comLuz = await pagina.evaluate(MEDIR);
        medidas['depois/luz'] = { acesos: comLuz.acesos };
        if (!comLuz.acesos.includes('Down')) {
          problemas.push('depois/luz: o botão ↓ NÃO está com data-apertada durante a chamada');
        }
        await pagina.screenshot({ path: '/out/depois-luz-1600x1000.png' }).catch(() => {});

        if (presa) await presa.continue().catch(() => {});
        await espera(1200);
        pagina.off('request', aoPedir);
        await pagina.setRequestInterception(false);
        // Desfaz este ArrowDown também: sem isto, as capturas de 390×844 veriam a seta noutra
        // linha e o par antes/depois deixaria de ser "a mesma pergunta".
        await pagina.keyboard.press('ArrowUp');
        await espera(1200);
      }

      // ── C2: a rolagem horizontal, no celular ─────────────────────────────
      if (vp.nome === '390x844') {
        if (antesDaTecla.colunas < 60) {
          problemas.push('390x844: PRÉ-CONDIÇÃO não satisfeita — a captura tem só '
            + antesDaTecla.colunas + ' colunas (< 60); C2 não pode ser julgado com uma TUI estreita');
        } else if (!(antesDaTecla.scrollW > antesDaTecla.clientW)) {
          problemas.push('390x844: C2 — a .pergunta-tela NÃO fica mais larga que a caixa ('
            + antesDaTecla.scrollW + ' vs ' + antesDaTecla.clientW + ')');
        }
      }

      // ── O Enter, ÚLTIMO ato do roteiro (só no "depois", só no último viewport) ──────
      // Navegar prova metade; RESPONDER é o gesto que o card pede. Fica por último porque
      // fecha o menu de verdade na TUI — e a TUI é uma só para os dois cockpits.
      if (STATE === 'depois' && vp.nome === VIEWPORTS[VIEWPORTS.length - 1].nome) {
        const antesDoEnter = await pagina.evaluate(MEDIR);
        await pagina.keyboard.press('Enter');
        await espera(2500);
        const depoisDoEnter = await pagina.evaluate(MEDIR);
        // A régua NÃO é "o menu fechou": medido contra a TUI real, o `/model` do Codex tem
        // DOIS passos — o Enter confirma o modelo e abre "Select Reasoning Level", com a
        // `.pergunta` seguindo aberta (corretamente). O que prova que a tecla chegou e a TUI
        // reagiu é a tela ter MUDADO; exigir o fechamento reprovava um Enter que funcionou.
        const respondeu = depoisDoEnter.texto !== antesDoEnter.texto
          || depoisDoEnter.perguntaVisivel === false;
        medidas['depois/enter'] = {
          respondeu, aindaAberta: depoisDoEnter.perguntaVisivel,
          trecho: depoisDoEnter.texto.slice(0, 80),
        };
        if (!respondeu) problemas.push('depois/enter: o Enter pelo TECLADO não mudou nada — responder não funcionou ponta a ponta');
        await pagina.screenshot({ path: '/out/depois-respondido-' + vp.nome + '.png' }).catch(() => {});
      }

      if (erros.length) problemas.push(STATE + '/' + vp.nome + ': ' + erros.length + ' erro(s) de console: ' + erros.slice(0, 3).join(' | '));
    } catch (e) {
      problemas.push(STATE + '/' + vp.nome + ': o roteiro estourou — ' + String(e && e.message).slice(0, 300));
    } finally {
      await pagina.close().catch(() => {});
    }
  }

  await navegador.close();
  console.log('@@MEDIDAS@@' + JSON.stringify({ problemas, medidas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e);
  process.exit(1);
});
"""

try:
    # ─── A TUI real, com o menu aberto ──────────────────────────────────────
    cmd = f'CODEX_HOME={home} {codex_bin}'
    pane = tm('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'fixture',
              '-x', '120', '-y', '45', '-c', str(cwd), cmd).strip()
    time.sleep(2)

    tela_inicial = tm('capture-pane', '-p', '-t', pane)
    if 'update available' in tela_inicial.lower():
        print('🔴 o prompt de update apareceu mesmo com version.json pré-gravado — '
              'abortando (fail-closed), sem digitar nada nele.')
        raise SystemExit(1)
    ok(True, 'version.json pré-gravado: sem prompt de update na tela inicial')

    # Uma TUI recém-subida está em `preSessao`; um turno a tira de lá.
    tm('send-keys', '-t', pane, '-l', '--', 'Responda OK')
    time.sleep(.2)
    tm('send-keys', '-t', pane, 'Enter')
    for _ in range(50):
        arquivos = list((home / 'sessions').rglob('*.jsonl')) if (home / 'sessions').exists() else []
        if any('task_complete' in f.read_text() for f in arquivos):
            break
        time.sleep(.2)
    time.sleep(2)

    env_node = {**os.environ, 'CODEX_HOME': str(home), 'COCKPIT_CODEX_RAIZ': str(home / 'sessions'),
                'COCKPIT_TMUX_SOCKET': sock, 'COCKPIT_TMUX_SESSAO': 'fixture'}

    js_abrir_menu = r"""
const assert = require('node:assert/strict');
const a = require('./lib/abas');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let x = (await a.listar()).find((ab) => ab.agente === 'codex');
  assert.ok(x, 'nenhuma aba de Codex apareceu em listar()');
  assert.equal(x.preSessao, false, 'preSessao continua true — a TUI não passou do degrau inicial');
  await a.enviar(x.chave, '/model');
  let aberto = null;
  for (let i = 0; i < 40 && !aberto; i += 1) {
    x = await a.buscar(x.chave);
    if (x.esperando === true && x.menuCodex === 'menu') aberto = x;
    else await espera(250);
  }
  assert.ok(aberto, '/model não abriu o menu em 10s');
  console.log('MENU ABERTO: chave=' + x.chave + ' esperando=true menuCodex=menu');
})().catch((e) => { console.error(e); process.exitCode = 1; });
"""
    rodar_no(env_node, js_abrir_menu, 'a TUI real subiu e o /model abriu o menu', 60)

    # ─── O "antes": a ÁRVORE da base, não dois arquivos soltos (i) ──────────
    subprocess.run(f'git archive {BASE_REF} | tar -x -C {base_tree}',
                   shell=True, cwd=repo, check=True)
    ok((base_tree / 'server.js').exists() and (base_tree / 'public' / 'app.js').exists(),
       f'árvore da base extraída para o "antes" ({BASE_REF[:8]})')
    fonte_antes = (base_tree / 'public' / 'app.js').read_text()
    ok('TECLAS_FISICAS' not in fonte_antes,
       'e ela NÃO tem o ouvinte de teclado — é mesmo o "antes" desta entrega')

    # ─── Os dois cockpits, com ambiente ISOLADO (ii) ────────────────────────
    def ambiente_servidor(porta, casa):
        amb = {**os.environ}
        amb.pop('COCKPIT_TOKEN', None)
        amb.update({
            'HOST': '127.0.0.1', 'PORT': str(porta), 'COCKPIT_CERT_DIR': '/dev/null',
            'COCKPIT_TMUX_SOCKET': sock, 'COCKPIT_TMUX_SESSAO': 'fixture',
            'COCKPIT_CODEX_RAIZ': str(home / 'sessions'),
            'COCKPIT_JOBS_DIR': str(root / 'sem-jobs'),   # nunca criada: painel de jobs desligado
            # 🔴 Os dois que o smoke irmão NÃO define, e que sem isto escrevem no
            # ~/.cockpit/lidas.json DE PRODUÇÃO assim que o roteiro abre uma aba.
            'HOME': str(casa),
            'COCKPIT_LIDAS_DIR': str(casa / '.cockpit'),
        })
        return amb

    casa_depois = root / 'casa-depois'
    casa_antes = root / 'casa-antes'
    for c in (casa_depois, casa_antes):
        (c / '.cockpit').mkdir(parents=True)

    s_depois = subprocess.Popen(['node', str(repo / 'server.js')], cwd=repo,
                                env=ambiente_servidor(PORTA_DEPOIS, casa_depois),
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if not ok(aguardar_saude(PORTA_DEPOIS, s_depois),
              f'cockpit "depois" (código real) no ar em :{PORTA_DEPOIS}'):
        raise SystemExit(1)

    s_antes = subprocess.Popen(['node', str(base_tree / 'server.js')], cwd=base_tree,
                               env=ambiente_servidor(PORTA_ANTES, casa_antes),
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if not ok(aguardar_saude(PORTA_ANTES, s_antes),
              f'cockpit "antes" (árvore da base) no ar em :{PORTA_ANTES}'):
        raise SystemExit(1)

    # ─── Os prints. "antes" PRIMEIRO (iii): ele é o único que não mexe na TUI ─
    SAIDA.mkdir(parents=True, exist_ok=True)
    medidas_todas = {}
    for estado, porta in (('antes', PORTA_ANTES), ('depois', PORTA_DEPOIS)):
        p = subprocess.run(
            ['docker', 'run', '--rm', '--network', 'host',
             '-e', f'BASE=http://127.0.0.1:{porta}', '-e', f'STATE={estado}',
             '-v', f'{SAIDA}:/out', IMAGEM, 'node', '-e', ROTEIRO_JS],
            capture_output=True, text=True, timeout=300)
        print(p.stdout[-3000:], p.stderr[-2000:], flush=True)
        m = re.search(r'@@MEDIDAS@@(.*)', p.stdout)
        if m:
            dados = json.loads(m.group(1))
            medidas_todas.update(dados['medidas'])
            for problema in dados['problemas']:
                ok(False, problema)
        ok(p.returncode == 0, f'roteiro do "{estado}" passou sem problema')

    # ─── O que só a COMPARAÇÃO entre os dois revela ─────────────────────────
    for vp in ('1600x1000', '390x844'):
        a_ = medidas_todas.get(f'antes/{vp}')
        d_ = medidas_todas.get(f'depois/{vp}')
        if not a_ or not d_:
            ok(False, f'{vp}: faltou medida de um dos estados para comparar')
            continue
        ok(a_['cor'] != d_['cor'],
           f'{vp}: a cor da tela da pane MUDOU entre antes e depois ({a_["cor"]} → {d_["cor"]})')
    # 🔴 `screenshot(...).catch(() => {})` no roteiro engole falha de gravação: o smoke ficaria
    # VERDE sem o PNG existir, e o gate da Fase 6 é justamente o PNG. Conferência no disco, aqui.
    esperados = ['antes-1600x1000.png', 'depois-1600x1000.png', 'depois-luz-1600x1000.png',
                 'antes-390x844.png', 'depois-390x844.png', 'depois-respondido-390x844.png']
    for nome in esperados:
        arq = SAIDA / nome
        ok(arq.exists() and arq.stat().st_size > 10000,
           f'PNG gravado e com tamanho de gente: {nome}'
           + ('' if arq.exists() else ' — NÃO EXISTE'))

    enter = medidas_todas.get('depois/enter') or {}
    ok(enter.get('respondeu') is True,
       'o Enter pelo TECLADO respondeu a pergunta — a TUI reagiu '
       f'(ainda aberta: {enter.get("aindaAberta")}, tela agora: {str(enter.get("trecho"))[:60]!r})')

    luz = medidas_todas.get('depois/luz') or {}
    ok('Down' in (luz.get('acesos') or []),
       f'a luz do ↓ estava acesa no instante do print ({luz.get("acesos")})')

    saida_codigo = 1 if falhas else 0
    print(f'\n{"❌" if falhas else "✅"} smoke teclado-pergunta — '
          f'{len(falhas)} problema(s)\nPNGs em: {SAIDA}\n', flush=True)
    for f in falhas:
        print('   ·', f)
finally:
    for s in (s_depois, s_antes):
        if s:
            s.terminate()
            try:
                s.wait(timeout=5)
            except Exception:
                s.kill()
    subprocess.run(base_tmux + ['kill-server'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    srv.shutdown()
    # `root` NÃO é apagada de propósito (mesmo hábito do smoke irmão): dá para inspecionar a
    # TUI, o rollout e a árvore da base depois que o smoke fecha.
    print(f'pasta de trabalho (não apagada): {root}', flush=True)

sys.exit(saida_codigo)
