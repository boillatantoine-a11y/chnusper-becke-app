// api/send.js — Envoie des notifications push aux abonnés concernés
const webpush = require('web-push');

// Configuration VAPID
const VAPID_PUBLIC = 'BJ_B6lZVtFCm87VEW3W5x6NFpmWlhYhzI2JJIzz2lSIYwep2hzooklDmh9yeSD6O38MRdn3OoM1_3tyAIZ1BgDo';
const VAPID_PRIVATE = 's33-1XalyBqOzpgqU1FiuLeH0DQsTvBTpjJ7P4ueAdk';

webpush.setVapidDetails(
  'mailto:contact@chnusper-becke.ch',
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

// JSONBin config (même bin que l'app)
const BIN_ID = '6a47e28cf5f4af5e295b2d76';
const API_KEY = '$2a$10$ojwWhUw28GI5ZG7/g/Cdn.F.t7OcPnW3Sca83hyF28XBmhyH6lD8y';

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { title, body, recipients } = req.body;
    // recipients = tableau de noms d'employés à notifier

    // Récupérer les abonnements depuis JSONBin
    const binResp = await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}/latest`, {
      headers: { 'X-Master-Key': API_KEY }
    });
    const binData = await binResp.json();
    const record = binData.record || {};
    const subscriptions = record.pushSubs || {};

    let sent = 0;
    let failed = 0;
    const promises = [];

    // Pour chaque personne à notifier
    for (const name of (recipients || Object.keys(subscriptions))) {
      const sub = subscriptions[name];
      if (!sub) continue;

      const payload = JSON.stringify({
        title: title || 'Chnusper Becke',
        body: body || 'Nouvelle notification',
      });

      const p = webpush.sendNotification(sub, payload)
        .then(() => { sent++; })
        .catch((err) => {
          failed++;
          console.error(`Push failed for ${name}:`, err.statusCode);
        });
      promises.push(p);
    }

    await Promise.all(promises);

    return res.status(200).json({ success: true, sent, failed });
  } catch (error) {
    console.error('Send error:', error);
    return res.status(500).json({ error: error.message });
  }
};
