/**
 * OFFscript Lead Scraper worker.
 * Reads the `agents/scraper` config from Firestore, and when a run is requested
 * (runRequested > runStartedAt, or --force), builds an outreach-ready lead list:
 *   1. geocode the configured location (OpenStreetMap Nominatim, free)
 *   2. query OpenStreetMap Overpass by radius + selected niches
 *   3. extract website / phone / socials, best-effort scrape site for a contact email
 *   4. verify each email (syntax -> junk-pattern -> MX record) and DROP failures
 *   5. flag franchises/chains, suggest a routing tag (T1/T2/T3/T4)
 *   6. write deduped leads to the `prospects` collection for the Cold Outreach agent
 *
 * Ported from prospect_scraper.py v2. Free sources only (no API key needed).
 * SAFETY: emails are MX-checked but NOT marked human-verified — the outreach
 * agent/queue must not send until a human confirms each address (Spam Act ss20-22).
 *
 * Income filtering: the `incomeType` control is stored and stamped on every lead,
 * but real per-suburb income filtering needs a demographic dataset (ABS SEIFA by
 * postcode). Until that's wired, incomeType is pass-through (recorded, not dropped).
 * See TODO(income) below.
 *
 * Pass --force to run regardless of runRequested. Pass --dry to run the scrape but
 * write no prospects (still updates run status).
 */
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const dns = require('dns').promises;

const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry');

function loadCreds() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  throw new Error('No Firebase creds');
}
initializeApp({ credential: cert(loadCreds()), projectId: 'offscript-platform-8deb4' });
const db = getFirestore();

// ---------------------------------------------------------------- constants
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const UA = { 'User-Agent': 'offscript-prospect-research/2.0 (small business outreach; contact via offscriptcrew.com.au)' };
const SERVER_LIMIT = 400;

// niche -> Overpass fragments (an `{around}` placeholder is filled per run)
const NICHE_QUERIES = {
  gyms: [
    'nwr["leisure"="fitness_centre"]({around});',
    'nwr["sport"~"fitness|crossfit|gym",i]({around});',
  ],
  wellness: [
    'nwr["sport"~"yoga|pilates",i]({around});',
    'nwr["shop"="massage"]({around});',
    'nwr["healthcare"~"physiotherapist|alternative",i]({around});',
    'nwr["leisure"="sports_centre"]["sport"~"yoga|pilates",i]({around});',
  ],
  hospitality: [
    'nwr["amenity"~"^(cafe|restaurant|bar|pub)$"]({around});',
  ],
  trades: [
    'nwr["craft"~"electrician|plumber|carpenter|painter|hvac|roofer|tiler|gardener",i]({around});',
    'nwr["shop"~"^(trade|doityourself)$"]({around});',
  ],
};

const KNOWN_CHAINS = new Set([
  'anytime fitness', 'f45', 'snap fitness', 'jetts', 'goodlife', 'fitness first',
  'plus fitness', 'world gym', 'fernwood', 'curves', 'bft', '12rnd',
  "mcdonald's", 'kfc', 'subway', "domino's", "hungry jack's", 'guzman y gomez',
  'zambrero', "grill'd", 'boost juice', "gloria jean's", 'the coffee club',
  "zarraffa's", 'starbucks', "nando's", 'red rooster', 'sushi hub',
  "jim's mowing", 'hire a hubby',
]);

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const JUNK_EMAIL = /(sentry|wixpress|godaddy|squarespace|shopify|cloudflare|example\.|\.png|\.jpe?g|\.gif|\.webp|\.svg|noreply|no-reply|donotreply)/i;
const SOCIAL_RE = /(?:instagram\.com|facebook\.com|tiktok\.com)\/[A-Za-z0-9_.\-]{2,60}/gi;
const LONGFORM_RE = /(youtube\.com\/(?:@|channel|user|c\/)|youtu\.be\/|podcast|spotify\.com\/show|buzzsprout|libsyn|vimeo\.com\/)/i;
const SOCIAL_AS_SITE = /^https?:\/\/(www\.)?(instagram|facebook|tiktok|linktr)\./i;

// ---------------------------------------------------------------- utilities
const log = (...m) => console.log(...m);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

function normalizePhone(raw) {
  if (!raw) return '';
  let d = String(raw).split(';')[0].replace(/[^\d+]/g, '');
  if (d.startsWith('+61')) d = '0' + d.slice(3);
  else if (d.startsWith('61') && d.length >= 11) d = '0' + d.slice(2);
  if (d.length === 10 && d.startsWith('0')) {
    if (d.startsWith('04')) return `${d.slice(0,4)} ${d.slice(4,7)} ${d.slice(7,10)}`;
    return `${d.slice(0,2)} ${d.slice(2,6)} ${d.slice(6,10)}`;
  }
  return String(raw).trim();
}

function cleanWebsite(tags) {
  let w = (tags.website || tags['contact:website'] || '').trim();
  if (!w) return ['', ''];
  if (!w.startsWith('http')) w = 'https://' + w;
  if (SOCIAL_AS_SITE.test(w)) return ['', w.replace(/\/$/, '')];
  const m = w.match(/(https?:\/\/[^/]+)/);
  return [m ? m[1] : w.replace(/\/$/, ''), ''];
}

function osmSocials(tags) {
  const out = [];
  for (const k of ['contact:instagram', 'contact:facebook', 'contact:tiktok']) {
    const v = (tags[k] || '').trim();
    if (v) out.push(v.includes('.') ? v : (k.includes('instagram') ? `instagram.com/${v}` : v));
  }
  return out;
}

// ---------------------------------------------------------------- geocode + query
async function geocode(location) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(location);
  const r = await fetchWithTimeout(url, { headers: UA }, 15000);
  const j = await r.json();
  if (!j.length) throw new Error(`Could not geocode "${location}"`);
  return { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon) };
}

async function overpassQuery(fragments) {
  const body = `[out:json][timeout:120];(${fragments.join('')});out center tags ${SERVER_LIMIT};`;
  let lastErr;
  for (const mirror of OVERPASS_MIRRORS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetchWithTimeout(mirror, {
          method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(body),
        }, 150000);
        if (r.status === 429 || r.status === 504) { await sleep(20000 * (attempt + 1)); continue; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        return j.elements || [];
      } catch (e) { lastErr = e; await sleep(8000); }
    }
    log(`  mirror ${mirror.split('/')[2]} failed, trying next…`);
  }
  throw new Error('All Overpass mirrors failed: ' + (lastErr && lastErr.message));
}

// ---------------------------------------------------------------- website scrape
async function scrapeSite(url) {
  const emails = new Set(); const socials = new Set(); let longform = false;
  for (const path of ['', '/contact', '/contact-us']) {
    try {
      const resp = await fetchWithTimeout(url + path, { headers: UA, redirect: 'follow' }, 8000);
      if (!resp.ok) continue;
      const text = (await resp.text()).slice(0, 400000);
      for (const e of (text.match(EMAIL_RE) || [])) {
        if (!JUNK_EMAIL.test(e)) emails.add(e.toLowerCase().replace(/\.$/, ''));
      }
      for (const s of (text.match(SOCIAL_RE) || [])) socials.add(s.toLowerCase());
      if (LONGFORM_RE.test(text)) longform = true;
      if (emails.size && socials.size) break;
    } catch { /* ignore */ }
  }
  const ranked = [...emails].sort((a, b) => {
    const rank = (e) => /^(hello|hi|info|bookings|contact|enquiries)/.test(e) ? 0 : (!e.startsWith('admin') ? 1 : 2);
    return rank(a) - rank(b) || a.length - b.length;
  });
  return { email: ranked[0] || '', socials: [...socials].slice(0, 3).join(', '), longform };
}

// ---------------------------------------------------------------- email verify
async function checkEmail(email) {
  if (!email) return '';
  if (!new RegExp('^' + EMAIL_RE.source + '$').test(email) || JUNK_EMAIL.test(email)) return 'syntax_fail';
  try {
    const mx = await dns.resolveMx(email.split('@')[1]);
    return (mx && mx.length) ? 'mx_ok' : 'mx_fail';
  } catch { return 'mx_fail'; }
}

// ---------------------------------------------------------------- assembly helpers
function suggestTag(row) {
  if (row.longform_footage === 'yes') return 'T1?';
  if (row.socials) return 'T3';
  if (row.vertical === 'wellness' || row.vertical === 'gyms') return 'T4?';
  return 'T2';
}

function chainFlag(name, brandTag, nameCounts) {
  const n = name.toLowerCase().trim();
  if (KNOWN_CHAINS.has(n) || [...KNOWN_CHAINS].some(c => n.includes(c))) return 'likely_chain';
  if (brandTag) return 'likely_chain';
  if ((nameCounts[n] || 0) >= 3) return 'check_chain';
  return '';
}

// TODO(income): real income filtering needs ABS SEIFA (socio-economic index) by
// postcode/suburb. Until that dataset is wired, we stamp incomeType on each lead
// but do not drop rows. Keeps the control honest rather than faking demographics.
function incomeAllows(_row, _incomeType) { return true; }

// ---------------------------------------------------------------- main
async function run() {
  const ref = db.doc('agents/scraper');
  const snap = await ref.get();
  if (!snap.exists) { log('No agents/scraper doc — nothing to do.'); return; }
  const a = snap.data();
  const cfg = a.config || {};

  const requested = a.runRequested || 0;
  const started = a.runStartedAt || 0;
  if (!FORCE && requested <= started) { log('No new run requested.'); return; }

  const runAt = Date.now();
  await ref.set({ runStatus: 'running', runStartedAt: runAt }, { merge: true });

  try {
    const location = (cfg.location || '').trim();
    const radiusM = Math.round((Number(cfg.radiusKm) || 15) * 1000);
    const niches = (cfg.niches && cfg.niches.length) ? cfg.niches : ['gyms', 'wellness'];
    const incomeType = cfg.incomeType || 'any';
    const limit = Number(cfg.limit) || 50;
    if (!location) throw new Error('No location set');

    log(`Geocoding "${location}"…`);
    const { lat, lon } = await geocode(location);
    const around = `around:${radiusM},${lat},${lon}`;

    const fragments = niches.flatMap(n => (NICHE_QUERIES[n] || []).map(f => f.replace('{around}', around)));
    if (!fragments.length) throw new Error('No valid niches selected');

    log(`Querying OpenStreetMap: ${niches.join(', ')} within ${radiusM / 1000}km of ${lat.toFixed(3)},${lon.toFixed(3)}…`);
    const elements = await overpassQuery(fragments);

    // vertical lookup: which niche each fragment came from (by re-tagging on parse)
    const nicheForTags = (t) => {
      if (t.leisure === 'fitness_centre' || /fitness|crossfit|gym/i.test(t.sport || '')) return 'gyms';
      if (/yoga|pilates/i.test(t.sport || '') || t.shop === 'massage' || /physio|alternative/i.test(t.healthcare || '')) return 'wellness';
      if (/^(cafe|restaurant|bar|pub)$/.test(t.amenity || '')) return 'hospitality';
      if (t.craft || /^(trade|doityourself)$/.test(t.shop || '')) return 'trades';
      return niches[0];
    };

    const raw = [];
    for (const el of elements) {
      const t = el.tags || {};
      const name = (t.name || '').trim();
      if (!name) continue;
      raw.push({ name, tags: t });
    }

    const nameCounts = {};
    for (const r of raw) nameCounts[r.name.toLowerCase()] = (nameCounts[r.name.toLowerCase()] || 0) + 1;

    const seen = new Set();
    let rows = [];
    for (const r of raw) {
      const t = r.tags;
      const suburb = (t['addr:suburb'] || t['addr:city'] || '').trim();
      const key = `${r.name.toLowerCase()}|${suburb.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [website, socialSite] = cleanWebsite(t);
      const socials = osmSocials(t);
      if (socialSite) socials.push(socialSite.split('//').pop().replace(/^www\./, ''));
      rows.push({
        business: r.name,
        vertical: nicheForTags(t),
        suburb,
        address: [t['addr:housenumber'] || '', t['addr:street'] || ''].filter(Boolean).join(' '),
        phone: normalizePhone(t.phone || t['contact:phone'] || t.mobile || ''),
        website,
        email: (t.email || t['contact:email'] || '').toLowerCase().trim(),
        socials: [...new Set(socials)].join(', '),
        contact_name: '',
        specific_observation: '',
        template_tag: '',
        email_verified: 'no',
        status: 'new',
        income_type: incomeType,
        source: 'scraper-osm',
        chain_flag: chainFlag(r.name, t.brand || '', nameCounts),
        email_check: '',
        longform_footage: '',
      });
    }

    // best-effort website scrape for rows missing an email (bounded)
    const targets = rows.filter(r => r.website && (!r.email || !r.socials)).slice(0, 120);
    log(`Visiting ${targets.length} websites for contact details…`);
    for (const row of targets) {
      const info = await scrapeSite(row.website);
      row.email = row.email || info.email;
      const merged = [row.socials, info.socials].filter(Boolean).join(', ');
      row.socials = merged ? [...new Set(merged.split(', '))].join(', ') : '';
      row.longform_footage = info.longform ? 'yes' : '';
      await sleep(700);
    }

    // verify emails; clear failures so a bad address can never be sent to
    for (const row of rows) {
      row.email_check = await checkEmail(row.email);
      if (row.email_check === 'syntax_fail' || row.email_check === 'mx_fail') row.email = '';
      row.template_tag = suggestTag(row);
      if (row.chain_flag) row.notes = 'franchise/chain — usually skip (HQ controls marketing); keep only if independently owned';
    }

    // income filter (pass-through until SEIFA wired) + rank: email-first, then phone, then website
    rows = rows.filter(r => incomeAllows(r, incomeType));
    rows.sort((x, y) => (x.email === '') - (y.email === '') || (x.phone === '') - (y.phone === '') || (x.website === '') - (y.website === ''));
    rows = rows.slice(0, limit);

    const mxOk = rows.filter(r => r.email_check === 'mx_ok').length;
    const withPhone = rows.filter(r => r.phone).length;
    const chains = rows.filter(r => r.chain_flag).length;
    log(`Assembled ${rows.length} leads (${mxOk} mx_ok email / ${withPhone} phone / ${chains} chains flagged).`);

    if (!DRY) {
      const batchId = `${niches.join('+')}-${new Date().toISOString().slice(0, 10)}`;
      let written = 0;
      let batch = db.batch();
      for (const row of rows) {
        const id = `${row.business}|${row.suburb}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
        batch.set(db.doc('prospects/' + id), {
          ...row, batch: batchId, createdAt: FieldValue.serverTimestamp(), scrapedAt: runAt,
        }, { merge: true });
        if (++written % 400 === 0) { await batch.commit(); batch = db.batch(); }
      }
      await batch.commit();
      log(`Wrote ${written} prospects (batch ${batchId}).`);
    }

    const when = new Date().toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const acts = (a.activity || []).slice();
    acts.unshift({ when, text: `Scraped ${rows.length} prospects (${mxOk} email · ${withPhone} phone · ${chains} chains flagged) — ${niches.join('+')} within ${radiusM / 1000}km of ${location}` });
    const stats = a.stats || { handled: 0, drafts: 0 };
    stats.handled = (stats.handled || 0) + rows.length;
    await ref.set({
      runStatus: 'done',
      lastError: null,
      config: { ...cfg, lastRun: runAt, lastCount: rows.length },
      stats,
      activity: acts.slice(0, 60),
      updatedAt: Date.now(),
    }, { merge: true });
    log('Done.');
  } catch (e) {
    log('FAILED: ' + e.message);
    const when = new Date().toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const acts = (a.activity || []).slice();
    acts.unshift({ when, text: 'Run failed: ' + String(e.message).slice(0, 140) });
    await ref.set({ runStatus: 'error', lastError: String(e.message).slice(0, 300), activity: acts.slice(0, 60), updatedAt: Date.now() }, { merge: true });
    process.exitCode = 1;
  }
}

run().catch(e => { console.error(e); process.exit(1); });
