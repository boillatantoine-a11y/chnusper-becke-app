// api/cron-backzettel.js
// Rappel Backzettel — envoyé à midi par le cron Vercel (voir vercel.json).
// Réutilise /api/send pour l'envoi, donc rien à savoir ici sur les abonnements push.
//
// Test manuel depuis l'app : GET /api/cron-backzettel?force=1

const BZ_RECIPIENTS = [
  "Antoine",
  "Deniz Teixeira",
  "Timon Burri"
];

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

function demainTexte() {
  // Heure suisse (UTC+1 hiver / UTC+2 été) — suffisant pour nommer le jour
  const now = new Date();
  const suisse = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Zurich" }));
  const demain = new Date(suisse);
  demain.setDate(demain.getDate() + 1);
  const jour = JOURS[demain.getDay()];
  const d = String(demain.getDate()).padStart(2, "0");
  const m = String(demain.getMonth() + 1).padStart(2, "0");
  return `${jour} ${d}.${m}`;
}

export default async function handler(req, res) {
  const force = req.query && (req.query.force === "1" || req.query.force === 1);
  const dayText = demainTexte();

  // Sécurité : hors test manuel, on n'accepte que le cron Vercel
  if (!force) {
    const secret = process.env.CRON_SECRET;
    const auth = req.headers["authorization"] || "";
    if (secret && auth !== `Bearer ${secret}`) {
      return res.status(401).json({ recipients: [], dayText, reason: "non autorisé" });
    }
  }

  const recipients = BZ_RECIPIENTS;

  if (!recipients.length) {
    return res.status(200).json({ recipients: [], dayText, reason: "aucun destinataire configuré" });
  }

  // Base URL du déploiement courant
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const base = `${proto}://${host}`;

  try {
    const resp = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "🥖 Backzettel",
        body: `Ce soir tu fais le Backzettel pour ${dayText}.`,
        url: "/",
        recipients: recipients
      })
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return res.status(200).json({
        recipients: [],
        dayText,
        reason: `/api/send a répondu ${resp.status} ${txt.slice(0, 120)}`
      });
    }

    return res.status(200).json({ recipients, dayText });
  } catch (e) {
    return res.status(200).json({
      recipients: [],
      dayText,
      reason: "envoi impossible : " + (e && e.message ? e.message : String(e))
    });
  }
}
