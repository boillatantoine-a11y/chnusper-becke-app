// api/_firebase.js
// Acces REST a la Realtime Database, sans SDK — meme principe que l'app.
// Le nom commence par "_" : Vercel ne le publie pas comme endpoint.
//
// Variables d'env Vercel requises :
//   FB_URL  = https://chnusper-app-default-rtdb.europe-west1.firebasedatabase.app
//   FB_KEY  = cle Web API (AIza...)

import crypto from "crypto";

const FB_URL = (process.env.FB_URL || "").replace(/\/+$/, "");
const FB_KEY = process.env.FB_KEY || "";

// Le jeton est garde en memoire du module : une fonction Vercel deja chaude
// le reutilise au lieu de recreer une session a chaque appel.
let tokenCache = null;   // { idToken, refresh, exp }

async function token() {
  if (!FB_KEY) return null;                    // regles ouvertes : pas de jeton
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
        tokenCache = {
          idToken: j.id_token, refresh: j.refresh_token,
          exp: now + (parseInt(j.expires_in, 10) || 3600) * 1000
        };
        return tokenCache.idToken;
      }
    } catch (e) { /* on retombe sur une nouvelle session */ }
  }

  const r2 = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + FB_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnSecureToken: true })
  });
  if (!r2.ok) throw new Error("Auth Firebase " + r2.status);
  const j2 = await r2.json();
  tokenCache = {
    idToken: j2.idToken, refresh: j2.refreshToken,
    exp: now + (parseInt(j2.expiresIn, 10) || 3600) * 1000
  };
  return tokenCache.idToken;
}

async function fbUrl(path) {
  if (!FB_URL) throw new Error("FB_URL manquante dans les variables d'environnement");
  const u = FB_URL + "/" + path + ".json";
  const tk = await token();
  return tk ? u + "?auth=" + encodeURIComponent(tk) : u;
}

export async function fbGet(path) {
  const r = await fetch(await fbUrl(path));
  if (!r.ok) throw new Error("Firebase GET " + r.status);
  return await r.json();
}

export async function fbPut(path, data) {
  const r = await fetch(await fbUrl(path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error("Firebase PUT " + r.status);
  return true;
}

export async function fbDel(path) {
  const r = await fetch(await fbUrl(path), { method: "DELETE" });
  if (!r.ok) throw new Error("Firebase DELETE " + r.status);
  return true;
}

// L'app stocke l'etat principal en CHAINE JSON (pour ne perdre ni les tableaux
// vides ni les cles numeriques). On la deplie ici.
export async function fbGetEtat() {
  const raw = await fbGet("etat");
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  return raw;                                  // ancien format objet : accepte
}

// Une cle Realtime Database ne supporte ni . ni / ni : — on hache l'endpoint.
// Bonus : le meme appareil qui se reabonne ecrase son entree au lieu d'en
// creer une deuxieme.
export function subKey(endpoint) {
  return crypto.createHash("sha1").update(String(endpoint)).digest("hex");
}
