// api/diag.js — DIAGNOSTIC. A supprimer une fois le probleme regle.
// Ouvrir : https://chnusper-becke-app.vercel.app/api/diag
// Ne revele aucune valeur secrete : seulement present / absent.

export default async function handler(req, res) {
  const present = (k) => !!(process.env[k] && String(process.env[k]).trim());

  const out = {
    node: process.version,
    variables: {
      FB_URL:            present("FB_URL"),
      FB_KEY:            present("FB_KEY"),
      VAPID_PUBLIC_KEY:  present("VAPID_PUBLIC_KEY"),
      VAPID_PRIVATE_KEY: present("VAPID_PRIVATE_KEY"),
      VAPID_SUBJECT:     present("VAPID_SUBJECT"),
      JSONBIN_KEY:       present("JSONBIN_KEY"),
      SUBS_BIN_ID:       present("SUBS_BIN_ID"),
      CRON_SECRET:       present("CRON_SECRET")
    },
    webpush: "non teste",
    firebase: "non teste"
  };

  // 1) le paquet web-push est-il installe ?
  try {
    await import("web-push");
    out.webpush = "module trouve";
  } catch (e) {
    out.webpush = "MODULE ABSENT : " + (e && e.message ? e.message : String(e));
  }

  // 2) Firebase repond-il ?
  try {
    const FB_URL = (process.env.FB_URL || "").replace(/\/+$/, "");
    const FB_KEY = process.env.FB_KEY || "";
    if (!FB_URL) {
      out.firebase = "FB_URL absente";
    } else {
      let auth = "";
      if (FB_KEY) {
        const r = await fetch(
          "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + FB_KEY,
          { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ returnSecureToken: true }) });
        if (!r.ok) {
          out.firebase = "authentification refusee : " + r.status;
          return res.status(200).json(out);
        }
        const j = await r.json();
        auth = "?auth=" + encodeURIComponent(j.idToken);
      }
      const r2 = await fetch(FB_URL + "/push_subs.json" + auth);
      if (!r2.ok) {
        out.firebase = "lecture refusee : " + r2.status;
      } else {
        const data = await r2.json();
        out.firebase = "OK";
        out.abonnes_dans_firebase = data ? Object.keys(data).length : 0;
        // Sous quel nom de compte chaque appareil est-il enregistre, et quand ?
        out.abonnes = [];
        if (data) {
          for (const k in data) {
            if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
            const s = data[k] || {};
            const ep = (s.subscription && s.subscription.endpoint) || "";
            out.abonnes.push({
              compte: s.user || "?",
              enregistre_le: s.ts ? new Date(s.ts).toISOString().slice(0, 16).replace("T", " ") : "?",
              service: ep.indexOf("apple") >= 0 ? "Apple" :
                       ep.indexOf("google") >= 0 ? "Google" : "autre"
            });
          }
        }
      }
    }
  } catch (e) {
    out.firebase = "erreur : " + (e && e.message ? e.message : String(e));
  }

  return res.status(200).json(out);
}
