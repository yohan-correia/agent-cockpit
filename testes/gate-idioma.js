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
console.log(`✅ idioma: ${Object.keys(catalogo).length} traduções, parâmetros, preferências, troca e conteúdo preservado`);
