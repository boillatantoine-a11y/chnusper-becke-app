// api/subscriptions.js — Fonction Vercel (Node)
// Deux usages :
//   GET  /api/subscriptions        → la VRAIE liste des abonnés, telle qu'elle
//                                    est enregistrée dans "push_subs".
//   POST /api/subscriptions        → { action: "reset" } efface tout,
//                                    { action: "delete", key: "..." } une seule
//                                    entrée.
//
// Jusqu'ici l'app affichait une liste reconstituée à partir de ce que chaque
// téléphone avait rapporté au nuage — pas celle du serveur. Un appareil qui ne
// s'était pas synchronisé n'y figurait pas, et un abonnement supprimé y restait.
//
// Variables d'env requises : FB_URL, FB_KEY

// ---------------------------------------------------------------------------
//  Acces REST a la Realtime Database, sans SDK.
//  Ce bloc est recopie a l'identique dans chaque fichier de api/ : Vercel ne
//  deploie pas les fichiers partages commencant par un tiret bas.
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

async function fbDel(path) {
  const r = await fetch(await fbEndpoint(path), { method: "DELETE" });
  if (!r.ok) throw new Error("Firebase DELETE " + r.status);
  return true;
}

// Le navigateur se devine à l'endpoint : utile pour reconnaître un appareil
// quand la même personne en a deux.
function origine(endpoint) {
  const e = String(endpoint || "");
  if (e.indexOf("web.push.apple.com") >= 0)      return "iPhone / iPad";
  if (e.indexOf("fcm.googleapis.com") >= 0)      return "Android / Chrome";
  if (e.indexOf("mozilla.com") >= 0)             return "Firefox";
  if (e.indexOf("notify.windows.com") >= 0)      return "Windows";
  return "—";
}

export default async function handler(req, res) {
  if (!process.env.FB_URL) {
    return res.status(200).json({ ok: false, error: "FB_URL manquante sur Vercel" });
  }

  try {
    // ---------------------------------------------------------- la liste ----
    if (req.method === "GET") {
      const map = (await fbGet("push_subs")) || {};
      const liste = Object.keys(map).map(function (k) {
        const s = map[k] || {};
        const ep = (s.subscription && s.subscription.endpoint) || "";
        return {
          key: k,
          user: s.user || "?",
          ts: s.ts || 0,
          appareil: origine(ep)
        };
      });
      liste.sort(function (a, b) {
        if (a.user === b.user) return b.ts - a.ts;
        return a.user.localeCompare(b.user);
      });
      return res.status(200).json({ ok: true, total: liste.length, abonnes: liste });
    }

    // ------------------------------------------------------ la suppression --
    if (req.method === "POST") {
      const { action, key } = req.body || {};

      if (action === "reset") {
        const map = (await fbGet("push_subs")) || {};
        const cles = Object.keys(map);
        let n = 0;
        for (const k of cles) {
          try { await fbDel("push_subs/" + k); n++; } catch (e) { /* on continue */ }
        }
        return res.status(200).json({ ok: true, supprimes: n });
      }

      if (action === "delete" && key) {
        await fbDel("push_subs/" + key);
        return res.status(200).json({ ok: true, supprimes: 1 });
      }

      return res.status(400).json({ ok: false, error: "action inconnue" });
    }

    return res.status(405).json({ ok: false, error: "GET ou POST" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
