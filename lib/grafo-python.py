#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Extrator Python pela `ast` da biblioteca padrão (sem pip) — a metade Python do grafo do projeto do
Cockpit. Lê do stdin um JSON `[{ "caminho": "...", "texto": "..." }]`, escreve no stdout um JSON
com uma entrada por arquivo (ver spec/plano "Fase 1", `lib/grafo-python.py`).

Nenhum `eval`: expressões de `sys.path.insert/append` são avaliadas por um interpretador bem
restrito sobre a própria AST (função `avaliar`), só com as formas listadas no plano.
"""

import ast
import json
import posixpath
import sys


def nome_pontilhado(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = nome_pontilhado(node.value)
        if base is None:
            return None
        return f"{base}.{node.attr}"
    return None


def constante_str(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def indice_de_subscript(node):
    """Índice inteiro de `X[n]`, cobrindo ast.Constant (3.9+) e ast.Index (versões antigas)."""
    sl = node.slice
    if isinstance(sl, ast.Constant) and isinstance(sl.value, int):
        return sl.value
    valor = getattr(sl, "value", None)
    if isinstance(valor, ast.Constant) and isinstance(valor.value, int):
        return valor.value
    return None


def avaliar(node, env, caminho):
    """Avalia uma expressão de caminho sem `eval`, só as formas do plano §1.3. `None` = não avaliável."""
    if node is None:
        return None

    s = constante_str(node)
    if s is not None:
        return s

    if isinstance(node, ast.Name):
        if node.id == "__file__":
            return caminho
        return env.get(node.id)

    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
        esq = avaliar(node.left, env, caminho)
        dire = avaliar(node.right, env, caminho)
        if esq is None or dire is None:
            return None
        return posixpath.join(esq, dire)

    if isinstance(node, ast.Attribute):
        if node.attr == "parent":
            base = avaliar(node.value, env, caminho)
            return posixpath.dirname(base) if base is not None else None
        return None

    if isinstance(node, ast.Subscript):
        if isinstance(node.value, ast.Attribute) and node.value.attr == "parents":
            base = avaliar(node.value.value, env, caminho)
            n = indice_de_subscript(node)
            if base is None or n is None:
                return None
            resultado = base
            for _ in range(n + 1):
                resultado = posixpath.dirname(resultado)
            return resultado
        return None

    if isinstance(node, ast.Call):
        func = node.func
        if isinstance(func, ast.Name) and func.id in ("Path", "PurePath", "str") and len(node.args) == 1:
            return avaliar(node.args[0], env, caminho)

        # `.resolve()` / `.absolute()` / `.expanduser()` são passthrough — a base pode ser
        # qualquer expressão avaliável (inclusive outra chamada, como `Path(x).resolve()`),
        # então são tratados ANTES do nome pontilhado (que só soma Name/Attribute).
        if isinstance(func, ast.Attribute) and func.attr in ("resolve", "absolute", "expanduser") and not node.args:
            return avaliar(func.value, env, caminho)

        dotted = nome_pontilhado(func)
        if dotted is None:
            return None

        if dotted == "os.fspath" and len(node.args) == 1:
            return avaliar(node.args[0], env, caminho)
        if dotted == "os.path.join":
            partes = [avaliar(a, env, caminho) for a in node.args]
            if any(p is None for p in partes) or not partes:
                return None
            return posixpath.join(*partes)
        if dotted == "os.path.dirname" and len(node.args) == 1:
            v = avaliar(node.args[0], env, caminho)
            return posixpath.dirname(v) if v is not None else None
        if dotted in ("os.path.abspath", "os.path.realpath", "os.path.normpath") and len(node.args) == 1:
            v = avaliar(node.args[0], env, caminho)
            return posixpath.normpath(v) if v is not None else None
        return None

    return None


def normalizar_syspath(valor):
    if valor is None:
        return None
    v = posixpath.normpath(valor)
    if v == "." or v == "":
        return "."
    if v.startswith(".."):
        return None
    return v


def coletar_decls(tree):
    decls = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            decls.append({"nome": node.name, "tipo": "function", "ini": node.lineno, "fim": node.end_lineno})
        elif isinstance(node, ast.ClassDef):
            decls.append({"nome": node.name, "tipo": "class", "ini": node.lineno, "fim": node.end_lineno})
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    decls.append({
                        "nome": f"{node.name}.{item.name}",
                        "tipo": "function",
                        "ini": item.lineno,
                        "fim": item.end_lineno,
                    })
    return decls


def coletar_imports(tree):
    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            nomes = [{"nome": a.name, "como": a.asname or a.name} for a in node.names]
            imports.append({"tipo": "import", "modulo": None, "nivel": 0, "nomes": nomes, "linha": node.lineno})
        elif isinstance(node, ast.ImportFrom):
            nomes = [{"nome": a.name, "como": a.asname or a.name} for a in node.names]
            imports.append({
                "tipo": "from",
                "modulo": node.module,
                "nivel": node.level or 0,
                "nomes": nomes,
                "linha": node.lineno,
            })
    return imports


def coletar_syspath(tree, caminho):
    env = {}
    syspath = []

    def processa_chamadas(stmt):
        for node in ast.walk(stmt):
            if not isinstance(node, ast.Call):
                continue
            dotted = nome_pontilhado(node.func)
            if dotted == "sys.path.insert" and len(node.args) == 2:
                v = normalizar_syspath(avaliar(node.args[1], env, caminho))
                if v is not None:
                    syspath.append(v)
            elif dotted == "sys.path.append" and len(node.args) == 1:
                v = normalizar_syspath(avaliar(node.args[0], env, caminho))
                if v is not None:
                    syspath.append(v)

    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            v = avaliar(stmt.value, env, caminho)
            if v is not None:
                env[stmt.targets[0].id] = v
        processa_chamadas(stmt)

    return syspath


def dono_por_linha(decls, linha):
    melhor = None
    for d in decls:
        if d["tipo"] == "class":
            continue
        if d["ini"] <= linha <= d["fim"]:
            if melhor is None or (d["fim"] - d["ini"]) < (melhor["fim"] - melhor["ini"]):
                melhor = d
    return melhor["nome"] if melhor else None


def coletar_chamadas(tree, decls):
    chamadas = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        linha = node.lineno
        dono = dono_por_linha(decls, linha)
        if isinstance(func, ast.Name):
            chamadas.append({"nome": func.id, "objeto": None, "dono": dono, "linha": linha})
        elif isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            objeto = func.value.id
            if objeto in ("self", "cls") and dono and "." in dono:
                classe = dono.split(".")[0]
                chamadas.append({"nome": func.attr, "objeto": objeto, "classe": classe, "dono": dono, "linha": linha})
            else:
                chamadas.append({"nome": func.attr, "objeto": objeto, "dono": dono, "linha": linha})
    return chamadas


def coletar_todos(tree):
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name) and target.id == "__all__":
                if isinstance(node.value, (ast.List, ast.Tuple)):
                    nomes = [constante_str(e) for e in node.value.elts]
                    if all(n is not None for n in nomes):
                        return nomes
    return None


def analisar(caminho, texto):
    try:
        tree = ast.parse(texto, filename=caminho)
    except (SyntaxError, ValueError) as e:
        linha = getattr(e, "lineno", None)
        msg = getattr(e, "msg", str(e))
        return {"caminho": caminho, "erro": f"{type(e).__name__}: {msg} (linha {linha})"}

    return {
        "caminho": caminho,
        "decls": coletar_decls(tree),
        "imports": coletar_imports(tree),
        "chamadas": coletar_chamadas(tree, coletar_decls(tree)),
        "syspath": coletar_syspath(tree, caminho),
        "todos": coletar_todos(tree),
    }


def main():
    entrada = json.load(sys.stdin)
    saida = [analisar(item["caminho"], item["texto"]) for item in entrada]
    json.dump(saida, sys.stdout)


if __name__ == "__main__":
    main()
