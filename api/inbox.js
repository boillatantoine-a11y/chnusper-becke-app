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

const webpush = require("web-push");

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

    // Les notifications partent D'ICI, directement avec web-push. Quand c'était
    // l'app qui les envoyait, elles n'arrivaient que si quelqu'un avait l'app
    // ouverte — jamais sur un écran verrouillé. Le rappel de midi utilise déjà
    // cette méthode et fonctionne. L'ancien échec venait d'un appel HTTP de
    // serveur à serveur vers /api/send, pas de web-push lui-même.
    let envoyes = 0;
    try {
      envoyes = await prevenir(nom, ts);
    } catch (e) {
      // Une notification qui échoue ne doit pas faire échouer le dépôt
    }

    return res.status(200).json({ ok: true, name: nom, ts: ts,
                                  taille_ko: Math.round(octets / 1024),
                                  notifies: envoyes });
  } catch (e) {
    return res.status(200).json({ ok: false, reason: String((e && e.message) || e) });
  }
};

// ---------------------------------------------------------------------------
//  Prévenir l'équipe — depuis le serveur, pour que la notification arrive
//  même écran verrouillé, app fermée.
// ---------------------------------------------------------------------------

// Qui fait le Backzettel aujourd'hui, d'après l'onglet Monatsplan.
const NOMS_BZ = {
  "antoine": ["Antoine Boillat", "Antoine"],
  "timon":   ["Timon Burri", "Timon"],
  "deniz":   ["Deniz Teixeira", "Deniz"]
};

// La Konditorei reçoit sa propre notification à chaque dépôt.
const KONDITOREI = ["Stefanie Zeller", "Cornelia Zürcher", "Miguel Pascoal"];

async function quiFaitLeBackzettel() {
  let etat = null;
  try { etat = await fbGet("etat"); } catch (e) { return null; }
  if (typeof etat === "string") { try { etat = JSON.parse(etat); } catch (e) { return null; } }
  const mp = etat && etat.monatsplan;
  if (!mp) return null;

  const d = new Date();
  const mois = mp[d.getFullYear() + "-" + (d.getMonth() + 1)];
  if (!mois) return null;
  const brut = String(mois[String(d.getDate())] || "").trim();
  if (!brut) return null;

  const out = [];
  for (const m of brut.split(/[\/,+&]| et | und /i)) {
    const p = m.trim().toLowerCase();
    if (!p) continue;
    for (const cle in NOMS_BZ) {
      if (p.indexOf(cle) >= 0) {
        for (const n of NOMS_BZ[cle]) if (!out.includes(n)) out.push(n);
        break;
      }
    }
  }
  return out.length ? out : null;
}

async function envoyerA(abonnes, noms, titre, texte, tag) {
  let n = 0;
  const charge = JSON.stringify({ title: titre, body: texte, tag: tag, url: "/" });
  for (const nom of noms) {
    const sub = abonnes && abonnes[nom.replace(/[.#$/[\]]/g, "_")];
    if (!sub) continue;
    for (const s of (Array.isArray(sub) ? sub : [sub])) {
      try { await webpush.sendNotification(s, charge); n++; }
      catch (e) { console.log("Envoi refusé pour un abonné : " + (e && e.statusCode)); }
    }
  }
  return n;
}

async function prevenir(nomFichier, ts) {
  // Sans les clés VAPID, aucune notification ne peut partir du serveur — et
  // c'est exactement ce qui manquait : la seule notification reçue venait de
  // l'app, donc seulement quand elle était ouverte.
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.log("PAS DE NOTIFICATION : VAPID_PUBLIC_KEY ou VAPID_PRIVATE_KEY "
              + "manque dans les variables d'environnement Vercel.");
    return -1;
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:info@chnusper-becke.ch",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  let abonnes = null;
  try { abonnes = await fbGet("pushSubs"); } catch (e) { return 0; }
  if (!abonnes) return 0;

  // Un seul envoi par dépôt, même si le mail portait plusieurs PDF
  const marque = "notif_" + new Date(ts).toISOString().slice(0, 13);
  try {
    const deja = await fbGet(FB_FILES + "/" + marque);
    if (deja) return 0;
    await fbPut(FB_FILES + "/" + marque, ts);
  } catch (e) {}

  // Celui qui fait le Backzettel ce jour-là ; sinon les trois
  let cibles = null;
  try { cibles = await quiFaitLeBackzettel(); } catch (e) {}
  if (!cibles || !cibles.length) {
    cibles = ["Antoine Boillat", "Antoine", "Timon Burri", "Deniz Teixeira"];
  }

  let n = 0;
  n += await envoyerA(abonnes, cibles, "\ud83d\udcac Neues Backzettel",
                      "Ein neues Backzettel wurde hinterlegt", "bz-" + ts);
  n += await envoyerA(abonnes, KONDITOREI, "\ud83c\udf70 Konditorei",
                      "Die Konditorei-Produktionsliste ist bereit!", "kond-" + ts);
  return n;
}
