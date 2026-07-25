// api/migrate-subs.js — A UTILISER UNE SEULE FOIS, puis supprimer ce fichier.
// Recopie les abonnements push de l'ancien bin JSONBin vers Firebase, pour que
// personne n'ait a reactiver les notifications sur son telephone.
//
// Appel : https://chnusper-becke-app.vercel.app/api/migrate-subs
//
// Variables d'env encore necessaires pour ce seul fichier :
//   JSONBIN_KEY, SUBS_BIN_ID   (en plus de FB_URL et FB_KEY)

import crypto from "crypto";

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
