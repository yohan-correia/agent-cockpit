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
    badge: 'icone-192.png',
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
    const abertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const janela of abertas) {
      // Já tem o cockpit aberto: foca essa janela em vez de abrir uma segunda.
      if (janela.url.startsWith(new URL('./', self.location.href).href)) {
        await janela.focus();
        if (sessaoId && 'navigate' in janela) await janela.navigate(destino).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(destino);
  })());
});
