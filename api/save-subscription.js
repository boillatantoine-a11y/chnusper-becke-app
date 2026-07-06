// api/save-subscription.js — Enregistre l'abonnement push d'un employé
const BIN_ID = '6a47e28cf5f4af5e295b2d76';
const API_KEY = '$2a$10$ojwWhUw28GI5ZG7/g/Cdn.F.t7OcPnW3Sca83hyF28XBmhyH6lD8y';

module.exports = async (req, res) => {
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
    const { user, subscription } = req.body;
    if (!user || !subscription) {
      return res.status(400).json({ error: 'user et subscription requis' });
    }

    // Récupérer les données actuelles du BIN
    const binResp = await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}/latest`, {
      headers: { 'X-Master-Key': API_KEY }
    });
    const binData = await binResp.json();
    const record = binData.record || {};

    // Ajouter/mettre à jour l'abonnement pour cette personne
    if (!record.pushSubs) record.pushSubs = {};
    record.pushSubs[user] = subscription;

    // Stocker aussi la date d'activation (séparément)
    if (!record.pushSubsInfo) record.pushSubsInfo = {};
    const now = new Date();
    const dateStr = String(now.getDate()).padStart(2,'0') + '.' +
                    String(now.getMonth()+1).padStart(2,'0') + '.' +
                    now.getFullYear() + ' ' +
                    String(now.getHours()).padStart(2,'0') + ':' +
                    String(now.getMinutes()).padStart(2,'0');
    record.pushSubsInfo[user] = { date: dateStr, ts: now.getTime() };

    // Sauvegarder dans le BIN
    await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': API_KEY
      },
      body: JSON.stringify(record)
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Save subscription error:', error);
    return res.status(500).json({ error: error.message });
  }
};
