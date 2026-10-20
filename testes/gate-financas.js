#!/usr/bin/env node
'use strict';
// GATE — o Painel de Finanças (D90; spec 2026-10-17-painel-financas-design.md): o leitor do
// resumo financeiro diário gravado por um gerador externo (lib/financas.js) e o envio do PDF
// pelo Taildrop (o pedaço extraído de lib/arquivos.js). Molde `testes/gate-sites.js`.
//
// F1–F10 provam o leitor (funções PURAS + `ler()`/`estado()`/`enviar()` com disco de
// fixture, SEMPRE em `mkdtemp`, e o envio contra um Taildrop de MENTIRA) — nenhum valor do
// arquivo real entra aqui: as pessoas são `ana`/`bia`, as contas "Banco A"/"Banco B". O F11
// (as rotas, com `server.js` FILHO) entra na fase 2, junto com as rotas.
//
// Isolamento: `COCKPIT_FINANCAS_DIR` é definida ANTES do `require('../lib/financas')` — ela
// VENCE um `HOME` falso (#62): sem a env, o módulo cairia no `~/.cockpit/financas/` de quem
// estiver rodando o gate. O mundo do Taildrop de mentira (binário + socket localapi) é criado
// UMA vez no começo do `main()` e fechado só no `finally` dele.
//
// Uso: node testes/gate-financas.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

let falhas = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); if (!cond) falhas += 1; return cond; };

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-financas-'));
// Caminho que nunca é criado: estado neutro antes de o primeiro caso plantar a pasta de verdade.
process.env.COCKPIT_FINANCAS_DIR = path.join(RAIZ, 'nada');
delete process.env.COCKPIT_FINANCAS_DESTINO;
const financas = require('../lib/financas');
const arquivos = require('../lib/arquivos');
const fx = require('./fixtures-arquivos');
const fxFin = require('./fixtures-financas'); // D92 — a alavanca: mundo ana/bia coerente

/** Cria `RAIZ/<nome>`, aponta `COCKPIT_FINANCAS_DIR` para ela, devolve o caminho. */
function pasta(nome) {
  const dir = path.join(RAIZ, nome);
  fs.mkdirSync(dir, { recursive: true });
  process.env.COCKPIT_FINANCAS_DIR = dir;
  return dir;
}

const iso = (msAtras) => new Date(Date.now() - msAtras).toISOString();

/** 7 categorias (6 + "Demais"), decrescentes — valores redondos inventados. */
function catsPadrao() {
  return [
    { nome: 'Mercado', valor: 900 },
    { nome: 'Casa', valor: 700 },
    { nome: 'Transporte', valor: 500 },
    { nome: 'Saúde', valor: 300 },
    { nome: 'Lazer', valor: 200 },
    { nome: 'Educação', valor: 100 },
    { nome: 'Demais', valor: 50 },
  ];
}

/** Um resumo `versao: 1` completo e VÁLIDO (fixture falsa); `sobrescreve` faz merge RASO. */
function resumo(id, sobrescreve = {}) {
  const base = {
    versao: 1,
    pessoa: { id, nome: id === 'ana' ? 'Ana' : 'Bia' },
    gerado_em: iso(3600e3),
    dados_ate: '2026-03-14',
    saldo: {
      total: 1500,
      contas: [
        { nome: 'Banco A', tipo: 'checking', conectada: true, saldo: 1000 },
        { nome: 'Banco B', tipo: 'checking', conectada: false, saldo: 500 },
      ],
    },
    meses: [
      { mes: '2026-01', rotulo: 'jan', periodo: '01/01 a 31/01', parcial: false, renda: 5000, gasto: 3000, fatura_cartao: 800, categorias: catsPadrao() },
      { mes: '2026-02', rotulo: 'fev', periodo: '01/02 a 28/02', parcial: false, renda: 5200, gasto: 3100, fatura_cartao: 850, categorias: catsPadrao() },
      { mes: '2026-03', rotulo: 'mar', periodo: '01/03 a 14/03', parcial: true, renda: 2000, gasto: 1200, fatura_cartao: 300, categorias: catsPadrao() },
    ],
    reembolsos: {
      pendente: 120,
      itens: [
        { data: '2026-02-10', descricao: 'Consulta', valor: 80, atrasado: true },
        { data: '2026-03-05', descricao: 'Farmácia', valor: 40, atrasado: false },
      ],
    },
    avisos: [],
    pdf: `${id}.pdf`,
  };
  return { ...base, ...sobrescreve };
}

/** Grava `<dir>/<id>.json` (objeto → JSON; string → texto cru). */
function plantar(dir, id, objOuTexto) {
  const caminho = path.join(dir, `${id}.json`);
  const texto = typeof objOuTexto === 'string' ? objOuTexto : JSON.stringify(objOuTexto);
  fs.writeFileSync(caminho, texto);
  return caminho;
}

/** Grava `<dir>/<id>.pdf` com um PDF falso curto. */
function pdf(dir, id) {
  const caminho = path.join(dir, `${id}.pdf`);
  fs.writeFileSync(caminho, '%PDF-1.4 falso');
  return caminho;
}

/** Grava `<dir>/<id>.lancamentos.json` (objeto → JSON; string → texto cru). D92/bloco L. */
function plantarLancamentos(dir, id, objOuTexto) {
  const caminho = path.join(dir, `${id}.lancamentos.json`);
  const texto = typeof objOuTexto === 'string' ? objOuTexto : JSON.stringify(objOuTexto);
  fs.writeFileSync(caminho, texto);
  return caminho;
}

/** Envelope v1 de lançamentos — `sobrescreve` faz merge RASO. D92/bloco L. */
function envelopeLanc(id, lancamentos, sobrescreve = {}) {
  return { versao: 1, pessoa: { id, nome: id }, gerado_em: iso(0), lancamentos, ...sobrescreve };
}

/** Uma linha de lançamento VÁLIDA — `i` só varia data/descrição/valor. D92/bloco L. */
function linhaValida(i) {
  const dia = String(1 + (i % 27)).padStart(2, '0');
  return {
    data: `2026-01-${dia}`, descricao: `Loja ${i}`, valor: 10 + i, tipo: 'debito',
    categoria: 'Mercado', grupo: null, fora_do_gasto: false, conta: 'Banco A',
  };
}

/** Molde `gate-sites.js:268`: verdadeiro se a porta não aparece num `ss -H -lptn`. */
function portaLivre(porta) {
  try {
    const saida = execFileSync('ss', ['-H', '-lptn'], { encoding: 'utf8' });
    return !saida.split('\n').some((l) => (l.trim().split(/\s+/)[3] || '').endsWith(`:${porta}`));
  } catch { return true; }
}

async function main() {
  // ─── Mundo do Taildrop de MENTIRA — compartilhado por F10 (e F11, na fase 2) ───
  const raizT = fx.raizTemporaria('gate-fin-');
  fx.montarInbox(raizT); // o binarioFalso exige o inbox
  const bin = fx.binarioFalso(raizT);
  if (!bin || /(^|\/)tailscale$/.test(bin)) {
    console.error(`🔴 recuso seguir com o tailscale REAL (${bin})`);
    process.exit(1);
  }
  const sock = path.join(raizT, 'ts.sock');
  const estadoSock = {};
  const s = fx.socketFalso(sock, estadoSock);
  await s.pronto;
  const chamadasLog = path.join(raizT, 'chamadas.log');
  const lerChamadas = () => (fs.existsSync(chamadasLog) ? fs.readFileSync(chamadasLog, 'utf8') : '');

  try {
    // ─── F1 — pasta ausente / vazia / só nomes inválidos; e `estado()` ───
    {
      financas._zerarParaTeste();
      process.env.COCKPIT_FINANCAS_DIR = path.join(RAIZ, 'f1-ausente');
      const r1 = await financas.ler();
      ok(r1.ligado === false, `F1: pasta ausente → ligado false (veio ${JSON.stringify(r1)})`);
      const e1 = await financas.estado();
      ok(e1.ligado === false, `F1: estado() pasta ausente → false (veio ${JSON.stringify(e1)})`);

      pasta('f1-vazia');
      const r2 = await financas.ler();
      ok(r2.ligado === false, `F1: pasta vazia → ligado false (veio ${JSON.stringify(r2)})`);
      const e2 = await financas.estado();
      ok(e2.ligado === false, `F1: estado() pasta vazia → false (veio ${JSON.stringify(e2)})`);

      const dirInvalido = pasta('f1-invalida');
      fs.writeFileSync(path.join(dirInvalido, 'Ana.json'), 'nao importa');
      fs.writeFileSync(path.join(dirInvalido, 'a.b.json'), 'nao importa');
      fs.writeFileSync(path.join(dirInvalido, 'casa.json'), 'nao importa');
      const r3 = await financas.ler();
      ok(r3.ligado === false, `F1: só nomes inválidos → ligado false (veio ${JSON.stringify(r3)})`);
      const e3 = await financas.estado();
      ok(e3.ligado === false, `F1: estado() só nomes inválidos → false (veio ${JSON.stringify(e3)})`);
    }

    // ─── F2 — uma pessoa válida ───
    {
      financas._zerarParaTeste();
      const dir = pasta('f2');
      plantar(dir, 'ana', resumo('ana'));
      pdf(dir, 'ana');
      const r = await financas.ler();
      ok(r.ligado === true, `F2: ligado true (veio ${JSON.stringify(r.ligado)})`);
      ok(r.pessoas.length === 1 && r.casa === null, `F2: 1 pessoa, casa null (veio ${r.pessoas.length} pessoa(s), casa ${JSON.stringify(r.casa)})`);
      ok(r.pessoas[0].ultimoCompleto === '2026-02', `F2: ultimoCompleto = maior mês com parcial false (veio ${r.pessoas[0].ultimoCompleto})`);
      ok(r.pessoas[0].arquivos.pdf === true, `F2: arquivos.pdf true quando o PDF existe (veio ${JSON.stringify(r.pessoas[0].arquivos)})`);
      const e = await financas.estado();
      ok(e.ligado === true, `F2: estado() true com 1 candidato (veio ${JSON.stringify(e)})`);

      financas._zerarParaTeste();
      const dir2 = pasta('f2-sem-pdf');
      plantar(dir2, 'ana', resumo('ana'));
      const r2 = await financas.ler();
      ok(r2.pessoas[0].arquivos.pdf === false, `F2: arquivos.pdf false sem o PDF no disco (veio ${JSON.stringify(r2.pessoas[0].arquivos)})`);
    }

    // ─── F3 — "não sei" ───
    {
      financas._zerarParaTeste();
      const dir = pasta('f3');
      plantar(dir, 'ana', resumo('ana', {
        saldo: { total: undefined, contas: [] },
        meses: [
          { mes: '2026-01', rotulo: 'jan', periodo: 'p1', parcial: true, renda: '100', gasto: null, fatura_cartao: 800, categorias: [] },
          { mes: '2026-02', rotulo: 'fev', periodo: 'p2', parcial: 'sim', renda: 5200, gasto: 3100, fatura_cartao: 850, categorias: [] },
        ],
      }));
      const r = await financas.ler();
      const p = r.pessoas[0];
      ok(p.saldo.total === null, `F3: saldo sem total → null (veio ${p.saldo.total})`);
      ok(p.meses[0].renda === null, `F3: renda "100" (string) → null (veio ${p.meses[0].renda})`);
      ok(p.meses[0].gasto === null, `F3: gasto null → null (veio ${p.meses[0].gasto})`);
      ok(p.meses[1].parcial === null, `F3: parcial "sim" → null (veio ${p.meses[1].parcial})`);
      ok(p.ultimoCompleto === null, `F3: mês com parcial null não conta como completo (veio ${p.ultimoCompleto})`);
    }

    // ─── F4 — ilegíveis ───
    {
      financas._zerarParaTeste();
      const dir = pasta('f4');
      fs.writeFileSync(path.join(dir, 'grande.json'), 'x'.repeat(300 * 1024));
      fs.writeFileSync(path.join(dir, 'quebrado.json'), '{ "versao": 1,');
      plantar(dir, 'versaoerrada', resumo('versaoerrada', { versao: 2 }));
      plantar(dir, 'idtrocado', resumo('outraidentidade'));
      const r = await financas.ler();
      for (const id of ['grande', 'quebrado', 'versaoerrada', 'idtrocado']) {
        ok(r.ilegiveis.includes(id), `F4: "${id}" em ilegiveis (veio ${JSON.stringify(r.ilegiveis)})`);
      }
      ok(r.ligado === true && r.pessoas.length === 0, `F4: ligado true, pessoas vazio (veio ligado=${r.ligado}, pessoas=${r.pessoas.length})`);

      const original = console.error;
      let contador = 0;
      console.error = () => { contador += 1; };
      try {
        await financas.ler();
        await financas.ler();
      } finally {
        console.error = original;
      }
      ok(contador === 0, `F4: leituras seguidas sem NOVA transição não logam de novo (veio ${contador})`);
    }

    // ─── F4b — excedente (9 válidos → 8 em pessoas, o 9º em ilegiveis + casaIndisponivel) ───
    {
      financas._zerarParaTeste();
      const dir = pasta('f4-nove');
      for (let i = 1; i <= 9; i += 1) {
        const id = `p${i}`;
        plantar(dir, id, resumo(id, { pessoa: { id, nome: `Pessoa ${i}` } }));
      }
      const r = await financas.ler();
      ok(r.pessoas.length === 8, `F4b: 9 válidos → 8 em pessoas (veio ${r.pessoas.length})`);
      ok(r.ilegiveis.length === 1 && r.ilegiveis[0] === 'p9', `F4b: o 9º em ilegiveis (veio ${JSON.stringify(r.ilegiveis)})`);
      ok(r.casa === null && r.casaIndisponivel === true, `F4b: casa null + casaIndisponivel (veio casa=${JSON.stringify(r.casa)}, casaIndisponivel=${r.casaIndisponivel})`);
    }

    // ─── F4c — uma pessoa ok + uma ilegível → casa: null ───
    {
      financas._zerarParaTeste();
      const dir = pasta('f4-uma-mais-ilegivel');
      plantar(dir, 'ana', resumo('ana'));
      fs.writeFileSync(path.join(dir, 'zebra.json'), 'lixo {');
      const r = await financas.ler();
      ok(r.pessoas.length === 1 && r.ilegiveis.length === 1, `F4c: 1 ok + 1 ilegível (veio pessoas=${r.pessoas.length}, ilegiveis=${JSON.stringify(r.ilegiveis)})`);
      ok(r.casa === null, `F4c: casa null com 1 ilegível (veio ${JSON.stringify(r.casa)})`);
    }

    // ─── F4d — pasta chmod 000 → ligado true, erro: 'pasta' ───
    {
      financas._zerarParaTeste();
      const dirChmod = pasta('f4-chmod');
      plantar(dirChmod, 'ana', resumo('ana'));
      fs.chmodSync(dirChmod, 0o000);
      try {
        const r = await financas.ler();
        ok(r.ligado === true && r.erro === 'pasta', `F4d: pasta sem permissão → ligado true, erro pasta (veio ${JSON.stringify(r)})`);
      } finally {
        fs.chmodSync(dirChmod, 0o755);
      }
    }

    // ─── F5 — nomes ignorados (incluindo symlink) ───
    {
      financas._zerarParaTeste();
      const dir = pasta('f5');
      plantar(dir, 'ana', resumo('ana'));
      fs.writeFileSync(path.join(dir, 'Ana.json'), 'nao importa');
      fs.writeFileSync(path.join(dir, 'a.b.json'), 'nao importa');
      fs.writeFileSync(path.join(dir, 'casa.json'), 'nao importa');
      const alvoFora = path.join(RAIZ, 'f5-alvo-externo.json');
      fs.writeFileSync(alvoFora, JSON.stringify(resumo('c')));
      fs.symlinkSync(alvoFora, path.join(dir, 'c.json'));
      const r = await financas.ler();
      ok(r.pessoas.length === 1 && r.pessoas[0].id === 'ana', `F5: só "ana" em pessoas (veio ${JSON.stringify(r.pessoas.map((p) => p.id))})`);
      ok(!r.ilegiveis.includes('Ana') && !r.ilegiveis.includes('a.b') && !r.ilegiveis.includes('casa') && !r.ilegiveis.includes('c'),
        `F5: nomes inválidos e o symlink fora de ilegiveis (veio ${JSON.stringify(r.ilegiveis)})`);
    }

    // ─── F6 — casa ───
    {
      financas._zerarParaTeste();
      const dir = pasta('f6');
      plantar(dir, 'ana', resumo('ana', {
        dados_ate: '2026-03-10',
        meses: [
          { mes: '2026-01', rotulo: 'jan', periodo: 'p1', parcial: false, renda: 5000, gasto: 3000, fatura_cartao: 800, categorias: [
            { nome: 'Mercado', valor: 900 }, { nome: 'Casa', valor: 700 }, { nome: 'Transporte', valor: 500 },
            { nome: 'Saúde', valor: 300 }, { nome: 'Lazer', valor: 200 }, { nome: 'Educação', valor: 100 }, { nome: 'Demais', valor: 50 },
          ] },
          { mes: '2026-02', rotulo: 'fev', periodo: 'p2', parcial: false, renda: 5200, gasto: null, fatura_cartao: 850, categorias: [
            { nome: 'Mercado', valor: 950 }, { nome: 'Casa', valor: 750 }, { nome: 'Transporte', valor: 550 },
            { nome: 'Saúde', valor: 350 }, { nome: 'Lazer', valor: 250 }, { nome: 'Educação', valor: 150 }, { nome: 'Demais', valor: 60 },
          ] },
          { mes: '2026-03', rotulo: 'mar', periodo: 'p3', parcial: true, renda: 2000, gasto: 1200, fatura_cartao: 300, categorias: [] },
        ],
        reembolsos: { pendente: 120, itens: [{ data: '2026-02-10', descricao: 'Consulta', valor: 80, atrasado: true }] },
      }));
      plantar(dir, 'bia', resumo('bia', {
        dados_ate: '2026-03-05',
        meses: [
          { mes: '2026-01', rotulo: 'jan', periodo: 'p1', parcial: false, renda: 4000, gasto: 2500, fatura_cartao: 400, categorias: [
            { nome: 'Mercado', valor: 500 }, { nome: 'Casa', valor: 400 }, { nome: 'Transporte', valor: 300 },
            { nome: 'Saúde', valor: 200 }, { nome: 'Lazer', valor: 100 }, { nome: 'Pets', valor: 90 }, { nome: 'Demais', valor: 40 },
          ] },
          { mes: '2026-02', rotulo: 'fev', periodo: 'p2', parcial: false, renda: 4200, gasto: 2800, fatura_cartao: 420, categorias: [
            { nome: 'Mercado', valor: 550 }, { nome: 'Casa', valor: 420 }, { nome: 'Transporte', valor: 310 },
            { nome: 'Saúde', valor: 210 }, { nome: 'Lazer', valor: 110 }, { nome: 'Pets', valor: 95 }, { nome: 'Demais', valor: 45 },
          ] },
        ],
        reembolsos: null,
      }));
      const r = await financas.ler();
      ok(r.casa !== null, `F6: casa existe com 2 pessoas legíveis (veio ${JSON.stringify(r.casa)})`);
      const casa = r.casa;
      ok(casa.meses.length === 2 && casa.meses.map((m) => m.mes).join(',') === '2026-01,2026-02',
        `F6: só os meses presentes nas duas entram na casa — "2026-03" (só de ana) fica de fora (veio ${JSON.stringify(casa.meses.map((m) => m.mes))})`);
      ok(casa.meses[0].renda === 9000 && casa.meses[0].gasto === 5500, `F6: soma certa de renda/gasto no mês completo (veio renda=${casa.meses[0].renda}, gasto=${casa.meses[0].gasto})`);
      ok(casa.meses[1].gasto === null, `F6: gasto null de ana contamina a soma do mês (veio ${casa.meses[1].gasto})`);
      ok(casa.dadosAte === '2026-03-05', `F6: dadosAte = o menor (veio ${casa.dadosAte})`);
      ok(casa.categoriasAproximadas === true, `F6: nomes de categoria diferentes (Educação × Pets) → aproximado (veio ${casa.categoriasAproximadas})`);
      const demais = casa.meses[0].categorias.find((c) => c.nome === 'Demais');
      ok(Boolean(demais), `F6: categoria "Demais" presente na casa (veio ${JSON.stringify(casa.meses[0].categorias)})`);
      ok(casa.reembolsos && casa.reembolsos.pendente === 120, `F6: reembolsos null de bia não contamina — pendente só de ana (veio ${JSON.stringify(casa.reembolsos)})`);
    }

    // ─── F6b — mesma lista de nomes → categoriasAproximadas: false ───
    {
      financas._zerarParaTeste();
      const dir = pasta('f6-iguais');
      const catsIguais = () => ([
        { nome: 'Mercado', valor: 100 }, { nome: 'Casa', valor: 90 }, { nome: 'Transporte', valor: 80 },
        { nome: 'Saúde', valor: 70 }, { nome: 'Lazer', valor: 60 }, { nome: 'Educação', valor: 50 }, { nome: 'Demais', valor: 10 },
      ]);
      plantar(dir, 'ana', resumo('ana', { meses: [{ mes: '2026-01', rotulo: 'jan', periodo: 'p1', parcial: false, renda: 1000, gasto: 500, fatura_cartao: 0, categorias: catsIguais() }] }));
      plantar(dir, 'bia', resumo('bia', { meses: [{ mes: '2026-01', rotulo: 'jan', periodo: 'p1', parcial: false, renda: 900, gasto: 400, fatura_cartao: 0, categorias: catsIguais() }] }));
      const r = await financas.ler();
      ok(r.casa.categoriasAproximadas === false, `F6b: mesmos nomes de categoria → categoriasAproximadas false (veio ${r.casa.categoriasAproximadas})`);
    }

    // ─── F6c — categoria no top de uma e escondida no Demais da outra → aproximado ───
    {
      financas._zerarParaTeste();
      const dir = pasta('f6-escondida');
      plantar(dir, 'ana', resumo('ana', { meses: [{ mes: '2026-01', rotulo: 'jan', periodo: 'p1', parcial: false, renda: 1000, gasto: 500, fatura_cartao: 0, categorias: [
        { nome: 'Mercado', valor: 300 }, { nome: 'Casa', valor: 200 }, { nome: 'Transporte', valor: 150 },
        { nome: 'Saúde', valor: 100 }, { nome: 'Lazer', valor: 80 }, { nome: 'Educação', valor: 70 }, { nome: 'Demais', valor: 10 },
      ] }] }));
      plantar(dir, 'bia', resumo('bia', { meses: [{ mes: '2026-01', rotulo: 'jan', periodo: 'p1', parcial: false, renda: 900, gasto: 400, fatura_cartao: 0, categorias: [
        { nome: 'Mercado', valor: 250 }, { nome: 'Casa', valor: 180 }, { nome: 'Transporte', valor: 140 },
        { nome: 'Saúde', valor: 90 }, { nome: 'Lazer', valor: 60 }, { nome: 'Pets', valor: 50 }, { nome: 'Demais', valor: 35 },
      ] }] }));
      const r = await financas.ler();
      ok(r.casa.categoriasAproximadas === true, `F6c: categoria no top de uma e escondida no Demais da outra → aproximado (veio ${r.casa.categoriasAproximadas})`);
    }

    // ─── F7 — desatualizado ───
    {
      financas._zerarParaTeste();
      const dir = pasta('f7');
      plantar(dir, 'ana', resumo('ana', { gerado_em: iso(37 * 3600e3) }));
      const r1 = await financas.ler();
      ok(r1.pessoas[0].desatualizado === true, `F7: gerado há 37 h → desatualizado true (veio ${r1.pessoas[0].desatualizado})`);

      financas._zerarParaTeste();
      plantar(dir, 'ana', resumo('ana', { gerado_em: iso(1 * 3600e3) }));
      const r2 = await financas.ler();
      ok(r2.pessoas[0].desatualizado === false, `F7: gerado há 1 h → desatualizado false (veio ${r2.pessoas[0].desatualizado})`);

      financas._zerarParaTeste();
      plantar(dir, 'ana', resumo('ana', { gerado_em: 'isto nao e data' }));
      const r3 = await financas.ler();
      ok(r3.pessoas[0].desatualizado === true && r3.pessoas[0].geradoHaS === null,
        `F7: gerado_em inválido → desatualizado true, geradoHaS null (veio ${JSON.stringify(r3.pessoas[0].desatualizado)}/${r3.pessoas[0].geradoHaS})`);

      // Casa com uma idade desconhecida (painel de execução, Codex #3): a casa diz "não sei quando",
      // nunca a idade da outra pessoa — senão a tela afirma "gerado há 1 h" escondendo o buraco.
      financas._zerarParaTeste();
      plantar(dir, 'bia', resumo('bia', { gerado_em: iso(1 * 3600e3) }));
      const r4 = await financas.ler();
      ok(r4.casa && r4.casa.geradoHaS === null && r4.casa.geradoEm === null && r4.casa.desatualizado === true,
        `F7: casa com um gerado_em inválido → geradoHaS/geradoEm null e desatualizado (veio ${r4.casa && JSON.stringify([r4.casa.geradoHaS, r4.casa.geradoEm, r4.casa.desatualizado])})`);
    }

    // ─── F7b — `estado()` com falha de ACESSO (painel de execução, Claude #7 e Codex #2) ───
    // Mesma régua do `ler()`: só ENOENT/ENOTDIR desligam; pasta inacessível mantém o botão, e o
    // diálogo explica o erro. Sem isto o botão sumia e o aviso nunca era visto.
    {
      const pai = pasta('f7b-pai');
      const filha = path.join(pai, 'painel');
      fs.mkdirSync(filha);
      plantar(filha, 'ana', resumo('ana'));
      process.env.COCKPIT_FINANCAS_DIR = filha;
      fs.chmodSync(pai, 0o000);
      try {
        const e = await financas.estado();
        ok(e.ligado === true, `F7b: estado() com o pai sem permissão (EACCES no lstat) → ligado true (veio ${JSON.stringify(e)})`);
        const r = await financas.ler();
        ok(r.ligado === true && r.erro === 'pasta', `F7b: ler() no mesmo caso → ligado true, erro 'pasta' (veio ${JSON.stringify({ ligado: r.ligado, erro: r.erro })})`);
      } finally {
        fs.chmodSync(pai, 0o755);
      }
    }

    // ─── F8 — tetos e limpeza ───
    {
      financas._zerarParaTeste();
      const dir = pasta('f8');
      const meses30 = [];
      for (let i = 0; i < 30; i += 1) {
        const ano = 2024 + Math.floor(i / 12);
        const mesNum = String((i % 12) + 1).padStart(2, '0');
        meses30.push({ mes: `${ano}-${mesNum}`, rotulo: `m${i}`, periodo: 'p', parcial: false, renda: 100 + i, gasto: 50, fatura_cartao: 0, categorias: [] });
      }
      const mesRepetidoStr = meses30[29].mes;
      meses30.push({ mes: mesRepetidoStr, rotulo: 'repetido', periodo: 'p', parcial: false, renda: 999999, gasto: 0, fatura_cartao: 0, categorias: [] });
      plantar(dir, 'ana', resumo('ana', {
        meses: meses30,
        pessoa: { id: 'ana', nome: '\u0007' + 'x'.repeat(500) },
      }));
      const r = await financas.ler();
      ok(r.pessoas[0].meses.length === 24, `F8: 30 meses → 24 (os mais recentes) (veio ${r.pessoas[0].meses.length})`);
      const achadoRepetido = r.pessoas[0].meses.find((m) => m.mes === mesRepetidoStr);
      ok(Boolean(achadoRepetido) && achadoRepetido.rotulo !== 'repetido', `F8: mês repetido → fica o primeiro (veio rotulo="${achadoRepetido && achadoRepetido.rotulo}")`);
      ok(r.pessoas[0].nome.length <= 120 && !r.pessoas[0].nome.includes('\u0007'), `F8: nome limpo e cortado (veio tamanho ${r.pessoas[0].nome.length})`);

      // B3 (D92): o campo "pdf" do resumo não decide mais nada — o nome é fixo `<id>.pdf` no
      // servidor. Planta `bia.pdf` solto (sem `bia.json`) ao lado: mesmo existindo NO DISCO,
      // `arquivos.pdf` de ANA continua false — a trava é o nome fixo, nunca o campo do resumo.
      pdf(dir, 'bia');
      for (const [pdfRuim, desc] of [['../x.pdf', '..'], ['a/b.pdf', 'barra'], ['x.txt', 'extensão'], ['bia.pdf', 'id trocado']]) {
        financas._zerarParaTeste();
        plantar(dir, 'ana', resumo('ana', { pdf: pdfRuim }));
        const rp = await financas.ler();
        const anaResp = rp.pessoas.find((p) => p.id === 'ana');
        ok(anaResp && anaResp.arquivos.pdf === false, `F8: pdf "${pdfRuim}" (${desc}) → arquivos.pdf false mesmo com bia.pdf no disco (veio ${anaResp && JSON.stringify(anaResp.arquivos)})`);
      }
    }

    // ─── F9 — o corpo do `ler()` nunca tem o caminho da pasta nem o campo `pdf` ───
    {
      financas._zerarParaTeste();
      const dir = pasta('f9');
      plantar(dir, 'ana', resumo('ana'));
      pdf(dir, 'ana');
      const r = await financas.ler();
      const bruto = JSON.stringify(r);
      ok(!bruto.includes(dir), `F9: o corpo não contém o caminho da pasta (veio contém? ${bruto.includes(dir)})`);
      // A regex antiga (!/"pdf"\s*:/ no JSON inteiro) reprovaria o `arquivos: { pdf, xlsx }`
      // novo (Codex #1 do painel) — a checagem certa é por pessoa, nunca no corpo inteiro.
      for (const p of r.pessoas) {
        ok(!Object.hasOwn(p, 'pdf'), `F9: pessoa "${p.id}" não tem o campo "pdf" do resumo (veio ${JSON.stringify(Object.keys(p))})`);
      }
    }

    // ─── F10 — `enviar()` direto, com o Taildrop de mentira (D92: substitui `enviarPdf`) ───
    {
      financas._zerarParaTeste();
      const dir = pasta('f10');
      plantar(dir, 'ana', resumo('ana'));
      pdf(dir, 'ana');

      const guardados = {
        COCKPIT_BIN_TAILSCALE: process.env.COCKPIT_BIN_TAILSCALE,
        COCKPIT_TAILSCALE_SOCKET: process.env.COCKPIT_TAILSCALE_SOCKET,
        TAILSCALE_FALSO_DORMIR_MS: process.env.TAILSCALE_FALSO_DORMIR_MS,
        COCKPIT_FINANCAS_DESTINOS: process.env.COCKPIT_FINANCAS_DESTINOS,
        COCKPIT_FINANCAS_DESTINO: process.env.COCKPIT_FINANCAS_DESTINO,
      };
      process.env.COCKPIT_BIN_TAILSCALE = bin;
      process.env.COCKPIT_TAILSCALE_SOCKET = sock;
      process.env.TAILSCALE_FALSO_DORMIR_MS = '0';
      process.env.COCKPIT_FINANCAS_DESTINOS = 'galaxy-falso';
      delete process.env.COCKPIT_FINANCAS_DESTINO;

      try {
        const r1 = await financas.enviar({ pessoa: 'bad id!', formato: 'pdf', destino: 'galaxy-falso' }).catch((e) => e);
        ok(r1 && r1.codigo === 400, `F10: pessoa inválida → 400 (veio ${r1 && r1.codigo})`);
        const r1b = await financas.enviar({ pessoa: 'casa', formato: 'pdf', destino: 'galaxy-falso' }).catch((e) => e);
        ok(r1b && r1b.codigo === 400, `F10: pessoa "casa" → 400 (veio ${r1b && r1b.codigo})`);

        delete process.env.COCKPIT_FINANCAS_DESTINOS;
        const r2 = await financas.enviar({ pessoa: 'ana', formato: 'pdf', destino: 'galaxy-falso' }).catch((e) => e);
        ok(r2 && r2.codigo === 400, `F10: sem destino configurado (lista vazia) → 400 "aparelho fora da lista" (veio ${r2 && r2.codigo}/${r2 && r2.message})`);
        process.env.COCKPIT_FINANCAS_DESTINOS = 'galaxy-falso';

        // `enviar()` NÃO lê o resumo (D92, Claude #6) — "PDF ausente" não precisa nem de
        // `semcorpo.json`: o nome é fixo no servidor, nunca lido do JSON.
        const r3 = await financas.enviar({ pessoa: 'semcorpo', formato: 'pdf', destino: 'galaxy-falso' }).catch((e) => e);
        ok(r3 && r3.codigo === 404, `F10: PDF ausente → 404 (veio ${r3 && r3.codigo})`);

        const foraDaPasta = path.join(raizT, 'fora.pdf');
        fs.writeFileSync(foraDaPasta, '%PDF-1.4 falso fora');
        fs.symlinkSync(foraDaPasta, path.join(dir, 'comlink.pdf'));
        const antesLog1 = lerChamadas();
        const r5 = await financas.enviar({ pessoa: 'comlink', formato: 'pdf', destino: 'galaxy-falso' }).catch((e) => e);
        ok(r5 && r5.codigo === 404, `F10: PDF symlink para fora → 404 (B3: symlink é sempre 404, nunca 400) (veio ${r5 && r5.codigo})`);
        ok(lerChamadas() === antesLog1, 'F10: symlink para fora não chama a CLI');

        const pdfGrande = path.join(dir, 'grandona.pdf');
        fs.writeFileSync(pdfGrande, '');
        fs.truncateSync(pdfGrande, 21 * 1024 * 1024);
        const r6 = await financas.enviar({ pessoa: 'grandona', formato: 'pdf', destino: 'galaxy-falso' }).catch((e) => e);
        ok(r6 && r6.codigo === 413, `F10: PDF de 21 MiB → 413 (veio ${r6 && r6.codigo})`);

        const r7 = await financas.enviar({ pessoa: 'ana', formato: 'pdf', destino: 'aparelho-que-nao-existe' }).catch((e) => e);
        ok(r7 && r7.codigo === 400, `F10: aparelho fora da lista → 400 (veio ${r7 && r7.codigo})`);

        const alvoReal = fs.realpathSync(path.join(dir, 'ana.pdf'));
        const r8 = await financas.enviar({ pessoa: 'ana', formato: 'pdf', destino: 'galaxy-falso' });
        ok(Boolean(r8 && r8.enviado === true), `F10: sucesso → enviado true (veio ${JSON.stringify(r8)})`);
        const chamadas = lerChamadas();
        ok(chamadas.includes(`file\tcp\t${alvoReal}\tgalaxy-falso:`), `F10: chamadas.log tem "file cp <realpath> galaxy-falso:" (veio ${chamadas})`);

        // Os quatro casos que dependiam de LER o resumo (ana.json ilegível 409, chmod 000 409,
        // JSON acima do teto 409, JSON symlink 404) saem de propósito (D92, Claude #6):
        // `enviar()` nunca lê o resumo. Prova POSITIVA: ana.json chmod 000 não impede o envio.
        fs.chmodSync(path.join(dir, 'ana.json'), 0o000);
        try {
          const r9 = await financas.enviar({ pessoa: 'ana', formato: 'pdf', destino: 'galaxy-falso' });
          ok(Boolean(r9 && r9.enviado === true), `F10: ana.json chmod 000 não impede o envio — enviar() não lê o resumo (veio ${JSON.stringify(r9)})`);
        } finally {
          fs.chmodSync(path.join(dir, 'ana.json'), 0o644);
        }

        const antesLog3 = lerChamadas();
        const alvoSimulado = path.join(dir, 'link-mandar.pdf');
        fs.symlinkSync(alvoReal, alvoSimulado);
        const estadoFake = fs.statSync(alvoSimulado);
        const r10 = await arquivos.mandarArquivo({ alvo: alvoSimulado, estado: estadoFake, destino: 'galaxy-falso' }).catch((e) => e);
        ok(r10 && r10.codigo === 400, `F10: mandarArquivo com caminho que não é o próprio realpath → 400 (veio ${r10 && r10.codigo})`);
        ok(lerChamadas() === antesLog3, 'F10: mandarArquivo com symlink não chama a CLI');
      } finally {
        for (const [k, v] of Object.entries(guardados)) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
    }

    // ─── F11 — as rotas, com `server.js` FILHO (token + isolamento) ───
    {
      const porta = [7888, 7889].find(portaLivre);
      ok(porta !== undefined, `F11: achou porta livre na lista (${porta})`);
      const home = path.join(RAIZ, 'home');
      fs.mkdirSync(home, { recursive: true });
      const dirF11 = path.join(RAIZ, 'f11-dados');
      fs.mkdirSync(dirF11, { recursive: true });
      plantar(dirF11, 'ana', resumo('ana'));
      pdf(dirF11, 'ana');
      const TOKEN = 'gate-financas';

      const srv = await fx.subirServidor({
        porta, home, socket: sock, binario: bin, extras: {
          COCKPIT_FINANCAS_DIR: dirF11, COCKPIT_FINANCAS_DESTINOS: 'galaxy-falso', COCKPIT_VIGIA_MS: '0',
          COCKPIT_MONITOR_MS: '0', COCKPIT_PUSH_DIR: path.join(RAIZ, 'push'),
          COCKPIT_DU_BIN: path.join(RAIZ, 'sem-du'), COCKPIT_DOCKER_BIN: path.join(RAIZ, 'sem-docker'),
          COCKPIT_VIGIA_PROD_ARQ: path.join(RAIZ, 'sem-vigia', 'estado.json'), TAILSCALE_FALSO_DORMIR_MS: '0',
          COCKPIT_TOKEN: TOKEN,
        },
      });

      const pedir = (metodo, rota, { semToken = false, tokenErrado = false, corpo = null } = {}) => new Promise((resolve, reject) => {
        const cabecalhos = {};
        if (!semToken) cabecalhos.authorization = `Bearer ${tokenErrado ? 'token-errado' : TOKEN}`;
        let dados = null;
        if (corpo !== null) {
          dados = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
          cabecalhos['content-type'] = 'application/json';
          cabecalhos['content-length'] = Buffer.byteLength(dados);
        }
        const req = http.request({ host: '127.0.0.1', port: porta, path: rota, method: metodo, headers: cabecalhos }, (res) => {
          let bruto = ''; res.setEncoding('utf8');
          res.on('data', (c) => { bruto += c; });
          res.on('end', () => { let corpoResp = null; try { corpoResp = JSON.parse(bruto); } catch { /* não-JSON */ } resolve({ status: res.statusCode, corpo: corpoResp, bruto }); });
        });
        req.on('error', reject);
        if (dados !== null) req.write(dados);
        req.end();
      });

      try {
        const antesSemToken = lerChamadas();
        const semA = await pedir('GET', '/api/financas', { semToken: true });
        ok(semA.status === 401, `F11: GET /api/financas sem token → 401 (veio ${semA.status})`);
        const semB = await pedir('GET', '/api/financas/estado', { semToken: true });
        ok(semB.status === 401, `F11: GET /api/financas/estado sem token → 401 (veio ${semB.status})`);
        // D92: o cliente agora é POST /api/financas/enviar (o .../pdf saiu — F11 confere 404 abaixo).
        const semC = await pedir('POST', '/api/financas/enviar', { semToken: true, corpo: { pessoa: 'ana', formato: 'pdf', destino: 'galaxy-falso' } });
        ok(semC.status === 401, `F11: POST /api/financas/enviar sem token → 401 (veio ${semC.status})`);
        const errA = await pedir('GET', '/api/financas', { tokenErrado: true });
        ok(errA.status === 401, `F11: GET /api/financas com token errado → 401 (veio ${errA.status})`);
        const errC = await pedir('POST', '/api/financas/enviar', { tokenErrado: true, corpo: { pessoa: 'ana', formato: 'pdf', destino: 'galaxy-falso' } });
        ok(errC.status === 401, `F11: POST /api/financas/enviar com token errado → 401 (veio ${errC.status})`);
        ok(lerChamadas() === antesSemToken, 'F11: nenhuma das recusas de token chega à CLI');

        const r = await pedir('GET', '/api/financas');
        ok(r.status === 200 && r.corpo && r.corpo.ligado === true, `F11: GET /api/financas → 200, ligado true (veio ${r.status}/${r.corpo && r.corpo.ligado})`);
        ok(!r.bruto.includes(dirF11), `F11: o corpo bruto não traz o caminho da pasta (veio contém? ${r.bruto.includes(dirF11)})`);

        const invalido = await pedir('POST', '/api/financas/enviar', { corpo: 'isto nao e json' });
        ok(invalido.status === 400, `F11: POST /api/financas/enviar com JSON inválido → 400 (veio ${invalido.status})`);

        // A13 (D92): o POST .../pdf saiu — único cliente era o modal.
        const rotaVelha = await pedir('POST', '/api/financas/pdf', { corpo: { pessoa: 'ana' } });
        ok(rotaVelha.status === 404, `F11: POST /api/financas/pdf → 404 (a rota saiu, D92) (veio ${rotaVelha.status})`);

        // O caso "destino do corpo ignorado" (molde antigo, que confiava num destino ÚNICO da
        // env) virou "destino fora da lista → 400" — agora a lista é que decide, nunca o corpo sozinho.
        const antesPost = lerChamadas();
        const destinoFora = await pedir('POST', '/api/financas/enviar', { corpo: { pessoa: 'ana', formato: 'pdf', destino: 'caixa-offline' } });
        ok(destinoFora.status === 400, `F11: POST enviar com destino fora da lista ("caixa-offline") → 400 (veio ${destinoFora.status})`);
        ok(lerChamadas() === antesPost, 'F11: destino fora da lista não chama a CLI');

        const post = await pedir('POST', '/api/financas/enviar', { corpo: { pessoa: 'ana', formato: 'pdf', destino: 'galaxy-falso' } });
        ok(post.status === 200, `F11: POST enviar com destino válido ("galaxy-falso") → 200 (veio ${post.status})`);
        const depoisPost = lerChamadas();
        ok(depoisPost !== antesPost && depoisPost.includes('galaxy-falso:'), `F11: a chamada foi para "galaxy-falso:" (veio ${depoisPost})`);

        fs.renameSync(dirF11, `${dirF11}-fora`);
        const depoisRename = await pedir('GET', '/api/financas');
        ok(depoisRename.status === 200 && depoisRename.corpo && depoisRename.corpo.ligado === false,
          `F11: pasta renomeada entre dois GETs → ligado false (veio ${depoisRename.status}/${depoisRename.corpo && depoisRename.corpo.ligado})`);
      } finally {
        await srv.matar(); // pelo PID — #24
      }
    }

    // ─── L — lerLancamentos/interpretarLancamentos (D92) ───
    {
      financas._zerarParaTeste();
      const dirL = pasta('l1-ausente');
      const rAusente = await financas.lerLancamentos('ana');
      ok(rAusente.estado === 'ausente', `L: arquivo ausente → estado 'ausente' (veio ${JSON.stringify(rAusente)})`);

      const alvoForaL = path.join(RAIZ, 'l-alvo-externo.lancamentos.json');
      fs.writeFileSync(alvoForaL, JSON.stringify(envelopeLanc('ana', [])));
      fs.symlinkSync(alvoForaL, path.join(dirL, 'ana.lancamentos.json'));
      const rSym = await financas.lerLancamentos('ana');
      ok(rSym.estado === 'ausente', `L: symlink pra arquivo fora → 'ausente' (veio ${JSON.stringify(rSym)})`);
      fs.unlinkSync(path.join(dirL, 'ana.lancamentos.json'));

      const caminhoGrande = plantarLancamentos(dirL, 'ana', '');
      fs.truncateSync(caminhoGrande, financas.TETO_LANCAMENTOS + 1);
      const rGrande = await financas.lerLancamentos('ana');
      ok(rGrande.estado === 'ilegivel', `L: 2 MB + 1 byte → 'ilegivel' (veio ${JSON.stringify(rGrande)})`);

      plantarLancamentos(dirL, 'ana', '{ "versao": 1,');
      const rQuebrado = await financas.lerLancamentos('ana');
      ok(rQuebrado.estado === 'ilegivel' && rQuebrado.motivo === 'json', `L: JSON quebrado → ilegivel/json (veio ${JSON.stringify(rQuebrado)})`);

      // `lancamentos` ausente, null ou objeto não é "lista vazia" (painel de execução, Codex #1):
      // aceitar viraria Casa somando com buraco sem o aviso de ilegível.
      for (const [rotulo, valorCampo] of [['ausente', undefined], ['null', null], ['objeto', { a: 1 }]]) {
        const env = { versao: 1, pessoa: { id: 'ana', nome: 'Ana' }, gerado_em: iso(3600e3) };
        if (valorCampo !== undefined) env.lancamentos = valorCampo;
        plantarLancamentos(dirL, 'ana', JSON.stringify(env));
        const rForma = await financas.lerLancamentos('ana');
        ok(rForma.estado === 'ilegivel' && rForma.motivo === 'forma', `L: campo lancamentos ${rotulo} → ilegivel/forma (veio ${JSON.stringify(rForma)})`);
      }

      plantarLancamentos(dirL, 'ana', envelopeLanc('ana', [], { versao: 2 }));
      const rVersao = await financas.lerLancamentos('ana');
      ok(rVersao.estado === 'ilegivel' && rVersao.motivo === 'versao', `L: versao !== 1 → ilegivel/versao (veio ${JSON.stringify(rVersao)})`);

      plantarLancamentos(dirL, 'ana', envelopeLanc('bia', [])); // pessoa.id de outra
      const rIdTrocado = await financas.lerLancamentos('ana');
      ok(rIdTrocado.estado === 'ilegivel' && rIdTrocado.motivo === 'id', `L: pessoa.id de outra pessoa → ilegivel/id (veio ${JSON.stringify(rIdTrocado)})`);

      const muitos = [];
      for (let i = 0; i < 20001; i += 1) muitos.push(linhaValida(i));
      // Direto na função PURA: 20001 itens de verdade passariam do teto de 2 MB de ARQUIVO
      // (já coberto no caso "2 MB + 1 byte" acima, outra regra) — aqui o que se testa é só a
      // contagem de itens, isolada do tamanho do arquivo.
      const rMuitos = financas.interpretarLancamentos(JSON.stringify(envelopeLanc('ana', muitos)), 'ana');
      ok(rMuitos.ok === false && rMuitos.motivo === 'muitos', `L: 20001 itens → ilegivel/muitos (veio ${JSON.stringify(rMuitos)})`);

      const validos = [linhaValida(0), linhaValida(1), linhaValida(2)];
      const invalidos = [
        { ...linhaValida(3), data: '2026-13-01' },
        { ...linhaValida(4), valor: -1 },
        { ...linhaValida(5), tipo: 'x' },
        { ...linhaValida(6), fora_do_gasto: 'sim' },
      ];
      plantarLancamentos(dirL, 'ana', envelopeLanc('ana', [...validos, ...invalidos]));
      const rDescartados = await financas.lerLancamentos('ana');
      ok(rDescartados.estado === 'ok' && rDescartados.descartados === 4 && rDescartados.lancamentos.length === 3,
        `L: 4 linhas inválidas no meio de válidas → ok, descartados=4 (veio ${JSON.stringify(rDescartados)})`);

      plantarLancamentos(dirL, 'ana', envelopeLanc('ana', [{ ...linhaValida(0), categoria: '' }]));
      const rCatVazia = await financas.lerLancamentos('ana');
      ok(rCatVazia.lancamentos[0].categoria === 'Sem categoria', `L: categoria '' → "Sem categoria" (veio ${rCatVazia.lancamentos[0].categoria})`);

      for (const pessoaInvalida of ['casa', 'Bad!']) {
        const erroLanc = await financas.lerLancamentos(pessoaInvalida).catch((e) => e);
        ok(erroLanc && erroLanc.codigo === 400, `L: pessoa "${pessoaInvalida}" → lança código 400 (veio ${erroLanc && erroLanc.codigo})`);
      }

      const dirLFixture = pasta('l-fixture');
      const mundoL = fxFin.plantarMundo(dirLFixture);
      const rFixture = await financas.lerLancamentos('ana');
      ok(rFixture.estado === 'ok' && rFixture.lancamentos.length === mundoL.lancamentos.ana.length,
        `L: ok com a fixture → lancamentos.length = o plantado (veio ${rFixture.lancamentos.length} de ${mundoL.lancamentos.ana.length})`);
      ok(rFixture.lancamentos.every((l) => l.mes === l.data.slice(0, 7)), 'L: cada item tem mes = data.slice(0,7)');
    }

    // ─── Nome com ponto — o fato-chave (degrau 4 permanente, D92) ───
    {
      financas._zerarParaTeste();
      const dirPonto = pasta('ponto');
      fxFin.plantarMundo(dirPonto, { pessoas: ['ana'] });
      const rPonto = await financas.ler();
      ok(JSON.stringify(rPonto.pessoas.map((p) => p.id)) === JSON.stringify(['ana']) && rPonto.ilegiveis.length === 0,
        `nome-com-ponto: ana.lancamentos.json/ana.xlsx não viram "pessoa" (veio pessoas=${JSON.stringify(rPonto.pessoas.map((p) => p.id))}, ilegiveis=${JSON.stringify(rPonto.ilegiveis)})`);
      const ePonto = await financas.estado();
      ok(ePonto.ligado === true, `nome-com-ponto: estado().ligado true (veio ${JSON.stringify(ePonto)})`);

      // Controle negativo: tirar o ponto do nome faz o arquivo PASSAR a existir como "pessoa".
      fs.renameSync(path.join(dirPonto, 'ana.lancamentos.json'), path.join(dirPonto, 'ana-lancamentos.json'));
      financas._zerarParaTeste();
      const rPontoNeg = await financas.ler();
      ok(rPontoNeg.ilegiveis.includes('ana-lancamentos'), `nome-com-ponto: controle negativo — "ana-lancamentos" vira ilegível (veio ${JSON.stringify(rPontoNeg.ilegiveis)})`);
    }

    // ─── A — localizarArquivo (D92) ───
    {
      financas._zerarParaTeste();
      const dirA = pasta('a1');
      fxFin.plantarMundo(dirA, { pessoas: ['ana'] });

      const rPdf = await financas.localizarArquivo({ pessoa: 'ana', formato: 'pdf' });
      ok(rPdf.real === fs.realpathSync(path.join(dirA, 'ana.pdf')), `A: pdf ok → real = realpath do arquivo (veio ${rPdf.real})`);
      const rXlsx = await financas.localizarArquivo({ pessoa: 'ana', formato: 'xlsx' });
      ok(rXlsx.real === fs.realpathSync(path.join(dirA, 'ana.xlsx')), `A: xlsx ok → real = realpath do arquivo (veio ${rXlsx.real})`);

      const eFormato = await financas.localizarArquivo({ pessoa: 'ana', formato: 'csv' }).catch((e) => e);
      ok(eFormato && eFormato.codigo === 400, `A: formato "csv" → 400 (veio ${eFormato && eFormato.codigo})`);
      const ePessoaA = await financas.localizarArquivo({ pessoa: 'casa', formato: 'pdf' }).catch((e) => e);
      ok(ePessoaA && ePessoaA.codigo === 400, `A: pessoa "casa" → 400 (veio ${ePessoaA && ePessoaA.codigo})`);
      const eAusenteA = await financas.localizarArquivo({ pessoa: 'bia', formato: 'pdf' }).catch((e) => e);
      ok(eAusenteA && eAusenteA.codigo === 404, `A: ausente → 404 (veio ${eAusenteA && eAusenteA.codigo})`);

      // symlink pra FORA da pasta
      const alvoFora = path.join(RAIZ, 'a-fora.xlsx');
      fs.writeFileSync(alvoFora, 'PK falso fora');
      fs.unlinkSync(path.join(dirA, 'ana.xlsx'));
      fs.symlinkSync(alvoFora, path.join(dirA, 'ana.xlsx'));
      const eSymFora = await financas.localizarArquivo({ pessoa: 'ana', formato: 'xlsx' }).catch((e) => e);
      ok(eSymFora && eSymFora.codigo === 404, `A: <id>.xlsx symlink pra fora → 404 (veio ${eSymFora && eSymFora.codigo})`);

      // symlink mesmo pra DENTRO da pasta — a checagem de symlink é incondicional
      fs.unlinkSync(path.join(dirA, 'ana.xlsx'));
      fs.writeFileSync(path.join(dirA, 'ana-real.xlsx'), 'PK falso dentro');
      fs.symlinkSync(path.join(dirA, 'ana-real.xlsx'), path.join(dirA, 'ana.xlsx'));
      const eSymDentro = await financas.localizarArquivo({ pessoa: 'ana', formato: 'xlsx' }).catch((e) => e);
      ok(eSymDentro && eSymDentro.codigo === 404, `A: <id>.xlsx symlink mesmo pra DENTRO da pasta → 404 (veio ${eSymDentro && eSymDentro.codigo})`);

      // 21 MiB → 413
      fs.unlinkSync(path.join(dirA, 'ana.pdf'));
      fs.writeFileSync(path.join(dirA, 'ana.pdf'), '');
      fs.truncateSync(path.join(dirA, 'ana.pdf'), 21 * 1024 * 1024);
      const eGrandeA = await financas.localizarArquivo({ pessoa: 'ana', formato: 'pdf' }).catch((e) => e);
      ok(eGrandeA && eGrandeA.codigo === 413, `A: arquivo de 21 MiB → 413 (veio ${eGrandeA && eGrandeA.codigo})`);

      // ler().pessoas[i].arquivos bate com a presença no disco
      financas._zerarParaTeste();
      const dirAParcial = pasta('a-parcial');
      fxFin.plantarMundo(dirAParcial, { pessoas: ['ana'] });
      fs.unlinkSync(path.join(dirAParcial, 'ana.xlsx'));
      const rParcial = await financas.ler();
      const anaParcial = rParcial.pessoas.find((p) => p.id === 'ana');
      ok(anaParcial && anaParcial.arquivos.pdf === true && anaParcial.arquivos.xlsx === false,
        `A: ler().pessoas[i].arquivos = {pdf:true,xlsx:false} quando só o PDF existe (veio ${anaParcial && JSON.stringify(anaParcial.arquivos)})`);

      // o campo "pdf" do RESUMO nunca decide disponibilidade de OUTRA pessoa
      financas._zerarParaTeste();
      const dirCruzado = pasta('a-cruzado');
      fxFin.plantarMundo(dirCruzado, { pessoas: ['bia'] }); // bia.pdf existe no disco
      plantar(dirCruzado, 'ana', resumo('ana', { pdf: 'bia.pdf' })); // resumo de ana aponta pro pdf de bia; ana.pdf não existe
      const rCruzado = await financas.ler();
      const anaCruzada = rCruzado.pessoas.find((p) => p.id === 'ana');
      ok(anaCruzada && anaCruzada.arquivos.pdf === false,
        `A: resumo de ana apontando "bia.pdf" (que existe) → arquivos.pdf de ana false — nunca o de outra pessoa (veio ${anaCruzada && JSON.stringify(anaCruzada.arquivos)})`);
    }

    // ─── D — destinosPermitidos() (D92) ───
    {
      const guardadosD = {
        COCKPIT_FINANCAS_DESTINOS: process.env.COCKPIT_FINANCAS_DESTINOS,
        COCKPIT_FINANCAS_DESTINO: process.env.COCKPIT_FINANCAS_DESTINO,
      };
      try {
        process.env.COCKPIT_FINANCAS_DESTINOS = ' meu-desktop , meu-celular,meu-desktop,../x, ';
        delete process.env.COCKPIT_FINANCAS_DESTINO;
        ok(JSON.stringify(financas.destinosPermitidos()) === JSON.stringify(['meu-desktop', 'meu-celular']),
          `D: lista aparada, sem repetido, inválido fora (veio ${JSON.stringify(financas.destinosPermitidos())})`);

        process.env.COCKPIT_FINANCAS_DESTINOS = 'meu-desktop,meu-celular';
        process.env.COCKPIT_FINANCAS_DESTINO = 'legado-valido';
        ok(JSON.stringify(financas.destinosPermitidos()) === JSON.stringify(['meu-desktop', 'meu-celular', 'legado-valido']),
          `D: legado somado no fim (veio ${JSON.stringify(financas.destinosPermitidos())})`);

        const nove = Array.from({ length: 9 }, (_, i) => `aparelho-${i}`).join(',');
        process.env.COCKPIT_FINANCAS_DESTINOS = nove;
        process.env.COCKPIT_FINANCAS_DESTINO = 'legado-valido';
        const r9 = financas.destinosPermitidos();
        ok(r9.length === 8, `D: 9 válidos + o legado → 8 itens, corte depois da soma (veio ${r9.length})`);
        ok(!r9.includes('legado-valido'), `D: o legado foi cortado junto com o 9º (veio ${JSON.stringify(r9)})`);

        delete process.env.COCKPIT_FINANCAS_DESTINOS;
        delete process.env.COCKPIT_FINANCAS_DESTINO;
        ok(JSON.stringify(financas.destinosPermitidos()) === '[]', `D: nada configurado → [] (veio ${JSON.stringify(financas.destinosPermitidos())})`);
      } finally {
        for (const [k, v] of Object.entries(guardadosD)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      }
    }

    // ─── E — enviar({pessoa,formato,destino}) (D92) ───
    {
      financas._zerarParaTeste();
      const dirE = pasta('e1');
      fxFin.plantarMundo(dirE, { pessoas: ['ana'] });
      const guardadosE = {
        COCKPIT_BIN_TAILSCALE: process.env.COCKPIT_BIN_TAILSCALE,
        COCKPIT_TAILSCALE_SOCKET: process.env.COCKPIT_TAILSCALE_SOCKET,
        TAILSCALE_FALSO_DORMIR_MS: process.env.TAILSCALE_FALSO_DORMIR_MS,
        COCKPIT_FINANCAS_DESTINOS: process.env.COCKPIT_FINANCAS_DESTINOS,
        COCKPIT_FINANCAS_DESTINO: process.env.COCKPIT_FINANCAS_DESTINO,
      };
      process.env.COCKPIT_BIN_TAILSCALE = bin;
      process.env.COCKPIT_TAILSCALE_SOCKET = sock;
      process.env.TAILSCALE_FALSO_DORMIR_MS = '0';
      process.env.COCKPIT_FINANCAS_DESTINOS = 'galaxy-falso';
      delete process.env.COCKPIT_FINANCAS_DESTINO;
      try {
        const antesLogE = lerChamadas();
        const rOutro = await financas.enviar({ pessoa: 'ana', formato: 'pdf', destino: 'outro' }).catch((e) => e);
        ok(rOutro && rOutro.codigo === 400, `E: destino "outro" fora da lista → 400 (veio ${rOutro && rOutro.codigo})`);
        ok(lerChamadas() === antesLogE, 'E: destino fora da lista não chama a CLI');

        const rCsv = await financas.enviar({ pessoa: 'ana', formato: 'csv', destino: 'galaxy-falso' }).catch((e) => e);
        ok(rCsv && rCsv.codigo === 400, `E: formato "csv" → 400 sem CLI (veio ${rCsv && rCsv.codigo})`);
        ok(lerChamadas() === antesLogE, 'E: formato inválido não chama a CLI');

        const realXlsx = fs.realpathSync(path.join(dirE, 'ana.xlsx'));
        const rOk = await financas.enviar({ pessoa: 'ana', formato: 'xlsx', destino: 'galaxy-falso' });
        ok(Boolean(rOk && rOk.enviado === true), `E: xlsx ok → enviado true (veio ${JSON.stringify(rOk)})`);
        ok(rOk.destino === 'galaxy-falso', `E: destino devolvido = "galaxy-falso" (veio ${rOk.destino})`);
        const chamadasE = lerChamadas();
        ok(chamadasE.includes(`file\tcp\t${realXlsx}\tgalaxy-falso:`), `E: chamadas.log tem "file cp <realpath do xlsx> galaxy-falso:" (veio ${chamadasE})`);
      } finally {
        for (const [k, v] of Object.entries(guardadosE)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      }
    }

    // ─── R — as rotas novas, com `server.js` FILHO (D92) ───
    {
      const portaR = [7890, 7891].find(portaLivre);
      ok(portaR !== undefined, `R: achou porta livre na lista (${portaR})`);
      const homeR = path.join(RAIZ, 'home-r');
      fs.mkdirSync(homeR, { recursive: true });
      const dirR = path.join(RAIZ, 'r-dados');
      fs.mkdirSync(dirR, { recursive: true });
      fxFin.plantarMundo(dirR, { pessoas: ['ana'] });
      const TOKEN_R = 'gate-financas-r';

      const srvR = await fx.subirServidor({
        porta: portaR, home: homeR, socket: sock, binario: bin, extras: {
          COCKPIT_FINANCAS_DIR: dirR, COCKPIT_FINANCAS_DESTINOS: 'galaxy-falso', COCKPIT_VIGIA_MS: '0',
          COCKPIT_MONITOR_MS: '0', COCKPIT_PUSH_DIR: path.join(RAIZ, 'push-r'),
          COCKPIT_DU_BIN: path.join(RAIZ, 'sem-du-r'), COCKPIT_DOCKER_BIN: path.join(RAIZ, 'sem-docker-r'),
          COCKPIT_VIGIA_PROD_ARQ: path.join(RAIZ, 'sem-vigia-r', 'estado.json'), TAILSCALE_FALSO_DORMIR_MS: '0',
          COCKPIT_TOKEN: TOKEN_R,
        },
      });

      const pedirR = (metodo, rota, { semToken = false, corpo = null, binario = false } = {}) => new Promise((resolve, reject) => {
        const cabecalhos = {};
        if (!semToken) cabecalhos.authorization = `Bearer ${TOKEN_R}`;
        let dados = null;
        if (corpo !== null) {
          dados = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
          cabecalhos['content-type'] = 'application/json';
          cabecalhos['content-length'] = Buffer.byteLength(dados);
        }
        const req = http.request({ host: '127.0.0.1', port: portaR, path: rota, method: metodo, headers: cabecalhos }, (res) => {
          const pedacos = [];
          res.on('data', (c) => pedacos.push(c));
          res.on('end', () => {
            const bruto = Buffer.concat(pedacos);
            let corpoResp = null;
            if (!binario) { try { corpoResp = JSON.parse(bruto.toString('utf8')); } catch { /* não-JSON */ } }
            resolve({ status: res.statusCode, headers: res.headers, corpo: corpoResp, bruto });
          });
        });
        req.on('error', reject);
        if (dados !== null) req.write(dados);
        req.end();
      });

      try {
        const semLanc = await pedirR('GET', '/api/financas/lancamentos?pessoa=ana', { semToken: true });
        ok(semLanc.status === 401, `R: GET /api/financas/lancamentos sem token → 401 (veio ${semLanc.status})`);
        const semArq = await pedirR('GET', '/api/financas/arquivo?pessoa=ana&formato=pdf', { semToken: true, binario: true });
        ok(semArq.status === 401, `R: GET /api/financas/arquivo sem token → 401 (veio ${semArq.status})`);
        const semEnv = await pedirR('POST', '/api/financas/enviar', { semToken: true, corpo: { pessoa: 'ana', formato: 'pdf', destino: 'galaxy-falso' } });
        ok(semEnv.status === 401, `R: POST /api/financas/enviar sem token → 401 (veio ${semEnv.status})`);

        const rLanc = await pedirR('GET', '/api/financas/lancamentos?pessoa=ana');
        ok(rLanc.status === 200 && rLanc.corpo && rLanc.corpo.estado === 'ok', `R: GET lancamentos?pessoa=ana → 200, estado ok (veio ${rLanc.status}/${rLanc.corpo && rLanc.corpo.estado})`);
        const rLancBad = await pedirR('GET', '/api/financas/lancamentos?pessoa=Bad!');
        ok(rLancBad.status === 400, `R: GET lancamentos?pessoa=Bad! → 400 (veio ${rLancBad.status})`);

        for (const formato of ['pdf', 'xlsx']) {
          const rArq = await pedirR('GET', `/api/financas/arquivo?pessoa=ana&formato=${formato}`, { binario: true });
          ok(rArq.status === 200, `R: GET arquivo formato=${formato} → 200 (veio ${rArq.status})`);
          const noDisco = fs.readFileSync(path.join(dirR, `ana.${formato}`));
          ok(Buffer.compare(rArq.bruto, noDisco) === 0, `R: bytes idênticos ao arquivo da pasta (${formato})`);
          ok(rArq.headers['content-type'] === financas.FORMATOS[formato], `R: content-type certo (${formato}) (veio ${rArq.headers['content-type']})`);
          ok(rArq.headers['content-disposition'] === `attachment; filename="financas-ana.${formato}"`, `R: content-disposition com filename certo (${formato}) (veio ${rArq.headers['content-disposition']})`);
          ok(rArq.headers['cache-control'] === 'no-store', `R: cache-control: no-store (${formato})`);
        }
        const rArqCsv = await pedirR('GET', '/api/financas/arquivo?pessoa=ana&formato=csv');
        ok(rArqCsv.status === 400, `R: GET arquivo formato=csv → 400 (veio ${rArqCsv.status})`);

        const antesEnviar = lerChamadas();
        const rEnviar = await pedirR('POST', '/api/financas/enviar', { corpo: { pessoa: 'ana', formato: 'pdf', destino: 'galaxy-falso' } });
        ok(rEnviar.status === 200, `R: POST enviar com destino válido → 200 (veio ${rEnviar.status})`);
        ok(lerChamadas() !== antesEnviar, 'R: a CLI foi chamada no envio ok');

        const rEnviarFora = await pedirR('POST', '/api/financas/enviar', { corpo: { pessoa: 'ana', formato: 'pdf', destino: 'aparelho-fora' } });
        ok(rEnviarFora.status === 400, `R: POST enviar com destino fora da lista → 400 (veio ${rEnviarFora.status})`);

        const rGetFinancas = await pedirR('GET', '/api/financas', { binario: true });
        const corpoFinancas = JSON.parse(rGetFinancas.bruto.toString('utf8'));
        ok(rGetFinancas.status === 200 && JSON.stringify(corpoFinancas.destinos) === JSON.stringify(['galaxy-falso']),
          `R: GET /api/financas traz destinos (veio ${JSON.stringify(corpoFinancas.destinos)})`);
        const anaResp = corpoFinancas.pessoas.find((p) => p.id === 'ana');
        ok(anaResp && anaResp.arquivos && anaResp.arquivos.pdf === true && anaResp.arquivos.xlsx === true,
          `R: GET /api/financas traz arquivos por pessoa (veio ${anaResp && JSON.stringify(anaResp.arquivos)})`);
        ok(!rGetFinancas.bruto.toString('utf8').includes(dirR), 'R: nenhum corpo traz o caminho da pasta');

        const rPagina = await pedirR('GET', '/cockpit/financas.html', { binario: true });
        ok(rPagina.status === 200, `R: GET /cockpit/financas.html → 200 (A10, estático sob /cockpit/) (veio ${rPagina.status})`);
      } finally {
        await srvR.matar();
      }
    }

    // ─── F12 — a costura, como texto (D92: a página substitui o modal) ───
    {
      const htmlTexto = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
      const posBtn = htmlTexto.indexOf('id="btn-financas"');
      ok(posBtn >= 0 && /<button[^>]*id="btn-financas"[^>]*hidden/.test(htmlTexto.slice(Math.max(0, posBtn - 200), posBtn + 200)),
        'F12: index.html tem #btn-financas hidden');
      ok(!/id="btn-financas"[^>]*aria-haspopup/.test(htmlTexto) && !/aria-haspopup="dialog"[^>]*id="btn-financas"/.test(htmlTexto),
        'F12: #btn-financas sem aria-haspopup (não abre mais diálogo)');
      ok(!htmlTexto.includes('id="dialogo-financas"'), 'F12: index.html NÃO tem mais #dialogo-financas (saiu, D92)');
      ok(htmlTexto.includes('<script src="financas-entrada.js"></script>'), 'F12: index.html tem o <script> de financas-entrada.js');
      ok(!htmlTexto.includes('<script src="financas.js"></script>'), 'F12: index.html NÃO carrega mais financas.js direto (só financas.html)');

      const appTexto = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
      ok(!appTexto.includes("'dialogo-financas',"), 'F12: app.js NÃO tem mais "dialogo-financas" em DIALOGOS');

      const cssTexto = fs.readFileSync(path.join(__dirname, '..', 'public', 'estilo.css'), 'utf8');
      ok(/\.icone-so\.financas\s*\{[^}]*width:\s*40px[^}]*height:\s*40px/.test(cssTexto), 'F12: estilo.css tem .icone-so.financas com 40px');
      ok(!cssTexto.includes('.financas-'), 'F12: estilo.css sem resíduo de classe .financas-* do modal (saiu, D92)');

      const paginaTexto = fs.readFileSync(path.join(__dirname, '..', 'public', 'financas.html'), 'utf8');
      ok(paginaTexto.includes('id="pagina-financas"'), 'F12: financas.html tem #pagina-financas');
      for (const idSecao of ['fin-kpis', 'fin-rendagasto', 'fin-empilhado', 'fin-detalhe', 'fin-tabela', 'fin-maiores', 'fin-fora', 'fin-contas', 'fin-reembolsos']) {
        ok(paginaTexto.includes(`id="${idSecao}"`), `F12: financas.html tem a seção #${idSecao}`);
      }
      ok(paginaTexto.includes('financas.css') && paginaTexto.includes('estilo.css'), 'F12: financas.html carrega financas.css e estilo.css');
      ok(!/<base[\s>]/i.test(paginaTexto.replace(/<!--[\s\S]*?-->/g, '')), 'F12: financas.html SEM <base> (mesmo diretório do app)');

      const entradaTexto = fs.readFileSync(path.join(__dirname, '..', 'public', 'financas-entrada.js'), 'utf8');
      ok(entradaTexto.includes("location.assign('financas.html')"), "F12: financas-entrada.js navega com location.assign('financas.html')");
      ok(!entradaTexto.includes('.innerHTML'), 'F12: financas-entrada.js sem .innerHTML (#26)');

      const jsTexto = fs.readFileSync(path.join(__dirname, '..', 'public', 'financas.js'), 'utf8');
      ok(!jsTexto.includes('.innerHTML'), 'F12: financas.js sem .innerHTML (#26)');

      // Varredura dos tr(...) de financas.js E financas-entrada.js (molde `gate-idioma.js:150-163`).
      const vm = require('node:vm');
      const ctx = vm.createContext({});
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'traducoes.js'), 'utf8'), ctx);
      const catalogo = ctx.cockpitTraducoes;
      const chavesUsadas = new Set();
      for (const texto of [jsTexto, entradaTexto]) {
        const fonteSemComentarios = texto.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const m of fonteSemComentarios.matchAll(/\btr\(\s*(['"])((?:(?!\1).)*)\1/g)) chavesUsadas.add(m[2]);
        for (const m of fonteSemComentarios.matchAll(/\btr`((?:[^`\\]|\\.)*)`/g)) {
          let i = 0;
          chavesUsadas.add(m[1].replace(/\$\{[^}]*\}/g, () => `{${i++}}`));
        }
      }
      ok(chavesUsadas.size > 0, 'F12: a varredura achou pelo menos uma chamada a tr(...) em financas.js/financas-entrada.js');
      for (const chave of chavesUsadas) {
        ok(Object.hasOwn(catalogo, chave), `F12: financas.js/financas-entrada.js usa tr(...) com chave fora do catálogo: ${chave}`);
      }
      for (const chave of ['Finanças', 'Ver de quem', 'Período', 'Exportar ▾', 'Formato', 'Pra onde', 'Baixar neste aparelho']) {
        ok(Object.hasOwn(catalogo, chave), `F12: catálogo tem a chave estática "${chave}" do financas.html`);
      }
    }

    // ─── F13 — as puras do cliente, em Node puro ───
    {
      const antigoI18n = globalThis.cockpitI18n;
      globalThis.cockpitI18n = { t: (s, ...v) => s.replace(/\{(\d+)\}/g, (_, i) => v[i]), idioma: 'pt-BR' };
      delete require.cache[require.resolve('../public/financas.js')];
      require('../public/financas.js');
      const { diaMes, visoes, larguras, mesDoKpi } = globalThis.cockpitFinancas;
      const trFake = (s, ...v) => s.replace(/\{(\d+)\}/g, (_, i) => v[i]);

      ok(diaMes('2026-03-01') === '01/03', `F13: diaMes('2026-03-01') === '01/03' (veio ${diaMes('2026-03-01')})`);
      ok(diaMes('lixo') === null, `F13: diaMes inválido → null (veio ${diaMes('lixo')})`);

      const listaComCasa = visoes({ casa: { id: 'casa' }, pessoas: [{ id: 'ana', nome: 'Ana' }] }, trFake);
      ok(listaComCasa[0] && listaComCasa[0].id === 'casa', `F13: visoes com casa → casa primeiro (veio ${JSON.stringify(listaComCasa.map((v) => v.id))})`);

      const larg = larguras([{ mes: 'a', renda: null, gasto: -5 }, { mes: 'b', renda: -1, gasto: null }]);
      ok(larg.a.renda === 0 && larg.a.gasto === 0 && larg.b.renda === 0 && larg.b.gasto === 0,
        `F13: larguras com null/negativo e sem nenhum positivo → tudo 0 (veio ${JSON.stringify(larg)})`);

      ok(mesDoKpi({ ultimoCompleto: null, meses: [] }) === null,
        `F13: mesDoKpi sem mês completo → null (veio ${mesDoKpi({ ultimoCompleto: null, meses: [] })})`);

      globalThis.cockpitI18n = antigoI18n;
    }

    // ─── P — as puras da PÁGINA de finanças, em Node puro (D92, Fase 2) ───
    {
      const antigoI18nP = globalThis.cockpitI18n;
      globalThis.cockpitI18n = { t: (s, ...v) => s.replace(/\{(\d+)\}/g, (_, i) => v[i]), idioma: 'pt-BR' };
      delete require.cache[require.resolve('../public/financas.js')];
      require('../public/financas.js');
      const {
        mesesDoPeriodo, gastoPorCategoria, lancamentosDe: lancamentosDeCliente, categoriasDoPeriodo,
        foraDoGasto, maioresGastos, chaveLoja, variacao, pctDoMes, divergencias, juntarLancamentos,
      } = globalThis.cockpitFinancas;

      // As puras do cliente leem o lançamento NORMALIZADO (`fora`, não `fora_do_gasto`) — o
      // mesmo formato que `GET /api/financas/lancamentos` devolve, via `interpretarLancamentos`.
      // A fixture (`fxFin.lancamentosDe`) grava o formato do ARQUIVO; aqui ela passa pelo mesmo
      // normalizador do servidor antes de alimentar as funções do cliente.
      const normalizar = (id, raw) => financas.interpretarLancamentos(
        JSON.stringify({ versao: 1, pessoa: { id }, gerado_em: new Date().toISOString(), lancamentos: raw }), id,
      ).lancamentos;

      ok(JSON.stringify(mesesDoPeriodo(['a', 'b', 'c', 'd'], 3)) === JSON.stringify(['b', 'c', 'd']),
        'P: mesesDoPeriodo(meses,3) → os 3 últimos');
      ok(JSON.stringify(mesesDoPeriodo(['a', 'b'], 5)) === JSON.stringify(['a', 'b']),
        'P: mesesDoPeriodo com n maior que a lista → a lista inteira');

      // Com a fixture: Σ gastoPorCategoria ≈ resumo.gasto em todo mês/pessoa (mesma régua da Fase 0).
      for (const id of ['ana', 'bia']) {
        const lancsRaw = fxFin.lancamentosDe(id);
        const resumoFx = fxFin.resumoDe(id, lancsRaw);
        const lancs = normalizar(id, lancsRaw);
        for (const mes of fxFin.MESES) {
          const info = resumoFx.meses.find((m) => m.mes === mes);
          let soma = 0;
          for (const v of gastoPorCategoria(lancs, mes).values()) soma += v;
          ok(Math.abs(soma - info.gasto) < 0.005,
            `P: Σ gastoPorCategoria(${id},${mes}) ≈ resumo.gasto (veio ${soma} vs ${info.gasto})`);
        }
      }

      // lancamentosDe (cliente): o MESMO filtro de gastoPorCategoria — débitos−créditos = célula.
      {
        const lancsAna = normalizar('ana', fxFin.lancamentosDe('ana'));
        const mesTeste = '2026-01';
        const linhasSaude = lancamentosDeCliente(lancsAna, mesTeste, 'Saúde');
        const netSaude = linhasSaude.reduce((s, l) => s + (l.tipo === 'debito' ? 1 : -1) * l.valor, 0);
        ok(Math.abs(netSaude - gastoPorCategoria(lancsAna, mesTeste).get('Saúde')) < 0.005,
          `P: lancamentosDe(Saúde) débitos−créditos = gastoPorCategoria.get('Saúde') (veio ${netSaude} vs ${gastoPorCategoria(lancsAna, mesTeste).get('Saúde')})`);
        ok(linhasSaude.every((l) => !l.fora && l.grupo !== 'Renda'), 'P: lancamentosDe não traz linha fora nem Renda');
      }

      // categoriasDoPeriodo em ordem decrescente do total.
      {
        const lancsAna = normalizar('ana', fxFin.lancamentosDe('ana'));
        const periodo = fxFin.MESES.slice(-3);
        const ordem = categoriasDoPeriodo(lancsAna, periodo);
        const totais = ordem.map((cat) => periodo.reduce((s, mes) => s + (gastoPorCategoria(lancsAna, mes).get(cat) || 0), 0));
        const decrescente = totais.every((v, i) => i === 0 || totais[i - 1] >= v);
        ok(decrescente, `P: categoriasDoPeriodo em ordem decrescente do total (veio ${JSON.stringify(totais)})`);
      }

      // foraDoGasto: grupos "Transferências"/"Investimentos" com o total certo.
      {
        const lancsAna = normalizar('ana', fxFin.lancamentosDe('ana'));
        const mesTeste = '2026-01';
        const fora = foraDoGasto(lancsAna, mesTeste);
        const faturaLinha = lancsAna.find((l) => l.mes === mesTeste && l.categoria === 'Transferências');
        const cdbLinha = lancsAna.find((l) => l.mes === mesTeste && l.categoria === 'Investimentos');
        ok(Math.abs(fora.get('Transferências') - faturaLinha.valor) < 0.005, `P: foraDoGasto Transferências = o débito da fatura (veio ${fora.get('Transferências')})`);
        ok(Math.abs(fora.get('Investimentos') - cdbLinha.valor) < 0.005, `P: foraDoGasto Investimentos = o débito do CDB (veio ${fora.get('Investimentos')})`);
      }

      // maioresGastos / chaveLoja.
      {
        const lancsAna = normalizar('ana', fxFin.lancamentosDe('ana'));
        const mesTeste = '2026-01';
        const top = maioresGastos(lancsAna, mesTeste, 6);
        ok(top.length <= 6, `P: maioresGastos ≤ 6 (veio ${top.length})`);
        ok(top.every((v, i) => i === 0 || top[i - 1].total >= v.total), 'P: maioresGastos decrescente');
        ok(top.every((v) => v.total > 0), 'P: maioresGastos só valores positivos (débitos)');
        ok(chaveLoja('Pix enviado para  Fulano de Tal') === chaveLoja('PIX ENVIADO PARA Fulano De Tal'),
          `P: chaveLoja normaliza espaço/prefixo/caixa (veio "${chaveLoja('Pix enviado para  Fulano de Tal')}" vs "${chaveLoja('PIX ENVIADO PARA Fulano De Tal')}")`);
      }

      // variacao / pctDoMes.
      ok(JSON.stringify(variacao(110, 100)) === JSON.stringify({ pct: 10 }), `P: variacao(110,100) = {pct:10} (veio ${JSON.stringify(variacao(110, 100))})`);
      ok(variacao(null, 100) === null, 'P: variacao(null,100) → null');
      ok(variacao(100, null) === null, 'P: variacao(100,null) → null');
      ok(variacao(100, 0) === null, 'P: variacao(100,0) → null (nunca Infinity)');
      ok(pctDoMes(50, 0) === null, 'P: pctDoMes(50,0) → null ("—")');
      ok(pctDoMes(25, 200) === 12.5, `P: pctDoMes(25,200) === 12.5 (veio ${pctDoMes(25, 200)})`);

      // divergencias.
      {
        const lancsAnaRaw = fxFin.lancamentosDe('ana');
        const resumoAnaFx = fxFin.resumoDe('ana', lancsAnaRaw);
        const lancsAna = normalizar('ana', lancsAnaRaw);
        ok(divergencias(resumoAnaFx.meses, lancsAna).length === 0,
          `P: divergencias(...) → [] com a fixture (veio ${JSON.stringify(divergencias(resumoAnaFx.meses, lancsAna))})`);

        const indicePrimeiroJan = lancsAna.findIndex((l) => l.mes === '2026-01');
        const semUmJan = lancsAna.filter((l, i) => i !== indicePrimeiroJan);
        const div = divergencias(resumoAnaFx.meses, semUmJan);
        ok(div.length === 1 && div[0].mes === '2026-01', `P: tirar 1 lançamento de jan → ['2026-01'] com diferença (veio ${JSON.stringify(div)})`);

        const mesesComBuraco = resumoAnaFx.meses.concat([{ mes: '2099-01', gasto: 999, rotulo: 'x', parcial: false, categorias: [] }]);
        const divBuraco = divergencias(mesesComBuraco, lancsAna);
        ok(!divBuraco.some((d) => d.mes === '2099-01'), 'P: mês do resumo sem nenhum lançamento → não aparece como divergência');
      }

      // juntarLancamentos.
      {
        const juntos = juntarLancamentos({ ana: [{ mes: '2026-01', valor: 1 }], bia: [{ mes: '2026-01', valor: 2 }] }, { ana: 'Ana', bia: 'Bia' });
        ok(juntos.length === 2 && juntos.every((l) => typeof l.pessoa === 'string'), `P: juntarLancamentos → cada linha com pessoa (veio ${JSON.stringify(juntos)})`);
      }

      // P-mão — números escritos à MÃO (a regra contra fixture circular).
      {
        const mesMao = '2026-01';
        const lancsMao = [
          { mes: mesMao, categoria: 'Mercado', grupo: null, fora: false, tipo: 'debito', valor: 50.10, descricao: 'Loja A' },
          { mes: mesMao, categoria: 'Mercado', grupo: null, fora: false, tipo: 'debito', valor: 20.25, descricao: 'Loja B' },
          { mes: mesMao, categoria: 'Saúde', grupo: null, fora: false, tipo: 'debito', valor: 100.00, descricao: 'Clínica' },
          { mes: mesMao, categoria: 'Saúde', grupo: null, fora: false, tipo: 'credito', valor: 30.00, descricao: 'Reembolso' },
          { mes: mesMao, categoria: 'Transferências', grupo: null, fora: true, tipo: 'debito', valor: 500.00, descricao: 'Pagamento de fatura' },
          { mes: mesMao, categoria: 'Salário', grupo: 'Renda', fora: false, tipo: 'credito', valor: 1000.00, descricao: 'Salário' },
          { mes: mesMao, categoria: 'Lazer', grupo: null, fora: false, tipo: 'credito', valor: 5.00, descricao: 'Estorno lazer' },
        ];
        const gastoMao = gastoPorCategoria(lancsMao, mesMao);
        ok(Math.abs(gastoMao.get('Mercado') - 70.35) < 0.005, `P-mão: Mercado = 70,35 (veio ${gastoMao.get('Mercado')})`);
        ok(Math.abs(gastoMao.get('Saúde') - 70.00) < 0.005, `P-mão: Saúde = 70,00 (veio ${gastoMao.get('Saúde')})`);
        ok(Math.abs(gastoMao.get('Lazer') - (-5.00)) < 0.005, `P-mão: Lazer = −5,00 (veio ${gastoMao.get('Lazer')})`);
        const totalMao = [...gastoMao.values()].reduce((s, v) => s + v, 0);
        ok(Math.abs(totalMao - 135.35) < 0.005, `P-mão: total = 135,35 (veio ${totalMao})`);
        const foraMao = foraDoGasto(lancsMao, mesMao);
        ok(Math.abs(foraMao.get('Transferências') - 500.00) < 0.005, `P-mão: foraDoGasto Transferências = 500,00 (veio ${foraMao.get('Transferências')})`);
        const maioresMao = maioresGastos(lancsMao, mesMao, 6);
        ok(!maioresMao.some((m) => m.nome === 'Reembolso' || m.nome === 'Estorno lazer'), 'P-mão: maioresGastos não tem o crédito');
        ok(!maioresMao.some((m) => m.nome === 'Pagamento de fatura'), 'P-mão: maioresGastos não tem a transferência');
      }

      // Casa — divergencias(somarCasa(resumos).meses, juntarLancamentos(...)) com a fixture → [].
      {
        const lancsAnaRaw = fxFin.lancamentosDe('ana');
        const lancsBiaRaw = fxFin.lancamentosDe('bia');
        const resumoAnaFx = fxFin.resumoDe('ana', lancsAnaRaw);
        const resumoBiaFx = fxFin.resumoDe('bia', lancsBiaRaw);
        const pessoaAna = financas.interpretar(JSON.stringify(resumoAnaFx), 'ana', Date.now()).pessoa;
        const pessoaBia = financas.interpretar(JSON.stringify(resumoBiaFx), 'bia', Date.now()).pessoa;
        const casa = financas.somarCasa([pessoaAna, pessoaBia]);
        const lancsCasa = juntarLancamentos(
          { ana: normalizar('ana', lancsAnaRaw), bia: normalizar('bia', lancsBiaRaw) },
          { ana: 'Ana', bia: 'Bia' },
        );
        const divCasa = divergencias(casa.meses, lancsCasa);
        ok(divCasa.length === 0, `P-Casa: divergencias(somarCasa.meses, juntarLancamentos) → [] com a fixture (veio ${JSON.stringify(divCasa)})`);
      }

      globalThis.cockpitI18n = antigoI18nP;
    }
  } finally {
    s.fechar();
    fs.rmSync(raizT, { recursive: true, force: true });
    fs.rmSync(RAIZ, { recursive: true, force: true });
  }

  console.log(falhas ? `\n❌ ${falhas} falha(s)` : '\n✅ gate-financas verde (F1–F13, L, A, D, E, R, P)');
  process.exitCode = falhas ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
