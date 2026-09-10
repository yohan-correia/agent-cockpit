# TUI real, CODEX_HOME/cwd/socket isolados e provider HTTP local. Zero tokens reais.
# Evidências ficam na pasta /tmp/cockpit-clear-integrado-* impressa ao final.
import os, json, time, tempfile, threading, subprocess, shlex, shutil
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
repo=Path(__file__).resolve().parents[1]
root=Path(tempfile.mkdtemp(prefix='cockpit-clear-integrado-')); home=root/'home';cwd=root/'cwd';home.mkdir();cwd.mkdir();calls=[]
class H(BaseHTTPRequestHandler):
 def log_message(self,*a): pass
 def do_POST(self):
  body=self.rfile.read(int(self.headers.get('Content-Length','0')));calls.append(self.path);(root/('request-'+str(len(calls))+'.json')).write_bytes(body)
  item={'id':'msg_fixture','type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':'OK','annotations':[]}]}
  resp={'id':'resp_fixture','object':'response','created_at':int(time.time()),'status':'completed','model':'mock','output':[item],'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}
  events=[{'type':'response.created','response':{**resp,'status':'in_progress','output':[]}}, {'type':'response.output_item.added','output_index':0,'item':{**item,'status':'in_progress','content':[]}}, {'type':'response.output_text.delta','item_id':'msg_fixture','output_index':0,'content_index':0,'delta':'OK'}, {'type':'response.output_text.done','item_id':'msg_fixture','output_index':0,'content_index':0,'text':'OK'}, {'type':'response.output_item.done','output_index':0,'item':item},{'type':'response.completed','response':resp}]
  data=''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events).encode()
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
srv=ThreadingHTTPServer(('127.0.0.1',0),H);threading.Thread(target=srv.serve_forever,daemon=True).start()
(home/'config.toml').write_text(f'model="mock"\nmodel_provider="mock"\n[projects."{cwd}"]\ntrust_level="trusted"\n[model_providers.mock]\nname="Fixture local"\nbase_url="http://127.0.0.1:{srv.server_port}/v1"\nenv_key="COCKPIT_TEST_API_KEY"\nwire_api="responses"\n')
sock='cockpit-status-integrado-'+str(os.getpid());base=['tmux','-L',sock,'-f','/dev/null']
def tm(*a):return subprocess.check_output(base+list(a),text=True)
try:
 codex_bin=os.environ.get('COCKPIT_BIN_CODEX') or shutil.which('codex')
 assert codex_bin, 'instale Codex CLI ou defina COCKPIT_BIN_CODEX'
 cmd='env CODEX_HOME='+shlex.quote(str(home))+' COCKPIT_TEST_API_KEY=fixture-only '+shlex.quote(codex_bin)+' --no-alt-screen --dangerously-bypass-approvals-and-sandbox'
 pane=tm('new-session','-d','-P','-F','#{pane_id}','-s','fixture','-x','120','-y','45','-c',str(cwd),cmd).strip();time.sleep(2)
 tm('send-keys','-t',pane,'-l','--','Responda OK');time.sleep(.2);tm('send-keys','-t',pane,'Enter')
 for i in range(50):
  files=list((home/'sessions').rglob('*.jsonl')) if (home/'sessions').exists() else []
  if any('task_complete' in f.read_text() for f in files):break
  time.sleep(.2)
 env={**os.environ,'CODEX_HOME':str(home),'COCKPIT_CODEX_RAIZ':str(home/'sessions'),'COCKPIT_TMUX_SOCKET':sock,'COCKPIT_TMUX_SESSAO':'fixture','COCKPIT_STATUS_CODEX_DIR':str(root/'snapshots'),'COCKPIT_CLEAR_CODEX_DIR':str(root/'clears')}
 time.sleep(2)
 before=len(calls)
 js="""const assert=require('node:assert/strict');const a=require('./lib/abas');
 (async()=>{const x=(await a.listar()).find(x=>x.agente==='codex');assert.ok(x?.sessaoId);
 console.log('antes',x.sessaoId);const r=await a.enviar(x.chave,'/clear',[],'clear-fixture');
 assert.equal(a.pendentesDe(x.chave).length,0,'/clear não é mensagem pendente');
 const y=await a.buscar(x.chave);assert.equal(y.arquivo,null,'histórico antigo deve sair antes de nova mensagem');
 assert.equal(y.sessaoId,null);assert.equal(y.reiniciada,true);
 assert.equal(y.preSessao,false,'reset confirmado não é prompt inicial');console.log('clear confirmado, sem histórico nem fila');
 })().catch(e=>{console.error(e);process.exitCode=1})"""
 p=subprocess.run(['node','-e',js],cwd=repo,env=env,text=True,capture_output=True,timeout=30)
 (root/'resultado.log').write_text(p.stdout+p.stderr)
 (root/'tela.txt').write_text(tm('capture-pane','-e','-p','-J','-S','-200','-t',pane))
 print(p.stdout,p.stderr,flush=True)
 assert p.returncode==0, 'regressão do clear'
 assert len(calls)==before, f'clear não deve chamar o provider: antes={before}, depois={len(calls)}, raiz={root}'
 js="""const assert=require('node:assert/strict');const a=require('./lib/abas');
 (async()=>{const x=(await a.listar()).find(x=>x.agente==='codex');assert.equal(x.arquivo,null);assert.equal(x.reiniciada,true);
 assert.equal(x.preSessao,false,'reset persistido continua liberando o composer');
 console.log('processo Node novo: reset persiste');await a.enviar(x.chave,'Responda OK novamente',[],'prompt-fixture');
 assert.equal(a.pendentesDe(x.chave).length,1,'mensagem normal continua pendente até eco');
 })().catch(e=>{console.error(e);process.exitCode=1})"""
 p=subprocess.run(['node','-e',js],cwd=repo,env=env,text=True,capture_output=True,timeout=30)
 print(p.stdout,p.stderr,flush=True);assert p.returncode==0
 time.sleep(3)
 js="""const assert=require('node:assert/strict');const a=require('./lib/abas');
 (async()=>{const x=(await a.listar()).find(x=>x.agente==='codex');assert.ok(x.arquivo);assert.ok(x.sessaoId);assert.ok(!x.reiniciada);
 const r=await require('./lib/adaptador-codex').lerConversa(x.arquivo,0);
 assert.ok(r.eventos.some(e=>e.tipo==='humano' && e.texto.includes('novamente')));
 assert.ok(!r.eventos.some(e=>e.tipo==='humano' && e.texto==='Responda OK'));
 console.log('nova conversa aparece sem herdar a anterior');
 await a.enviar(x.chave,'/clear',[],'clear-fixture');
 assert.equal((await a.buscar(x.chave)).sessaoId,x.sessaoId,'retry do mesmo ID não limpa conversa seguinte');
 await a.enviar(x.chave,'/new',[],'new-fixture');
 assert.equal((await a.buscar(x.chave)).arquivo,null);
 assert.equal(a.pendentesDe(x.chave).length,0);
 console.log('/new também confirma reset sem pendente; retry de clear não afeta a conversa seguinte');
 })().catch(e=>{console.error(e);process.exitCode=1})"""
 p=subprocess.run(['node','-e',js],cwd=repo,env=env,text=True,capture_output=True,timeout=30)
 print(p.stdout,p.stderr,flush=True);assert p.returncode==0
 # /new também deixa o CLI sem rollout. Texto longo precisa chegar inteiro, sem
 # um Enter manual posterior para liberar os blocos de colagem da TUI.
 longo='Responda OK novamente.\n' + 'Texto de teste do envio após clear. '.join(str(i) for i in range(180))
 js="""const assert=require('node:assert/strict');const a=require('./lib/abas');
 (async()=>{const x=(await a.listar()).find(x=>x.agente==='codex');assert.equal(x.arquivo,null);
 const texto=__TEXTO__;await a.enviar(x.chave,texto,[],'longo-fixture');
 const prazo=Date.now()+10000;
 while(Date.now()<prazo){const y=await a.buscar(x.chave);
 if(y.arquivo){const r=await require('./lib/adaptador-codex').lerConversa(y.arquivo,0);
 const humano=r.eventos.find(e=>e.tipo==='humano');
 if(humano){assert.equal(humano.texto,texto,'texto longo chega inteiro e uma única vez');
 assert.equal(r.eventos.filter(e=>e.tipo==='humano').length,1);
 assert.equal(a.consumirPendente(x.chave,humano.texto,humano.quando)?.id,'longo-fixture');
 assert.equal(a.pendentesDe(x.chave).length,0);console.log('mensagem longa após reset chegou inteira, sem fila e sem Enter manual');return;}}
 await new Promise(r=>setTimeout(r,150));}
 assert.fail('mensagem longa após reset não chegou ao rollout');
 })().catch(e=>{console.error(e);process.exitCode=1})""".replace('__TEXTO__',json.dumps(longo))
 p=subprocess.run(['node','-e',js],cwd=repo,env=env,text=True,capture_output=True,timeout=30)
 (root/'envio-longo.log').write_text(p.stdout+p.stderr)
 (root/'tela-envio-longo.txt').write_text(tm('capture-pane','-e','-p','-J','-S','-200','-t',pane))
 print(p.stdout,p.stderr,flush=True)
 print(json.dumps({'raiz':str(root),'requests_antes':before,'requests_depois':len(calls)}),flush=True)
 assert p.returncode==0, 'regressão do envio longo após reset'

finally:
 subprocess.run(base+['kill-session','-t','fixture'],capture_output=True);srv.shutdown()
