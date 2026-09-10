#!/usr/bin/env node
'use strict';
// Browser smoke with synthetic HTTP/SSE fixtures. Never opens a real terminal or uses a model.
const fs=require('fs'),http=require('http'),path=require('path');
// Install puppeteer-core in your test environment, or set PUPPETEER_MODULE to its absolute path.
const puppeteer=require(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const root=path.resolve(__dirname,'..','public');
const out=process.env.SAIDA;
if (!out || !process.env.CHROME_BIN) throw Error('Defina SAIDA e CHROME_BIN para o smoke de idioma.');
fs.mkdirSync(out,{recursive:true});
const assert=require('node:assert/strict');
const raw='Enviar <script>window.injetado=1</script> — arquivo unchanged';
const tabs=[{chave:'aba-p1',titulo:'Fixture project',cwd:'/tmp/fixture',agente:'codex',sessaoId:'fixture',temAgente:true,rodando:false,preSessao:false,atualizadoEm:'2026-09-10T10:00:00Z'}];
tabs.push({...tabs[0],chave:'aba-p2',titulo:'Second fixture',sessaoId:'fixture-2'});
let posts=0;const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/api/')){
  if(req.method==='POST')posts++;
  res.setHeader('Content-Type','application/json');
  if(url.pathname==='/api/abas')return res.end(JSON.stringify({abas:tabs}));
  if(url.pathname==='/api/jobs')return res.end(JSON.stringify({habilitado:false,jobs:[],painel:null}));
  if(url.pathname==='/api/eventos'){
   res.setHeader('Content-Type','text/event-stream');res.write('retry: 999999\n\n');
   // Events supplied through the app's fixture entry below; no terminal is involved.
   return;
  }
  if(url.pathname==='/api/projetos')return res.end(JSON.stringify({projetos:[{nome:'Fixture project'}]}));
  if(url.pathname==='/api/agentes')return res.end(JSON.stringify({agentes:[{id:'codex',rotulo:'Codex'}],padrao:'codex'}));
  if(url.pathname==='/api/effort')return res.end(JSON.stringify({nivel:'high'}));
  if(url.pathname==='/api/limite')return res.end(JSON.stringify({itens:[],codex:null}));
  if(url.pathname==='/api/uso')return res.end(JSON.stringify({dias:Number(url.searchParams.get('dias')||1),desde:'2026-09-04',ate:'2026-09-10',total:{entrada:1000,saida:200,cacheEscrita:0,cacheLeitura:0},projetos:[],leitura:{arquivos:2},custo:{usd:0.02,conhecido:true},porModelo:[],porDia:[]}));
  return res.end('{}');
 }
 const file=path.join(root,url.pathname==='/'?'index.html':url.pathname);try{const data=fs.readFileSync(file);res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(data)}catch{res.statusCode=404;res.end('missing')}
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN,headless:true,args:['--no-sandbox']});
try{for(const [name,width,height] of [['mobile',390,844],['desktop',1440,960]]){
 const context=await browser.createBrowserContext();const page=await context.newPage();await page.setViewport({width,height,isMobile:width<500,hasTouch:width<500});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.evaluateOnNewDocument(()=>{localStorage.setItem('cockpit-tema','catppuccin-mocha');if (!localStorage.getItem('cockpit-idioma')) localStorage.setItem('cockpit-idioma','pt-BR')});
 await page.goto(base);await page.waitForSelector('#btn-config');await page.click('#btn-config');await new Promise(r=>setTimeout(r,200));
 await new Promise(r=>setTimeout(r,350));await page.screenshot({path:path.join(out,name+'-pt.png')});
 assert(await page.$('#sel-idioma'),'language selector is present');
 {
  await page.select('#sel-idioma','en');
  await new Promise(r=>setTimeout(r,350));await page.screenshot({path:path.join(out,name+'-en.png')});
  const state=await page.evaluate(()=>({lang:document.documentElement.lang,settings:document.querySelector('#dialogo-config h2').textContent,labels:[...document.querySelectorAll('#dialogo-config .ajuste-rotulo')].map(x=>x.textContent),values:[...document.querySelectorAll('#dialogo-config .ajuste-valor')].map(x=>x.textContent),overflow:document.documentElement.scrollWidth>innerWidth}));console.log(name,JSON.stringify(state),errors);
  assert.equal(await page.$eval('#btn-nova-aba',n=>getComputedStyle(n).display),'flex');
  assert.equal(state.lang,'en');assert.equal(state.settings,'Settings');assert((await page.$eval('#dialogo-config',n=>n.textContent)).includes('The server'));assert.equal(state.overflow,false);
  await page.select('#sel-idioma','pt-BR');
  assert.equal(await page.$eval('#dialogo-config h2',x=>x.textContent),'Configuração');
  await page.click('#btn-fechar-config');
  await page.evaluate(async ({raw,split})=>{
    await abrirAba('aba-p1');
    const p=paineis.get('aba-p1');
    aplicarNoPainel(p,{tipo:'sessao',meta:{sessaoId:'fixture',titulo:'Enviar',cwd:'/tmp/arquivo',contexto:{modelo:'fixture',usados:1500,teto:10000,pct:15}}});
    aplicarNoPainel(p,{tipo:'humano',texto:raw,quando:'2026-09-10T10:00:00Z'});
    aplicarNoPainel(p,{tipo:'texto',texto:'Mandar arquivo — original response',quando:'2026-09-10T10:00:01Z'});
    aplicarNoPainel(p,{tipo:'sincronizado',turnoEmAndamento:false});
    aplicarNoPainel(p,{tipo:'pendente',id:'fixture-pending',texto:'Minha mensagem pendente',em:'2026-09-10T10:00:02Z'});
    escreverNaCaixa(p,'Meu rascunho /clear {0}');
    p.anexos.push({nome:'Enviar.txt',caminho:'/tmp/fixture/Enviar.txt',estado:'pronto'});
    if(split){await abrirAba('aba-p2',{aoLado:true});escreverNaCaixa(paineis.get('aba-p2'),'Second draft');}
    window.__idiomaState={painel:p,fluxo,history:history.length,entrada:p.entrada,humano:p.fita.querySelector('.bolha-eu')};
  },{raw,split:width>500});
  await new Promise(r=>setTimeout(r,500));
  await page.evaluate(()=>document.getElementById('btn-config').click());
  await new Promise(r=>setTimeout(r,200));
  const beforePosts=posts;
  await page.select('#sel-idioma','en');
  const preserved=await page.evaluate((raw)=>{
    const state=window.__idiomaState,p=paineis.get('aba-p1');
    return {samePanel:state.painel===p,sameStream:state.fluxo===fluxo,sameHistory:state.history===history.length,
      secondDraft:paineis.get('aba-p2')?.entrada.value,secondButton:paineis.get('aba-p2')?.raiz.querySelector('.btn-enviar').textContent,draft:p.entrada.value,attachments:p.anexos.map(a=>a.nome),
      original:state.humano.textContent===raw,sameNode:state.humano===p.fita.querySelector('.bolha-eu'),
      title:p.titulo.textContent,agent:p.fita.querySelector('.fala')?.textContent,script:!!window.injetado,
      meterTitle:p.medidor.el.title,placeholder:p.entrada.placeholder,queued:getComputedStyle(p.fita.querySelector('.bolha-pendente'),'::before').content};
  },raw);
  assert(preserved.samePanel&&preserved.sameStream&&preserved.sameHistory&&preserved.sameNode&&preserved.original);
  if(width>500){assert.equal(preserved.secondDraft,'Second draft');assert.equal(preserved.secondButton,'Send');}
  assert.equal(preserved.draft,'Meu rascunho /clear {0}');assert.deepEqual(preserved.attachments,['Enviar.txt']);
  assert.equal(preserved.title,'Enviar');assert.equal(preserved.script,false);assert(preserved.agent.includes('Mandar arquivo — original response'));
  assert(preserved.placeholder.startsWith('Write to the agent'));assert.equal(posts,beforePosts);assert.equal(preserved.queued,'"queued"');assert(preserved.meterTitle.includes('1,500 of 10,000 tokens'));
  await page.click('#btn-fechar-config');await new Promise(r=>setTimeout(r,350));await page.screenshot({path:path.join(out,name+'-conversation-en.png')});
  await page.evaluate(()=>document.getElementById('btn-config').click());await page.click('#btn-uso');
  await page.waitForFunction(()=>document.getElementById('uso-custo').textContent.includes('Estimated cost'));
  await new Promise(r=>setTimeout(r,350));await page.screenshot({path:path.join(out,name+'-usage-en.png')});
  await page.click('#btn-fechar-uso');
  assert((await page.$eval('#nota-trust-nova-aba',n=>n.textContent)).startsWith('Opening here'));
  // Reload explicitly in the test, to verify saved preference (the selector never reloads).
  await page.reload();assert.equal(await page.evaluate(()=>document.documentElement.lang),'en');
  console.log(name,'preservation, usage and saved preference OK');

 }
 if(errors.length)throw Error(errors.join('\n'));await context.close();
 }}finally{await browser.close();server.closeAllConnections();server.close()}
})().catch(e=>{console.error(e);server.closeAllConnections();server.close();process.exitCode=1});
