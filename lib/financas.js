'use strict';
/**
 * Página de Finanças (D90 → D92) — leitor SÓ-LEITURA do resumo financeiro diário e dos
 * lançamentos que um gerador EXTERNO a este repo grava, 1×/dia, por pessoa: `<id>.json` +
 * `<id>.lancamentos.json` + `<id>.pdf` + `<id>.xlsx` numa pasta própria.
 * Molde `lib/sites.js` (D87): configuração resolvida em TEMPO DE CHAMADA (a env vence um HOME
 * falso, #62); ausente = recurso desligado e calado; falha de ACESSO (ex.: `EACCES`) é ligado
 * com erro, nunca desligado; `ler()`/`estado()`/`lerLancamentos()` nunca lançam por conta
 * própria — erro de normalização de conteúdo vira "não sei" ou `ilegiveis[]`/`ilegivel`, nunca
 * exceção. `localizarArquivo()`/`enviar()` lançam (B3/B4) — quem chama (`server.js`) traduz em
 * status HTTP.
 *
 * Este módulo nunca ESCREVE na pasta do resumo. O envio de PDF/Excel é pelo Taildrop, via
 * `lib/arquivos.js` (`mandarArquivo`, extraído de `enviarParaFora`) — o cliente nunca escolhe
 * caminho: o POST leva id da pessoa, formato e destino (da lista fixa); o nome do arquivo é
 * montado no servidor (B3), nunca lido do JSON.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const arquivos = require('./arquivos');

const TETO_ARQUIVO = 256 * 1024;
const MAX_PESSOAS = 8;
const MAX_MESES = 24;
const MAX_CATEGORIAS = 12;
const MAX_CONTAS = 20;
const MAX_ITENS = 50;
const MAX_AVISOS = 10;
const TETO_TEXTO = 120;
const DESATUALIZADO_S = 36 * 3600;
// D92 — a Página de Finanças: teto próprio dos lançamentos (B2), régua do export (B3) e a
// lista fixa de destinos (B1). `FORMATOS` é o único lugar que decide extensão ↔ content-type.
const TETO_LANCAMENTOS = 2 * 1024 * 1024;
const MAX_LANCAMENTOS = 20000;
const TETO_EXPORT = 20 * 1024 * 1024;
const MAX_DESTINOS = 8;
const FORMATOS = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVADO = 'casa';
const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const DIA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const PDF = /^[A-Za-z0-9][\w-]{0,63}\.pdf$/;
const DESTINO = /^[A-Za-z0-9][\w.-]{0,62}$/;

// Resolvida a CADA chamada (molde `lib/sites.js:arqDe`): o gate troca a pasta entre os casos.
const dirDe = () => process.env.COCKPIT_FINANCAS_DIR || path.join(os.homedir(), '.cockpit', 'financas');

/** `COCKPIT_FINANCAS_DESTINO` aparada e casando o padrão de nome de aparelho, senão `null`. */
function destinoPadrao() {
  const bruto = process.env.COCKPIT_FINANCAS_DESTINO;
  if (typeof bruto !== 'string') return null;
  const aparado = bruto.trim();
  return aparado && DESTINO.test(aparado) ? aparado : null;
}

const numero = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const logico = (v) => (typeof v === 'boolean' ? v : null);
function texto(v) {
  if (typeof v !== 'string') return null;
  const limpo = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, TETO_TEXTO);
  return limpo || null;
}
/** Soma dos valores; qualquer parcela `null` contamina o total inteiro (soma com buraco). */
const soma = (vals) => (vals.some((v) => v === null) ? null : vals.reduce((a, b) => a + b, 0));

/** `pdf === "<id>.pdf"` EXATO (o invariante medido no arquivo real) — nunca de outra pessoa. */
function pdfValido(pdf, id) {
  return typeof pdf === 'string' && pdf === `${id}.pdf` && PDF.test(pdf) && !pdf.includes('..') && path.basename(pdf) === pdf;
}

/** Nomes (fora de "Demais", comparação exata) das categorias de um mês. */
function nomesForaDemais(categorias) {
  const s = new Set();
  for (const c of categorias) if (!/^demais$/i.test(c.nome)) s.add(c.nome);
  return s;
}

function mesmoConjunto(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Mescla as categorias de um mês entre pessoas: soma por nome EXATO (null contamina só aquela
 * categoria); "Demais" (nome `/^demais$/i`) é somado separado; top 6 das demais em ordem
 * decrescente + o resto (incluindo os "Demais" de cada pessoa) somado num "Demais" final.
 * Devolve também se o conjunto de nomes fora de "Demais" é o MESMO em todas as pessoas do mês.
 */
function mesclarCategorias(porPessoaMes) {
  const mapa = new Map(); // nome → { valor, nula }
  let demaisValor = 0;
  let demaisNula = false;
  const nomesPorPessoa = porPessoaMes.map((m) => nomesForaDemais(m.categorias));
  for (const m of porPessoaMes) {
    for (const c of m.categorias) {
      if (/^demais$/i.test(c.nome)) {
        if (c.valor === null) demaisNula = true;
        else if (!demaisNula) demaisValor += c.valor;
        continue;
      }
      if (!mapa.has(c.nome)) {
        mapa.set(c.nome, { valor: c.valor, nula: c.valor === null });
      } else {
        const atual = mapa.get(c.nome);
        if (atual.nula || c.valor === null) { atual.nula = true; atual.valor = null; }
        else atual.valor += c.valor;
      }
    }
  }
  const mesmosNomes = nomesPorPessoa.every((s) => mesmoConjunto(s, nomesPorPessoa[0] || s));
  const lista = [...mapa.entries()].map(([nome, v]) => ({ nome, valor: v.nula ? null : v.valor }));
  lista.sort((a, b) => (b.valor === null ? -Infinity : b.valor) - (a.valor === null ? -Infinity : a.valor));
  const top6 = lista.slice(0, 6);
  const resto = lista.slice(6);
  let demaisFinal = demaisNula ? null : demaisValor;
  for (const c of resto) {
    if (demaisFinal === null || c.valor === null) demaisFinal = null;
    else demaisFinal += c.valor;
  }
  return { categorias: [...top6, { nome: 'Demais', valor: demaisFinal }], mesmosNomes };
}

/**
 * Pura: `{ ok: true, pessoa }` ou `{ ok: false, motivo }` a partir do TEXTO do arquivo (nunca lê
 * disco). `idArquivo` é o nome do arquivo sem `.json` — a identidade de verdade vem dele, nunca
 * do conteúdo (R: `pessoa.id !== idArquivo` é defeito do gerador, não corrida nossa).
 */
function interpretar(textoOriginal, idArquivo, agoraMs) {
  if (typeof textoOriginal !== 'string' || textoOriginal.length > TETO_ARQUIVO) return { ok: false, motivo: 'grande' };
  let dado;
  try { dado = JSON.parse(textoOriginal); } catch { return { ok: false, motivo: 'json' }; }
  if (!dado || typeof dado !== 'object' || Array.isArray(dado)) return { ok: false, motivo: 'forma' };
  if (dado.versao !== 1) return { ok: false, motivo: 'versao' };
  const pessoaBruta = dado.pessoa;
  const idBruto = pessoaBruta && typeof pessoaBruta === 'object' && !Array.isArray(pessoaBruta) ? pessoaBruta.id : undefined;
  if (idBruto !== idArquivo) return { ok: false, motivo: 'id' };

  const geradoEmBruto = dado.gerado_em;
  const geradoEm = typeof geradoEmBruto === 'string' ? geradoEmBruto : null;
  const geradoMs = geradoEm !== null ? Date.parse(geradoEm) : NaN;
  const geradoHaS = Number.isFinite(geradoMs) ? Math.max(0, Math.floor((agoraMs - geradoMs) / 1000)) : null;
  const desatualizado = geradoHaS === null || geradoHaS > DESATUALIZADO_S;

  const dadosAteBruto = dado.dados_ate;
  const dadosAte = typeof dadosAteBruto === 'string' && DIA.test(dadosAteBruto) ? dadosAteBruto : null;

  const saldoBruto = dado.saldo && typeof dado.saldo === 'object' && !Array.isArray(dado.saldo) ? dado.saldo : {};
  const total = numero(saldoBruto.total);
  const contasBrutas = Array.isArray(saldoBruto.contas) ? saldoBruto.contas : [];
  const contas = [];
  for (const c of contasBrutas) {
    if (contas.length >= MAX_CONTAS) break;
    if (!c || typeof c !== 'object') continue;
    const nome = texto(c.nome);
    if (!nome) continue; // sem nome → pulada
    contas.push({ nome, conectada: logico(c.conectada), saldo: numero(c.saldo) });
  }

  const mesesBrutos = Array.isArray(dado.meses) ? dado.meses : [];
  const vistos = new Set();
  const mesesNormalizados = [];
  for (const m of mesesBrutos) {
    if (!m || typeof m !== 'object') continue;
    const mes = m.mes;
    if (typeof mes !== 'string' || !MES.test(mes) || vistos.has(mes)) continue; // repetido: fica o primeiro
    vistos.add(mes);
    const categoriasBrutas = Array.isArray(m.categorias) ? m.categorias : [];
    const categorias = [];
    for (const c of categoriasBrutas) {
      if (categorias.length >= MAX_CATEGORIAS) break;
      if (!c || typeof c !== 'object') continue;
      const nomeCat = texto(c.nome);
      if (!nomeCat) continue;
      categorias.push({ nome: nomeCat, valor: numero(c.valor) });
    }
    mesesNormalizados.push({
      mes,
      rotulo: texto(m.rotulo) || mes,
      periodo: texto(m.periodo),
      parcial: logico(m.parcial),
      renda: numero(m.renda),
      gasto: numero(m.gasto),
      faturaCartao: numero(m.fatura_cartao),
      categorias,
    });
  }
  mesesNormalizados.sort((a, b) => a.mes.localeCompare(b.mes)); // crescente
  const meses = mesesNormalizados.slice(-MAX_MESES); // até MAX_MESES, os mais recentes

  let ultimoCompleto = null;
  for (const m of meses) {
    if (m.parcial === false && (ultimoCompleto === null || m.mes > ultimoCompleto)) ultimoCompleto = m.mes;
  }

  const reembolsosBruto = dado.reembolsos;
  let reembolsos = null;
  if (reembolsosBruto !== null && reembolsosBruto !== undefined
    && typeof reembolsosBruto === 'object' && !Array.isArray(reembolsosBruto)) {
    const pendente = numero(reembolsosBruto.pendente);
    const itensBrutos = Array.isArray(reembolsosBruto.itens) ? reembolsosBruto.itens : [];
    const itens = [];
    for (const it of itensBrutos) {
      if (itens.length >= MAX_ITENS) break;
      if (!it || typeof it !== 'object') continue;
      const data = typeof it.data === 'string' && DIA.test(it.data) ? it.data : null;
      itens.push({ data, descricao: texto(it.descricao), valor: numero(it.valor), atrasado: logico(it.atrasado) });
    }
    reembolsos = { pendente, itens };
  }

  const avisosBrutos = Array.isArray(dado.avisos) ? dado.avisos : [];
  const avisos = [];
  for (const a of avisosBrutos) {
    if (avisos.length >= MAX_AVISOS) break;
    const t = texto(a);
    if (t) avisos.push(t);
  }

  const pdfBruto = dado.pdf;
  const pdf = pdfValido(pdfBruto, idArquivo) ? pdfBruto : null;

  const pessoa = {
    id: idArquivo,
    nome: texto(pessoaBruta.nome) || idArquivo,
    geradoEm, geradoHaS, desatualizado,
    dadosAte,
    saldo: { total, contas },
    meses,
    ultimoCompleto,
    reembolsos,
    avisos,
    pdf,
  };
  return { ok: true, pessoa };
}

/** Pura, só chamada com ≥ 2 pessoas (resultado de `interpretar`, já normalizado). */
function somarCasa(pessoas) {
  const membros = pessoas.map((p) => p.id);
  const totalSaldo = soma(pessoas.map((p) => p.saldo.total));
  const contas = [];
  for (const p of pessoas) for (const c of p.saldo.contas) contas.push({ ...c, pessoa: p.nome });

  const mesesComuns = pessoas[0].meses
    .map((m) => m.mes)
    .filter((mes) => pessoas.every((p) => p.meses.some((m) => m.mes === mes)));

  let categoriasAproximadas = false;
  const meses = mesesComuns.map((mes) => {
    const porPessoaMes = pessoas.map((p) => p.meses.find((m) => m.mes === mes));
    const renda = soma(porPessoaMes.map((m) => m.renda));
    const gasto = soma(porPessoaMes.map((m) => m.gasto));
    const faturaCartao = soma(porPessoaMes.map((m) => m.faturaCartao));
    const algumNull = porPessoaMes.some((m) => m.parcial === null);
    const algumTrue = porPessoaMes.some((m) => m.parcial === true);
    const parcial = algumTrue ? true : (algumNull ? null : false);
    const { categorias, mesmosNomes } = mesclarCategorias(porPessoaMes);
    if (!mesmosNomes) categoriasAproximadas = true;
    return { mes, rotulo: porPessoaMes[0].rotulo, periodo: porPessoaMes[0].periodo, parcial, renda, gasto, faturaCartao, categorias };
  });

  let ultimoCompleto = null;
  for (const m of meses) {
    if (m.parcial === false && (ultimoCompleto === null || m.mes > ultimoCompleto)) ultimoCompleto = m.mes;
  }

  const comReembolso = pessoas.filter((p) => p.reembolsos !== null);
  let reembolsos = null;
  if (comReembolso.length > 0) {
    const pendente = soma(comReembolso.map((p) => p.reembolsos.pendente));
    const itens = [];
    for (const p of comReembolso) for (const it of p.reembolsos.itens) itens.push({ ...it, pessoa: p.nome });
    itens.sort((a, b) => (a.data || '').localeCompare(b.data || ''));
    reembolsos = { pendente, itens };
  }

  const dadosAtes = pessoas.map((p) => p.dadosAte);
  const dadosAte = dadosAtes.some((d) => d === null) ? null : dadosAtes.reduce((a, b) => (a < b ? a : b));

  // Uma idade desconhecida contamina a da casa (mesma regra do `null` da soma): a tela diz "não
  // sei quando", nunca a idade da outra pessoa.
  const algumaIdadeDesconhecida = pessoas.some((p) => p.geradoHaS === null);
  const geradoEm = algumaIdadeDesconhecida ? null
    : new Date(Math.min(...pessoas.map((p) => Date.parse(p.geradoEm)))).toISOString();
  const geradoHaS = algumaIdadeDesconhecida ? null : Math.max(...pessoas.map((p) => p.geradoHaS));
  const desatualizado = pessoas.some((p) => p.desatualizado);

  const avisos = [];
  for (const p of pessoas) for (const a of p.avisos) avisos.push(`${p.nome}: ${a}`);

  return {
    id: 'casa', nome: null, membros,
    geradoEm, geradoHaS, desatualizado,
    dadosAte,
    saldo: { total: totalSaldo, contas },
    meses,
    ultimoCompleto,
    reembolsos,
    avisos,
    pdf: null,
    categoriasAproximadas,
  };
}

// Estado de módulo para o log por transição — motivo e "pasta" limpos quando a leitura volta a
// ok (molde `lib/sites.js`). `_zerarParaTeste()` é só do gate.
let ultimoMotivoPorId = new Map();
let ultimoErroPasta = null;

function logarTransicao(id, motivo) {
  if (ultimoMotivoPorId.get(id) !== motivo) {
    console.error(`financas: ${id} ${motivo}`); // só id e código, nunca caminho nem conteúdo
    ultimoMotivoPorId.set(id, motivo);
  }
}
function limparMotivo(id) { ultimoMotivoPorId.delete(id); }
function logarErroPasta(codigo) {
  if (ultimoErroPasta !== codigo) {
    console.error(`financas: pasta ${codigo}`);
    ultimoErroPasta = codigo;
  }
}
function limparErroPasta() { ultimoErroPasta = null; }

/** Só o gate usa: devolve o módulo ao estado de recém-carregado. */
function _zerarParaTeste() {
  ultimoMotivoPorId = new Map();
  ultimoErroPasta = null;
}

/**
 * Pra decidir se o botão da entrada aparece: `lstat` + `readdir`, SEM LER arquivo nenhum.
 * `false` só com pasta ausente/não-diretório ou sem nenhum candidato `<id>.json`; `true` com
 * ≥ 1 candidato ou com falha de acesso (o `ler()` explica o erro quando o diálogo abre).
 * Nunca lança.
 */
async function estado() {
  let st;
  try {
    st = await fsp.lstat(dirDe());
  } catch (e) {
    // Mesma régua do `ler()`: só "não existe" desliga; falha de acesso mantém o botão e o diálogo explica.
    return { ligado: !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) };
  }
  if (!st.isDirectory()) return { ligado: false };
  let nomes;
  try { nomes = await fsp.readdir(dirDe()); } catch { return { ligado: true }; }
  const candidatos = nomes.filter((n) => n.endsWith('.json') && ID.test(n.slice(0, -5)) && n.slice(0, -5) !== RESERVADO);
  return { ligado: candidatos.length > 0 };
}

/**
 * Lê o resumo financeiro diário. Nunca lança: pasta ausente, sem permissão, arquivo
 * corrompido ou gigante vira estado (`ligado: false`/`erro: 'pasta'`/`ilegiveis[]`), nunca
 * exceção — o servidor nunca cai por causa desta leitura.
 */
async function ler() {
  const dir = dirDe();
  let st;
  try {
    st = await fsp.lstat(dir);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { ligado: false };
    logarErroPasta((e && e.code) || 'erro');
    return { ligado: true, erro: 'pasta', pessoas: [], casa: null, ilegiveis: [], destinos: destinosPermitidos() };
  }
  if (!st.isDirectory()) return { ligado: false };

  let nomes;
  try {
    nomes = await fsp.readdir(dir);
  } catch (e) {
    logarErroPasta((e && e.code) || 'erro');
    return { ligado: true, erro: 'pasta', pessoas: [], casa: null, ilegiveis: [], destinos: destinosPermitidos() };
  }
  limparErroPasta();

  const candidatosTodos = nomes
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .filter((id) => ID.test(id) && id !== RESERVADO)
    .sort();
  const dentroDoLimite = candidatosTodos.slice(0, MAX_PESSOAS);
  const excedentes = candidatosTodos.slice(MAX_PESSOAS);

  const pessoasOk = [];
  const ilegiveis = [];
  const agoraMs = Date.now();

  for (const id of dentroDoLimite) {
    const caminho = path.join(dir, `${id}.json`);
    let lst;
    try { lst = await fsp.lstat(caminho); } catch (e) { ilegiveis.push(id); logarTransicao(id, (e && e.code) || 'erro'); continue; }
    if (lst.isSymbolicLink()) continue; // a pasta é de um gerador: link é pulado por completo
    if (!lst.isFile()) { ilegiveis.push(id); logarTransicao(id, 'nao-arquivo'); continue; }
    if (lst.size > TETO_ARQUIVO) { ilegiveis.push(id); logarTransicao(id, 'grande'); continue; }
    let conteudo;
    try { conteudo = await fsp.readFile(caminho, 'utf8'); } catch (e) { ilegiveis.push(id); logarTransicao(id, (e && e.code) || 'erro'); continue; }
    const r = interpretar(conteudo, id, agoraMs);
    if (!r.ok) { ilegiveis.push(id); logarTransicao(id, r.motivo); continue; }
    limparMotivo(id);
    pessoasOk.push(r.pessoa);
  }
  for (const id of excedentes) { ilegiveis.push(id); logarTransicao(id, 'excedente'); }

  const pessoasSaida = [];
  for (const p of pessoasOk) {
    // B3 (D92): arquivos{pdf,xlsx} = "localizarArquivo resolveria sem lançar" — o nome é fixo
    // no servidor, nunca decidido pelo campo "pdf" do resumo (qualquer erro, inclusive 413,
    // vira false; a tela diz "não disponível"). Substitui o `pdfDisponivel` de antes.
    const arquivosPessoa = { pdf: false, xlsx: false };
    for (const formato of ['pdf', 'xlsx']) {
      try { await localizarArquivo({ pessoa: p.id, formato }); arquivosPessoa[formato] = true; } catch { /* false */ }
    }
    pessoasSaida.push({
      id: p.id, nome: p.nome, geradoEm: p.geradoEm, geradoHaS: p.geradoHaS, desatualizado: p.desatualizado,
      dadosAte: p.dadosAte, saldo: p.saldo, meses: p.meses, ultimoCompleto: p.ultimoCompleto,
      reembolsos: p.reembolsos, avisos: p.avisos, arquivos: arquivosPessoa,
    });
  }

  if (pessoasSaida.length === 0 && ilegiveis.length === 0) return { ligado: false };

  let casa = null;
  let casaIndisponivel = false;
  if (pessoasSaida.length >= 2 && ilegiveis.length === 0) {
    casa = somarCasa(pessoasSaida);
  } else if (ilegiveis.length > 0) {
    casaIndisponivel = true; // um ilegível/excedente tornaria a soma uma soma com buraco
  }

  const resultado = {
    ligado: true, erro: null, agora: Math.floor(agoraMs / 1000),
    pessoas: pessoasSaida, casa, ilegiveis, destinos: destinosPermitidos(),
  };
  if (casaIndisponivel) resultado.casaIndisponivel = true;
  return resultado;
}

/**
 * B1 (D92) — lista fixa de destinos pro Taildrop (P6): `COCKPIT_FINANCAS_DESTINOS` (vírgula),
 * cada item aparado e casando `DESTINO`, sem repetido, mais o legado (`COCKPIT_FINANCAS_DESTINO`)
 * no fim se ainda válido — SÓ ENTÃO corta em `MAX_DESTINOS` (painel do plano, Claude #8).
 * Resolvida a CADA chamada (molde `dirDe`). Nome diferente de `arquivos.destinos()` (os
 * aparelhos VIVOS do tailnet) — nenhum nome de aparelho real entra aqui, nos testes nem na doc
 * (repo vai virar público, #106).
 */
function destinosPermitidos() {
  const bruto = process.env.COCKPIT_FINANCAS_DESTINOS;
  const vistos = new Set();
  const lista = [];
  if (typeof bruto === 'string') {
    for (const item of bruto.split(',')) {
      const aparado = item.trim();
      if (!aparado || !DESTINO.test(aparado) || vistos.has(aparado)) continue;
      vistos.add(aparado);
      lista.push(aparado);
    }
  }
  const legado = destinoPadrao();
  if (legado && !vistos.has(legado)) lista.push(legado);
  return lista.slice(0, MAX_DESTINOS);
}

/**
 * B2 (D92) — uma linha de `<id>.lancamentos.json` → `{ data, mes, descricao, valor, tipo,
 * categoria, grupo, fora, conta }` ou `null` (linha DESCARTADA, nunca lança). `categoria` vazia
 * vira "Sem categoria" **[S]** — a tela nunca mostra uma categoria sem nome.
 */
function linhaLancamento(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (typeof item.data !== 'string' || !DIA.test(item.data)) return null;
  const valor = numero(item.valor);
  if (valor === null || valor < 0) return null;
  if (item.tipo !== 'debito' && item.tipo !== 'credito') return null;
  if (typeof item.fora_do_gasto !== 'boolean') return null;
  return {
    data: item.data,
    mes: item.data.slice(0, 7),
    descricao: texto(item.descricao),
    valor,
    tipo: item.tipo,
    categoria: texto(item.categoria) || 'Sem categoria',
    grupo: texto(item.grupo),
    fora: item.fora_do_gasto,
    conta: texto(item.conta),
  };
}

/**
 * B2 (D92) — pura: `{ ok: true, geradoEm, lancamentos, descartados }` ou `{ ok: false, motivo }`
 * a partir do TEXTO do arquivo (nunca lê disco). Acima de `MAX_LANCAMENTOS` itens o arquivo
 * INTEIRO é `ilegivel` (motivo "muitos") — nunca truncado calado (Codex #3). Identidade vem do
 * nome do arquivo (`idArquivo`), nunca do conteúdo — mesma régua de `interpretar()`.
 */
function interpretarLancamentos(textoOriginal, idArquivo) {
  if (typeof textoOriginal !== 'string') return { ok: false, motivo: 'ilegivel' };
  let dado;
  try { dado = JSON.parse(textoOriginal); } catch { return { ok: false, motivo: 'json' }; }
  if (!dado || typeof dado !== 'object' || Array.isArray(dado)) return { ok: false, motivo: 'forma' };
  if (dado.versao !== 1) return { ok: false, motivo: 'versao' };
  const pessoaBruta = dado.pessoa;
  const idBruto = pessoaBruta && typeof pessoaBruta === 'object' && !Array.isArray(pessoaBruta) ? pessoaBruta.id : undefined;
  if (idBruto !== idArquivo) return { ok: false, motivo: 'id' };
  const geradoEmBruto = dado.gerado_em;
  const geradoEm = typeof geradoEmBruto === 'string' ? geradoEmBruto : null;
  // Campo ausente/null/objeto é arquivo malformado, não "lista vazia" (painel de execução, Codex #1).
  if (!Array.isArray(dado.lancamentos)) return { ok: false, motivo: 'forma' };
  const itensBrutos = dado.lancamentos;
  if (itensBrutos.length > MAX_LANCAMENTOS) return { ok: false, motivo: 'muitos' };
  const lancamentos = [];
  let descartados = 0;
  for (const item of itensBrutos) {
    const linha = linhaLancamento(item);
    if (linha) lancamentos.push(linha); else descartados += 1;
  }
  return { ok: true, geradoEm, lancamentos, descartados };
}

/**
 * B2 (D92) — lê `<dir>/<pessoa>.lancamentos.json`. Nunca lança por CONTEÚDO: ausente/symlink
 * vira `{ estado: 'ausente' }` (mesma régua do `ler()` `:388`); corrompido/gigante vira
 * `{ estado: 'ilegivel', motivo }`. Log por transição com a chave `"<id>.lancamentos"`.
 */
async function lerLancamentos(pessoa) {
  if (typeof pessoa !== 'string' || !ID.test(pessoa) || pessoa === RESERVADO) {
    throw arquivos.erro(400, 'pessoa inválida');
  }
  const caminho = path.join(dirDe(), `${pessoa}.lancamentos.json`);
  let lst;
  try {
    lst = await fsp.lstat(caminho);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { estado: 'ausente' };
    return { estado: 'ilegivel', motivo: (e && e.code) || 'erro' };
  }
  if (lst.isSymbolicLink()) return { estado: 'ausente' };
  if (!lst.isFile()) return { estado: 'ilegivel', motivo: 'nao-arquivo' };
  if (lst.size > TETO_LANCAMENTOS) return { estado: 'ilegivel', motivo: 'grande' };
  let conteudo;
  try {
    conteudo = await fsp.readFile(caminho, 'utf8');
  } catch (e) {
    return { estado: 'ilegivel', motivo: (e && e.code) || 'erro' };
  }
  const chave = `${pessoa}.lancamentos`;
  const r = interpretarLancamentos(conteudo, pessoa);
  if (!r.ok) { logarTransicao(chave, r.motivo); return { estado: 'ilegivel', motivo: r.motivo }; }
  limparMotivo(chave);
  return { estado: 'ok', geradoEm: r.geradoEm, lancamentos: r.lancamentos, descartados: r.descartados };
}

/**
 * B3 (D92) — uma régua só pra PDF e Excel (a mesma trava do D90-D5, mais a recusa de symlink
 * que o card pede): o nome é `<id>.<formato>` EXATO, montado AQUI — o cliente nunca escolhe
 * caminho. Lança `arquivos.erro(codigo)`. `ler()` chama isto por pessoa/formato só pra saber SE
 * resolveria (campo `arquivos{pdf,xlsx}`), nunca pra decidir o quê mostrar a partir do resumo —
 * o campo `pdf` do resumo continua validado em `interpretar()`, mas deixa de decidir
 * disponibilidade.
 */
async function localizarArquivo({ pessoa, formato }) {
  if (typeof pessoa !== 'string' || !ID.test(pessoa) || pessoa === RESERVADO) {
    throw arquivos.erro(400, 'pessoa inválida');
  }
  if (!Object.hasOwn(FORMATOS, formato)) throw arquivos.erro(400, 'formato inválido');
  const rotulo = formato === 'pdf' ? 'PDF' : 'Excel';
  const dir = dirDe();
  const caminho = path.join(dir, `${pessoa}.${formato}`);
  let lst;
  try {
    lst = await fsp.lstat(caminho);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) throw arquivos.erro(404, `esta pessoa não tem ${rotulo}`);
    throw arquivos.erro(409, `não consegui ler o ${rotulo}`);
  }
  if (lst.isSymbolicLink()) throw arquivos.erro(404, `esta pessoa não tem ${rotulo}`);
  if (!lst.isFile()) throw arquivos.erro(404, `esta pessoa não tem ${rotulo}`);
  let realDir;
  let real;
  try {
    realDir = await fsp.realpath(dir);
    real = await fsp.realpath(caminho);
  } catch {
    throw arquivos.erro(404, `esta pessoa não tem ${rotulo}`);
  }
  if (path.dirname(real) !== realDir) throw arquivos.erro(400, 'fora da pasta');
  let estado;
  try {
    estado = await fsp.stat(real);
  } catch {
    throw arquivos.erro(404, `esta pessoa não tem ${rotulo}`);
  }
  if (!estado.isFile()) throw arquivos.erro(404, `esta pessoa não tem ${rotulo}`);
  if (estado.size > TETO_EXPORT) throw arquivos.erro(413, `${rotulo} grande demais`);
  return { real, estado };
}

/**
 * B4 (D92) — manda o PDF/Excel da pessoa pro aparelho escolhido (substitui `enviarPdf`).
 * `destino` tem de estar em `destinosPermitidos()` lida AGORA, senão 400 SEM chamar a CLI (#22).
 * NUNCA lê o resumo: o nome já é fixo no servidor, então uma pessoa com `<id>.json` ilegível
 * ainda pode exportar pela API — aceito e registrado no D92 (a tela nem mostra essa pessoa; a
 * trava é o nome fixo + `realpath` + a lista de destinos).
 */
async function enviar({ pessoa, formato, destino }) {
  if (typeof destino !== 'string' || !destinosPermitidos().includes(destino)) {
    throw arquivos.erro(400, 'aparelho fora da lista');
  }
  const { real, estado } = await localizarArquivo({ pessoa, formato });
  return arquivos.mandarArquivo({ alvo: real, estado, destino });
}

module.exports = {
  interpretar, somarCasa, estado, ler, dirDe, _zerarParaTeste,
  TETO_ARQUIVO, DESATUALIZADO_S,
  interpretarLancamentos, lerLancamentos, localizarArquivo, enviar, destinosPermitidos,
  TETO_LANCAMENTOS, MAX_LANCAMENTOS, FORMATOS,
};
