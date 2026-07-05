/* sw.js — Service Worker Chnusper Becke
   À déployer à la RACINE du site (https://.../sw.js) pour couvrir tout le scope. */

// Réception d'un push envoyé par le serveur (fonctionne même app fermée, si installée sur l'écran d'accueil)
self.addEventListener("push", function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }

  var title = data.title || "Chnusper Becke";
  var options = {
    body:  data.body  || "",
    icon:  "/icon-192.png",   // grande icône dans la notif
    badge: "/badge-72.png",   // petite pastille (barre d'état Android)
    tag:   data.tag || "cb-notif",   // même tag = remplace au lieu d'empiler
    renotify: true,
    requireInteraction: true,        // reste affichée jusqu'à interaction (bien visible sur écran verrouillé)
    vibrate: [200, 100, 200],        // vibration (Android)
    timestamp: Date.now(),
    data:  { url: data.url || "/" }
  };

  // Chiffre à afficher sur l'icône de l'app (pastille). Défaut : 1.
  var count = (typeof data.badge === "number" && data.badge >= 0) ? data.badge : 1;

  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    (self.navigator && self.navigator.setAppBadge)
      ? self.navigator.setAppBadge(count).catch(function(){})
      : Promise.resolve()
  ]));
});

// Clic sur la notification : ouvre/focus l'app et efface la pastille
self.addEventListener("notificationclick", function(event) {
  event.notification.close();
  if (self.navigator && self.navigator.clearAppBadge) {
    self.navigator.clearAppBadge().catch(function(){});
  }
  var target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if ("focus" in list[i]) return list[i].focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});

// Active le nouveau SW immédiatement
self.addEventListener("install", function() { self.skipWaiting(); });
self.addEventListener("activate", function(event) { event.waitUntil(self.clients.claim()); });
