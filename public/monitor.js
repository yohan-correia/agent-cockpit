'use strict';
// Monitor do servidor (D64, a spec do monitor, 2026-10-06):
// a faixa CPU · RAM · disco na lateral, o selo do aviso e o painel de 24 h. Mesmo molde de
// `revisar.js`: IIFE própria, fora do `app.js`, texto só por `textContent` e nós por
// `createElement` (armadilha #26). A palavra do atributo proibido não aparece nem aqui: o gate
// U7 varre o fonte inteiro atrás dela.
(function () {

// 3× o passo nominal de 60 s do amostrador. Constante do CLIENTE, de propósito: se viesse do
// `COCKPIT_MONITOR_MS` do servidor, o smoke a 2 s estilhaçaria a fixture de 60 s em pontos soltos.
const LACUNA_S = 180;
const MS_FAIXA = 15000;
const EIXOS = ['cpu', 'ram', 'disco'];
const INDICE = { cpu: 1, ram: 2, disco: 3 }; // posição na amostra [t, cpu, ram, disco]

// ── puras (expostas ANTES de tocar em `document` — o gate faz require em Node puro) ──

/** Os três eixos prontos para pintar. `limites.liga` vem da resposta: nunca 90 chumbado aqui. */
function faixaDe({ agora, limites }) {
  return EIXOS.map((eixo) => {
    const v = agora ? agora[eixo] : null;
    const pct = typeof v === 'number' ? v : null;
    return { eixo, pct, texto: pct === null ? '—' : `${pct} %`, alerta: pct !== null && pct >= limites.liga };
  });
}

/**
 * Um `d` de <path> por eixo. Abre `M` novo a cada `null` E sempre que duas amostras vizinhas
 * distam mais que LACUNA_S: servidor parado gera AUSÊNCIA de amostra, não `null`, e o traço não
 * pode ligar 09:00 a 15:00 em linha reta.
 */
function caminhosDoGrafico(amostras, inicio, fim, largura, altura) {
  const saida = {};
  const num = (n) => Math.round(n * 100) / 100;
  for (const eixo of EIXOS) {
    const i = INDICE[eixo];
    const partes = [];
    let anterior = null; // t do último ponto DESENHADO; null depois de um buraco
    for (const a of amostras) {
      const t = a[0];
      if (t < inicio || t > fim) continue;
      const pct = a[i];
      if (pct === null || pct === undefined) { anterior = null; continue; }
      const continua = anterior !== null && t - anterior <= LACUNA_S;
      const x = num((t - inicio) / (fim - inicio) * largura);
      const y = num(altura - pct / 100 * altura);
      partes.push(`${continua ? 'L' : 'M'}${x} ${y}`);
      anterior = t;
    }
    saida[eixo] = partes.join(' ');
  }
  return saida;
}

/** `RAM em 87 % — limite 90 %`: o texto diz o LIMITE, não "acima de" (a histerese mantém o aviso entre 85 e 90). */
function textoDoAviso(aviso, agora, limites, tr) {
  const nomes = { cpu: 'CPU', ram: 'RAM', disco: tr('disco') };
  return EIXOS.filter((e) => aviso && aviso[e])
    .map((e) => tr`${nomes[e]} em ${agora && agora[e] != null ? agora[e] : '—'} % — limite ${limites.liga} %`)
    .join(' · ');
}

/** 1073741824 → '1 GB'; 1395864371 → '1,3 GB' (pt-BR) / '1.3 GB' (en). */
function formatarBytes(n, idioma) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let u = 0;
  while (v >= 1024 && u < unidades.length - 1) { v /= 1024; u += 1; }
  const arred = v >= 100 || Number.isInteger(Math.round(v * 10) / 10) ? Math.round(v) : Math.round(v * 10) / 10;
  const texto = String(arred);
  return `${idioma === 'en' ? texto : texto.replace('.', ',')} ${unidades[u]}`;
}

/** Marcas de 6 em 6 horas cheias (hora local) dentro de [inicio, fim): x em 0..1 e `HH:00`. */
function ticksDeHora(inicio, fim) {
  const marcas = [];
  const d = new Date(inicio * 1000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + (6 - (d.getHours() % 6)) % 6);
  for (let t = Math.floor(d.getTime() / 1000); t < fim; t += 21600) {
    if (t < inicio) continue;
    marcas.push({ x: (t - inicio) / (fim - inicio), rotulo: `${String(new Date(t * 1000).getHours()).padStart(2, '0')}:00` });
  }
  return marcas;
}

// ── D68: o painel maior (eixos clicáveis, pastas do disco) ──

/** Um eixo aberto por vez: tocar no aberto fecha. */
const alternarEixo = (atual, tocado) => (tocado === atual ? null : tocado);

/** Parte do disco inteiro (S3: a régua é a MESMA nas três listas); sem total, 0 — nunca NaN. */
const fracaoDe = (bytes, total) => (typeof bytes === 'number' && typeof total === 'number' && total > 0
  ? Math.min(1, Math.max(0, bytes / total)) : 0);

function linhasDePastas(bloco, discoTotal) {
  return ((bloco && bloco.itens) || []).slice(0, 10)
    .map((i) => ({ rotulo: i.rotulo, bytes: i.bytes, fracao: fracaoDe(i.bytes, discoTotal), contemHome: i.contemHome === true }));
}

function linhasDoDocker(docker, discoTotal) {
  return (Array.isArray(docker) ? docker : []).map((d) => ({ ...d, fracao: fracaoDe(d.bytes, discoTotal) }));
}

/** `medido às 14:05` (mesmo dia local) / `medido em 06/10 às 14:05` / `ainda não medido`. */
function textoMedidoEm(emS, agoraS, tr) {
  if (typeof emS !== 'number') return tr('ainda não medido');
  const dois = (n) => String(n).padStart(2, '0');
  const d = new Date(emS * 1000);
  const hoje = new Date(agoraS * 1000);
  const hora = `${dois(d.getHours())}:${dois(d.getMinutes())}`;
  if (d.toDateString() === hoje.toDateString()) return tr`medido às ${hora}`;
  return tr`medido em ${dois(d.getDate())}/${dois(d.getMonth() + 1)} às ${hora}`;
}

/** A única fonte do estado do "medir agora": o texto sai em pt-BR e o DOM aplica `tr()`. */
function estadoDoBotao({ medindo, enviando } = {}) {
  if (medindo) return { disabled: true, texto: 'medindo…' };
  return { disabled: Boolean(enviando), texto: 'medir agora' };
}

// O título diz de QUAL máquina são os números (D78): vem do servidor; sem nome, o texto genérico.
function tituloDoMonitor(maquina, tr) {
  return typeof maquina === 'string' && maquina.trim() ? tr('Monitor de {0}', maquina.trim().slice(0, 64)) : tr('Monitor do servidor');
}

globalThis.cockpitMonitor = { faixaDe, caminhosDoGrafico, textoDoAviso, formatarBytes, ticksDeHora, LACUNA_S,
  alternarEixo, linhasDePastas, linhasDoDocker, textoMedidoEm, estadoDoBotao, tituloDoMonitor };

// O resto é SÓ DOM — guardado pra este arquivo continuar `require`-ável em Node puro (gate U1-U7)
// e não quebrar numa página sem a faixa.
if (typeof document !== 'undefined' && document.getElementById('monitor-faixa')) {

const idiomaUI = globalThis.cockpitI18n;
const tr = (...a) => idiomaUI.t(...a);
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  return n;
};

// Token lido A CADA CHAMADA (mesmo motivo de revisar.js): o primeiro acesso por link ainda não
// tem o token no localStorage. Rota RELATIVA: o <base> do index.html é o que faz o prefixo do
// `tailscale serve` funcionar (#16).
const tokenAgora = () => { try { return localStorage.getItem('cockpit-token') || ''; } catch { return ''; } };

async function api(rota, metodo = 'GET') {
  const cabecalhos = {};
  const token = tokenAgora();
  if (token) cabecalhos.authorization = `Bearer ${token}`;
  const resposta = await fetch(rota, { method: metodo, headers: cabecalhos });
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  return resposta.json();
}

const faixa = $('monitor-faixa');
const selo = $('monitor-aviso');
const dlg = $('dialogo-monitor');
let ultimo = null;      // última resposta de /api/monitor
let historico = null;   // { amostras, inicio, fim }
let processos = null;
let relogio = null;
let eixoAberto = null;  // D68: qual seção do detalhe está aberta (null = só a dica)
let disco = null;       // última resposta de /api/monitor/disco
let enviando = false;   // o clique em "medir agora" saiu e a resposta ainda não voltou
let relogioDisco = null;
let tiques = 0;         // tiques com o painel aberto — o histórico só a cada 4 (60 s)

function pintarFaixa(dados) {
  const lim = dados.limites;
  for (const f of faixaDe(dados)) {
    const cela = faixa.querySelector(`.monitor-cela[data-eixo="${f.eixo}"]`);
    cela.querySelector('.monitor-barra-cheia').style.width = `${f.pct === null ? 0 : f.pct}%`;
    cela.querySelector('.monitor-pct').textContent = f.texto;
    if (f.alerta) cela.setAttribute('data-alerta', ''); else cela.removeAttribute('data-alerta');
  }
  const ligado = EIXOS.some((e) => dados.aviso && dados.aviso[e]);
  const texto = textoDoAviso(dados.aviso, dados.agora, lim, tr);
  if (ligado) faixa.setAttribute('data-aviso', 'ligado'); else faixa.removeAttribute('data-aviso');
  $('monitor-faixa-aviso').textContent = texto;
  // O selo: só o texto e o `hidden`. QUANDO ele aparece é decisão do CSS (duas media queries) —
  // nunca mexer em `display` daqui.
  selo.textContent = texto;
  selo.hidden = !texto;
  faixa.hidden = false;
}

function pintarMedidores(dados) {
  $('monitor-titulo').textContent = tituloDoMonitor(dados.maquina, tr);
  const idioma = idiomaUI.idioma;
  const subs = {
    cpu: dados.agora && dados.agora.nucleos ? tr`${dados.agora.nucleos} núcleos` : '',
    ram: dados.agora && dados.agora.ramTotal ? `${formatarBytes(dados.agora.ramUsado, idioma)} / ${formatarBytes(dados.agora.ramTotal, idioma)}` : '',
    disco: dados.agora && dados.agora.discoTotal ? `${formatarBytes(dados.agora.discoUsado, idioma)} / ${formatarBytes(dados.agora.discoTotal, idioma)}` : '',
  };
  for (const f of faixaDe(dados)) {
    const m = dlg.querySelector(`.monitor-medidor[data-eixo="${f.eixo}"]`);
    m.querySelector('.monitor-medidor-pct').textContent = f.texto;
    m.querySelector('.monitor-medidor-sub').textContent = subs[f.eixo];
    if (f.alerta) m.setAttribute('data-alerta', ''); else m.removeAttribute('data-alerta');
  }
  const pa = $('monitor-painel-aviso');
  pa.textContent = dados.relogio === false ? tr('histórico parado neste servidor') : '';
  pa.hidden = dados.relogio !== false;
}

const CORES = { cpu: 'var(--accent)', ram: 'var(--agente-codex)', disco: 'var(--texto-2)' };

function pintarGrafico() {
  const svg = $('monitor-grafico');
  svg.replaceChildren();
  const leg = $('monitor-legenda');
  leg.replaceChildren();
  if (!historico) return;
  const L = 600; const A = 160;
  for (const pct of [0, 50, 100]) {
    const y = A - pct / 100 * A;
    svg.appendChild(svgEl('line', { class: 'monitor-eixo', x1: 0, x2: L, y1: y, y2: y }));
  }
  for (const m of ticksDeHora(historico.inicio, historico.fim)) {
    svg.appendChild(svgEl('line', { class: 'monitor-eixo', x1: m.x * L, x2: m.x * L, y1: 0, y2: A }));
    const t = svgEl('text', { class: 'monitor-eixo-texto', x: m.x * L + 3, y: A - 4 });
    t.textContent = m.rotulo;
    svg.appendChild(t);
  }
  const d = caminhosDoGrafico(historico.amostras, historico.inicio, historico.fim, L, A);
  for (const eixo of EIXOS) {
    svg.appendChild(svgEl('path', { class: 'monitor-linha-grafico', 'data-eixo': eixo, d: d[eixo] }));
    const ult = [...historico.amostras].reverse().find((a) => a[INDICE[eixo]] !== null);
    const item = el('span');
    const cor = el('span', 'monitor-legenda-cor');
    cor.style.background = CORES[eixo];
    item.appendChild(cor);
    item.appendChild(document.createTextNode(`${eixo === 'disco' ? tr('disco') : eixo.toUpperCase()}${ult ? ` ${ult[INDICE[eixo]]} %` : ''}`));
    leg.appendChild(item);
  }
}

function pintarListas() {
  const idioma = idiomaUI.idioma;
  const linhas = (alvo, itens, valor) => {
    alvo.replaceChildren();
    for (const p of itens || []) {
      const l = el('div', 'monitor-linha');
      const nome = el('span', 'monitor-nome', p.nome);
      if (p.job) nome.appendChild(el('span', 'monitor-job', tr('job')));
      l.appendChild(nome);
      l.appendChild(el('span', 'monitor-comando', p.comando));
      l.appendChild(el('span', 'monitor-valor', valor(p)));
      alvo.appendChild(l);
    }
  };
  linhas($('monitor-top-ram'), processos && processos.ram, (p) => formatarBytes(p.rss, idioma));
  linhas($('monitor-top-cpu'), processos && processos.cpu, (p) => `${p.cpu} %`);
}

const NOMES_DOCKER = { imagens: 'Imagens', conteineres: 'Contêineres', volumes: 'Volumes', cache: 'Cache de build' };

function pintarDisco() {
  const medida = disco && disco.medida;
  const idioma = idiomaUI.idioma;
  const agoraS = Math.floor(Date.now() / 1000);
  const quando = $('monitor-disco-quando');
  quando.textContent = textoMedidoEm(medida && medida.em, agoraS, tr) + (disco && disco.falhou ? ` · ${tr('a última medida falhou')}` : '');
  quando.dataset.em = medida ? String(medida.em) : '';
  const estadoBotao = estadoDoBotao({ medindo: Boolean(disco && disco.medindo), enviando });
  const botao = $('btn-medir-disco');
  botao.disabled = estadoBotao.disabled;
  botao.textContent = tr(estadoBotao.texto);
  const total = ultimo && ultimo.agora && ultimo.agora.discoTotal;
  const falhas = (medida && medida.falhas) || {};
  const linha = (alvo, rotulo, bytes, fracao, notas) => {
    const l = el('div', 'monitor-pasta');
    l.appendChild(el('span', 'monitor-pasta-rotulo', rotulo));
    l.appendChild(el('span', 'monitor-valor', formatarBytes(bytes, idioma)));
    const barra = el('span', 'monitor-barra');
    const cheia = el('span', 'monitor-barra-cheia');
    cheia.style.width = `${fracao * 100}%`;
    barra.appendChild(cheia);
    l.appendChild(barra);
    for (const n of notas) l.appendChild(el('span', 'monitor-pasta-nota', n));
    alvo.appendChild(l);
  };
  const pintarPastas = (alvo, bloco, falha) => {
    alvo.replaceChildren();
    for (const p of linhasDePastas(bloco, total)) linha(alvo, p.rotulo, p.bytes, p.fracao, p.contemHome ? [tr('inclui ~')] : []);
    if (!bloco && falha) alvo.appendChild(el('p', 'monitor-pasta-nota', tr('não deu para medir agora')));
  };
  pintarPastas($('monitor-disco-home'), medida && medida.home, falhas.home);
  pintarPastas($('monitor-disco-raiz'), medida && medida.raiz, falhas.raiz);
  const alvoDocker = $('monitor-disco-docker');
  alvoDocker.replaceChildren();
  for (const d of linhasDoDocker(medida && medida.docker, total)) {
    linha(alvoDocker, tr(NOMES_DOCKER[d.tipo] || d.tipo), d.bytes, d.fracao,
      typeof d.recuperavel === 'number' ? [tr`${formatarBytes(d.recuperavel, idioma)} recuperável`] : []);
  }
  if (!(medida && medida.docker) && falhas.docker) alvoDocker.appendChild(el('p', 'monitor-pasta-nota', tr('Docker indisponível')));
}

/** Liga o relógio de 3 s enquanto o servidor diz que está medindo (e o painel aberto); desliga senão. */
function acompanhar() {
  if (disco && disco.medindo && dlg.open) {
    if (!relogioDisco) relogioDisco = setInterval(carregarDisco, 3000);
  } else {
    clearInterval(relogioDisco);
    relogioDisco = null;
  }
}

async function carregarDisco() {
  try { disco = await api('api/monitor/disco'); } catch { /* mantém o que tinha (inclusive o medindo do POST) */ }
  pintarDisco();
  acompanhar();
}

function pintarEixo() {
  for (const b of dlg.querySelectorAll('button.monitor-medidor')) b.setAttribute('aria-expanded', String(b.dataset.eixo === eixoAberto));
  $('monitor-dica').hidden = eixoAberto !== null;
  $('monitor-detalhe').hidden = eixoAberto === null;
  for (const s of dlg.querySelectorAll('[data-secao]')) s.hidden = s.dataset.secao !== eixoAberto;
}

async function carregarPainel({ comHistorico }) {
  try {
    if (comHistorico) historico = await api('api/monitor/historico');
    if (eixoAberto === 'cpu' || eixoAberto === 'ram') processos = await api('api/monitor/processos');
  } catch { /* o painel mantém o que tinha; a faixa já vira "—" se a rede caiu */ }
  if (dlg.open) { pintarGrafico(); pintarListas(); }
}

async function atualizar() {
  try {
    ultimo = await api('api/monitor');
    faixa.removeAttribute('data-estado');
    pintarFaixa(ultimo);
    if (dlg.open) {
      pintarMedidores(ultimo);
      tiques += 1;
      await carregarPainel({ comHistorico: tiques % 4 === 0 });
      if (eixoAberto === 'disco') pintarDisco(); // o `discoTotal` pode ter chegado depois da medida
    }
  } catch {
    // Falha de rede: as barras MANTÊM a última largura (apagadas pelo CSS) e o número vira "—"
    // (spec §5.2) — número velho com cara de ao vivo é justamente o que o monitor existe para não
    // mostrar. 401 não derruba nada — quem pede o token é o app.js.
    faixa.setAttribute('data-estado', 'sem-dado');
    for (const n of faixa.querySelectorAll('.monitor-pct')) n.textContent = '—';
  }
}

function abrir() {
  if (dlg.open) return;
  tiques = 0;
  dlg.showModal();
  if (ultimo) pintarMedidores(ultimo);
  pintarEixo();
  carregarDisco(); // S8: o GET dispara a medida se estiver velha — já pronta quando o dono tocar em disco
  carregarPainel({ comHistorico: true });
}

faixa.onclick = abrir;
selo.onclick = abrir;
$('btn-fechar-monitor').onclick = () => dlg.close();
dlg.addEventListener('close', () => { clearInterval(relogioDisco); relogioDisco = null; }); // Fechar, Esc ou close() de outro dono

for (const b of dlg.querySelectorAll('button.monitor-medidor')) {
  b.onclick = () => {
    eixoAberto = alternarEixo(eixoAberto, b.dataset.eixo);
    pintarEixo();
    if (!eixoAberto) return;
    $('monitor-detalhe').scrollIntoView({ block: 'nearest' });
    if (eixoAberto === 'disco') carregarDisco(); else carregarPainel({ comHistorico: false });
  };
}

// A resposta do POST É estado (`202 { medindo: true, … }`) e é ela que liga o acompanhamento: um GET
// que falhe logo depois não pode apagar isso.
$('btn-medir-disco').onclick = async () => {
  if (enviando) return;
  enviando = true; pintarDisco();
  try { disco = await api('api/monitor/disco', 'POST'); } catch { /* rede: o botão reabilita no finally */ }
  finally { enviando = false; }
  pintarDisco();
  acompanhar();
};

function ligar() { clearInterval(relogio); relogio = setInterval(atualizar, MS_FAIXA); }
// Aba escondida não consulta; ao voltar, lê na hora e religa (mesma regra do `app.js`).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearInterval(relogio); relogio = null; return; }
  if (relogio) return;
  ligar(); atualizar();
});

globalThis.cockpitMonitor.atualizar = atualizar;
ligar();
atualizar();

} // fim do guard `typeof document !== 'undefined'`
})();
