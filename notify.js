/**
 * OFFscript notification worker - runs every 5 minutes on GitHub Actions.
 *
 * Reconnected to OFFscript Command (2026-09-13). It used to read the old dashboard's
 * `boards/tasks` JSON blob and client follow-ups; nobody has written that board since
 * 29 Aug, and every device on file is now a Command-app device, so it was checking a
 * dead board and pushing to nobody.
 *
 * What it sends now (all to Command-app devices, by seat):
 *   - A task in appTasks that is due today or overdue, to the people on it. Once per
 *     task per due date, from 08:00 studio time.
 *   - An agent that has stopped working (a GitHub agent reporting an error, or a Mac
 *     helper in localAgents in the error state), to the founders. Once per agent per day.
 *
 * Assignment and crew notifications are NOT here: functions/command-push.js sends those
 * the moment the record changes. Dedupe lives in notifications/command, separate from
 * the old senders' notifications/sent so neither prunes the other's markers.
 *
 * Pass --dry to log what WOULD be sent without sending or writing.
 */
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FOUNDERS, brisbaneParts, sendToSeats, dayOf } = require('./command');

const DAILY_HOUR = 8;       // no date-based pings before 08:00 studio time
const LOOKBACK_DAYS = 14;   // a first run must not blast weeks-old overdue work
const DRY = process.argv.includes('--dry');

function loadCreds() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  throw new Error('No credentials: set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS');
}
initializeApp({ credential: cert(loadCreds()), projectId: 'offscript-platform-8deb4' });
const db = getFirestore();

const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const listOf = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
/* Tasks written before multi-assign have only `owner`. */
const assigneesOf = (t) => (listOf(t.assignees).length ? listOf(t.assignees) : (t.owner ? [t.owner] : []));

(async () => {
  const now = new Date();
  const { date: today, hour } = brisbaneParts(now);

  const sentRef = db.doc('notifications/command');
  const sentDoc = await sentRef.get();
  const sent = sentDoc.exists ? (sentDoc.data().keys || {}) : {};
  /* The first run after the reconnect found 26 overdue tasks, some two weeks old. Sending
     them all at once is a wall of pings about work people already know is late, so on the
     very first run anything ALREADY overdue is recorded as seen and only today's go out. */
  const firstRun = !sentDoc.exists;
  const queue = []; // { key, seats, title, body, url }

  // ── TASKS DUE ──
  // `due` is an ISO date or the label the app showed ("Wed 16 Sep"); dayOf reads both.
  // "Unscheduled" or unreadable text has no day to be due on and is skipped, never guessed.
  let seeded = 0;
  if (hour >= DAILY_HOUR) {
    const tasks = await db.collection('appTasks').get();
    tasks.forEach((d) => {
      const t = d.data() || {};
      if (t.done || t.deleted) return;
      const due = dayOf(t.due, today);
      if (!due) return;
      if (due > today || daysBetween(due, today) > LOOKBACK_DAYS) return;
      const seats = assigneesOf(t);
      if (!seats.length) return;
      const key = 'due:' + d.id + ':' + due;
      if (sent[key]) return;
      if (firstRun && due < today) { if (!DRY) sent[key] = Date.now(); seeded++; return; }
      queue.push({ key, seats, title: due < today ? 'Overdue' : 'Due today', body: t.title || 'A task', url: '/app/#queue' });
    });
  }

  // ── AGENT FAILURES ──
  // The Releases Feed once sat "Last run failed" for 16 days because the only place a broken
  // agent showed was a tab nobody opened. Failures come to the founders, once a day each.
  // A helper that is SWITCHED OFF on purpose reports state 'off', not 'error', and is quiet.
  const alerts = [];
  try {
    (await db.collection('localAgents').get()).forEach((d) => {
      const a = d.data() || {};
      if (a.state === 'error') alerts.push({ id: d.id, why: a.status || 'Last run failed' });
    });
  } catch (e) { console.error('localAgents read failed', e.message); }
  try {
    (await db.collection('agents').get()).forEach((d) => {
      const a = d.data() || {};
      if (a.enabled && (a.runStatus === 'error' || a.lastError)) alerts.push({ id: d.id, why: String(a.lastError || 'Run failed').slice(0, 120) });
    });
  } catch (e) { console.error('agents read failed', e.message); }
  for (const a of alerts) {
    const key = 'agentfail:' + a.id + ':' + today;
    if (!sent[key]) queue.push({ key, seats: FOUNDERS, title: 'An agent stopped working', body: a.id + ' - ' + a.why, url: '/app/#agents' });
  }

  // ── SEND ──
  let pushed = 0;
  for (const m of queue) {
    if (DRY) { console.log('[DRY] would send', JSON.stringify({ title: m.title, body: m.body, seats: m.seats })); continue; }
    pushed += await sendToSeats(db, m.seats, m.title, m.body, m.url);
    sent[m.key] = Date.now();
  }
  const cutoff = Date.now() - 60 * 86400000;
  for (const k in sent) { if (typeof sent[k] === 'number' && sent[k] < cutoff) delete sent[k]; }
  if (!DRY) await sentRef.set({ keys: sent, lastRun: Date.now() }, { merge: true });

  console.log(`run ok - today=${today} hour=${hour} candidates=${queue.length} pushed=${pushed} seededOverdue=${seeded}${DRY ? ' (DRY RUN)' : ''}`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
