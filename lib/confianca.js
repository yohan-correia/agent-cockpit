'use strict';
// "Esta pasta é confiável para este agente?" — lida na CONFIG do CLI, nunca na tela dele.
//
// Existe porque `preSessao` (agente vivo, nenhuma sessão publicada) é definido por AUSÊNCIA e cobre mais do que o
// menu de confiança (menu de update do Codex, onboarding, Codex que só cria o rollout na 1ª mensagem). A config é o
// único sinal positivo que separa "a pasta não é confiável" do resto, sem ler a TUI (D4).
//
// Regras medidas com os binários reais (spec 2026-10-13, §2):
//  · Claude: a confiança HERDA do ancestral — `projects[<ancestral>].hasTrustDialogAccepted` vale para a subpasta.
//  · Codex: a chave é a RAIZ GIT da pasta (primeiro ancestral com `.git`); sem git, NÃO herda do pai.
//
// `estadoDaPasta(agente, cwd)` → 'confiada' | 'nao-confiada' | null (`null` = não sei: quem chama não afirma nada).
// Síncrona, nunca lança. Os caminhos de config se resolvem por chamada (o gate troca de HOME/CODEX_HOME).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// caminho → { mtimeMs, size, conteudo }: relê só quando o arquivo mudou.
const cache = new Map();

function limparCache() {
  cache.clear();
}

/** Conteúdo do arquivo (com cache por mtime+size). Lança o erro do fs, quem chama decide. */
function lerComCache(caminho) {
  const st = fs.statSync(caminho);
  const guardado = cache.get(caminho);
  if (guardado && guardado.mtimeMs === st.mtimeMs && guardado.size === st.size) return guardado.conteudo;
  const conteudo = fs.readFileSync(caminho, 'utf8');
  cache.set(caminho, { mtimeMs: st.mtimeMs, size: st.size, conteudo });
  return conteudo;
}

function estadoClaude(cwd) {
  let config;
  try {
    config = JSON.parse(lerComCache(path.join(os.homedir(), '.claude.json')));
  } catch {
    return null;                                     // sem arquivo, ilegível ou JSON inválido
  }
  const projetos = config && typeof config.projects === 'object' && config.projects ? config.projects : null;
  if (!projetos) return null;
  // Mesma trava 1 de `confiarNaPasta`: a chave precisa existir em ALGUM projeto para provar o formato.
  const formatoConhecido = Object.values(projetos)
    .some((p) => p && typeof p === 'object' && 'hasTrustDialogAccepted' in p);
  if (!formatoConhecido) return null;
  let atual = cwd;
  for (;;) {
    const p = projetos[atual];
    if (p && typeof p === 'object' && p.hasTrustDialogAccepted === true) return 'confiada';
    const pai = path.dirname(atual);
    if (pai === atual) break;
    atual = pai;
  }
  return 'nao-confiada';
}

/** Primeiro ancestral (inclusive o próprio `cwd`) com `.git` — arquivo ou pasta. */
function raizGit(cwd) {
  let atual = cwd;
  for (;;) {
    if (fs.existsSync(path.join(atual, '.git'))) return atual;
    const pai = path.dirname(atual);
    if (pai === atual) return null;
    atual = pai;
  }
}

function estadoCodex(cwd) {
  const caminho = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  let texto;
  try {
    texto = lerComCache(caminho);
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'nao-confiada' : null;   // o Codex pergunta quando não há config
  }
  const raiz = raizGit(cwd);
  const candidatas = raiz && raiz !== cwd ? [cwd, raiz] : [cwd];

  // Parser mínimo, linha a linha: `[projects."<caminho>"]` abre a tabela; qualquer outro `[` fecha.
  const valores = new Map();
  let aberta = null;
  for (const linha of texto.split('\n')) {
    const cab = /^\s*\[projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\]\s*(#.*)?$/.exec(linha);
    if (cab) {
      aberta = cab[1] !== undefined ? cab[1].replace(/\\(.)/g, '$1') : cab[2];
      continue;
    }
    if (/^\s*\[/.test(linha)) { aberta = null; continue; }
    if (aberta === null) continue;
    const tl = /^\s*trust_level\s*=\s*"([^"]*)"/.exec(linha);
    if (tl) valores.set(aberta, tl[1]);
  }

  if (candidatas.some((c) => valores.get(c) === 'trusted')) return 'confiada';
  if (candidatas.some((c) => valores.has(c))) return null;     // valor explícito que não é "trusted"
  // Formato que eu não li (ex.: tabela inline `projects = { … }`) não vira afirmação.
  if (candidatas.some((c) => texto.includes(`"${c}"`) || texto.includes(`'${c}'`))) return null;
  return 'nao-confiada';
}

function estadoDaPasta(agente, cwd) {
  try {
    if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return null;
    if (agente === 'claude') return estadoClaude(cwd);
    if (agente === 'codex') return estadoCodex(cwd);
    return null;
  } catch {
    return null;
  }
}

module.exports = { estadoDaPasta, limparCache };
