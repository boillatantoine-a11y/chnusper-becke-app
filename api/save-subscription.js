// api/save-subscription.js — Fonction Vercel (Node)
// Stocke un abonnement push dans la Realtime Database, noeud "push_subs".
// Variables d'env requises : FB_URL, FB_KEY

import { fbPut, subKey } from "./_firebase.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { user, subscription } = req.body || {};
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: "subscription manquante" });
    }
    // Une entree par appareil, la cle vient de l'endpoint : le dedoublonnage
    // est automatique, plus besoin de relire toute la liste pour l'ecrire.
    await fbPut("push_subs/" + subKey(subscription.endpoint), {
      user: user || "?",
      subscription,
      ts: Date.now()
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
