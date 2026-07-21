/**
 * OFFscript Website Health agent.
 * Once per day, verifies the PUBLIC site www.offscriptcrew.com.au works on BOTH
 * desktop and mobile, writes a report into the dashboard (Firestore), emails a
 * summary to admin@offscriptcrew.com.au, and — when run locally with the website
 * source + wrangler auth present — auto-fixes safe issues and redeploys.
 *
 * This site is the Cloudflare Pages marketing site (project "offscriptcrew"). It is
 * completely separate from the dashboard app. Never touch the dashboard's deploy.
 *
 * ENV (all optional except Firebase):
 *   FIREBASE_SERVICE_ACCOUNT | GOOGLE_APPLICATION_CREDENTIALS  (required — Firestore)
 *   MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET             (email; skipped if absent)
 *   OFFSCRIPT_AUTOFIX=1                                        (enable local auto-fix+deploy)
 *   WEBSITE_DIR   (default ~/OFFscript_Deploy/website)         (local auto-fix source)
 * Flags: --dry (run checks + print, write nothing / send nothing)
 */
const { chromium } = require('playwright');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const tls = require('tls');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── CONFIG ──────────────────────────────────────────────────────────────
const WWW  = 'https://www.offscriptcrew.com.au';
const APEX = 'https://offscriptcrew.com.au';
const INTAKE = 'https://tncintake.netlify.app/';
const TZ = 'Australia/Brisbane';
const AGENT_KEY = 'website-health';
const ADMIN = 'admin@offscriptcrew.com.au';

// Cloudinary (Spark plan = no Firebase Storage; images go through Cloudinary — same as the app)
const CLD_CLOUD = 'nku6oxyh';
const CLD_PRESET = 'whbl2pnv';

// thresholds
// video-heavy site: measure DOM-ready (usable), not full media load
const LOAD_DESKTOP_MS = 5000, LOAD_MOBILE_MS = 6000, LOAD_HARD_MS = 15000;
const SSL_WARN_DAYS = 14;
const MAX_LINKS = 60;

const DRY = process.argv.includes('--dry');
const TENANT = process.env.MS_TENANT_ID, MS_CLIENT = process.env.MS_CLIENT_ID, MS_SECRET = process.env.MS_CLIENT_SECRET;
const WEBSITE_DIR = process.env.WEBSITE_DIR || path.join(os.homedir(), 'OFFscript_Deploy', 'website');
const AUTOFIX = process.env.OFFSCRIPT_AUTOFIX === '1';

const DEVICES = [
  { key: 'desktop', label: 'Desktop', viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, dsf: 1,
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    loadTarget: LOAD_DESKTOP_MS },
  { key: 'mobile', label: 'Mobile', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, dsf: 3,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    loadTarget: LOAD_MOBILE_MS },
];

// ── helpers ─────────────────────────────────────────────────────────────
function loadCreds() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const local = path.join(os.homedir(), '.config', 'offscript', 'firebase-service-account.json');
  if (fs.existsSync(local)) return require(local);
  throw new Error('No Firebase creds (set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS)');
}
function localDate() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
async function status(url, method = 'HEAD') {
  try {
    const r = await fetch(url, { method, redirect: 'follow', headers: { 'User-Agent': DEVICES[0].ua }, signal: AbortSignal.timeout(15000) });
    return { ok: r.ok, code: r.status, finalUrl: r.url };
  } catch (e) {
    if (method === 'HEAD') return status(url, 'GET'); // some hosts reject HEAD
    return { ok: false, code: 0, err: e.message };
  }
}
function sslDaysLeft(host) {
  return new Promise((resolve) => {
    try {
      const s = tls.connect({ host, port: 443, servername: host, timeout: 12000 }, () => {
        const c = s.getPeerCertificate();
        s.end();
        if (!c || !c.valid_to) return resolve(null);
        resolve({ validTo: c.valid_to, days: Math.round((new Date(c.valid_to) - Date.now()) / 86400000) });
      });
      s.on('error', () => resolve(null));
      s.on('timeout', () => { s.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}
async function cloudinaryUpload(buf, name) {
  try {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'image/png' }), name);
    fd.append('upload_preset', CLD_PRESET);
    fd.append('folder', 'health');
    const r = await fetch(`https://api.cloudinary.com/v1_1/${CLD_CLOUD}/image/upload`, { method: 'POST', body: fd });
    const j = await r.json();
    return j.secure_url || null;
  } catch (e) { return null; }
}
async function msToken() {
  const body = new URLSearchParams({ client_id: MS_CLIENT, client_secret: MS_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, { method: 'POST', body });
  const j = await r.json();
  if (!j.access_token) throw new Error('MS token: ' + (j.error_description || JSON.stringify(j)).slice(0, 140));
  return j.access_token;
}
const ERROR_MARKERS = /(page not found|site can.?t be reached|error 5\d\d|error 1\d{3}|not found|origin is unreachable|web server is down|cloudflare)/i;

// ── per-device checks ───────────────────────────────────────────────────
async function checkDevice(browser, dev, issues, mediaSeen) {
  const ctx = await browser.newContext({
    viewport: dev.viewport, userAgent: dev.ua, isMobile: dev.isMobile,
    hasTouch: dev.hasTouch, deviceScaleFactor: dev.dsf,
  });
  const page = await ctx.newPage();
  const consoleErrors = [], realFails = [], badResponses = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
  // Real failures only. This design-export bundle paints `{{ template }}` src placeholders
  // into the DOM for a beat before its runtime swaps in real URLs, and the reel/logo
  // carousels lazy-load + abort off-screen media — both fire ERR_ABORTED requests that are
  // NOT breakage. Ignore those; keep genuine failures (DNS, refused, blocked).
  page.on('requestfailed', r => {
    const u = r.url(), err = (r.failure() || {}).errorText || 'failed';
    if (err.includes('ERR_ABORTED')) return;
    if (u.includes('%7B%7B') || u.includes('{{')) return;
    realFails.push(`${u.slice(0, 90)} (${err})`);
  });
  // A real 4xx/5xx on one of OUR OWN assets is a genuine problem (missing file, etc.).
  // Third-party embeds/analytics and template-placeholder URLs are ignored.
  page.on('response', r => {
    const st = r.status(), u = r.url();
    if (st < 400 || st === 403 || st === 999) return;
    if (!/offscriptcrew\.com\.au/.test(u)) return;
    if (u.includes('%7B%7B') || u.includes('{{')) return;
    badResponses.push(`${st} ${u.slice(0, 90)}`);
  });

  const checks = [];
  const add = (name, st, detail, ms) => { checks.push({ name, status: st, detail: detail || '', ms: ms || 0 }); if (st === 'fail') issues.push({ device: dev.key, check: name, detail }); };

  // 3. Load time
  let loadMs = 0, loaded = false;
  const t0 = Date.now();
  try {
    const resp = await page.goto(WWW, { waitUntil: 'domcontentloaded', timeout: 30000 });
    loadMs = Date.now() - t0;
    loaded = true;
    const code = resp ? resp.status() : 0;
    if (code >= 400 || code === 0) add('Reachable (render)', 'fail', `HTTP ${code} on ${dev.label}`, loadMs);
    else add('Reachable (render)', 'pass', `HTTP ${code}`, loadMs);
    const target = dev.loadTarget;
    add('Load time', loadMs > LOAD_HARD_MS ? 'fail' : (loadMs > target ? 'warn' : 'pass'),
      `${(loadMs / 1000).toFixed(1)}s (target ${(target / 1000).toFixed(1)}s)`, loadMs);
    // Settle: this is a JS-rendered site, so wait for real content/video to mount
    // (capped) before the content/media/layout checks — without blocking on all videos.
    try { await page.waitForFunction(() => ((document.body && document.body.innerText) || '').trim().length > 200 || document.querySelector('video'), { timeout: 8000 }); } catch {}
    try { await page.waitForTimeout(800); } catch {}
  } catch (e) {
    add('Reachable (render)', 'fail', `${dev.label} did not load: ${e.message.slice(0, 80)}`, Date.now() - t0);
    await ctx.close();
    return { key: dev.key, label: dev.label, checks, loadMs, screenshot: null };
  }

  // 4. Content sanity
  try {
    const info = await page.evaluate(() => ({
      title: document.title || '',
      text: (document.body.innerText || '').trim(),
      videos: document.querySelectorAll('video').length,
      hasNav: !!document.querySelector('nav, header'),
    }));
    const bad = ERROR_MARKERS.test(info.title) || (ERROR_MARKERS.test(info.text) && info.text.length < 400);
    const hasBrand = /offscript/i.test(info.text) || /offscript/i.test(info.title);
    if (bad || info.text.length < 200) add('Content sanity', 'fail', `Looks blank/error page (title="${info.title.slice(0, 40)}", ${info.text.length} chars text)`);
    else if (!hasBrand) add('Content sanity', 'warn', 'Page rendered but "OFFscript" marker not found');
    else add('Content sanity', 'pass', `${info.text.length} chars, nav=${info.hasNav}, ${info.videos} video(s)`);
  } catch (e) { add('Content sanity', 'warn', 'Could not read content: ' + e.message.slice(0, 60)); }

  // 5. Media (videos + images)
  try {
    const media = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('video').forEach(v => {
        if (v.src) out.push({ t: 'video', u: v.src });
        v.querySelectorAll('source').forEach(s => { if (s.src) out.push({ t: 'video', u: s.src }); });
        if (v.poster) out.push({ t: 'img', u: v.poster });
      });
      document.querySelectorAll('img').forEach(i => { if (i.currentSrc || i.src) out.push({ t: 'img', u: i.currentSrc || i.src }); });
      return out;
    });
    const urls = [...new Set(media.filter(m => /^https?:/.test(m.u)).map(m => m.u))];
    const broken = [];
    for (const u of urls.slice(0, 40)) {
      if (mediaSeen.has(u)) { if (mediaSeen.get(u) === false) broken.push(u); continue; }
      const s = await status(u, 'GET');
      const ok = s.ok || s.code === 206;
      mediaSeen.set(u, ok);
      if (!ok) broken.push(u);
    }
    const vids = media.filter(m => m.t === 'video').length;
    if (broken.length) add('Media loads', 'fail', `${broken.length} broken asset(s): ${broken.slice(0, 3).map(u => u.split('/').pop()).join(', ')}`);
    else add('Media loads', 'pass', `${urls.length} assets OK (${vids} video src)`);

    // video playback (esp. mobile)
    const play = await page.evaluate(async () => {
      const v = document.querySelector('video'); if (!v) return 'no-video';
      try { v.muted = true; const p = v.play(); if (p && p.then) await p; return v.paused ? 'paused' : 'playing'; }
      catch (e) { return 'err:' + (e.message || '').slice(0, 40); }
    });
    if (play === 'no-video') add('Video playback', 'warn', 'No <video> element found');
    else if (play === 'playing') add('Video playback', 'pass', `Plays on ${dev.label}`);
    else add('Video playback', dev.isMobile ? 'fail' : 'warn', `Video did not play on ${dev.label} (${play})`);
  } catch (e) { add('Media loads', 'warn', 'Media check error: ' + e.message.slice(0, 60)); }

  // 6/7. Links + CTAs (crawl once from desktop DOM; verify key CTA both devices)
  try {
    const hrefs = await page.evaluate((intake) => {
      const set = new Set(), ctas = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const h = a.href;
        if (/^https?:/.test(h) && !h.startsWith('mailto') && !h.startsWith('tel')) set.add(h);
        const txt = (a.innerText || '').trim();
        if (/book|contact|get started|enquire|start|intake|work with/i.test(txt) || h.includes('tncintake')) ctas.push(h);
      });
      return { links: [...set], ctas: [...new Set(ctas)] };
    }, INTAKE);

    if (dev.key === 'desktop') {
      const broken = [];
      for (const h of hrefs.links.slice(0, MAX_LINKS)) {
        const s = await status(h);
        if (!s.ok && s.code !== 999 && s.code !== 403) broken.push(`${h.split('/').slice(0, 3).join('/')}… (${s.code})`);
      }
      if (broken.length) add('Links', 'fail', `${broken.length} dead link(s): ${broken.slice(0, 3).join(' | ')}`);
      else add('Links', 'pass', `${Math.min(hrefs.links.length, MAX_LINKS)} link(s) OK`);
    }
    // CTA reachable on this device
    if (hrefs.ctas.length) {
      const s = await status(hrefs.ctas[0]);
      add('Primary CTA', s.ok || s.code === 403 ? 'pass' : 'fail', `${hrefs.ctas[0].split('/').slice(0, 3).join('/')}… (${s.code})`);
    } else add('Primary CTA', 'warn', 'No booking/contact CTA link found');
  } catch (e) { add('Links', 'warn', 'Link check error: ' + e.message.slice(0, 60)); }

  // 9. Layout / responsive
  try {
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      iw: window.innerWidth,
    }));
    if (dev.isMobile) {
      if (layout.overflow > 12) add('Mobile layout', 'fail', `Horizontal overflow ${layout.overflow}px (viewport ${layout.iw}px)`);
      else add('Mobile layout', 'pass', 'No horizontal overflow');
    } else {
      add('Desktop layout', layout.overflow > 40 ? 'warn' : 'pass', layout.overflow > 40 ? `Overflow ${layout.overflow}px` : 'Layout OK');
    }
  } catch (e) { add('Layout', 'warn', 'Layout check error: ' + e.message.slice(0, 60)); }

  // 8. Console / failed requests (real breakage only — benign lazy/placeholder aborts ignored)
  if (badResponses.length) add('Console/assets', 'fail', `${badResponses.length} broken own-asset(s): ${badResponses.slice(0, 2).join(', ')}`);
  else if (realFails.length) add('Console/assets', 'warn', `${realFails.length} real failed request(s): ${realFails.slice(0, 2).join(', ')}`);
  else if (consoleErrors.length) add('Console/assets', 'warn', `${consoleErrors.length} JS console error(s)`);
  else add('Console/assets', 'pass', 'No real errors (benign lazy/placeholder aborts ignored)');

  // screenshot → Cloudinary
  let shot = null;
  try {
    const buf = await page.screenshot({ fullPage: dev.key === 'desktop' });
    shot = DRY ? null : await cloudinaryUpload(buf, `health-${dev.key}-${Date.now()}.png`);
  } catch {}

  await ctx.close();
  return { key: dev.key, label: dev.label, checks, loadMs, screenshot: shot };
}

// ── local auto-fix + deploy (only when source + wrangler present) ─────────
function tryAutoFix(brokenAssets) {
  const applied = [];
  if (!AUTOFIX || !fs.existsSync(path.join(WEBSITE_DIR, 'public'))) return applied;
  const pub = path.join(WEBSITE_DIR, 'public');
  // index all files under public by basename
  const byName = {};
  (function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.name.startsWith('.') || f.name.startsWith('_backup')) continue;
      const fp = path.join(dir, f.name);
      if (f.isDirectory()) walk(fp);
      else (byName[f.name] = byName[f.name] || []).push(path.relative(pub, fp));
    }
  })(pub);
  const htmlFiles = fs.readdirSync(pub).filter(f => f.endsWith('.html')).map(f => path.join(pub, f));
  for (const badUrl of brokenAssets) {
    const base = badUrl.split('/').pop().split('?')[0];
    const matches = byName[base];
    if (!matches || matches.length !== 1) continue; // only fix when the correct file is unambiguous
    const correct = matches[0];
    const badPath = new URL(badUrl).pathname.replace(/^\//, '');
    if (badPath === correct) continue;
    let changed = false;
    for (const hf of htmlFiles) {
      const src = fs.readFileSync(hf, 'utf8');
      if (src.includes(badPath)) { fs.writeFileSync(hf, src.split(badPath).join(correct)); changed = true; }
    }
    if (changed) applied.push({ from: badPath, to: correct, base });
  }
  if (applied.length) {
    try {
      execSync('npx wrangler pages deploy public --project-name offscriptcrew --branch production --commit-dirty=true',
        { cwd: WEBSITE_DIR, stdio: 'pipe', timeout: 180000 });
      applied.forEach(a => a.deployed = true);
    } catch (e) { applied.forEach(a => a.deployError = (e.message || '').slice(0, 100)); }
  }
  return applied;
}

// ── email ─────────────────────────────────────────────────────────────
function emailHtml(report) {
  const icon = report.overall === 'ok' ? '✅' : (report.overall === 'down' ? '🔴' : '⚠️');
  const row = c => `<tr><td style="padding:3px 10px 3px 0">${c.status === 'pass' ? '✅' : c.status === 'warn' ? '🟡' : '🔴'}</td><td style="padding:3px 10px 3px 0"><b>${c.name}</b></td><td style="padding:3px 0;color:#555">${c.detail}</td></tr>`;
  const dev = d => `<h3 style="margin:16px 0 4px">${d.label}${d.screenshot ? ` — <a href="${d.screenshot}">screenshot</a>` : ''}</h3><table style="font-size:13px;border-collapse:collapse">${d.checks.map(row).join('')}</table>`;
  const fixes = report.appliedFixes && report.appliedFixes.length
    ? `<h3 style="margin:16px 0 4px">Auto-fixed + deployed</h3><ul>${report.appliedFixes.map(f => `<li>${f.from} → ${f.to}${f.deployed ? ' (deployed)' : f.deployError ? ' (deploy FAILED: ' + f.deployError + ')' : ''}</li>`).join('')}</ul>`
    : '';
  const flagged = report.issues && report.issues.length
    ? `<h3 style="margin:16px 0 4px;color:#b00">Flagged for a human</h3><ul>${report.issues.map(i => `<li><b>${i.device}</b> · ${i.check}: ${i.detail}</li>`).join('')}</ul>`
    : '';
  return `<div style="font-family:Arial,sans-serif;color:#222;max-width:640px">
    <h2>${icon} OFFscript site health — ${report.dateLocal} ${report.timeLocal}</h2>
    <p>Overall: <b>${report.overall.toUpperCase()}</b> · ${WWW}</p>
    ${report.ssl ? `<p>SSL: valid to ${report.ssl.validTo} (${report.ssl.days} days left)</p>` : ''}
    ${flagged}${fixes}
    ${report.devices.map(dev).join('')}
    <p style="color:#999;font-size:11px;margin-top:20px">Automated by the Website Health agent.</p>
  </div>`;
}
async function sendEmail(report) {
  if (!TENANT || !MS_CLIENT || !MS_SECRET) { console.log('email skipped — no MS creds in env'); return 'skipped'; }
  const tok = await msToken();
  const icon = report.overall === 'ok' ? '✅ all good' : (report.overall === 'down' ? '🔴 SITE DOWN' : '⚠️ issues');
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${ADMIN}/sendMail`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: {
      subject: `OFFscript site health - ${report.dateLocal}: ${icon}`,
      body: { contentType: 'HTML', content: emailHtml(report) },
      toRecipients: [{ emailAddress: { address: ADMIN } }],
    }, saveToSentItems: true }),
  });
  if (!r.ok) throw new Error('sendMail ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return 'sent';
}

// ── main ────────────────────────────────────────────────────────────────
(async () => {
  const { date, time } = localDate();
  const issues = [];
  const mediaSeen = new Map();

  // device-independent: reachability + SSL
  const apexR = await status(APEX, 'GET');
  const wwwR = await status(WWW, 'GET');
  const redirOk = apexR.finalUrl && /www\.offscriptcrew\.com\.au/.test(apexR.finalUrl);
  if (!wwwR.ok) issues.push({ device: 'both', check: 'Reachability', detail: `www returned ${wwwR.code}` });
  if (!apexR.ok) issues.push({ device: 'both', check: 'Reachability', detail: `apex returned ${apexR.code}` });
  const ssl = await sslDaysLeft('www.offscriptcrew.com.au');
  if (ssl && ssl.days < SSL_WARN_DAYS) issues.push({ device: 'both', check: 'SSL', detail: `cert expires in ${ssl.days} days` });

  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const devices = [];
  for (const dev of DEVICES) devices.push(await checkDevice(browser, dev, issues, mediaSeen));
  await browser.close();

  // auto-fix broken assets (local only)
  const brokenAssets = [...mediaSeen.entries()].filter(([, ok]) => !ok).map(([u]) => u);
  const appliedFixes = brokenAssets.length ? tryAutoFix(brokenAssets) : [];

  // severity → overall
  const anyDown = !wwwR.ok || !apexR.ok || devices.some(d => d.checks.some(c => c.name === 'Reachable (render)' && c.status === 'fail') || d.checks.some(c => c.name === 'Content sanity' && c.status === 'fail'));
  const anyFail = issues.length > 0 || devices.some(d => d.checks.some(c => c.status === 'fail'));
  const overall = anyDown ? 'down' : (anyFail ? 'issues' : 'ok');

  const report = {
    ts: Date.now(), dateLocal: date, timeLocal: time, overall,
    reachability: { apex: apexR.code, www: wwwR.code, redirectToWww: !!redirOk },
    ssl: ssl ? { validTo: ssl.validTo, days: ssl.days } : null,
    devices, issues, appliedFixes,
  };

  console.log(`\n=== Website Health ${date} ${time} — ${overall.toUpperCase()} ===`);
  console.log(`apex=${apexR.code} www=${wwwR.code} redirect→www=${redirOk} ssl=${ssl ? ssl.days + 'd' : 'n/a'}`);
  devices.forEach(d => { console.log(`\n[${d.label}] load ${(d.loadMs / 1000).toFixed(1)}s${d.screenshot ? ' shot=' + d.screenshot : ''}`); d.checks.forEach(c => console.log(`  ${c.status === 'pass' ? '✓' : c.status === 'warn' ? '~' : '✗'} ${c.name}: ${c.detail}`)); });
  if (appliedFixes.length) console.log('\nauto-fixed:', JSON.stringify(appliedFixes));
  if (issues.length) console.log('\nissues:', JSON.stringify(issues));

  if (DRY) { console.log('\n(DRY — nothing written or emailed)'); process.exit(0); }

  // Firestore: update agent doc + append history
  initializeApp({ credential: cert(loadCreds()), projectId: 'offscript-platform-8deb4' });
  const db = getFirestore();
  const agentRef = db.doc(`agents/${AGENT_KEY}`);
  const snap = await agentRef.get();
  const prev = snap.exists ? snap.data() : {};
  const activity = [{ when: `${date} ${time}`, text: `${overall.toUpperCase()} — ${issues.length} issue(s), ${appliedFixes.length} fix(es)` }, ...((prev.activity) || [])].slice(0, 20);
  const payload = {
    key: AGENT_KEY, lastReport: report, activity,
    stats: { handled: ((prev.stats && prev.stats.handled) || 0) + 1, drafts: appliedFixes.length + ((prev.stats && prev.stats.drafts) || 0) },
    runStatus: overall, lastRun: Date.now(), updatedAt: Date.now(),
  };
  // First creation only: seed the display fields so the dashboard card renders even
  // if this worker runs before the Agents page seeds the doc. Never clobber the
  // team's enabled/instructions/autonomy on later runs.
  if (!snap.exists) Object.assign(payload, {
    name: 'Website Health', icon: '🩺', order: 6, status: 'setup', autonomy: 'auto', enabled: false,
    role: 'Checks www.offscriptcrew.com.au every day on desktop + mobile, reports the result here, emails a summary, and auto-fixes safe issues.',
  });
  await agentRef.set(payload, { merge: true });
  await db.collection('healthReports').doc(String(report.ts)).set(report);

  let mailed = 'skipped';
  try { mailed = await sendEmail(report); } catch (e) { console.error('email failed:', e.message); mailed = 'failed'; }

  console.log(`\nrun ok — overall=${overall} issues=${issues.length} fixes=${appliedFixes.length} email=${mailed}`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
