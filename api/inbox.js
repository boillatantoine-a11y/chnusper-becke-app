// api/inbox.js
//
// Reçoit un Backzettel envoyé par e-mail et le dépose dans le cloud, au même
// endroit que le bouton de dépôt de l'app. Il apparaît ensuite tout seul dans
// la liste des Backzettel et dans l'onglet Konditorei.
//
// À DÉPLOYER :
//   1. place ce fichier dans  api/inbox.js  à la racine du projet Vercel
//   2. ajoute les variables d'environnement sur Vercel :
//        FB_URL      l'URL de ta base Firebase (la même que l'app)
//        FB_KEY      la clé Web API Firebase
//        INBOX_TOKEN un mot de passe que TU choisis (ex. une longue suite
//                    de lettres et de chiffres) — il empêche n'importe qui
//                    de déposer un faux Backzettel
//
// Le service attend un POST JSON :
//   { token: "...", name: "Backliste.pdf", data: "data:application/pdf;base64,...",
//     from: "chef@chnusper-becke.ch", recipient: null }

const FB_URL = (process.env.FB_URL || "").replace(/\/+$/, "");
const FB_KEY = process.env.FB_KEY || "";
const TOKEN  = process.env.INBOX_TOKEN || "";

const FB_FILES = "fichiers";
const DOUZE_H  = 12 * 60 * 60 * 1000;
const MAX_MO   = 10;

// Firebase en REST, comme le reste du projet
let cache = null;
async function jeton() {
  if (!FB_KEY) return null;
  const now = Date.now();
  if (cache && cache.exp > now + 60000) return cache.id;
  const r = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + FB_KEY,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true }) });
  if (!r.ok) throw new Error("Auth Firebase " + r.status);
  const j = await r.json();
  cache = { id: j.idToken, exp: now + (parseInt(j.expiresIn, 10) || 3600) * 1000 };
  return cache.id;
}

async function url(chemin) {
  if (!FB_URL) throw new Error("FB_URL manquante");
  const t = await jeton();
  return FB_URL + "/" + chemin + ".json" + (t ? "?auth=" + encodeURIComponent(t) : "");
}
async function fbGet(chemin) {
  const r = await fetch(await url(chemin));
  if (!r.ok) throw new Error("GET " + r.status);
  return r.json();
}
async function fbPut(chemin, valeur) {
  const r = await fetch(await url(chemin), {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(valeur) });
  if (!r.ok) throw new Error("PUT " + r.status);
}
async function fbDel(chemin) {
  await fetch(await url(chemin), { method: "DELETE" }).catch(() => {});
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, reason: "POST attendu" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    // Le mot de passe : sans lui, n'importe qui pourrait déposer un Backzettel
    if (!TOKEN || body.token !== TOKEN) {
      return res.status(401).json({ ok: false, reason: "token invalide" });
    }

    const nom  = String(body.name || "Backzettel.pdf");
    const data = String(body.data || "");

    if (!data.startsWith("data:application/pdf")) {
      return res.status(200).json({ ok: false, reason: "ce n'est pas un PDF" });
    }
    // Taille approximative : le base64 pèse 4/3 du fichier
    const octets = Math.round((data.length - data.indexOf(",") - 1) * 0.75);
    if (octets > MAX_MO * 1024 * 1024) {
      return res.status(200).json({ ok: false, reason: "PDF trop lourd (" +
        Math.round(octets / 1024 / 1024) + " Mo, limite " + MAX_MO + ")" });
    }

    const ts = Date.now();
    const now = ts;

    // Ménage : on retire les Backzettel de plus de douze heures, comme le fait
    // l'app. Sans ça, la base enflerait à chaque envoi.
    try {
      const idx = await fbGet(FB_FILES + "/pdfs");
      for (const k in idx) {
        const e = idx[k];
        if (!e || !e.ts || (now - e.ts) > DOUZE_H) {
          await fbDel(FB_FILES + "/pdfs/" + k);
        }
      }
    } catch (e) { /* la base est peut-être vide : ce n'est pas une erreur */ }

    const heure = new Date(ts).toLocaleTimeString("fr-CH",
      { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" });

    await fbPut(FB_FILES + "/pdfs/ts_" + ts, {
      name: nom,
      data: data,
      ts: ts,
      by: body.from ? String(body.from).split("@")[0] : "e-mail",
      time: heure,
      recipient: body.recipient || null
    });

    // Les notifications ne partent PLUS d'ici. Un appel de serveur à serveur
    // vers /api/send échouait sans bruit sur Vercel : personne n'était prévenu.
    // C'est l'app qui les envoie, au moment où elle découvre le PDF — le même
    // chemin que pour un dépôt manuel, qui fonctionne depuis toujours.

    return res.status(200).json({ ok: true, name: nom, ts: ts,
                                  taille_ko: Math.round(octets / 1024) });
  } catch (e) {
    return res.status(200).json({ ok: false, reason: String((e && e.message) || e) });
  }
};
