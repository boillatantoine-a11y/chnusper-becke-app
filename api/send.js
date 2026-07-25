// api/send.js — Fonction Vercel (Node)
// Envoie une notification push aux comptes listes dans "recipients".
// Les abonnements sont lus dans la Realtime Database, noeud "push_subs".
// Variables d'env requises : FB_URL, FB_KEY, VAPID_PUBLIC_KEY,
//                            VAPID_PRIVATE_KEY, VAPID_SUBJECT

import webpush from "web-push";
import { fbGet, fbDel } from "./_firebase.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@chnusper-becke.ch",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const { title, body, url, badge, recipients } = req.body || {};

  // Securite : on refuse tout envoi sans destinataires explicites (pas de "a tous")
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: "recipients requis (aucun envoi general autorise)" });
  }

  const payload = JSON.stringify({
    title: title || "Chnusper Becke",
    body: body || "",
    url: url || "/",
    badge: (typeof badge === "number") ? badge : 1
  });

  try {
    const map = (await fbGet("push_subs")) || {};
    const cles = Object.keys(map);
    const perimes = [];
    let sent = 0;

    await Promise.all(cles.map(async (k) => {
      const s = map[k];
      if (!s || !s.subscription) return;
      if (recipients.indexOf(s.user) < 0) return;      // pas un destinataire
      try {
        await webpush.sendNotification(s.subscription, payload);
        sent++;
      } catch (err) {
        // 404/410 = abonnement expire -> on le retire ; autre erreur -> on garde
        if (err.statusCode === 404 || err.statusCode === 410) perimes.push(k);
      }
    }));

    // Menage cible : on supprime les entrees mortes une par une, sans
    // reecrire toute la liste (plus de risque d'ecrasement entre deux envois).
    for (const k of perimes) {
      try { await fbDel("push_subs/" + k); } catch (e) { /* sans consequence */ }
    }

    return res.status(200).json({ ok: true, sent, total: cles.length, retires: perimes.length });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
