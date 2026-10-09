#!/usr/bin/env node
'use strict';
// GATE das funções PURAS de `public/monitor.js` e da COSTURA da faixa/painel do monitor
// (card do monitor, D64, a spec do monitor, 2026-10-06, §6).
//
// U1-U6: `require('../public/monitor.js')` em Node PURO, sem DOM — o arquivo expõe
// `globalThis.cockpitMonitor` ANTES de tocar em `document`; esse require é a prova de pureza
// (molde de `gate-revisar-md.js`). U7 é estático: lê HTML/CSS/JS como texto e confere os pontos
// de costura (a lista `DIALOGOS`, as duas media queries do selo, os pares do catálogo, o que o
// monitor.js NÃO pode conter).
//
// Uso: node testes/gate-monitor-ui.js

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
require(path.join(PUBLIC, 'monitor.js'));
const { faixaDe, caminhosDoGrafico, textoDoAviso, formatarBytes, ticksDeHora, LACUNA_S } = globalThis.cockpitMonitor;
// D68: as puras do painel maior. `undefined` não derruba o gate — cada caso reprova legível.
const { alternarEixo, linhasDePastas, linhasDoDocker, textoMedidoEm, estadoDoBotao, tituloDoMonitor } = globalThis.cockpitMonitor;

let falhas = 0;
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) falhas += 1; return c; };
const igualJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const conta = (texto, letra) => (texto.match(new RegExp(letra, 'g')) || []).length;

// ─── U1 ───
{
  const f = faixaDe({ agora: { cpu: 90, ram: 89, disco: null }, limites: { liga: 90 } });
  ok(f[0].eixo === 'cpu' && f[0].alerta === true, 'U1: cpu 90 com liga 90 → alerta');
  ok(f[1].alerta === false, 'U1: ram 89 → sem alerta');
  ok(f[2].texto === '—' && f[2].pct === null && f[2].alerta === false, 'U1: disco null → "—", sem alerta');
  ok(f[0].texto === '90 %', `U1: texto "90 %" (veio "${f[0].texto}")`);
  const g = faixaDe({ agora: { cpu: 90, ram: 89, disco: null }, limites: { liga: 80 } });
  ok(g[1].alerta === true, 'U1: com limites.liga = 80 (lido da resposta) o 89 alerta');
}

// ─── U2 / U3 ───
{
  const d = caminhosDoGrafico([[0, 10, 10, 10], [60, 20, 20, 20], [120, null, 30, 30], [180, 40, 40, 40]], 0, 180, 600, 160);
  ok(conta(d.cpu, 'M') === 2, `U2: cpu abre 2 "M" (buraco no null; veio ${JSON.stringify(d.cpu)})`);
  ok(conta(d.ram, 'M') === 1 && conta(d.ram, 'L') === 3, `U2: ram é um traço só (veio ${JSON.stringify(d.ram)})`);
  ok(caminhosDoGrafico([], 0, 180, 600, 160).cpu === '', 'U2: sem amostras → d vazio');
  const lacuna = caminhosDoGrafico([[0, 10, 10, 10], [60, 10, 10, 10], [21600, 10, 10, 10]], 0, 21600, 600, 160);
  ok(conta(lacuna.cpu, 'M') === 2, `U3: 6 h sem amostra não vira reta (2 "M"; veio ${JSON.stringify(lacuna.cpu)})`);
  const justo = caminhosDoGrafico([[0, 10, 10, 10], [LACUNA_S, 10, 10, 10]], 0, 600, 600, 160);
  ok(LACUNA_S === 180 && conta(justo.cpu, 'M') === 1, 'U3: distância IGUAL a LACUNA_S (180) ainda liga (1 "M")');
  const fora = caminhosDoGrafico([[-50, 10, 10, 10], [10, 10, 10, 10], [999, 10, 10, 10]], 0, 100, 600, 160);
  ok(conta(fora.cpu, 'M') === 1 && conta(fora.cpu, 'L') === 0, 'U3: amostra fora de [inicio, fim] é ignorada');
}

// ─── U4 ───
{
  ok(formatarBytes(1073741824, 'pt-BR') === '1 GB', `U4: 1 GiB → "1 GB" (veio "${formatarBytes(1073741824, 'pt-BR')}")`);
  ok(formatarBytes(1395864371, 'pt-BR') === '1,3 GB', `U4: 1395864371 → "1,3 GB" (veio "${formatarBytes(1395864371, 'pt-BR')}")`);
  ok(formatarBytes(1395864371, 'en') === '1.3 GB', 'U4: em inglês, ponto decimal');
  ok(formatarBytes(null, 'pt-BR') === '—' && !/NaN/.test(formatarBytes(NaN, 'pt-BR')), 'U4: null/NaN → "—", nunca "NaN"');
}

// ─── U5 ───
{
  const t = ticksDeHora(0, 86400);
  ok(t.length === 4, `U5: 24 h dão 4 marcas de 6 em 6 h (veio ${t.length})`);
  ok(t.every((m) => /^\d\d:00$/.test(m.rotulo) && m.x >= 0 && m.x < 1), `U5: rótulos HH:00 e x em [0,1) (${t.map((m) => m.rotulo).join(' ')})`);
}

// ─── U6 ───
{
  // Um `tr` de mentira que sabe as duas formas de chamada (tag de template e string).
  const tr = (s, ...v) => (Array.isArray(s) ? s.map((p, i) => p + (i < v.length ? v[i] : '')).join('') : s);
  const txt = textoDoAviso({ cpu: false, ram: true, disco: false }, { ram: 87 }, { liga: 90 }, tr);
  ok(/RAM/.test(txt) && /87/.test(txt) && /90/.test(txt), `U6: aviso de RAM cita eixo, valor e LIMITE (veio "${txt}")`);
  ok(textoDoAviso({ cpu: false, ram: false, disco: false }, { ram: 50 }, { liga: 90 }, tr) === '', 'U6: nada ligado → ""');
  const dois = textoDoAviso({ cpu: true, ram: false, disco: true }, { cpu: 91, disco: 92 }, { liga: 90 }, tr);
  ok(/CPU/.test(dois) && /disco/.test(dois), `U6: dois eixos ligados aparecem juntos (veio "${dois}")`);
}

// ─── U-título — o título do monitor vem do servidor (D78) ───
{
  const tr = (s, ...v) => (Array.isArray(s) ? s.join('') : String(s).replace(/\{(\d+)\}/g, (o, i) => v[i] ?? o));
  ok(typeof tituloDoMonitor === 'function' && tituloDoMonitor('servidor-x', tr) === 'Monitor de servidor-x', 'U-título: maquina "servidor-x" → "Monitor de servidor-x"');
  ok(typeof tituloDoMonitor === 'function' && ['', undefined, 42].every((m) => tituloDoMonitor(m, tr) === 'Monitor do servidor'), 'U-título: vazio, undefined ou não-string → "Monitor do servidor"');
  ok(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').includes('<h2 id="monitor-titulo">'), 'U-título: index.html tem <h2 id="monitor-titulo">');
}

// ─── U8 — um eixo aberto por vez ───
{
  const f = typeof alternarEixo === 'function' ? alternarEixo : () => undefined;
  ok(f(null, 'disco') === 'disco', 'U8: nada aberto + tocar disco → abre disco');
  ok(f('disco', 'cpu') === 'cpu', 'U8: disco aberto + tocar cpu → troca para cpu');
  ok(f('cpu', 'cpu') === null, 'U8: tocar no eixo aberto → fecha (null)');
}

// ─── U9 — linhas de pasta e do Docker ───
{
  const itens = Array.from({ length: 12 }, (_, i) => ({ rotulo: `~/p${i}`, bytes: (12 - i) * 100, contemHome: i === 3 }));
  const p = typeof linhasDePastas === 'function' ? linhasDePastas({ itens }, 1000) : [];
  ok(p.length === 10, `U9: linhasDePastas corta em 10 (veio ${p.length})`);
  ok(p.every((l) => l.fracao >= 0 && l.fracao <= 1 && !Number.isNaN(l.fracao)), 'U9: fracao em [0, 1], nunca NaN');
  ok(p[3] && p[3].contemHome === true && p[0] && p[0].contemHome === false, 'U9: contemHome repassado');
  const grande = typeof linhasDePastas === 'function' ? linhasDePastas({ itens: [{ rotulo: 'x', bytes: 5000, contemHome: false }] }, 1000) : [];
  ok(grande[0] && grande[0].fracao === 1, 'U9: item maior que o disco → fracao 1');
  for (const total of [null, 0, undefined]) {
    const z = typeof linhasDePastas === 'function' ? linhasDePastas({ itens }, total) : [{ fracao: 9 }];
    ok(z.length > 0 && z.every((l) => l.fracao === 0), `U9: discoTotal ${total} → fracao 0`);
  }
  const d = typeof linhasDoDocker === 'function' ? linhasDoDocker([
    { tipo: 'imagens', bytes: 500, recuperavel: 100 }, { tipo: 'conteineres', bytes: 5, recuperavel: 5 },
    { tipo: 'volumes', bytes: 50, recuperavel: null }, { tipo: 'cache', bytes: 900, recuperavel: 800 }], 1000) : [];
  ok(d.length === 4 && d.every((l) => l.fracao >= 0 && l.fracao <= 1), 'U9: linhasDoDocker → 4 com fracao');
  ok(typeof linhasDoDocker === 'function' && igualJson(linhasDoDocker(null, 1000), []), 'U9: linhasDoDocker(null) → []');
}

// ─── U10 — "medido às" ───
{
  const tr = (s, ...v) => (Array.isArray(s) ? s.map((p, i) => p + (i < v.length ? v[i] : '')).join('') : s);
  const f = typeof textoMedidoEm === 'function' ? textoMedidoEm : () => '';
  const agora = Math.floor(new Date(2026, 9, 7, 15, 30, 0).getTime() / 1000);
  ok(f(null, agora, tr) === 'ainda não medido', 'U10: sem medida → "ainda não medido"');
  const hoje = f(agora - 600, agora, tr);
  ok(/^medido às \d\d:\d\d$/.test(hoje), `U10: mesmo dia → "medido às HH:MM" (veio "${hoje}")`);
  const ontem = f(agora - 86400, agora, tr);
  ok(/^medido em \d\d\/\d\d às \d\d:\d\d$/.test(ontem), `U10: ontem → "medido em dd/mm às HH:MM" (veio "${ontem}")`);
}

// ─── U11 — a tabela do botão "medir agora" ───
{
  const f = typeof estadoDoBotao === 'function' ? estadoDoBotao : () => ({});
  ok(f({ medindo: false, enviando: true }).disabled === true, 'U11: enviando → desabilitado');
  const m = f({ medindo: true });
  ok(m.disabled === true && m.texto === 'medindo…', `U11: servidor medindo → desabilitado + "medindo…" (veio ${JSON.stringify(m)})`);
  const l = f({ medindo: false, enviando: false });
  ok(l.disabled === false && l.texto === 'medir agora', `U11: livre → habilitado + "medir agora" (veio ${JSON.stringify(l)})`);
}

// ─── U7 — a costura, como texto ───
{
  const ler = (n) => fs.readFileSync(path.join(PUBLIC, n), 'utf8');
  const html = ler('index.html'); const app = ler('app.js'); const css = ler('estilo.css');
  const trad = ler('traducoes.js'); const mon = ler('monitor.js');

  for (const frag of ['id="monitor-faixa"', 'id="monitor-aviso"', 'id="dialogo-monitor"', 'src="monitor.js"']) {
    ok(html.includes(frag), `U7: index.html tem ${frag}`);
  }
  const ini = app.indexOf('const DIALOGOS = [');
  const lista = ini < 0 ? '' : app.slice(ini, app.indexOf('];', ini));
  ok(lista.includes("'dialogo-monitor'"), "U7: app.js tem 'dialogo-monitor' DENTRO do array DIALOGOS (#40)");

  // O corpo de cada @media com o cabeçalho dado, por contagem de chaves.
  const blocosMedia = (cabecalho) => {
    const saida = [];
    let i = css.indexOf(cabecalho);
    while (i >= 0) {
      let prof = 0; let j = css.indexOf('{', i);
      const comeco = j;
      for (; j < css.length; j += 1) {
        if (css[j] === '{') prof += 1;
        else if (css[j] === '}') { prof -= 1; if (prof === 0) break; }
      }
      saida.push(css.slice(comeco, j + 1));
      i = css.indexOf(cabecalho, j);
    }
    return saida;
  };
  const regraCel = '.app[data-vista="chat"] ~ .monitor-selo';
  const regraDesk = '.app[data-lateral="fechada"] ~ .monitor-selo';
  ok(blocosMedia('@media (max-width: 760px)').some((b) => b.includes(regraCel)), 'U7: a regra do selo do CELULAR está dentro de @media (max-width: 760px)');
  ok(blocosMedia('@media (min-width: 761px)').some((b) => b.includes(regraDesk)), 'U7: a regra do selo do DESKTOP está dentro de @media (min-width: 761px)');
  ok(!css.replace(/@media[^{]*\{[^{}]*\{[^}]*\}\s*\}/g, '').includes('~ .monitor-selo:not([hidden]) { display: block'),
    'U7: nenhuma regra que MOSTRA o selo fica fora de uma media query');

  const chaves = ['disco', 'Monitor do servidor', 'Monitor de {0}', 'últimas 24 horas', 'Mais RAM agora', 'Mais CPU agora', '% de um núcleo',
    '{0} em {1} % — limite {2} %', 'sem dado', 'histórico parado neste servidor', '{0} núcleos',
    'Monitor: abrir o detalhe de CPU, RAM e disco'];
  for (const k of chaves) ok(trad.includes(`"${k}":`), `U7: traducoes.js tem o par de "${k}"`);

  ok(!/\.innerHTML/.test(mon), 'U7: monitor.js não usa `.innerHTML` (#26)');

  // D68 — os medidores viram botões; o detalhe tem uma seção por eixo
  for (const eixo of ['cpu', 'ram', 'disco']) {
    ok(html.includes(`<button type="button" class="monitor-medidor" data-eixo="${eixo}" aria-expanded="false" aria-controls="monitor-detalhe"`),
      `U7: o medidor ${eixo} é <button> com aria-expanded/aria-controls`);
  }
  ok(!html.includes('<div class="monitor-medidor"'), 'U7: não sobrou medidor como <div>');
  for (const frag of ['id="monitor-detalhe"', 'data-secao="cpu"', 'data-secao="ram"', 'data-secao="disco"', 'id="btn-medir-disco"',
    'id="monitor-disco-home"', 'id="monitor-disco-raiz"', 'id="monitor-disco-docker"', 'id="monitor-disco-quando"', 'id="monitor-dica"',
    'class="monitor-grafico-y"', '>100<', '>50<', '>0<', 'id="monitor-top-ram"', 'id="monitor-top-cpu"']) {
    ok(html.includes(frag), `U7: index.html tem ${frag}`);
  }
  ok(blocosMedia('@media (max-width: 760px)').some((b) => b.includes('#dialogo-monitor[open]')), 'U7: a tela cheia #dialogo-monitor[open] está dentro de @media (max-width: 760px)');
  ok(!css.includes('.monitor-tops'), 'U7: estilo.css não tem mais .monitor-tops');
  const paresNovos = ['Toque em CPU, RAM ou disco para ver o top 10.', 'medir agora', 'medindo…', 'medido às {0}', 'medido em {0} às {1}',
    'ainda não medido', 'Tamanhos do que o usuário enxerga. O Docker mora em /var, que o usuário não lê — por isso vem à parte.',
    'Pasta pessoal (~)', 'Raiz (/)', 'Docker', 'Imagens', 'Contêineres', 'Volumes', 'Cache de build', '{0} recuperável', 'inclui ~', 'job',
    'não deu para medir agora', 'Docker indisponível', 'a última medida falhou'];
  for (const k of paresNovos) ok(trad.includes(`"${k}":`), `U7: traducoes.js tem o par de "${k}"`);
  // Só leitura: o painel não tem botão de apagar/limpar/prune (comentários do HTML não contam)
  const dlgMon = (html.match(/<dialog id="dialogo-monitor">[\s\S]*?<\/dialog>/) || [''])[0].replace(/<!--[\s\S]*?-->/g, '');
  ok(dlgMon.length > 0 && !/apagar|limpar|prune|excluir|remover/i.test(dlgMon), 'U7: o painel do monitor não oferece apagar/limpar/prune (só leitura)');
  ok(!mon.includes("'DELETE'") && !/prune/.test(mon), 'U7: monitor.js sem DELETE nem prune');
  // U12 — todo formatarBytes do disco leva o idioma (2º argumento)
  const iniDisco = mon.indexOf('function pintarDisco');
  const fimDisco = mon.indexOf('\n}\n', iniDisco);
  const corpoDisco = iniDisco < 0 ? '' : mon.slice(iniDisco, fimDisco);
  ok(corpoDisco.length > 0 && corpoDisco.includes('formatarBytes(') && !/formatarBytes\([^,()]*\)/.test(corpoDisco), 'U12: pintarDisco chama formatarBytes sempre com o idioma');
  ok(!/\btitle\s*=/.test(mon), 'U7: monitor.js não escreve `title` (#31)');
  // Rede caída: o atributo só vale se alguém o LÊ (#75) — e a prova de tela é o passo 6 do print-monitor.js
  ok(css.includes('.monitor-faixa[data-estado="sem-dado"]'), 'U7: estilo.css tem a regra de .monitor-faixa[data-estado="sem-dado"]');

  const tagFaixa = (html.match(/<button class="monitor-faixa"[\s\S]*?>/) || [''])[0];
  ok(tagFaixa.includes('aria-label="Monitor: abrir o detalhe de CPU, RAM e disco"'), 'U7: a faixa tem o aria-label do catálogo');
  ok(html.indexOf('class="monitor-faixa"') > 0 && html.indexOf('class="monitor-faixa"') < html.indexOf('class="barra-vistas"'),
    'U7: a faixa vem ANTES da .barra-vistas (a barra segue sendo a borda inferior, com a safe area)');
}

console.log(falhas ? `\n❌ ${falhas} falha(s)` : '\n✅ gate-monitor-ui verde');
process.exitCode = falhas ? 1 : 0;
