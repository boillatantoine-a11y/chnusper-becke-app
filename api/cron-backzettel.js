// api/cron-backzettel.js
// Rappel Backzettel — envoye a midi (voir vercel.json).
// Lit le MONATSPLAN dans la Realtime Database : pour le jour courant, la case
// contient le nom de la personne qui fait le Backzettel. Elle seule est prevenue.
//
// Test manuel depuis l'app : GET /api/cron-backzettel?force=1
//
// Variables d'env requises : FB_URL, FB_KEY

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


const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

function suisseNow() {
  const now = new Date();
  return new Date(now.toLocaleString("en-US", { timeZone: "Europe/Zurich" }));
}

export default async function handler(req, res) {
  const force = req.query && (req.query.force === "1" || req.query.force === 1);

  const today = suisseNow();
  const day = today.getDate();
  // Cle du mois telle qu'ecrite par l'app : "2026-7" (mois NON complete par un zero)
  const monthKey = today.getFullYear() + "-" + (today.getMonth() + 1);
  const dayText = JOURS[today.getDay()] + " " +
    String(day).padStart(2, "0") + "." +
    String(today.getMonth() + 1).padStart(2, "0");

  if (!force) {
    const secret = process.env.CRON_SECRET;
    const auth = req.headers["authorization"] || "";
    if (secret && auth !== "Bearer " + secret) {
      return res.status(401).json({ recipients: [], dayText, reason: "non autorise" });
    }
  }

  // 1) Lire le Monatsplan depuis Firebase
  let plan = null;
  try {
    const data = await fbGetEtat();
    if (!data) {
      return res.status(200).json({ recipients: [], dayText, reason: "etat vide dans Firebase" });
    }
    plan = data.monatsplan || null;
  } catch (e) {
    return res.status(200).json({
      recipients: [], dayText,
      reason: "lecture du Monatsplan impossible : " + (e && e.message ? e.message : String(e))
    });
  }

  if (!plan) {
    return res.status(200).json({ recipients: [], dayText, reason: "Monatsplan vide dans le cloud" });
  }

  const mois = plan[monthKey];
  if (!mois) {
    return res.status(200).json({ recipients: [], dayText, reason: "aucune entree pour " + monthKey });
  }

  // 2) Qui est inscrit aujourd'hui
  const nom = String(mois[String(day)] || mois[day] || "").trim();
  if (!nom) {
    return res.status(200).json({
      recipients: [], dayText,
      reason: "aucun nom inscrit le " + day + " dans le Monatsplan"
    });
  }

  // Correspondance prenom ecrit dans le Monatsplan -> compte dans l'app
  const NOMS = {
    "antoine": "Antoine",
    "timon":   "Timon Burri",
    "deniz":   "Deniz Teixeira"
  };
  // Plusieurs noms possibles, separes par virgule ou slash
  const recipients = nom
    .split(/[,\/]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => NOMS[s.toLowerCase()] || s);

  // 3) Envoyer le rappel a cette personne uniquement
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const base = proto + "://" + host;

  try {
    const resp = await fetch(base + "/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "🥖 Backzettel",
        body: "Ce soir tu fais le Backzettel (" + dayText + ").",
        url: "/",
        recipients: recipients
      })
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(function () { return ""; });
      return res.status(200).json({
        recipients: [], dayText,
        reason: "/api/send a repondu " + resp.status + " " + txt.slice(0, 120)
      });
    }
    return res.status(200).json({ recipients, dayText });
  } catch (e) {
    return res.status(200).json({
      recipients: [], dayText,
      reason: "envoi impossible : " + (e && e.message ? e.message : String(e))
    });
  }
}
