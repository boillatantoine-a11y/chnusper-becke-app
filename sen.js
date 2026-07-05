// api/send.js — Fonction Vercel (Node)
// Envoie une notification push à tous les appareils abonnés.
// Variables d'env requises : JSONBIN_KEY, SUBS_BIN_ID, VAPID_PUBLIC_KEY,
//                            VAPID_PRIVATE_KEY, VAPID_SUBJECT (ex: mailto:toi@exemple.ch)

import webpush from "web-push";

const BIN = () => "https://api.jsonbin.io/v3/b/" + process.env.SUBS_BIN_ID;

async function readSubs() {
  const r = await fetch(BIN() + "/latest", {
    headers: { "X-Master-Key": process.env.JSONBIN_KEY }
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.record && Array.isArray(j.record.subs)) ? j.record.subs : [];
}

async function writeSubs(subs) {
  await fetch(BIN(), {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Master-Key": process.env.JSONBIN_KEY },
    body: JSON.stringify({ subs })
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@chnusper-becke.ch",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const { title, body, url, badge, recipients } = req.body || {};

  // Sécurité : on refuse tout envoi sans destinataires explicites (pas de "à tous")
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
    const subs = await readSubs();
    const alive = [];
    let sent = 0;

    await Promise.all(subs.map(async (s) => {
      // On n'envoie qu'aux abonnés dont le compte est dans la liste des destinataires
      const isTarget = recipients.indexOf(s.user) >= 0;
      if (!isTarget) { alive.push(s); return; }
      try {
        await webpush.sendNotification(s.subscription, payload);
        alive.push(s);
        sent++;
      } catch (err) {
        // 404/410 = abonnement expiré -> on l'enlève ; autre erreur -> on garde
        if (err.statusCode === 404 || err.statusCode === 410) return;
        alive.push(s);
      }
    }));

    if (alive.length !== subs.length) await writeSubs(alive);
    return res.status(200).json({ ok: true, sent, total: subs.length });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
