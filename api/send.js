// api/send.js — Fonction Vercel (Node)
// Envoie une notification push aux comptes listes dans "recipients".
// Les abonnements sont lus dans la Realtime Database, noeud "push_subs".
// Variables d'env requises : FB_URL, FB_KEY, VAPID_PUBLIC_KEY,
//                            VAPID_PRIVATE_KEY, VAPID_SUBJECT

import crypto from "crypto";
import webpush from "web-push";

// ---------------------------------------------------------------------------
//  Acces REST a la Realtime Database, sans SDK.
//  Ce bloc est recopie a l'identique dans chaque fichier de api/ : Vercel ne
//  deploie pas les fichiers partages commencant par un tiret bas.
//  Variables d'env requises : FB_URL, FB_KEY
// ---------------------------------------------------------------------------

const FB_URL = (process.env.FB_URL || "").replace(/\/+$/, "");
const FB_KEY = process.env.FB_KEY || "";

let tokenCache = null;   // { idToken, refresh, exp } — reutilise si la fonction est chaude

async function fbAuthToken() {
  if (!FB_KEY) return null;
  const now = Date.now();
  if (tokenCache && tokenCache.exp > now + 60000) return tokenCache.idToken;

  if (tokenCache && tokenCache.refresh) {
    try {
      const r = await fetch("https://securetoken.googleapis.com/v1/token?key=" + FB_KEY, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(tokenCache.refresh)
      });
      if (r.ok) {
        const j = await r.json();
        tokenCache = { idToken: j.id_token, refresh: j.refresh_token,
                       exp: now + (parseInt(j.expires_in, 10) || 3600) * 1000 };
        return tokenCache.idToken;
      }
    } catch (e) { /* on repart sur une nouvelle session */ }
  }

  const r2 = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + FB_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnSecureToken: true })
  });
  if (!r2.ok) throw new Error("Auth Firebase " + r2.status);
  const j2 = await r2.json();
  tokenCache = { idToken: j2.idToken, refresh: j2.refreshToken,
                 exp: now + (parseInt(j2.expiresIn, 10) || 3600) * 1000 };
  return tokenCache.idToken;
}

async function fbEndpoint(path) {
  if (!FB_URL) throw new Error("FB_URL manquante dans les variables d'environnement");
  const u = FB_URL + "/" + path + ".json";
  const tk = await fbAuthToken();
  return tk ? u + "?auth=" + encodeURIComponent(tk) : u;
}

async function fbGet(path) {
  const r = await fetch(await fbEndpoint(path));
  if (!r.ok) throw new Error("Firebase GET " + r.status);
  return await r.json();
}

async function fbPut(path, data) {
  const r = await fetch(await fbEndpoint(path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error("Firebase PUT " + r.status);
  return true;
}

async function fbDel(path) {
  const r = await fetch(await fbEndpoint(path), { method: "DELETE" });
  if (!r.ok) throw new Error("Firebase DELETE " + r.status);
  return true;
}

// L'app stocke l'etat principal en CHAINE JSON (pour ne perdre ni les tableaux
// vides ni les cles numeriques). On la deplie ici.
async function fbGetEtat() {
  const raw = await fbGet("etat");
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  return raw;
}

// Une cle Realtime Database ne supporte ni . ni / ni : — on hache l'endpoint.
// Bonus : le meme appareil qui se reabonne ecrase son entree.
function subKey(endpoint) {
  return crypto.createHash("sha1").update(String(endpoint)).digest("hex");
}


export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Garde-fou : sans ces variables, web-push leve une exception et la fonction
  // renvoie un 500 muet. On prefere un message lisible dans l'app.
  const manque = [];
  if (!process.env.FB_URL)            manque.push("FB_URL");
  if (!process.env.VAPID_PUBLIC_KEY)  manque.push("VAPID_PUBLIC_KEY");
  if (!process.env.VAPID_PRIVATE_KEY) manque.push("VAPID_PRIVATE_KEY");
  if (manque.length) {
    return res.status(200).json({
      ok: false, sent: 0,
      error: "Variables d'environnement manquantes sur Vercel : " + manque.join(", ")
    });
  }

  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:admin@chnusper-becke.ch",
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  } catch (e) {
    return res.status(200).json({
      ok: false, sent: 0,
      error: "Cles VAPID invalides : " + (e && e.message ? e.message : String(e))
    });
  }

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
        // 404/410 = abonnement expire. 403 = signe avec l'ancienne cle VAPID.
        // Dans les deux cas l'entree ne sert plus a rien : on la retire.
        if (err.statusCode === 404 || err.statusCode === 410 || err.statusCode === 403) perimes.push(k);
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
