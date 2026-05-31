const express = require('express');
const cron = require('node-cron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'latest.json');

// ── Servir les fichiers statiques ──────────────────────────────────────────
app.use(express.static(__dirname));

// ── API : retourne latest.json ─────────────────────────────────────────────
app.get('/api/latest', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return res.json({ ts: null, results: {} });
    }
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    res.json(data);
  } catch (err) {
    res.json({ ts: null, results: {}, error: err.message });
  }
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── Fonction de scraping ───────────────────────────────────────────────────
function runScraper() {
  console.log(`[${new Date().toISOString()}] Lancement du scraper...`);
  const env = { ...process.env, DATA_DIR: __dirname };
  execFile('node', ['scraper.js'], { env, timeout: 300000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('Erreur scraper :', err.message);
    } else {
      console.log('Scraper terminé :', stdout.slice(-200));
    }
  });
}

// ── Cron : toutes les 30 minutes exactement ────────────────────────────────
cron.schedule('*/30 * * * *', () => {
  runScraper();
}, { timezone: 'Europe/Paris' });

// ── Démarrage ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🎰  Jackpots Paris — port ${PORT}`);
  // Lancer un scrape immédiat au démarrage
  runScraper();
});
