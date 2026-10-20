#!/usr/bin/env node
'use strict';
// Offline: catálogo, troca reversível, storage indisponível e isolamento de conteúdo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function carregar(salvo, language = 'pt-BR', bloquear = false) {
  const dados = new Map(salvo ? [['cockpit-idioma', salvo]] : []);
  const ctx = vm.createContext({ navigator: { language }, document: { documentElement: {} },
    localStorage: { getItem: k => { if (bloquear) throw Error('blocked'); return dados.get(k); },
      setItem: (k,v) => { if (bloquear) throw Error('blocked'); dados.set(k,v); } } });
  for (const arquivo of ['traducoes.js', 'i18n.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', arquivo), 'utf8'), ctx);
  return { ui: ctx.cockpitI18n, catalogo: ctx.cockpitTraducoes, dados, ctx };
}
const { ui, catalogo, dados } = carregar();
for (const [pt,en] of Object.entries(catalogo)) {
  assert.equal(typeof en, 'string');
  const params = s => [...s.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort().join(',');
  assert.equal(params(pt), params(en), `parâmetros: ${pt}`);
}
assert.equal(carregar(undefined,'en-US').ui.idioma,'en');
assert.equal(carregar('pt-BR','en-US').ui.idioma,'pt-BR');
assert.equal(carregar('invalido','pt-BR').ui.idioma,'pt-BR');
const label = { textContent: '' };
ui.bind(label,'textContent',()=>ui.t('Configuração'));
const original = { textContent: 'Configuração <script>teste</script> {0}' };
ui.definir('en');
assert.equal(label.textContent,'Settings');
assert.equal(original.textContent,'Configuração <script>teste</script> {0}');
assert.equal(dados.get('cockpit-idioma'),'en');
const literal = '<img src=x onerror=alert(1)> {0}';
assert.equal(ui.t(['Copiar caminho ', ''],literal),`Copy path ${literal}`);
assert.equal(ui.t(ui.t(['Copiar caminho ', ''],literal)),`Copy path ${literal}`);
assert.equal(ui.t('copy'), 'copy');
ui.definir('pt-BR');
assert.equal(label.textContent,'Configuração');
assert.equal(ui.t('Copy path /tmp/example.txt'), 'Copiar caminho /tmp/example.txt');
ui.bind(label,'textContent',()=> '');
label.textContent='conteúdo de outro dono';
ui.definir('en');
assert.equal(label.textContent,'conteúdo de outro dono');
assert.equal(ui.definir('fr'),false);
assert.equal(ui.idioma,'en');
const privado = carregar(undefined,'pt-BR',true).ui;
privado.definir('en');assert.equal(privado.t('Fechar'),'Close');

// card `tela-de-uso-no-fuso-do-aparelho`: o template de rotuloPeriodo (public/uso.js) traduz —
// sem este assert, a chave que diverge por um caractere cai calada no português
// (public/i18n.js:53) e o smoke, fixado em pt-BR, não vê.
const emIngles = carregar('en').ui;
assert.equal(emIngles.t`Hoje · ${'04/09'} (${'UTC-3'})`, 'Today · 04/09 (UTC-3)');
assert.equal(Object.hasOwn(catalogo, 'Hoje · {0} (UTC)'), false, 'a chave velha, com (UTC) cravado, não existe mais no catálogo');

// card `foto-some-entre-upload-e-envio`: as três frases do Enviar com anexo, pelo MESMO caminho do
// app.js (`tr` de template com `{0}` e `tr('...')` sem parâmetro).
assert.equal(emIngles.t`Esperando ${2} anexo(s) subir — a mensagem sai sozinha.`, 'Waiting for 2 attachment(s) to upload — the message will send on its own.');
assert.equal(emIngles.t('Escreva uma mensagem para ir junto do anexo.'), 'Write a message to go with the attachment.');
assert.equal(emIngles.t('Um anexo não subiu. Toque no × dele e anexe de novo — nada foi enviado.'), 'An attachment did not upload. Tap its × and attach it again — nothing was sent.');

// card `trabalhando-nao-distingue-subagente`: as 6 frases novas, pelo MESMO caminho de template
// do app.js (`tr` com `{0}`) — em pt a chave errada passa calada (public/i18n.js:53), e sem
// este assert o gate não prova que o catálogo em inglês bate com o que o cliente monta.
assert.equal(emIngles.t`livre · ${1} agente em background`, 'free · 1 agent in background');
assert.equal(emIngles.t`livre · ${3} agentes em background`, 'free · 3 agents in background');
assert.equal(emIngles.t`te esperando · ${1} agente em background`, 'waiting for you · 1 agent in background');
assert.equal(emIngles.t`te esperando · ${3} agentes em background`, 'waiting for you · 3 agents in background');
assert.equal(emIngles.t`Esta aba tem ${1} agente em background. Fechar mata ele junto.`, 'This tab has 1 agent in background. Closing it kills it too.');
assert.equal(emIngles.t`Esta aba tem ${3} agentes em background. Fechar mata eles junto.`, 'This tab has 3 agents in background. Closing it kills them too.');

// card `subagente-cartao-legivel` (D93): as 3 frases do cartão do sub-agente, pelo mesmo `tr('…')` do app.js.
assert.equal(emIngles.t('pedido'), 'request');
assert.equal(emIngles.t('em background'), 'in background');
assert.equal(emIngles.t('mostrar o pedido inteiro'), 'show the whole request');

// card `pra-revisar-v2-regra-main-retomada-branch-sumida`: as 8 chaves novas da tela Pra revisar v2
// existem no catálogo (a chave que diverge por um caractere cai calada no português), e as duas
// órfãs da v1 continuam lá, sinalizadas, não apagadas.
for (const chave of [
  'sem develop nem main',
  'branch sumiu',
  'retomada',
  '{0} jobs terminaram e ainda não entraram na develop (ou main) do repo deles.',
  'Em Atenção: {0} com a branch sumida.',
  'Nenhum job esperando revisão.',
  'retomou: {0}',
  'inclui: {0}',
]) assert.equal(Object.hasOwn(catalogo, chave), true, `chave nova ausente do catálogo: ${chave}`);
for (const velha of ['sem develop', '{0} jobs terminaram e ainda não entraram na develop do repo deles.']) {
  assert.equal(Object.hasOwn(catalogo, velha), true, `órfã sinalizada, não apagada: ${velha}`);
}

// card `criar-pasta-na-aba-nova`: as 5 chaves novas existem no catálogo, e o item sai pelo MESMO caminho de
// template do app.js (`tr` com `{0}`).
for (const chave of [
  '+ Criar pasta {0}',
  'nome de pasta inválido: use letras, números, - e _ (até 64)',
  'já existe uma pasta com esse nome',
  'a pasta de projetos não existe no servidor',
  'não deu para criar a pasta',
]) assert.equal(Object.hasOwn(catalogo, chave), true, `chave nova ausente do catálogo: ${chave}`);
assert.equal(emIngles.t`+ Criar pasta ${'ap'}`, '+ Create folder ap');

// card `pra-revisar-aviso-de-conflito-no-merge`: as chaves novas da prévia do merge existem no catálogo
// (a que diverge por um caractere cai calada no português, public/i18n.js:53).
for (const chave of [
  'merge limpo', 'conflito em 1 arquivo', 'conflito em {0} arquivos', 'conflito só no roadmap.json',
  'merge: não sei', 'Merge na {0}', 'Nenhum arquivo em conflito.', '{0} arquivo(s) em conflito:',
  'e mais {0}', 'Só o roadmap.json conflita.',
  'Não deu para saber agora (erro ou tempo do git). Isso não quer dizer limpo.',
]) assert.equal(Object.hasOwn(catalogo, chave), true, `chave nova ausente do catálogo: ${chave}`);
assert.equal(emIngles.t('conflito em {0} arquivos', 3), 'conflict in 3 files');

// card `revisar-nao-chama-de-pronto-job-entregue-ou-parado`: as 3 chaves novas existem no catálogo
// (a que diverge por um caractere cai calada no português, public/i18n.js:53).
for (const chave of ['pede decisão', 'relatório ilegível', 'Pede decisão'])
  assert.equal(Object.hasOwn(catalogo, chave), true, `chave nova ausente do catálogo: ${chave}`);
assert.equal(emIngles.t('Pede decisão'), 'Needs a decision');

// card `responder-confianca-do-cli-pelo-celular`: as chaves do aviso de confiança existem no catálogo, e a frase do
// servidor com o rótulo do agente resolve pelo mesmo caminho de `{0}` que o cliente usa para `erro.message`.
for (const chave of [
  'Esta pasta ainda não é confiável para o agente. Quando ele perguntar, "Yes" faz ele confiar nela de vez: as próximas abas aqui abrem sem essa pergunta. "No" fecha o agente.',
  'Esta pasta ainda não é confiável para o agente, e ele ainda não abriu conversa. ',
  'O Codex vai perguntar se você confia nesta pasta. Responda pelas setas na aba: "Yes" confia nela de vez, "No" fecha o agente.',
  'esta pasta ainda não é confiável para o {0}; responda pelas setas o que ele está perguntando antes de escrever',
  'esta pasta ainda não é confiável para o {0} — ele pergunta antes de abrir a conversa',
]) assert.equal(Object.hasOwn(catalogo, chave), true, `chave nova ausente do catálogo: ${chave}`);
assert.equal(
  emIngles.t('esta pasta ainda não é confiável para o Codex CLI; responda pelas setas o que ele está perguntando antes de escrever'),
  'this folder is not trusted by Codex CLI yet; answer what it is asking with the arrows before writing',
);

// card `grafo-do-projeto-no-cockpit`: as chaves novas do index.html e de grafo.js existem no
// catálogo (a que diverge por um caractere cai calada no português, public/i18n.js:53).
for (const chave of [
  'Grafos', 'Grafos dos projetos', 'O grafo mostrado é sempre o da develop de cada projeto.',
  'grafo da develop de {0}', 'em dia', '{0} commit atrás da develop', '{0} commits atrás da develop',
  'fora da história da develop', 'estado desconhecido', 'sem grafo ainda', 'Grafo',
  'Nenhum projeto com git encontrado.',
  // card `grafo-botao-fazer-grafo`: botão "Fazer grafo" e as mensagens do servidor (`MENSAGENS` de lib/grafo-fazer.js).
  'Fazer grafo', 'gerando…', 'não consegui falar com o servidor',
  'nome de projeto inválido', 'projeto não encontrado', 'não é repositório git',
  'a pasta não é a raiz de um repositório', 'outro processo está gerando este grafo — tente de novo',
  'a geração demorou demais', 'não consegui gerar o grafo (detalhe no log do grafo)',
  'hook parcial: um hook do repositório ficou intocado', 'hook não instalado: o repositório usa core.hooksPath',
  'hook não instalado (detalhe no log do grafo)',
]) assert.equal(Object.hasOwn(catalogo, chave), true, `chave nova ausente do catálogo: ${chave}`);
assert.equal(emIngles.t('{0} commit atrás da develop', 1), '1 commit behind develop');
assert.equal(emIngles.t('{0} commits atrás da develop', 3), '3 commits behind develop');
// "sem develop" é órfã desde a v2 do Pra revisar (linha 487) e volta a ser usada por grafo.js —
// mesma chave, mesmo valor, nenhuma duplicata.
assert.equal(Object.hasOwn(catalogo, 'sem develop'), true, 'sem develop (reaproveitada) continua no catálogo');

// Varredura do FONTE de public/grafo.js: todo literal passado a `tr('…')`/`tr("…")`/`` tr`…` ``
// (tira comentários antes; no template, `${…}` vira `{0}`, `{1}`… na ordem) tem par no catálogo —
// gate-idioma.js:17-21 só confere o que JÁ está no catálogo, nunca o que o cliente pede e não existe.
{
  const fonteGrafo = fs.readFileSync(path.join(__dirname, '..', 'public', 'grafo.js'), 'utf8')
    .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const chavesUsadas = new Set();
  for (const m of fonteGrafo.matchAll(/\btr\(\s*(['"])((?:(?!\1).)*)\1/g)) chavesUsadas.add(m[2]);
  for (const m of fonteGrafo.matchAll(/\btr`((?:[^`\\]|\\.)*)`/g)) {
    let i = 0;
    chavesUsadas.add(m[1].replace(/\$\{[^}]*\}/g, () => `{${i++}}`));
  }
  assert.ok(chavesUsadas.size > 0, 'a varredura achou pelo menos uma chamada a tr(...) em grafo.js');
  for (const chave of chavesUsadas) assert.equal(Object.hasOwn(catalogo, chave), true, `grafo.js usa tr(...) com chave fora do catálogo: ${chave}`);
}

// card `grafo-mapa-foco` (D94, sobre o D91): varredura de `tr(...)` em `public/grafo-mapa.js`
// (molde EXATO da varredura de `grafo.js` acima) + cada chave de `CHAVES_DE_EXPLICACAO` existe no
// catálogo — `explicarCamada` devolve uma chave VARIÁVEL, que a varredura de `tr('…')` não vê
// (a que diverge por um caractere cai calada no português, `public/i18n.js:53`).
{
  const fonteMapa = fs.readFileSync(path.join(__dirname, '..', 'public', 'grafo-mapa.js'), 'utf8')
    .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const chavesUsadas = new Set();
  for (const m of fonteMapa.matchAll(/\btr\(\s*(['"])((?:(?!\1).)*)\1/g)) chavesUsadas.add(m[2]);
  for (const m of fonteMapa.matchAll(/\btr`((?:[^`\\]|\\.)*)`/g)) {
    let i = 0;
    chavesUsadas.add(m[1].replace(/\$\{[^}]*\}/g, () => `{${i++}}`));
  }
  assert.ok(chavesUsadas.size > 0, 'a varredura achou pelo menos uma chamada a tr(...) em grafo-mapa.js');
  for (const chave of chavesUsadas) assert.equal(Object.hasOwn(catalogo, chave), true, `grafo-mapa.js usa tr(...) com chave fora do catálogo: ${chave}`);
}
{
  // Molde de `testes/gate-grafo-mapa.js` (`carregarMapa`): carrega os três arquivos reais num `vm`.
  const sandbox = { document: { getElementById: () => null }, localStorage: { getItem: () => null, setItem: () => {} }, URLSearchParams, console };
  const contexto = vm.createContext(sandbox);
  for (const arquivo of ['traducoes.js', 'i18n.js', 'grafo-mapa.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', arquivo), 'utf8'), contexto, { filename: arquivo });
  }
  const chavesDeExplicacao = contexto.cockpitMapa.CHAVES_DE_EXPLICACAO;
  assert.ok(Array.isArray(chavesDeExplicacao) && chavesDeExplicacao.length > 0, 'CHAVES_DE_EXPLICACAO não está vazia');
  for (const chave of chavesDeExplicacao) assert.equal(Object.hasOwn(catalogo, chave), true, `explicarCamada pode devolver uma chave fora do catálogo: ${chave}`);
}
assert.equal(emIngles.t`Visão completa (${'7,7 MB'})`, 'Full view (7,7 MB)');
assert.equal(emIngles.t`mostrar todos (${471})`, 'show all (471)');
assert.equal(emIngles.t`mostrando ${60} de ${471}`, 'showing 60 of 471');
assert.equal(emIngles.t('arquivos da pasta {0}', 'src'), 'files in the src folder');
assert.equal(emIngles.t('+{0} mais', 3), '+3 more');

// Mesma varredura (molde acima) do fonte de public/financas.js e public/financas-entrada.js
// (card pagina-financas, D92) — a página substitui o diálogo D90.
{
  const chavesUsadas = new Set();
  for (const arquivo of ['financas.js', 'financas-entrada.js']) {
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'public', arquivo), 'utf8')
      .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of fonte.matchAll(/\btr\(\s*(['"])((?:(?!\1).)*)\1/g)) chavesUsadas.add(m[2]);
    for (const m of fonte.matchAll(/\btr`((?:[^`\\]|\\.)*)`/g)) {
      let i = 0;
      chavesUsadas.add(m[1].replace(/\$\{[^}]*\}/g, () => `{${i++}}`));
    }
  }
  assert.ok(chavesUsadas.size > 0, 'a varredura achou pelo menos uma chamada a tr(...) em financas.js/financas-entrada.js');
  for (const chave of chavesUsadas) assert.equal(Object.hasOwn(catalogo, chave), true, `financas.js/financas-entrada.js usa tr(...) com chave fora do catálogo: ${chave}`);
}

// Mesma varredura (molde acima) do fonte de public/diff.js e public/diff-entrada.js (card
// ver-a-diff-do-codigo, D95) — `diff-entrada.js` não chama `tr(...)` (molde `financas-entrada.js`:
// nenhum texto ali), mas entra na lista pelo MESMO motivo que `financas-entrada.js` entra.
{
  const chavesUsadas = new Set();
  for (const arquivo of ['diff.js', 'diff-entrada.js']) {
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'public', arquivo), 'utf8')
      .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of fonte.matchAll(/\btr\(\s*(['"])((?:(?!\1).)*)\1/g)) chavesUsadas.add(m[2]);
    for (const m of fonte.matchAll(/\btr`((?:[^`\\]|\\.)*)`/g)) {
      let i = 0;
      chavesUsadas.add(m[1].replace(/\$\{[^}]*\}/g, () => `{${i++}}`));
    }
  }
  assert.ok(chavesUsadas.size > 0, 'a varredura achou pelo menos uma chamada a tr(...) em diff.js/diff-entrada.js');
  for (const chave of chavesUsadas) assert.equal(Object.hasOwn(catalogo, chave), true, `diff.js/diff-entrada.js usa tr(...) com chave fora do catálogo: ${chave}`);
}

console.log(`✅ idioma: ${Object.keys(catalogo).length} traduções, parâmetros, preferências, troca e conteúdo preservado`);
