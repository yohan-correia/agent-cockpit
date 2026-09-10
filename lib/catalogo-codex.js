'use strict';
// Consulta somente metadados locais. Não abre thread, turno ou conexão com uma TUI.
const { spawn } = require('node:child_process');
const agentes = require('./agentes');
const cache = new Map();

// Comandos nativos do Codex CLI — tabela curada, pequena e revisável, não a lista completa
// do CLI: menus como /model e /resume ficam para o card `menu-da-tui-do-codex-na-tela`. O
// Cockpit não renderiza a saída própria de /diff — por isso a descrição deixa claro que o
// resultado fica no terminal, e /compact avisa que consome um turno do modelo. Já /status
// GANHOU captura nativa (card `resposta-status-codex`, 2026-09-08): a resposta chega aqui
// dentro da conversa, num bloco próprio — não é mais "vá olhar o terminal".
// Conferidos na TUI real do codex-cli 0.153.4 em 2026-09-08:
// https://learn.chatgpt.com/docs/developer-commands?surface=cli
const COMANDOS = [
  { nome: 'clear', descricao: 'Limpa a tela do terminal e inicia uma conversa nova.' },
  { nome: 'compact', descricao: 'Usa o modelo para resumir o contexto e liberar espaço.' },
  { nome: 'diff', descricao: 'Mostra as alterações do código no terminal.' },
  { nome: 'new', descricao: 'Inicia uma conversa nova sem limpar a tela do terminal.' },
  { nome: 'status', descricao: 'Mostra o estado da sessão aqui na conversa.' },
].map((c) => ({ ...c, tipo: 'comando', origem: 'embutido', invocacao: '/' + c.nome }));

function consultar(cwd) {
  return new Promise((resolve, reject) => {
    const filho = spawn(agentes.de('codex').bin(), ['app-server', '--listen', 'stdio://'],
      { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    let acabou = false, buffer = '', bytes = 0;
    const terminar = (erro, valor) => {
      if (acabou) return;
      acabou = true;
      clearTimeout(prazo);
      filho.kill('SIGKILL');
      if (erro) reject(new Error('Não consegui consultar as skills do Codex. Tente novamente.'));
      else resolve(valor);
    };
    const prazo = setTimeout(() => terminar(true), 8000);
    const enviar = mensagem => filho.stdin.write(JSON.stringify(mensagem) + '\n');
    filho.on('error', () => terminar(true));
    filho.stdin.on('error', () => terminar(true));
    filho.on('exit', () => terminar(true));
    filho.stdout.setEncoding('utf8');
    filho.stdout.on('data', bloco => {
      bytes += Buffer.byteLength(bloco);
      if (bytes > 4 * 1024 * 1024) return terminar(true);
      buffer += bloco;
      let corte;
      while (!acabou && (corte = buffer.indexOf('\n')) >= 0) {
        const linha = buffer.slice(0, corte); buffer = buffer.slice(corte + 1);
        let resposta;
        try { resposta = JSON.parse(linha); } catch { return terminar(true); }
        if (!resposta || typeof resposta !== 'object') return terminar(true);
        if (resposta.id === 1) {
          if (resposta.error) return terminar(true);
          enviar({ method: 'initialized', params: {} });
          enviar({ id: 2, method: 'skills/list', params: { cwds: [cwd], forceReload: true } });
        } else if (resposta.id === 2) {
          const entradas = resposta.result?.data;
          const dados = Array.isArray(entradas) ? entradas.find(d => d?.cwd === cwd) : null;
          if (resposta.error || !Array.isArray(dados?.skills)) return terminar(true);
          terminar(false, dados.skills);
        }
      }
    });
    enviar({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cockpit_catalogo', version: '1' } } });
  });
}

async function listar(cwd) {
  const chave = cwd || process.cwd();
  const anterior = cache.get(chave);
  if (anterior && Date.now() - anterior.em < 60_000) return anterior.promessa;
  const promessa = consultar(chave).then(skills => {
    const vistos = new Set();
    const doCatalogo = skills.filter(s => s.enabled && typeof s.name === 'string' && /^[\w:.-]+$/.test(s.name))
      .filter(s => !vistos.has(s.name) && vistos.add(s.name))
      .map(s => ({ nome: s.name, tipo: 'skill', origem: s.scope === 'repo' ? 'projeto' : s.pluginId ? 'plugin' : 'global',
        descricao: String(s.description || '').slice(0, 240), invocacao: '$' + s.name }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
    // Comandos primeiro, alfabeticamente, depois as skills — nunca dedupe comando × skill
    // pelo nome: `clear` (skill) e `clear` (comando) coexistem como $clear e /clear.
    return [...COMANDOS, ...doCatalogo];
  }).catch(erro => { cache.delete(chave); throw erro; });
  cache.set(chave, { em: Date.now(), promessa });
  return promessa;
}
module.exports = { listar };
