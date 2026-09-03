// api/cron-backzettel.js
//
// Le rappel de midi « tu fais le Backzettel ce soir » NE PEUT PAS partir de
// l'app : une PWA fermée n'exécute aucun code. Il faut un service côté
// serveur, déclenché par une planification Vercel. C'est ce fichier.
//
// À DÉPLOYER :
//   1. place ce fichier dans  api/cron-backzettel.js  à la racine du projet
//   2. ajoute la planification dans vercel.json (voir plus bas)
//   3. renseigne les variables d'environnement sur Vercel :
//        FB_URL             l'URL de ta base Firebase
//        VAPID_PUBLIC_KEY   la clé publique des notifications
//        VAPID_PRIVATE_KEY  la clé privée
//        VAPID_SUBJECT      mailto:ton@adresse
//   4. installe la dépendance :  npm install web-push
//
// vercel.json :
//   { "crons": [ { "path": "/api/cron-backzettel", "schedule": "0 11 * * *" } ] }
//
//   11h UTC = 12h en Suisse l'hiver, 13h l'été. Pour viser midi toute
//   l'année, il faudrait deux planifications ; Vercel n'accepte que l'UTC.

const webpush = require("web-push");

const FB = (process.env.FB_URL || "").replace(/\/$/, "");

// Le rappel lit l'onglet MONATSPLAN — la liste où Antoine inscrit, jour par
// jour, QUI fait le Backzettel. Un seul nom par jour, écrit en clair.
// Ce n'est PAS le planning de l'équipe : celui-là dit qui travaille, pas qui
// fait la feuille. Le service lisait le mauvais tableau et prévenait tous
// ceux qui étaient de service le soir.
//
// Forme des données : cb_monatsplan["2026-9"]["3"] = "Deniz"
//                     (l'année et le mois SANS zéro devant)

// Le prénom du Monatsplan -> la clé d'abonné aux notifications.
// Antoine s'abonne sous « Antoine Boillat » ou « Antoine » selon l'appareil :
// on tente les deux, le service d'envoi ignore ce qu'il ne connaît pas.
const NOMS_PUSH = {
  "antoine": ["Antoine Boillat", "Antoine"],
  "timon":   ["Timon Burri", "Timon"],
  "deniz":   ["Deniz Teixeira", "Deniz"]
};

async function fbGet(chemin) {
  const r = await fetch(`${FB}/${chemin}.json`);
  if (!r.ok) throw new Error(`Firebase ${r.status}`);
  return r.json();
}

function dateDemain() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const a = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const j = String(d.getDate()).padStart(2, "0");
  return {
    iso: `${a}-${m}-${j}`,
    moisCle: `${a}-${m}`,
    annee: a,
    mois: d.getMonth() + 1,          // SANS zéro devant : la clé du Monatsplan
    jour: d.getDate(),
    texte: `${d.getDate()}.${d.getMonth() + 1}.`
  };
}

// Qui fait le Backzettel ce jour-là, d'après l'onglet Monatsplan
function destinatairesPour(monatsplan, dem) {
  if (!monatsplan) return [];

  // La clé du mois s'écrit sans zéro devant : "2026-9", pas "2026-09"
  const cle = dem.annee + "-" + dem.mois;
  const mois = monatsplan[cle];
  if (!mois) return [];

  const brut = String(mois[String(dem.jour)] || "").trim();
  if (!brut) return [];

  // Une case peut contenir deux noms (« Antoine / Deniz »)
  const morceaux = brut.split(/[\/,+&]| et | und /i);
  const out = [];
  for (const m of morceaux) {
    const p = m.trim().toLowerCase();
    if (!p) continue;
    for (const cleN in NOMS_PUSH) {
      if (p.indexOf(cleN) >= 0) {
        for (const n of NOMS_PUSH[cleN]) if (!out.includes(n)) out.push(n);
        break;
      }
    }
  }
  return out;
}

module.exports = async (req, res) => {
  const force = req.query && req.query.force === "1";
  const dem = dateDemain();

  try {
    if (!FB) {
      return res.status(200).json({ ok: false, reason: "FB_URL absente des variables d'environnement" });
    }

    // Le Monatsplan n'est PAS un nœud séparé : il voyage à l'intérieur de
    // l'état général, sous "etat". Le service lisait un chemin qui n'existe
    // pas et ne trouvait donc jamais personne.
    const [etatBrut, abonnes] = await Promise.all([
      fbGet("etat").catch(() => null),
      fbGet("pushSubs").catch(() => null),
    ]);

    let etat = etatBrut;
    // L'app enregistre l'état sous forme de texte JSON
    if (typeof etat === "string") {
      try { etat = JSON.parse(etat); } catch (e) { etat = null; }
    }
    const monatsplan = (etat && etat.monatsplan) ? etat.monatsplan : null;

    const noms = destinatairesPour(monatsplan, dem);

    // En mode diagnostic on ne notifie personne : on répond seulement QUI
    // serait notifié. C'est ce que lit le bouton « Pourquoi je ne reçois
    // pas le rappel ? » dans l'app.
    if (force) {
      return res.status(200).json({
        ok: true, force: true, dayText: dem.texte, recipients: noms,
        abonnesConnus: abonnes ? Object.keys(abonnes).length : 0,
        reason: noms.length ? null : ("aucun nom au Monatsplan pour le " + dem.jour + "."
                  + dem.mois + " — clé cherchée : " + dem.annee + "-" + dem.mois),
      });
    }

    if (!noms.length) {
      return res.status(200).json({ ok: true, sent: 0, reason: "aucun destinataire demain" });
    }

    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:info@chnusper-becke.ch",
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    const charge = JSON.stringify({
      title: "🥖 Backzettel",
      body: `Tu fais le Backzettel ce soir pour demain ${dem.texte}`,
      tag: "backzettel-" + dem.iso,
      url: "/",
    });

    let envoyes = 0, perimes = 0;
    for (const nom of noms) {
      const sub = abonnes && abonnes[nom.replace(/[.#$/[\]]/g, "_")];
      if (!sub) continue;
      const liste = Array.isArray(sub) ? sub : [sub];
      for (const s of liste) {
        try {
          await webpush.sendNotification(s, charge);
          envoyes++;
        } catch (e) {
          // 404 et 410 : l'abonnement de l'appareil a expiré
          if (e.statusCode === 404 || e.statusCode === 410) perimes++;
        }
      }
    }

    return res.status(200).json({ ok: true, sent: envoyes, expired: perimes, recipients: noms, dayText: dem.texte });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
};
