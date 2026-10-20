#!/usr/bin/env node
'use strict';
// GATE do extrator multi-linguagem do grafo do projeto — spec `2026-10-16-grafo-do-projeto-no-cockpit`
// (Fase 1). Node puro, sem repo git: `arquivos`/`configs` são `Map`s de fixture em memória.
//
//   node testes/gate-grafo-extrator.js [js|python|montar]
//
// Três blocos (unidades 1a/1b/1c do plano): `blocoJs` (extrairJs + resolução JS/TS mínima pelo
// montarGrafo), `blocoPython` (analisarPython + resolução Python), `blocoMontar` (HTML, filtros,
// schema do understand-anything, herança, camadas). Sem argumento, roda os três — é o que o
// `npm test` chama.

const path = require('node:path');

const RAIZ_REPO = path.resolve(__dirname, '..');

let passou = 0;
let total = 0;
let vermelho = false;

function ok(condicao, mensagem) {
  total += 1;
  if (condicao) { passou += 1; console.log(`  ✅ ${mensagem}`); return true; }
  vermelho = true;
  console.log(`  ❌ ${mensagem}`);
  return false;
}
async function bloco(nome, fn) {
  console.log(`\n${nome}`);
  try { await fn(); } catch (e) {
    vermelho = true;
    console.log(`  ❌ o bloco estourou — ${e && e.stack}`);
  }
}

// ─── bloco JS/TS (unidade 1a) ───────────────────────────────────────────────

function blocoJs() {
  const { extrairJs } = require(path.join(RAIZ_REPO, 'lib', 'grafo-js.js'));
  const { montarGrafo } = require(path.join(RAIZ_REPO, 'lib', 'grafo-extrator.js'));

  const FIXTURE = new Map([
    ['src/a.mjs', [
      "import x, { b as c } from './b.mjs';",
      "import * as u from './util/index.js';",
      "import './efeito.css';",
      'export function principal() { c(); u.ajuda(); x(); }',
      'export default principal;',
      '',
    ].join('\n')],
    ['src/efeito.css', 'p { color: red; }\n'],
    ['src/b.mjs', [
      'export function b() {}',
      'export default function padrao() {}',
      '',
    ].join('\n')],
    ['src/util/index.js', 'function ajuda() {}\nmodule.exports = { ajuda };\n'],
    ['src/c.cjs', [
      "const { ajuda: h } = require('./util');",
      "const m = require('./util/index.js');",
      'function f() { h(); m.ajuda(); }',
      'module.exports = f;',
      '',
    ].join('\n')],
    ['src/d.js', [
      "// require('./nao-existe')",
      "const s = 'import x from \"./b.mjs\"';",
      'const re = /\\/\\*nao é comentário/g;',
      'const div = a / b / c;',
      'const t = `x ${ y({ z: `in ${w}` }) } k`;',
      "const dyn = () => import('./b.mjs');",
      '',
    ].join('\n')],
    ['src/e.tsx', [
      "import { b } from '@/b.mjs';",
      `export const Tela = () => <p title="a'b">don't break {b()} it's</p>;`,
      'export const Lista = ({ itens }) => (<ul>{itens.map((i) => <li key={i}>{b()}</li>)}</ul>);',
      'export class Caixa { abrir() { this.fechar(); } fechar() {} }',
      'const menor = (a, z) => a < z;',
      '',
    ].join('\n')],
    ['src/g.js', [
      "const t = '<p>don't</p>';",
      'function depois() { b(); }',
      "import { b } from './b.mjs'",
      '',
    ].join('\n')],
    ['src/f.ts', "import { b } from './b.js';\n"],
    ['src/b.ts', 'export function b() {}\n'],
  ]);
  const CONFIGS = new Map([
    ['tsconfig.json', '{ /* x */ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], }, }, }'],
  ]);

  bloco('JS1. extrairJs(a.mjs) — imports (alias, namespace, efeito-css) e exports', () => {
    const r = extrairJs('src/a.mjs', FIXTURE.get('src/a.mjs'));
    ok(r.imports.some((i) => i.especificador === './b.mjs' && i.tipo === 'padrao' && i.nomes[0].local === 'x'), 'import default x de ./b.mjs');
    ok(r.imports.some((i) => i.especificador === './b.mjs' && i.tipo === 'nomeados' && i.nomes.some((n) => n.importado === 'b' && n.local === 'c')), 'import nomeado b as c de ./b.mjs');
    ok(r.imports.some((i) => i.especificador === './util/index.js' && i.tipo === 'namespace' && i.nomes[0].local === 'u'), 'import namespace u de ./util/index.js');
    ok(r.imports.some((i) => i.especificador === './efeito.css' && i.tipo === 'efeito'), 'import de efeito ./efeito.css');
    ok(r.declaracoes.some((d) => d.nome === 'principal' && d.tipo === 'function'), 'declara function principal');
    const principal = r.declaracoes.find((d) => d.nome === 'principal');
    ok(principal.ini === 4 && principal.fim === 4, `lineRange de principal = [${principal.ini}, ${principal.fim}] (esperado [4,4])`);
    ok(r.exportados.some((e) => e.local === 'principal' && e.nome === 'principal'), 'exports principal (named)');
    ok(r.padrao === 'principal', `padrao = ${r.padrao} (esperado principal)`);
  });

  bloco('JS2. extrairJs(b.mjs) — export function + export default function', () => {
    const r = extrairJs('src/b.mjs', FIXTURE.get('src/b.mjs'));
    ok(r.declaracoes.some((d) => d.nome === 'b'), 'declara b');
    ok(r.declaracoes.some((d) => d.nome === 'padrao'), 'declara padrao');
    ok(r.exportados.some((e) => e.local === 'b' && e.nome === 'b'), 'exports b');
    ok(r.exportados.some((e) => e.local === 'padrao' && e.nome === 'default'), 'exports padrao como default');
    ok(r.padrao === 'padrao', `padrao = ${r.padrao} (esperado padrao)`);
  });

  bloco('JS3. extrairJs(util/index.js) — CommonJS module.exports = { ajuda }', () => {
    const r = extrairJs('src/util/index.js', FIXTURE.get('src/util/index.js'));
    ok(r.declaracoes.some((d) => d.nome === 'ajuda'), 'declara ajuda');
    ok(r.exportados.some((e) => e.local === 'ajuda' && e.nome === 'ajuda'), 'exports ajuda');
  });

  bloco('JS4. extrairJs(c.cjs) — require namespace/nomeado e module.exports = f', () => {
    const r = extrairJs('src/c.cjs', FIXTURE.get('src/c.cjs'));
    ok(r.imports.some((i) => i.especificador === './util' && i.tipo === 'nomeados' && i.nomes.some((n) => n.importado === 'ajuda' && n.local === 'h')), 'require nomeado ajuda as h de ./util');
    ok(r.imports.some((i) => i.especificador === './util/index.js' && i.tipo === 'namespace' && i.nomes[0].local === 'm'), 'require namespace m de ./util/index.js');
    ok(r.declaracoes.some((d) => d.nome === 'f'), 'declara f');
    ok(r.exportados.some((e) => e.local === 'f'), 'exports f (module.exports = f)');
    ok(r.chamadas.filter((c) => c.nome === 'h').length === 1, 'uma chamada a h()');
    ok(r.chamadas.filter((c) => c.objeto === 'm' && c.nome === 'ajuda').length === 1, 'uma chamada a m.ajuda()');
  });

  bloco('JS5. extrairJs(d.js) — comentário, string, regex, template aninhado, import() dinâmico', () => {
    const r = extrairJs('src/d.js', FIXTURE.get('src/d.js'));
    ok(!r.imports.some((i) => i.especificador === './nao-existe'), 'nenhum import de ./nao-existe (comentário)');
    ok(r.imports.filter((i) => i.especificador === './b.mjs').length === 1, 'exatamente um import de ./b.mjs (o import() dinâmico)');
    ok(r.imports.some((i) => i.especificador === './b.mjs' && i.tipo === 'dinamico'), 'é dinâmico');
  });

  bloco('JS6. extrairJs(e.tsx) — JSX com apóstrofo, classe/método, calls via JSX', () => {
    const r = extrairJs('src/e.tsx', FIXTURE.get('src/e.tsx'));
    ok(r.imports.some((i) => i.especificador === '@/b.mjs' && i.nomes.some((n) => n.local === 'b')), 'import nomeado b de @/b.mjs');
    ok(r.declaracoes.some((d) => d.nome === 'Tela'), 'declara Tela');
    ok(r.declaracoes.some((d) => d.nome === 'Lista'), 'declara Lista');
    ok(r.declaracoes.some((d) => d.nome === 'Caixa' && d.tipo === 'class'), 'declara class Caixa');
    ok(r.declaracoes.some((d) => d.nome === 'Caixa.abrir'), 'declara método Caixa.abrir');
    ok(r.declaracoes.some((d) => d.nome === 'menor'), 'declara menor');
    ok(r.chamadas.some((c) => c.nome === 'fechar' && c.objeto === 'this' && c.dono === 'Caixa.abrir'), 'chamada this.fechar() dentro de Caixa.abrir');
    ok(r.chamadas.some((c) => c.nome === 'b' && c.dono === 'Tela'), 'chamada b() dentro de Tela (apóstrofo do JSX não abriu string)');
    ok(r.chamadas.some((c) => c.nome === 'b' && c.dono === 'Lista'), 'chamada b() dentro de Lista');
    ok(!r.chamadas.some((c) => c.nome === 'z' || c.nome === 'menor'), 'a < z não vira chamada');
  });

  bloco('JS7. extrairJs(g.js) — JSX em .js não é tratado (limite declarado): string sem fechar termina na linha', () => {
    const r = extrairJs('src/g.js', FIXTURE.get('src/g.js'));
    ok(r.declaracoes.some((d) => d.nome === 'depois'), 'declara depois mesmo após a string crua da linha 1');
    ok(r.chamadas.some((c) => c.nome === 'b' && c.dono === 'depois'), 'chamada b() dentro de depois');
  });

  bloco('JS8. extrairJs(f.ts) — import ./b.js (convenção ESM do TS apontando para .ts)', () => {
    const r = extrairJs('src/f.ts', FIXTURE.get('src/f.ts'));
    ok(r.imports.some((i) => i.especificador === './b.js'), 'import ./b.js registrado como está escrito');
  });

  bloco('JS8b. extrairJs(shebang.js) — #!/usr/bin/env node não trava o lexer (achado real: bin/check.js do piloto cockpit-agentes)', () => {
    const texto = "#!/usr/bin/env node\nfunction depois() { b(); }\n";
    const t0 = Date.now();
    const r = extrairJs('src/shebang.js', texto);
    ok(Date.now() - t0 < 1000, `termina rápido, não trava (achei ${Date.now() - t0}ms)`);
    ok(r.declaracoes.some((d) => d.nome === 'depois'), 'declara depois (o shebang não virou um regex gigante que engoliu a linha)');
    ok(r.chamadas.some((c) => c.nome === 'b' && c.dono === 'depois'), 'chamada b() dentro de depois');
  });

  bloco('JS9. montarGrafo mínimo — imports exatos por arquivo (lista fechada)', () => {
    const { grafo } = montarGrafo({
      arquivos: FIXTURE, configs: CONFIGS, sha: 'deadbeef', ref: 'develop', nome: 'app-exemplo',
      analisadoEm: '2026-10-16T00:00:00.000Z', python: { indisponivel: true, motivo: 'não usado neste bloco' },
    });
    const importsDe = (de) => grafo.edges.filter((e) => e.type === 'imports' && e.source === `file:${de}`).map((e) => e.target);
    ok(JSON.stringify(importsDe('src/a.mjs').sort()) === JSON.stringify(['file:src/b.mjs', 'file:src/efeito.css', 'file:src/util/index.js'].sort()), `imports de a.mjs: ${importsDe('src/a.mjs')}`);
    ok(JSON.stringify(importsDe('src/d.js')) === JSON.stringify(['file:src/b.mjs']), `imports de d.js: ${importsDe('src/d.js')} (só o import() dinâmico)`);
    ok(JSON.stringify(importsDe('src/e.tsx')) === JSON.stringify(['file:src/b.mjs']), `imports de e.tsx: ${importsDe('src/e.tsx')} (via tsconfig paths @/*)`);
    ok(JSON.stringify(importsDe('src/f.ts')) === JSON.stringify(['file:src/b.ts']), `imports de f.ts: ${importsDe('src/f.ts')} (.js aponta para .ts)`);
    ok(JSON.stringify(importsDe('src/g.js')) === JSON.stringify(['file:src/b.mjs']), `imports de g.js: ${importsDe('src/g.js')}`);
    ok(JSON.stringify(importsDe('src/c.cjs').sort()) === JSON.stringify(['file:src/util/index.js'].sort()) || JSON.stringify(importsDe('src/c.cjs').sort()) === JSON.stringify(['file:src/util/index.js']), `imports de c.cjs: ${importsDe('src/c.cjs')} (./util e ./util/index.js resolvem para o mesmo arquivo)`);
  });

  bloco('JS10. montarGrafo mínimo — calls resolvidas entre arquivos (alias, namespace, default, this.m)', () => {
    const { grafo } = montarGrafo({
      arquivos: FIXTURE, configs: CONFIGS, sha: 'deadbeef', ref: 'develop', nome: 'app-exemplo',
      analisadoEm: '2026-10-16T00:00:00.000Z', python: { indisponivel: true, motivo: 'não usado neste bloco' },
    });
    const calls = grafo.edges.filter((e) => e.type === 'calls');
    const tem = (source, target) => calls.some((e) => e.source === source && e.target === target);
    ok(tem('function:src/a.mjs:principal', 'function:src/b.mjs:b'), 'principal → b.mjs:b (alias c)');
    ok(tem('function:src/a.mjs:principal', 'function:src/util/index.js:ajuda'), 'principal → util/index.js:ajuda (namespace)');
    ok(tem('function:src/a.mjs:principal', 'function:src/b.mjs:padrao'), 'principal → b.mjs:padrao (default)');
    ok(calls.filter((e) => e.source === 'function:src/c.cjs:f' && e.target === 'function:src/util/index.js:ajuda').length === 1, 'c.cjs:f → util/index.js:ajuda — UMA aresta (duas chamadas no código)');
    ok(tem('function:src/e.tsx:Caixa.abrir', 'function:src/e.tsx:Caixa.fechar'), 'Caixa.abrir → Caixa.fechar (this.m)');
    ok(tem('function:src/e.tsx:Tela', 'function:src/b.mjs:b'), 'Tela → b.mjs:b');
    ok(tem('function:src/e.tsx:Lista', 'function:src/b.mjs:b'), 'Lista → b.mjs:b');
    ok(tem('function:src/g.js:depois', 'function:src/b.mjs:b'), 'depois → b.mjs:b');
  });

  bloco('JS11. montarGrafo mínimo — exports e nós de arquivo com complexity', () => {
    const { grafo } = montarGrafo({
      arquivos: FIXTURE, configs: CONFIGS, sha: 'deadbeef', ref: 'develop', nome: 'app-exemplo',
      analisadoEm: '2026-10-16T00:00:00.000Z', python: { indisponivel: true, motivo: 'não usado neste bloco' },
    });
    const exportsDe = (de) => grafo.edges.filter((e) => e.type === 'exports' && e.source === `file:${de}`).map((e) => e.target);
    ok(exportsDe('src/a.mjs').includes('function:src/a.mjs:principal'), 'exports principal');
    ok(exportsDe('src/b.mjs').includes('function:src/b.mjs:b'), 'exports b');
    ok(exportsDe('src/b.mjs').includes('function:src/b.mjs:padrao'), 'exports padrao');
    ok(exportsDe('src/util/index.js').includes('function:src/util/index.js:ajuda'), 'exports ajuda');
    const noA = grafo.nodes.find((n) => n.id === 'file:src/a.mjs');
    ok(noA && noA.complexity === 'simple', `nó file:src/a.mjs com complexity simple (achei ${noA && noA.complexity})`);
  });
}

// ─── bloco Python (unidade 1b) ──────────────────────────────────────────────

async function blocoPython() {
  const { analisarPython } = require(path.join(RAIZ_REPO, 'lib', 'grafo-python.js'));
  const { montarGrafo } = require(path.join(RAIZ_REPO, 'lib', 'grafo-extrator.js'));

  const FIXTURE = new Map([
    ['backend/agente/cofre.py', [
      "__all__ = ['ler']",
      'def ler(): pass',
      'class Cofre:',
      '    def abrir(self): self.fechar()',
      '    def fechar(self): pass',
      '',
    ].join('\n')],
    ['backend/agente/__init__.py', ''],
    ['lab/treino/bancada.py', [
      'import sys',
      'from pathlib import Path',
      'sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "agente"))',
      'import cofre as c',
      'from cofre import Cofre',
      'RAIZ = Path(__file__).parent',
      'sys.path.insert(0, str(RAIZ / "irmao"))',
      'import vizinho',
      'def rodar():',
      '    c.ler()',
      '    Cofre()',
      '    vizinho.v()',
      '',
    ].join('\n')],
    ['lab/treino/irmao/vizinho.py', 'def v(): pass\n'],
    ['lab/treino/comparar.py', [
      'from bancada import rodar',
      'from .. import nada',
      '',
    ].join('\n')],
    ['pkg/__init__.py', ''],
    ['pkg/mod.py', 'def m(): pass\n'],
    ['usa.py', [
      'from pkg import mod',
      'from pkg.mod import m',
      'def x():',
      '    mod.m()',
      '    m()',
      '',
    ].join('\n')],
    ['quebrado.py', 'def (:\n'],
  ]);

  const arquivosPy = [...FIXTURE].map(([caminho, texto]) => ({ caminho, texto }));
  const pythonResultado = await analisarPython(arquivosPy);

  await bloco('PY1. analisarPython — decls, imports e sys.path de bancada.py', () => {
    const r = pythonResultado.find((p) => p.caminho === 'lab/treino/bancada.py');
    ok(!!r && !r.erro, 'bancada.py analisado sem erro');
    ok(r.decls.some((d) => d.nome === 'rodar' && d.tipo === 'function'), 'declara rodar');
    ok(r.syspath.includes('backend/agente'), `syspath inclui backend/agente (achei ${r.syspath})`);
    ok(r.syspath.includes('lab/treino/irmao'), `syspath inclui lab/treino/irmao (achei ${r.syspath})`);
    ok(r.imports.some((i) => i.tipo === 'import' && i.nomes.some((n) => n.nome === 'cofre' && n.como === 'c')), 'import cofre as c');
    ok(r.imports.some((i) => i.tipo === 'from' && i.modulo === 'cofre' && i.nomes.some((n) => n.nome === 'Cofre')), 'from cofre import Cofre');
  });

  await bloco('PY2. analisarPython — __all__ só com ler em cofre.py', () => {
    const r = pythonResultado.find((p) => p.caminho === 'backend/agente/cofre.py');
    ok(JSON.stringify(r.todos) === JSON.stringify(['ler']), `todos = ${JSON.stringify(r.todos)}`);
    ok(r.decls.some((d) => d.nome === 'Cofre.abrir'), 'declara método Cofre.abrir');
    ok(r.chamadas.some((c) => c.nome === 'fechar' && c.objeto === 'self' && c.classe === 'Cofre' && c.dono === 'Cofre.abrir'), 'self.fechar() dentro de Cofre.abrir');
  });

  await bloco('PY3. analisarPython — quebrado.py vira erro, não crasha o lote', () => {
    const r = pythonResultado.find((p) => p.caminho === 'quebrado.py');
    ok(!!r && typeof r.erro === 'string' && r.erro.includes('SyntaxError'), `erro reportado: ${r && r.erro}`);
  });

  await bloco('PY4. montarGrafo — imports Python resolvidos (sys.path, pasta do arquivo, raiz do repo)', () => {
    const { grafo, avisos } = montarGrafo({
      arquivos: FIXTURE, sha: 'cafef00d', ref: 'develop', nome: 'app-exemplo',
      analisadoEm: '2026-10-16T00:00:00.000Z', python: pythonResultado,
    });
    const importsDe = (de) => grafo.edges.filter((e) => e.type === 'imports' && e.source === `file:${de}`).map((e) => e.target);
    ok(importsDe('lab/treino/bancada.py').includes('file:backend/agente/cofre.py'), 'bancada → cofre.py (via sys.path parents[2])');
    ok(importsDe('lab/treino/bancada.py').includes('file:lab/treino/irmao/vizinho.py'), 'bancada → irmao/vizinho.py (via RAIZ)');
    ok(importsDe('lab/treino/comparar.py').includes('file:lab/treino/bancada.py'), 'comparar → bancada');
    ok(!importsDe('lab/treino/comparar.py').some((t) => t.includes('nada')), 'from .. import nada não resolve — sem aresta, sem erro');
    ok(importsDe('usa.py').filter((t) => t === 'file:pkg/mod.py').length === 1, 'usa → pkg/mod.py (as duas formas, uma aresta)');
    ok(avisos.some((a) => a.includes('quebrado.py')), 'avisos cita quebrado.py');
  });

  await bloco('PY5. montarGrafo — calls Python (namespace, Classe(), this/self.m, exports filtrado por __all__)', () => {
    const { grafo } = montarGrafo({
      arquivos: FIXTURE, sha: 'cafef00d', ref: 'develop', nome: 'app-exemplo',
      analisadoEm: '2026-10-16T00:00:00.000Z', python: pythonResultado,
    });
    const calls = grafo.edges.filter((e) => e.type === 'calls');
    const tem = (source, target) => calls.some((e) => e.source === source && e.target === target);
    ok(tem('function:lab/treino/bancada.py:rodar', 'function:backend/agente/cofre.py:ler'), 'bancada:rodar → cofre.py:ler');
    ok(tem('function:lab/treino/bancada.py:rodar', 'class:backend/agente/cofre.py:Cofre'), 'bancada:rodar → class:cofre.py:Cofre');
    ok(tem('function:lab/treino/bancada.py:rodar', 'function:lab/treino/irmao/vizinho.py:v'), 'bancada:rodar → vizinho.py:v');
    ok(tem('function:backend/agente/cofre.py:Cofre.abrir', 'function:backend/agente/cofre.py:Cofre.fechar'), 'Cofre.abrir → Cofre.fechar');
    ok(tem('function:usa.py:x', 'function:pkg/mod.py:m'), 'usa:x → pkg/mod.py:m');
    const exportsDe = (de) => grafo.edges.filter((e) => e.type === 'exports' && e.source === `file:${de}`).map((e) => e.target);
    ok(exportsDe('backend/agente/cofre.py').includes('function:backend/agente/cofre.py:ler'), 'exports ler');
    ok(!exportsDe('backend/agente/cofre.py').includes('class:backend/agente/cofre.py:Cofre'), 'NÃO exports Cofre (__all__ só tem ler)');
  });

  await bloco('PY6. Sem python3 (COCKPIT_GRAFO_PYTHON inexistente) — .py só como nó file, aviso cita python3', () => {
    process.env.COCKPIT_GRAFO_PYTHON = '/caminho/que-nao-existe-de-verdade';
    delete require.cache[require.resolve(path.join(RAIZ_REPO, 'lib', 'grafo-python.js'))];
    const { analisarPython: analisarPythonSemBin } = require(path.join(RAIZ_REPO, 'lib', 'grafo-python.js'));
    return analisarPythonSemBin([{ caminho: 'x.py', texto: 'def f(): pass\n' }]).then((resultado) => {
      delete process.env.COCKPIT_GRAFO_PYTHON;
      ok(resultado && resultado.indisponivel === true, `indisponivel: true (achei ${JSON.stringify(resultado)})`);
      const { avisos } = montarGrafo({
        arquivos: new Map([['x.py', 'def f(): pass\n']]), sha: 'cafef00d', ref: 'develop', nome: 'app-exemplo',
        analisadoEm: '2026-10-16T00:00:00.000Z', python: resultado,
      });
      ok(avisos.some((a) => a.includes('python3')), `avisos cita python3 (achei ${JSON.stringify(avisos)})`);
    });
  });
}

// ─── bloco montar (unidade 1c) ──────────────────────────────────────────────

// Regras copiadas de ~/.claude/plugins/cache/understand-anything/understand-anything/2.9.4/
// packages/core/src/schema.ts:420-483 (GraphNodeSchema/GraphEdgeSchema/ProjectMetaSchema/
// LayerSchema/TourStepSchema/KnowledgeGraphSchema) — o essencial que o dashboard exige.
function validarSchema(grafo) {
  const problemas = [];
  const idsDeNo = new Set(grafo.nodes.map((n) => n.id));
  for (const no of grafo.nodes) {
    if (typeof no.id !== 'string') problemas.push(`nó sem id string: ${JSON.stringify(no)}`);
    if (!['file', 'function', 'class'].includes(no.type)) problemas.push(`nó ${no.id}: type inválido (${no.type})`);
    if (typeof no.name !== 'string') problemas.push(`nó ${no.id}: name não é string`);
    if (typeof no.summary !== 'string') problemas.push(`nó ${no.id}: summary não é string`);
    // `autoFixGraph` (core/src/schema.ts:235-300) trata summary VAZIO como ausente e "corrige" o nó —
    // o dashboard abre com a faixa "Knowledge graph loaded with N auto-corrections" (visto no print
    // da Fase 7 com os 2.507 nós do piloto). String não vazia, sempre.
    else if (!no.summary) problemas.push(`nó ${no.id}: summary vazio (o autoFixGraph do dashboard corrigiria)`);
    if (!Array.isArray(no.tags)) problemas.push(`nó ${no.id}: tags não é array`);
    if (!['simple', 'moderate', 'complex'].includes(no.complexity)) problemas.push(`nó ${no.id}: complexity inválida (${no.complexity})`);
    if (no.lineRange !== undefined && !(Array.isArray(no.lineRange) && no.lineRange.length === 2 && no.lineRange.every((n) => typeof n === 'number'))) {
      problemas.push(`nó ${no.id}: lineRange não é tupla de 2 números`);
    }
  }
  const chavesDeAresta = new Set();
  for (const a of grafo.edges) {
    if (!idsDeNo.has(a.source)) problemas.push(`aresta aponta de nó inexistente: ${a.source}`);
    if (!idsDeNo.has(a.target)) problemas.push(`aresta aponta para nó inexistente: ${a.target}`);
    if (!['imports', 'exports', 'contains', 'calls', 'depends_on'].includes(a.type)) problemas.push(`aresta ${a.source}→${a.target}: type inválido (${a.type})`);
    if (a.direction !== 'forward') problemas.push(`aresta ${a.source}→${a.target}: direction != forward`);
    if (typeof a.weight !== 'number' || a.weight < 0 || a.weight > 1) problemas.push(`aresta ${a.source}→${a.target}: weight fora de 0..1 (${a.weight})`);
    const chave = `${a.source}|${a.target}|${a.type}`;
    if (chavesDeAresta.has(chave)) problemas.push(`aresta duplicada: ${chave}`);
    chavesDeAresta.add(chave);
  }
  const p = grafo.project || {};
  for (const campo of ['name', 'languages', 'frameworks', 'description', 'analyzedAt', 'gitCommitHash']) {
    if (!(campo in p)) problemas.push(`project sem o campo ${campo}`);
  }
  if (!Array.isArray(grafo.layers)) problemas.push('layers não é array');
  else for (const l of grafo.layers) {
    for (const campo of ['id', 'name', 'description', 'nodeIds']) if (!(campo in l)) problemas.push(`layer ${l.id}: sem o campo ${campo}`);
  }
  if (!Array.isArray(grafo.tour)) problemas.push('tour não é array');
  return problemas;
}

async function blocoMontar() {
  const { montarGrafo } = require(path.join(RAIZ_REPO, 'lib', 'grafo-extrator.js'));
  const { extrairHtml } = require(path.join(RAIZ_REPO, 'lib', 'grafo-html.js'));
  const { analisarPython } = require(path.join(RAIZ_REPO, 'lib', 'grafo-python.js'));

  await bloco('M1. extrairHtml — script/link locais, comentário, protocolo externo, protocol-relative', () => {
    const texto = [
      '<script src="./app.js"></script>',
      '<script src="/web/x.js"></script>',
      '<link rel="stylesheet" href="estilo.css?v=2">',
      '<!-- <script src="comentado.js"> -->',
      '<script src="https://cdn.x/y.js"></script>',
      '<link href="//cdn.x/z.css">',
    ].join('\n');
    const refs = extrairHtml(texto);
    ok(JSON.stringify(refs) === JSON.stringify(['./app.js', '/web/x.js', 'estilo.css']), `refs: ${JSON.stringify(refs)}`);
  });

  const FIXTURE_FILTROS = new Map([
    ['web/index.html', [
      '<script src="./app.js"></script>',
      '<script src="/web/x.js"></script>',
      '<link rel="stylesheet" href="estilo.css?v=2">',
      '<!-- <script src="comentado.js"> -->',
      '<script src="https://cdn.x/y.js"></script>',
      '<link href="//cdn.x/z.css">',
      '',
    ].join('\n')],
    ['web/app.js', 'export function appFn() {}\n'],
    ['web/x.js', 'export function xFn() {}\n'],
    ['web/estilo.css', 'p { color: red; }\n'],
    ['node_modules/x.js', 'function f() {}\n'],
    ['dist/y.js', 'function f() {}\n'],
    ['vendor/z.js', 'function f() {}\n'],
    ['a.min.js', 'function f() {}\n'],
    ['grande.js', `// ${'x'.repeat(513 * 1024)}\n`],
    ['notas.md', '# nada\n'],
  ]);

  let grafoFiltros;
  await bloco('M2. montarGrafo — filtros (node_modules/dist/vendor/.min/.md/>512KB) e depends_on do HTML', () => {
    const { grafo, avisos } = montarGrafo({
      arquivos: FIXTURE_FILTROS, sha: 'f11tr0', ref: 'develop', nome: 'app-exemplo',
      analisadoEm: '2026-10-16T00:00:00.000Z', python: { indisponivel: true, motivo: 'não usado' },
    });
    grafoFiltros = grafo;
    const ids = new Set(grafo.nodes.map((n) => n.id));
    ok(!ids.has('file:node_modules/x.js'), 'node_modules fora');
    ok(!ids.has('file:dist/y.js'), 'dist fora');
    ok(!ids.has('file:vendor/z.js'), 'vendor fora');
    ok(!ids.has('file:a.min.js'), '.min.js fora');
    ok(!ids.has('file:grande.js'), '> 512 KB fora');
    ok(!ids.has('file:notas.md'), '.md fora (extensão não indexada)');
    ok(avisos.some((a) => a.includes('512')), `avisos cita o > 512 KB (achei ${JSON.stringify(avisos)})`);
    const dependsDe = (de) => grafo.edges.filter((e) => e.type === 'depends_on' && e.source === `file:${de}`).map((e) => e.target);
    ok(JSON.stringify(dependsDe('web/index.html').sort()) === JSON.stringify(['file:web/app.js', 'file:web/estilo.css', 'file:web/x.js'].sort()), `depends_on de index.html: ${dependsDe('web/index.html')}`);
  });

  await bloco('M3. schema do understand-anything — todo nó/aresta/project/layers/tour na forma exigida', () => {
    const problemas = validarSchema(grafoFiltros);
    ok(problemas.length === 0, problemas.length === 0 ? 'sem problemas de schema' : `problemas: ${problemas.join(' | ')}`);
  });

  // ── herança ────────────────────────────────────────────────────────────────
  const FIXTURE_HERANCA = new Map([
    ['src/a.mjs', 'export function principal() {}\n'],
    ['src/b.mjs', 'export function outra() {}\n'],
    ['backend/agente/cofre.py', 'def ler(): pass\n'],
  ]);
  const pyHeranca = await analisarPython([{ caminho: 'backend/agente/cofre.py', texto: FIXTURE_HERANCA.get('backend/agente/cofre.py') }]);

  const G1 = {
    project: { frameworks: ['algumframework'], description: 'projeto G1' },
    nodes: [{ id: 'file:src/a.mjs', type: 'file', name: 'a.mjs', filePath: 'src/a.mjs', summary: 'resumo G1', tags: ['x'], languageNotes: 'nota G1', complexity: 'simple' }],
    edges: [],
    layers: [
      { id: 'layer:customA', name: 'Camada A', description: 'desc A', nodeIds: ['file:src/a.mjs', 'document:README.md'] },
      { id: 'layer:vazia', name: 'Vazia', description: 'nada daqui sobrevive', nodeIds: ['document:outro.md'] },
    ],
    tour: [
      { order: 1, title: 'Passo 1', description: 'd', nodeIds: ['file:src/a.mjs', 'file:inexistente.js'] },
      { order: 2, title: 'Passo 2 (só inexistente)', description: 'd2', nodeIds: ['file:so-inexistente.js'] },
    ],
  };
  const G2 = {
    project: {},
    nodes: [{ id: 'function:agente/cofre.py:ler', type: 'function', name: 'ler', filePath: 'agente/cofre.py', summary: 'resumo G2', tags: [], complexity: 'simple' }],
    edges: [], layers: [], tour: [],
  };
  const G0 = {
    project: {},
    nodes: [
      { id: 'file:src/a.mjs', type: 'file', name: 'a.mjs', filePath: 'src/a.mjs', summary: 'resumo G0 para a.mjs (não deve vencer)', tags: [], complexity: 'simple' },
      { id: 'file:src/b.mjs', type: 'file', name: 'b.mjs', filePath: 'src/b.mjs', summary: 'resumo G0', tags: ['g0'], complexity: 'simple' },
    ],
    edges: [], layers: [], tour: [],
  };

  const paramsBase = { arquivos: FIXTURE_HERANCA, sha: 'her4nca', ref: 'develop', nome: 'app-exemplo', analisadoEm: '2026-10-16T00:00:00.000Z', python: pyHeranca };

  await bloco('M4. herança — summary/tags/languageNotes/camada de G1 (prefixo vazio) e G2 (prefixo backend/)', () => {
    const { grafo } = montarGrafo({ ...paramsBase, heranca: [{ prefixo: '', grafo: G1 }, { prefixo: 'backend/', grafo: G2 }], anterior: G0 });
    const noA = grafo.nodes.find((n) => n.id === 'file:src/a.mjs');
    ok(noA.summary === 'resumo G1', `a.mjs herda summary de G1 (achei "${noA.summary}")`);
    ok(JSON.stringify(noA.tags) === JSON.stringify(['x']), `a.mjs herda tags de G1 (achei ${JSON.stringify(noA.tags)})`);
    ok(noA.languageNotes === 'nota G1', `a.mjs herda languageNotes de G1 (achei "${noA.languageNotes}")`);
    const noLer = grafo.nodes.find((n) => n.id === 'function:backend/agente/cofre.py:ler');
    ok(!!noLer && noLer.summary === 'resumo G2', `function:backend/agente/cofre.py:ler herda de G2 (achei ${noLer && noLer.summary})`);
    const noB = grafo.nodes.find((n) => n.id === 'file:src/b.mjs');
    ok(noB.summary === 'resumo G0', `b.mjs (só em G0) herda de G0 (achei "${noB.summary}")`);

    const layerA = grafo.layers.find((l) => l.id === 'layer:customA');
    ok(!!layerA && layerA.nodeIds.includes('file:src/a.mjs'), 'camada customA contém a.mjs');
    ok(!!layerA && !layerA.nodeIds.includes('document:README.md'), 'camada customA NÃO leva document:README.md (não é nó)');
    ok(!grafo.layers.some((l) => l.id === 'layer:vazia'), 'camada vazia (só document:outro.md) não aparece');

    ok(grafo.tour.length === 1, `tour tem 1 passo (o que ficou vazio some) — achei ${grafo.tour.length}`);
    ok(grafo.tour[0] && JSON.stringify(grafo.tour[0].nodeIds) === JSON.stringify(['file:src/a.mjs']), `passo 1 só com o id existente (achei ${grafo.tour[0] && JSON.stringify(grafo.tour[0].nodeIds)})`);
  });

  await bloco('M5. sem herança — layer:<1º segmento> / layer:raiz, com description "Arquivos em …/"', () => {
    const { grafo } = montarGrafo(paramsBase);
    const layerSrc = grafo.layers.find((l) => l.id === 'layer:src');
    ok(!!layerSrc && layerSrc.description === 'Arquivos em src/', `layer:src com a description certa (achei ${layerSrc && layerSrc.description})`);
    ok(!!layerSrc && layerSrc.nodeIds.includes('file:src/a.mjs') && layerSrc.nodeIds.includes('file:src/b.mjs'), 'layer:src contém a.mjs e b.mjs');
    const layerBackend = grafo.layers.find((l) => l.id === 'layer:backend');
    ok(!!layerBackend && layerBackend.nodeIds.includes('function:backend/agente/cofre.py:ler'), 'layer:backend contém a função de cofre.py');
  });

  await bloco('M6. estrutura independe da herança (nodes sem summary/tags/languageNotes e edges idênticos)', () => {
    const semHeranca = (n) => ({ ...n, summary: undefined, tags: undefined, languageNotes: undefined });
    const r1 = montarGrafo({ ...paramsBase, heranca: [{ prefixo: '', grafo: G1 }, { prefixo: 'backend/', grafo: G2 }], anterior: G0 });
    const r2 = montarGrafo(paramsBase);
    const nodesIguais = JSON.stringify(r1.grafo.nodes.map(semHeranca)) === JSON.stringify(r2.grafo.nodes.map(semHeranca));
    const edgesIguais = JSON.stringify(r1.grafo.edges) === JSON.stringify(r2.grafo.edges);
    ok(nodesIguais, 'nodes (sem summary/tags/languageNotes) idênticos com e sem herança');
    ok(edgesIguais, 'edges idênticos com e sem herança');
  });
}

// ─── despacho ────────────────────────────────────────────────────────────────

async function principal() {
  const arg = process.argv[2];
  if (!arg || arg === 'js') blocoJs();
  if (!arg || arg === 'python') await blocoPython();
  if (!arg || arg === 'montar') await blocoMontar();

  console.log(`\n${passou}/${total} asserções`);
  console.log(vermelho ? '\n❌ GATE VERMELHO' : '\n✅ GATE VERDE — extrator multi-linguagem do grafo');
  process.exitCode = vermelho ? 1 : 0;
}

principal();
