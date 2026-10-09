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

console.log(`✅ idioma: ${Object.keys(catalogo).length} traduções, parâmetros, preferências, troca e conteúdo preservado`);
