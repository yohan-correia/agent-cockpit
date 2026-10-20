'use strict';
// A ALAVANCA da Página de Finanças (D92): um mundo FALSO coerente de lançamentos — `ana`/`bia`,
// sete meses (`2025-09` a `2026-02` completos, `2026-03` parcial até o dia 14) — e o resumo v1
// DERIVADO dos próprios lançamentos pela MESMA regra do gerador externo (`gera_relatorio.py:
// resumir`): por mês, renda = créditos − débitos do grupo "Renda"; categoria = débitos − créditos
// (sem `fora_do_gasto`, sem grupo "Renda"); gasto do mês = soma das categorias; top 6 + "Demais";
// `fatura_cartao` = débitos `fora` da categoria "Transferências" com "fatura" na descrição.
//
// Gerado por um laço DETERMINÍSTICO (tabela fixa de lojas × categorias + fator por mês) — nunca
// `Math.random`: a mesma fixture sai igual em toda rodada do gate e do print. Zero dado real:
// pessoas `ana`/`bia`, contas "Banco A"/"Banco B", lojas inventadas.
//
// Usado por `testes/gate-financas.js` (blocos L, A, D, E, R, P) e `testes/print-financas.js`.

const fs = require('node:fs');
const path = require('node:path');

const round2 = (v) => Math.round(v * 100) / 100;
/** Dias no mês 1-indexado (`mes` 1=jan…12=dez) — cálculo LOCAL de inteiros, sem parsear data. */
const diasNoMes = (ano, mes) => new Date(ano, mes, 0).getDate();

const MESES = ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03'];
const ROTULOS = ['set', 'out', 'nov', 'dez', 'jan', 'fev', 'mar'];
const MES_PARCIAL = '2026-03';
const DIA_FIM_PARCIAL = 14;

const CATEGORIAS = ['Mercado', 'Casa', 'Transporte', 'Saúde', 'Lazer', 'Educação', 'Pets', 'Assinaturas'];
// bia sem Educação, ana sem Pets (painel do plano) — 7 categorias de gasto por pessoa.
const CATEGORIAS_DE = {
  ana: CATEGORIAS.filter((c) => c !== 'Pets'),
  bia: CATEGORIAS.filter((c) => c !== 'Educação'),
};

// Lojas inventadas, fixas por categoria — nenhuma delas é um estabelecimento real.
const LOJAS = {
  Mercado: ['Supermercado Exemplo', 'Padaria Central', 'Hortifruti Modelo', 'Atacado Fictício', 'Mercadinho da Esquina'],
  Casa: ['Loja de Materiais Exemplo', 'Conta de Luz Fictícia', 'Conta de Água Fictícia', 'Pix enviado para Fulano de Tal'],
  Transporte: ['Posto Fictício', 'App de Corrida Exemplo', 'Estacionamento Modelo', 'Oficina Fictícia'],
  Saúde: ['Farmácia Modelo', 'Clínica Exemplo', 'Laboratório Fictício', 'Plano de Saúde Exemplo'],
  Lazer: ['Cinema Fictício', 'Streaming de Vídeo Exemplo', 'Restaurante Modelo', 'Parque Fictício'],
  Educação: ['Escola Exemplo', 'Curso Fictício', 'Livraria Modelo', 'Material Escolar Exemplo'],
  Pets: ['Pet Shop Exemplo', 'Veterinário Fictício', 'Ração Modelo', 'Banho e Tosa Exemplo'],
  Assinaturas: ['Streaming A Fictício', 'Streaming B Exemplo', 'Nuvem Fictícia', 'Revista Modelo'],
};

// Valor TÍPICO de um item da categoria — o fator por mês/item varia em torno disto.
const BASE_VALOR = { Mercado: 95, Casa: 160, Transporte: 55, Saúde: 70, Lazer: 45, Educação: 180, Pets: 60, Assinaturas: 35 };

const NOMES = { ana: 'Ana', bia: 'Bia' };
const CONTAS_DE = {
  ana: [{ nome: 'Banco A', conectada: true, saldo: 3250.45 }, { nome: 'Banco B', conectada: false, saldo: 480.10 }],
  bia: [{ nome: 'Banco A', conectada: true, saldo: 1820.30 }],
};

/**
 * Lista FIXA (determinística) de lançamentos de `id` nos sete meses — formato do contrato
 * (`{ data, descricao, valor, tipo, categoria, grupo, fora_do_gasto, conta }`). Por mês: 2-5
 * débitos por categoria (loja da tabela fixa × fator por mês/item), um crédito de estorno em
 * Saúde ("Reembolso plano"), uma renda (grupo "Renda", categoria "Salário", crédito) e dois
 * lançamentos fora do gasto ("Transferências" com "Pagamento de fatura", "Investimentos" com
 * "Aplicação CDB"). Nunca `Math.random`.
 */
function lancamentosDe(id) {
  if (id !== 'ana' && id !== 'bia') throw new Error(`fixtures-financas: pessoa desconhecida "${id}"`);
  const categorias = CATEGORIAS_DE[id];
  const contas = CONTAS_DE[id].map((c) => c.nome);
  const lancamentos = [];

  MESES.forEach((mes, mesIndex) => {
    const [ano, mm] = mes.split('-').map(Number);
    const parcial = mes === MES_PARCIAL;
    const diasDisponiveis = parcial ? DIA_FIM_PARCIAL : diasNoMes(ano, mm);

    categorias.forEach((cat, catIndex) => {
      const nItens = 2 + ((mesIndex + catIndex) % 4); // 2..5
      const lojas = LOJAS[cat];
      for (let i = 0; i < nItens; i += 1) {
        const dia = 1 + ((i * 6 + catIndex * 4 + mesIndex * 2) % diasDisponiveis);
        const fator = 1 + (((mesIndex + 1) * 13 + (catIndex + 1) * 7 + (i + 1) * 11) % 37) / 100; // 1,00–1,36
        lancamentos.push({
          data: `${mes}-${String(dia).padStart(2, '0')}`,
          descricao: lojas[(mesIndex + i) % lojas.length],
          valor: round2(BASE_VALOR[cat] * fator),
          tipo: 'debito',
          categoria: cat,
          grupo: null,
          fora_do_gasto: false,
          conta: contas[(mesIndex + catIndex) % contas.length],
        });
      }
    });

    // Um crédito de estorno em Saúde — nunca entra no gasto da categoria por acaso: é subtraído.
    lancamentos.push({
      data: `${mes}-${String(parcial ? 10 : 20).padStart(2, '0')}`,
      descricao: 'Reembolso plano',
      valor: round2((id === 'ana' ? 45 : 35) + mesIndex * 1.5),
      tipo: 'credito',
      categoria: 'Saúde',
      grupo: null,
      fora_do_gasto: false,
      conta: contas[0],
    });

    // Renda do mês (grupo "Renda") — parcial encolhe pra refletir dias trabalhados.
    const rendaBase = id === 'ana' ? 7200 : 6100;
    const fatorMes = parcial ? 0.45 : 1 + mesIndex * 0.01;
    lancamentos.push({
      data: `${mes}-05`,
      descricao: 'Salário',
      valor: round2(rendaBase * fatorMes),
      tipo: 'credito',
      categoria: 'Salário',
      grupo: 'Renda',
      fora_do_gasto: false,
      conta: contas[0],
    });

    // Fora do gasto — Transferências (fatura) e Investimentos (CDB).
    const faturaBase = id === 'ana' ? 650 : 520;
    const fatorFatura = parcial ? 0.5 : 1 + mesIndex * 0.02;
    lancamentos.push({
      data: `${mes}-${parcial ? '12' : '15'}`,
      descricao: 'Pagamento de fatura',
      valor: round2(faturaBase * fatorFatura),
      tipo: 'debito',
      categoria: 'Transferências',
      grupo: null,
      fora_do_gasto: true,
      conta: contas[0],
    });
    const investBase = id === 'ana' ? 400 : 250;
    lancamentos.push({
      data: `${mes}-01`,
      descricao: 'Aplicação CDB',
      valor: round2(investBase * (1 + mesIndex * 0.005)),
      tipo: 'debito',
      categoria: 'Investimentos',
      grupo: null,
      fora_do_gasto: true,
      conta: contas[0],
    });
  });

  return lancamentos;
}

/**
 * Deriva o resumo v1 de `lancs` com A MESMA regra do gerador externo (`gera_relatorio.py:
 * resumir`): por mês, renda = créditos − débitos do grupo "Renda"; categorias = débitos −
 * créditos (sem `fora_do_gasto`, sem grupo "Renda"); `gasto` = soma das categorias; top 6 +
 * "Demais"; `fatura_cartao` = débitos `fora` da categoria "Transferências" com "fatura" na
 * descrição. `parcial: true` só em `2026-03`. Arredonda a 2 casas como o gerador (`round(v,2)`).
 */
function resumoDe(id, lancs, { geradoEm } = {}) {
  const porMes = new Map(MESES.map((mes) => [mes, { categorias: new Map(), renda: 0, faturaCartao: 0 }]));

  for (const l of lancs) {
    const mes = l.data.slice(0, 7);
    const alvo = porMes.get(mes);
    if (!alvo) continue; // fora da janela de 7 meses — não acontece com esta fixture
    const sinal = l.tipo === 'debito' ? 1 : -1;
    if (l.grupo === 'Renda') {
      alvo.renda += -sinal * l.valor; // renda = créditos − débitos
      continue;
    }
    if (l.fora_do_gasto) {
      if (l.categoria === 'Transferências' && l.tipo === 'debito' && /fatura/i.test(l.descricao)) {
        alvo.faturaCartao += l.valor;
      }
      continue;
    }
    alvo.categorias.set(l.categoria, (alvo.categorias.get(l.categoria) || 0) + sinal * l.valor);
  }

  const meses = MESES.map((mes, i) => {
    const info = porMes.get(mes);
    const lista = [...info.categorias.entries()].map(([nome, valor]) => ({ nome, valor: round2(valor) }));
    lista.sort((a, b) => b.valor - a.valor);
    const top6 = lista.slice(0, 6);
    const resto = lista.slice(6);
    const categorias = resto.length ? [...top6, { nome: 'Demais', valor: round2(resto.reduce((s, c) => s + c.valor, 0)) }] : top6;
    const gasto = round2(lista.reduce((s, c) => s + c.valor, 0));
    const parcial = mes === MES_PARCIAL;
    const mm = mes.slice(5, 7);
    const [ano, mesNum] = mes.split('-').map(Number);
    const diaFim = parcial ? String(DIA_FIM_PARCIAL).padStart(2, '0') : String(diasNoMes(ano, mesNum)).padStart(2, '0');
    return {
      mes, rotulo: ROTULOS[i], periodo: `01/${mm} a ${diaFim}/${mm}`, parcial,
      renda: round2(info.renda), gasto, fatura_cartao: round2(info.faturaCartao), categorias,
    };
  });

  const contas = CONTAS_DE[id];
  const reembolsos = id === 'ana'
    ? {
      pendente: 120,
      itens: [
        { data: '2026-02-10', descricao: 'Consulta', valor: 80, atrasado: true },
        { data: '2026-03-05', descricao: 'Farmácia', valor: 40, atrasado: false },
      ],
    }
    : null;

  return {
    versao: 1,
    pessoa: { id, nome: NOMES[id] },
    gerado_em: geradoEm || new Date(Date.now() - 3600e3).toISOString(),
    dados_ate: '2026-03-14',
    saldo: {
      total: round2(contas.reduce((s, c) => s + c.saldo, 0)),
      contas: contas.map((c) => ({ nome: c.nome, conectada: c.conectada, saldo: c.saldo })),
    },
    meses,
    reembolsos,
    avisos: [],
    pdf: `${id}.pdf`,
  };
}

/**
 * Planta `<id>.json` (resumo), `<id>.lancamentos.json` (envelope v1), `<id>.pdf` e `<id>.xlsx`
 * (bytes falsos) em `dir`, para cada `pessoas`. Devolve `{ resumos, lancamentos }` por id.
 */
function plantarMundo(dir, { pessoas = ['ana', 'bia'], geradoEm } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const resumos = {};
  const lancamentos = {};
  for (const id of pessoas) {
    const lancs = lancamentosDe(id);
    const resumo = resumoDe(id, lancs, { geradoEm });
    resumos[id] = resumo;
    lancamentos[id] = lancs;
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(resumo));
    fs.writeFileSync(path.join(dir, `${id}.lancamentos.json`), JSON.stringify({
      versao: 1,
      pessoa: { id, nome: resumo.pessoa.nome },
      gerado_em: resumo.gerado_em,
      lancamentos: lancs,
    }));
    fs.writeFileSync(path.join(dir, `${id}.pdf`), `%PDF-1.4 falso ${id}`);
    fs.writeFileSync(path.join(dir, `${id}.xlsx`), `PK\u0003\u0004 xlsx falso ${id}`);
  }
  return { resumos, lancamentos };
}

module.exports = { lancamentosDe, resumoDe, plantarMundo, MESES, MES_PARCIAL };
