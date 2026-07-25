// api/migrate-subs.js — A UTILISER UNE SEULE FOIS, puis supprimer ce fichier.
// Recopie les abonnements push de l'ancien bin JSONBin vers Firebase, pour que
// personne n'ait a reactiver les notifications sur son telephone.
//
// Appel : https://chnusper-becke-app.vercel.app/api/migrate-subs
//
// Variables d'env encore necessaires pour ce seul fichier :
//   JSONBIN_KEY, SUBS_BIN_ID   (en plus de FB_URL et FB_KEY)

import { fbPut, subKey } from "./_firebase.js";

export default async function handler(req, res) {
  try {
    if (!process.env.SUBS_BIN_ID || !process.env.JSONBIN_KEY) {
      return res.status(200).json({ ok: false, reason: "SUBS_BIN_ID ou JSONBIN_KEY absente" });
    }

    const r = await fetch("https://api.jsonbin.io/v3/b/" + process.env.SUBS_BIN_ID + "/latest", {
      headers: { "X-Master-Key": process.env.JSONBIN_KEY }
    });
    if (!r.ok) return res.status(200).json({ ok: false, reason: "JSONBin a repondu " + r.status });

    const j = await r.json();
    const subs = (j.record && Array.isArray(j.record.subs)) ? j.record.subs : [];

    let copies = 0;
    const comptes = [];
    for (const s of subs) {
      if (!s || !s.subscription || !s.subscription.endpoint) continue;
      await fbPut("push_subs/" + subKey(s.subscription.endpoint), {
        user: s.user || "?",
        subscription: s.subscription,
        ts: s.ts || Date.now()
      });
      copies++;
      if (comptes.indexOf(s.user) < 0) comptes.push(s.user);
    }

    return res.status(200).json({ ok: true, copies, comptes });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
