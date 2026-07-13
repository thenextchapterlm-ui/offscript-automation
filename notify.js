/**
 * OFFscript notification worker — runs on a schedule (GitHub Actions).
 * Scans tasks + client follow-ups and sends web-push notifications via FCM to
 * each person's registered devices, even when the app is closed. Deduped via
 * notifications/sent so nobody gets pinged twice. Runs on Firebase's FREE plan.
 *
 * Auth: reads the service-account JSON from either
 *   - env FIREBASE_SERVICE_ACCOUNT  (the whole JSON string — used in GitHub Actions), or
 *   - env GOOGLE_APPLICATION_CREDENTIALS (a file path — used for local testing).
 * Pass --dry to log what WOULD be sent without actually sending.
 */
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

// ── CONFIG (safe to tweak) ──────────────────────────────────────────────
const TZ = 'Australia/Perth';   // team timezone — controls when "due today" / follow-up pings go out
const DAILY_HOUR = 8;           // don't send date-based (due / follow-up) pings before this local hour
const LOOKBACK_DAYS = 14;       // ignore dates older than this so a first run doesn't blast ancient items

const DRY = process.argv.includes('--dry');

function loadCreds() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (path) return require(path);
  throw new Error('No credentials: set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS');
}

initializeApp({ credential: cert(loadCreds()), projectId: 'offscript-platform-8deb4' });
const db = getFirestore();

function localParts(now) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) };
}
function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

(async () => {
  const now = new Date();
  const { date: today, hour } = localParts(now);

  // Registered devices, grouped by person
  const tokSnap = await db.collection('pushTokens').get();
  const byPerson = {}; const all = [];
  tokSnap.forEach(d => {
    const t = d.data(); if (!t.token) return;
    all.push(t.token);
    const who = t.assignee || 'Team';
    (byPerson[who] = byPerson[who] || []).push(t.token);
  });
  const targetsFor = who => (who && byPerson[who] ? byPerson[who] : all);
  // A task may be assigned to several people — notify all of them.
  const asgsOf = t => (t.assignees && t.assignees.length) ? t.assignees : (t.assignee ? [t.assignee] : []);
  const targetsForMany = arr => { if (!arr || !arr.length) return all; const s = new Set(); arr.forEach(w => (byPerson[w] || []).forEach(x => s.add(x))); return s.size ? [...s] : all; };

  // Dedupe map of already-sent events
  const sentRef = db.doc('notifications/sent');
  const sentDoc = await sentRef.get();
  const sent = sentDoc.exists ? (sentDoc.data().keys || {}) : {};

  const queue = []; // { key, tokens, title, body }

  // ── TASKS ──
  const tasksDoc = await db.doc('boards/tasks').get();
  let tasks = [];
  if (tasksDoc.exists) { try { tasks = JSON.parse(tasksDoc.data().json).tasks || []; } catch (e) {} }

  for (const t of tasks) {
    if (t.archived) continue;
    const done = t.status === 'done' || t.done;
    if (done) continue;

    if (t.remindAt) {
      const when = new Date(t.remindAt);
      if (when <= now && (now - when) < LOOKBACK_DAYS * 86400000) {
        const key = 'remind:' + t.id + ':' + t.remindAt;
        if (!sent[key]) queue.push({ key, tokens: targetsForMany(asgsOf(t)), title: '⏰ Reminder', body: t.title });
      }
    }

    if (t.scheduledDate && hour >= DAILY_HOUR &&
        t.scheduledDate <= today && daysBetween(t.scheduledDate, today) <= LOOKBACK_DAYS) {
      const key = 'due:' + t.id + ':' + t.scheduledDate;
      if (!sent[key]) {
        const overdue = t.scheduledDate < today;
        queue.push({
          key, tokens: targetsForMany(asgsOf(t)),
          title: overdue ? '🔴 Overdue task' : '📌 Due today', body: t.title
        });
      }
    }
  }

  // ── CLIENT FOLLOW-UPS ──
  const cliSnap = await db.collection('clients').get();
  cliSnap.forEach(d => {
    const c = d.data();
    if (!c.active) return;
    if (c.nextTouch && hour >= DAILY_HOUR &&
        c.nextTouch <= today && daysBetween(c.nextTouch, today) <= LOOKBACK_DAYS) {
      const key = 'followup:' + d.id + ':' + c.nextTouch;
      if (!sent[key]) queue.push({ key, tokens: all, title: '👋 Follow-up due', body: (c.business || c.name || 'Client') });
    }
  });

  // ── SEND ──
  let pushed = 0;
  for (const msg of queue) {
    const tokens = [...new Set(msg.tokens)].filter(Boolean);
    if (DRY) { console.log('[DRY] would send', msg.title, '-', msg.body, 'to', tokens.length, 'device(s)'); sent[msg.key] = Date.now(); continue; }
    if (!tokens.length) { sent[msg.key] = Date.now(); continue; }
    try {
      const res = await getMessaging().sendEachForMulticast({
        tokens,
        data: { title: msg.title, body: msg.body, url: '/' },
        webpush: { headers: { Urgency: 'high', TTL: '3600' }, fcmOptions: { link: '/' } }
      });
      pushed += res.successCount;
      res.responses.forEach((r, i) => {
        if (!r.success) {
          const code = (r.error && r.error.code) || '';
          if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
            db.collection('pushTokens').doc(tokens[i]).delete().catch(() => {});
          }
        }
      });
    } catch (e) { console.error('send failed', msg.key, e.message); }
    sent[msg.key] = Date.now();
  }

  // Keep the dedupe doc small — drop markers older than 60 days
  const cutoff = Date.now() - 60 * 86400000;
  for (const k in sent) { if (typeof sent[k] === 'number' && sent[k] < cutoff) delete sent[k]; }
  if (!DRY) await sentRef.set({ keys: sent, lastRun: Date.now() }, { merge: true });

  console.log(`run ok — today=${today} hour=${hour} tz=${TZ} candidates=${queue.length} pushed=${pushed} devices=${all.length}${DRY ? ' (DRY RUN)' : ''}`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
