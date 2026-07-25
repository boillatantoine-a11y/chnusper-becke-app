// api/cron-backzettel.js
// Rappel Backzettel — envoye a midi (voir vercel.json).
// Lit l'onglet MONATSPLAN dans la Realtime Database : pour le jour courant,
// la case contient le nom de la personne qui fait le Backzettel.
// Seule cette personne recoit la notification.
//
// Test manuel depuis l'app : GET /api/cron-backzettel?force=1
//
// Variables d'env requises : FB_URL, FB_KEY

import { fbGetEtat } from "./_firebase.js";

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
