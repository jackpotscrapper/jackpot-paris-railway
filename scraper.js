const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '.';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── 1. Imperial Club Paris ───────────────────────────────────────────────────
async function scrapeImperial(page) {
  await sleep(3000);
  return page.evaluate(() => {
    const clean = (raw) => {
      const d = (raw || '').replace(/[^\d]/g, '');
      if (!d || parseInt(d, 10) < 100) return null;
      return parseInt(d, 10).toLocaleString('fr-FR') + ' €';
    };
    let blackjack_minor = null, blackjack_major = null, ultimate = null;

    document.querySelectorAll('*').forEach(el => {
      if (el.children.length > 3) return;
      const t = el.textContent.trim();
      if (!t || t.length > 60) return;
      if (/^MINOR\s+[\d.,\s]+€/.test(t)) {
        const m = t.match(/[\d.,]+/); if (m) blackjack_minor = clean(m[0]);
      }
      if (/^MAJOR\s+[\d.,\s]+€/.test(t)) {
        const m = t.match(/[\d.,]+/); if (m) blackjack_major = clean(m[0]);
      }
    });

    document.querySelectorAll('*').forEach(el => {
      if (el.children.length > 3) return;
      const t = el.textContent.trim();
      if (!t || t.length > 30) return;
      if (t.includes('MINOR') || t.includes('MAJOR')) return;
      if (/^[\d.,\s]+€$/.test(t)) {
        const n = parseInt(t.replace(/[^\d]/g, ''), 10);
        if (n > 5000) ultimate = clean(t);
      }
    });
    return { blackjack_minor, blackjack_major, ultimate };
  });
}

// ─── 2. Club Barrière Paris ───────────────────────────────────────────────────
async function scrapeBarriere(page) {
  await sleep(4000);
  const grab = () => page.evaluate(() => {
    const clean = (raw) => {
      const d = (raw || '').replace(/[^\d]/g, '');
      if (!d || parseInt(d, 10) < 100) return null;
      return parseInt(d, 10).toLocaleString('fr-FR') + ' €';
    };
    const amtEl  = document.querySelector('.CsnJackpot__amount');
    const nameEl = document.querySelector('.CsnJackpot__name');
    if (!amtEl || !nameEl) return null;
    const amt  = clean(amtEl.textContent.trim());
    const name = nameEl.textContent.trim().toLowerCase();
    if (!amt) return null;
    // "minor blackjack" → minor, "blackjack" seul → major, "ultimate" → ultimate
    if (name.includes('minor')) return { type: 'blackjack_minor', amt };
    if (name.includes('blackjack') || name.includes('black jack')) return { type: 'blackjack_major', amt };
    if (name.includes('ultimate') || name.includes('hold')) return { type: 'ultimate', amt };
    return { type: 'unknown_' + name.slice(0,20), amt }; // log pour debug
  });
  const collected = { blackjack_minor: null, blackjack_major: null, ultimate: null };
  // Ne jamais s'arrêter tôt : laisser tourner 40s pour voir défiler les 3 jackpots
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const snap = await grab().catch(() => null);
    if (snap) collected[snap.type] = snap.amt;
    await sleep(700);
  }
  return collected;
}

// ─── 3. Paris Élysées Club ────────────────────────────────────────────────────
async function scrapeElysees(page) {
  await sleep(3000);
  return page.evaluate(() => {
    const clean = (raw) => {
      const d = (raw || '').replace(/[^\d]/g, '');
      if (!d || parseInt(d, 10) < 100) return null;
      return parseInt(d, 10).toLocaleString('fr-FR') + ' €';
    };
    const result = { blackjack: null, ultimate: null };
    document.querySelectorAll('article.jackpot-card').forEach(card => {
      const label = card.querySelector('p.jackpot-label');
      const value = card.querySelector('p.jackpot-value');
      if (!label || !value) return;
      const lbl = label.textContent.trim().toUpperCase();
      const amt = clean(value.textContent.trim());
      if (!amt) return;
      if (lbl.includes('BLACKJACK')) result.blackjack = amt;
      else if (lbl.includes('ULTIMATE')) result.ultimate = amt;
    });
    return result;
  });
}

// ─── 4. Club Circus Paris ─────────────────────────────────────────────────────
// Compteurs animés : chaque chiffre est dans un <span> séparé.
// element.textContent colle tous les chiffres → illisible.
// Solution : TreeWalker sur les noeuds TEXTE bruts pour lire chaque span
// individuellement, puis reconstituer les nombres par conteneur parent.
async function scrapeCircus(page) {
  await sleep(7000);
  return page.evaluate(() => {
    const intro = document.querySelector('#intro');
    if (!intro) return { blazing_blackjack: null, uth_progressive: null };

    const amounts = new Set();

    // ── Stratégie 1 : attributs data-* portant la valeur cible du compteur ──
    intro.querySelectorAll('*').forEach(el => {
      ['value','target','count','number','amount','final'].forEach(attr => {
        const v = el.dataset[attr];
        if (!v) return;
        const n = parseFloat(v.replace(/[^0-9.]/g, ''));
        if (n > 1000 && n < 10000000) amounts.add(Math.floor(n));
      });
    });

    // ── Stratégie 2 : TreeWalker sur les noeuds texte bruts ──
    // Chaque span d'un compteur contient UN chiffre → on remonte au parent
    // commun pour reconstituer le nombre complet
    const seen = new WeakSet();
    const walker = document.createTreeWalker(intro, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      // Noeud texte contenant uniquement des chiffres/virgule/point/espace
      if (!/^[\d\s.,]+$/.test(t) || t.length === 0) continue;

      // Remonter au parent englobant (jusqu'à 4 niveaux) et lire son innerText
      let el = node.parentElement;
      for (let i = 0; i < 4 && el && el !== intro; i++, el = el.parentElement) {
        if (seen.has(el)) continue;
        seen.add(el);
        const raw = el.innerText || el.textContent || '';
        // Chercher le format "XX XXX,XX" (avec ou sans espace, séparateur virgule)
        const matches = [...raw.matchAll(/(\d[\d\s.]*),(\d{2})/g)];
        matches.forEach(m => {
          const n = parseInt(m[1].replace(/[\s.]/g, ''), 10);
          if (n > 1000 && n < 10000000) amounts.add(n);
        });
        // Aussi chercher juste de grands entiers si pas de virgule
        const intMatches = [...raw.matchAll(/\b(\d{2}\s?\d{3})\b/g)];
        intMatches.forEach(m => {
          const n = parseInt(m[1].replace(/\s/g, ''), 10);
          if (n > 5000 && n < 10000000) amounts.add(n);
        });
      }
    }

    // ── Stratégie 3 : fallback texte brut de toute la section #intro ──
    if (amounts.size < 2) {
      const raw = intro.innerText || intro.textContent || '';
      const matches = [...raw.matchAll(/(\d[\d\s.]*),(\d{2})/g)];
      matches.forEach(m => {
        const n = parseInt(m[1].replace(/[\s.]/g, ''), 10);
        if (n > 1000 && n < 10000000) amounts.add(n);
      });
    }

    const sorted = [...amounts].sort((a, b) => b - a);
    return {
      uth_progressive:   sorted[0] ? sorted[0].toLocaleString('fr-FR') + ' €' : null,
      blazing_blackjack: sorted[1] ? sorted[1].toLocaleString('fr-FR') + ' €' : null,
    };
  });
}

// ─── 5. Club Pierre Charron ───────────────────────────────────────────────────
async function scrapePierreCharron(page) {
  await sleep(6000);
  return page.evaluate(() => {
    const clean = (raw) => {
      if (!raw) return null;
      const d = raw.replace(/[^\d]/g, '');
      if (!d || parseInt(d, 10) < 100) return null;
      return parseInt(d, 10).toLocaleString('fr-FR') + ' €';
    };
    const result = { blackjack_minor: null, blackjack_major: null, ultimate: null };

    const multiItem = document.querySelector('.jackpot-widget-item .content.-multi');
    if (multiItem) {
      multiItem.querySelectorAll('.jackpot-aside-amount').forEach(aside => {
        const titleEl = aside.querySelector('.jackpot-title');
        const amtEl   = aside.querySelector('.jackpot-small');
        if (!titleEl || !amtEl) return;
        const title = titleEl.textContent.trim().toLowerCase();
        const amt   = clean(amtEl.textContent.trim());
        if (title.includes('minor')) result.blackjack_minor = amt;
        if (title.includes('méga') || title.includes('mega') || title.includes('major')) result.blackjack_major = amt;
      });
      if (!result.blackjack_major) {
        const mainAmt = multiItem.querySelector('.jackpot-main-amount');
        if (mainAmt) {
          const cloned = mainAmt.cloneNode(true);
          cloned.querySelectorAll('.jackpot-aside-amount').forEach(e => e.remove());
          const v = clean(cloned.textContent.trim());
          if (v) result.blackjack_major = v;
        }
      }
    }

    document.querySelectorAll('.jackpot-widget-item').forEach(item => {
      if (item.querySelector('.content.-multi')) return;
      const amtEl = item.querySelector('.jackpot-main-amount');
      if (amtEl) {
        const v = clean(amtEl.textContent.trim());
        if (v) result.ultimate = v;
      }
    });

    return result;
  });
}

// ─── Scraper principal ────────────────────────────────────────────────────────
const clubs = [
  { id: 'imperial',      name: 'Imperial Club Paris',    url: 'https://imperialclubparis.com/',                scrapeFn: scrapeImperial },
  { id: 'barriere',      name: 'Club Barrière Paris',    url: 'https://www.casinosbarriere.com/paris',         scrapeFn: scrapeBarriere },
  { id: 'elyseesclub',   name: 'Paris Élysées Club',     url: 'https://www.pariselyseesclub.com/',             scrapeFn: scrapeElysees },
  { id: 'circus',        name: 'Club Circus Paris',      url: 'https://www.circuscasino.fr/fr/casinos/paris/', scrapeFn: scrapeCircus },
  { id: 'pierrecharron', name: 'Club Pierre Charron',    url: 'https://www.clubpierrecharron.com/',            scrapeFn: scrapePierreCharron },
];

async function scrapeClub(browser, club) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });
    console.log(`  → ${club.url}`);
    await page.goto(club.url, { waitUntil: 'networkidle2', timeout: 45000 });
    const data = await club.scrapeFn(page);
    console.log(`  ✓ ${club.name} :`, JSON.stringify(data));
    return { ok: true, data };
  } catch (err) {
    console.error(`  ✗ ${club.name} : ${err.message}`);
    return { ok: false, error: err.message, data: {} };
  } finally {
    await page.close();
  }
}

async function main() {
  console.log('🎰  Jackpots Paris — ' + new Date().toISOString());
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  const results = {};
  for (const club of clubs) {
    console.log(`\n[${club.id}]`);
    results[club.id] = await scrapeClub(browser, club);
  }
  await browser.close();
  const output = { ts: new Date().toISOString(), results };
  const outPath = path.join(DATA_DIR, 'latest.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log('\n✅  latest.json sauvegardé');
  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
