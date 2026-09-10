'use strict';
// Localização explícita da interface. Nunca percorre mensagens, arquivos ou saídas do CLI.
(function () {
  const catalogo = globalThis.cockpitTraducoes || {};
  const chave = 'cockpit-idioma';
  let idioma = 'pt-BR';
  try {
    const salvo = localStorage.getItem(chave);
    idioma = salvo === 'en' || salvo === 'pt-BR' ? salvo
      : (/^en\b/i.test(globalThis.navigator?.language || '') ? 'en' : 'pt-BR');
  } catch { /* Sem storage: português continua disponível. */ }

  // Alguns rótulos são montados antes de chegar ao nó (botão de copiar, status).
  // Reencontrar a mensagem inteira permite trocar o idioma desses rótulos também.
  // O matching é ancorado e só recebe textos explicitamente marcados como interface.
  const inverso = new Map();
  const modelos = [];
  const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [pt, en] of Object.entries(catalogo)) {
    if (!inverso.has(en)) inverso.set(en, pt);
    if (!/\{\d+\}/.test(pt)) continue;
    for (const original of [pt, en]) {
      const indices = [];
      const partes = original.split(/(\{\d+\})/);
      const padrao = partes.map(parte => {
        if (!/^\{\d+\}$/.test(parte)) return escapar(parte);
        indices.push(Number(parte.slice(1, -1)));
        return '([\\s\\S]*?)';
      }).join('');
      modelos.push({ pt, en, indices, regex: new RegExp('^' + padrao + '$'), peso: original.replace(/\{\d+\}/g, '').length });
    }
  }
  modelos.sort((a, b) => b.peso - a.peso);
  function resolver(texto) {
    if (Object.hasOwn(catalogo, texto)) return idioma === 'en' ? catalogo[texto] : texto;
    if (inverso.has(texto)) return idioma === 'en' ? texto : inverso.get(texto);
    if (/[^\W\d_].*\s|[à-ü]/iu.test(texto)) {
      for (const modelo of modelos) {
        const match = modelo.regex.exec(texto);
        if (!match) continue;
        const valores = [];
        modelo.indices.forEach((indice, i) => { valores[indice] = match[i + 1]; });
        return (idioma === 'en' ? modelo.en : modelo.pt).replace(/\{(\d+)\}/g, (_, i) => valores[i] ?? '');
      }
    }
    return texto;
  }

  function t(mensagem, ...valores) {
    const modelo = Array.isArray(mensagem)
      ? mensagem.map((parte, i) => parte + (i < valores.length ? `{${i}}` : '')).join('')
      : String(mensagem ?? '');
    const traduzido = valores.length ? (idioma === 'en' ? (catalogo[modelo] ?? modelo) : modelo) : resolver(modelo);
    // Substituição única: valores nunca são tratados como HTML ou como outras mensagens.
    return valores.length ? traduzido.replace(/\{(\d+)\}/g, (original, i) => i < valores.length ? String(valores[i] ?? '') : original) : traduzido;
  }

  // WeakMap/WeakRef: a tradução não mantém painéis fechados ou histórico descartado vivos.
  const registros = new WeakMap();
  const referencias = new Set();
  let insercoes = 0;
  function bind(no, propriedade, pintar, atributo = false) {
    const valor = String(pintar() ?? '');
    if (atributo) no.setAttribute(propriedade, valor);
    else no[propriedade] = valor;
    let mapa = registros.get(no);
    if (!mapa) {
      mapa = new Map();
      registros.set(no, mapa);
      referencias.add(new WeakRef(no));
    }
    const id = `${atributo ? 'a' : 'p'}:${propriedade}`;
    // Limpar um container não é um texto traduzível: não limpá-lo de novo na troca.
    if (!valor) mapa.delete(id);
    else mapa.set(id, { propriedade, pintar, atributo, valor,
      texto: propriedade === 'textContent' ? no.firstChild : null });
    if (++insercoes % 256 === 0) for (const ref of referencias) if (!ref.deref()) referencias.delete(ref);
    return valor;
  }
  function attr(no, propriedade, pintar) { return bind(no, propriedade, pintar, true); }
  function refresh() {
    for (const ref of referencias) {
      const no = ref.deref();
      if (!no) { referencias.delete(ref); continue; }
      for (const [id, r] of registros.get(no) || []) {
        // Outro dono substituiu o conteúdo: não ressuscitar rótulos antigos.
        if (r.texto && r.texto.parentNode !== no) { registros.get(no).delete(id); continue; }
        const atual = r.texto ? r.texto.data : (r.atributo ? no.getAttribute(r.propriedade) : no[r.propriedade]);
        if (String(atual) !== r.valor) { registros.get(no).delete(id); continue; }
        const novo = String(r.pintar() ?? '');
        if (r.texto) r.texto.data = novo; // preserva ícones/filhos acrescentados depois do texto
        else if (r.atributo) no.setAttribute(r.propriedade, novo);
        else no[r.propriedade] = novo;
        r.valor = novo;
      }
    }
  }
  function aplicarDocumento() {
    if (!globalThis.document?.documentElement) return;
    document.documentElement.lang = idioma;
    document.documentElement.style?.setProperty('--rotulo-fila', JSON.stringify(t('na fila')));
  }
  function definir(valor) {
    if (valor !== 'pt-BR' && valor !== 'en') return false;
    idioma = valor;
    try { localStorage.setItem(chave, idioma); } catch { /* vale nesta página */ }
    aplicarDocumento();
    refresh();
    return true;
  }
  function texto(no, mensagem) { return bind(no, 'data', () => t(mensagem)); }

  // Executado UMA vez, antes de app.js criar conversas. Só marca o HTML estático.
  function estatico() {
    if (!document.createTreeWalker) return;
    aplicarDocumento();
    const walker = document.createTreeWalker(document.documentElement, 4);
    const nos = [];
    while (walker.nextNode()) {
      const no = walker.currentNode;
      if (!no.parentElement?.closest('script, style')) nos.push(no);
    }
    for (const no of nos) {
      const original = no.data;
      const centro = original.trim();
      if (!Object.hasOwn(catalogo, centro)) continue;
      bind(no, 'data', () => original.replace(centro, () => t(centro)));
    }
    for (const no of document.querySelectorAll('[title], [aria-label], [placeholder], [alt]')) {
      for (const atributo of ['title', 'aria-label', 'placeholder', 'alt']) {
        const original = no.getAttribute(atributo);
        if (original && Object.hasOwn(catalogo, original)) attr(no, atributo, () => t(original));
      }
    }
  }
  globalThis.cockpitI18n = { t, bind, attr, texto, definir, refresh, estatico, get idioma() { return idioma; } };
})();
