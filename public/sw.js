// Service worker do Cockpit.
//
// NÃO faz cache de API nem de HTML de propósito: a verdade mora no servidor e uma
// resposta velha aqui viraria conversa fantasma. O handler de fetch é passthrough — só
// precisa existir, porque sem ele o Chrome recusa a instalação.
//
// Ele só chega a registrar em HTTPS: service worker exige contexto seguro. Foi por isso
// que este arquivo passou semanas no repo sem nunca ter rodado.
//
// A partir daqui ele também é quem recebe a notificação com o app FECHADO. É o único
// pedaço de código do cockpit que roda sem ninguém olhando a tela.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (evento) => {
  let aviso = {};
  try {
    aviso = evento.data ? evento.data.json() : {};
  } catch {
    aviso = { titulo: 'Cockpit', corpo: evento.data ? evento.data.text() : '' };
  }

  evento.waitUntil(self.registration.showNotification(aviso.titulo || 'Cockpit de Agentes', {
    body: aviso.corpo || '',
    icon: 'icone-192.png',
    // O badge é o ícone MINÚSCULO da barra de status do Android, e lá ele é recolorido: o
    // sistema joga fora as cores e pinta o CANAL ALFA de branco. `icone-192.png` tem fundo
    // opaco no quadrado inteiro, então virava um quadrado branco sólido (visto no aparelho do
    // dono em 11/09). Por isso um arquivo só de silhueta: fundo transparente, desenho branco.
    badge: 'icone-badge-96.png',
    // A tag é o id da conversa: um aviso novo da mesma conversa SUBSTITUI o anterior em
    // vez de empilhar. Turno longo com várias etapas não vira quinze notificações.
    tag: aviso.tag || aviso.sessaoId || 'cockpit',
    renotify: true,
    data: { sessaoId: aviso.sessaoId || null },
  }));
});

self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  const sessaoId = evento.notification.data && evento.notification.data.sessaoId;
  // `#c=<id>` em vez de query: o cliente lê isso e já abre a conversa certa, e o hash
  // não some no meio do caminho como a query some quando o app já está aberto.
  const destino = new URL(sessaoId ? `./#c=${sessaoId}` : './', self.location.href).href;

  evento.waitUntil((async () => {
    const raiz = new URL('./', self.location.href).href;
    const abertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const janela of abertas) {
      // Já tem o cockpit aberto: foca essa janela em vez de abrir uma segunda. Desde D96 (regra da casa: tudo
      // dentro do app) diff, mapa e grafo moram na janela DO APP, como `financas.html` — nenhuma é poupada.
      // Com `sessaoId` ela navega para a conversa; sem, só ganha o foco.
      if (janela.url.startsWith(raiz)) {
        await janela.focus();
        if (sessaoId && 'navigate' in janela) await janela.navigate(destino).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(destino);
  })());
});
