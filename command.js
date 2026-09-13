/**
 * Talking to OFFscript Command (the /app/ PWA) from these workers.
 *
 * The Command app is a different world from the old dashboard: people are SEATS
 * ("miles", "makaila"), not names, and a device's push token is the DOCUMENT ID of
 * pushTokens/<token> carrying { seat, app: 'command', disabled }. The old dashboard's
 * tokens carry a `token` field and an `assignee` name instead, which is how the two
 * never cross: nothing here sends to an old token, and the old senders skip these.
 *
 * Push copy follows the app's house style (functions/command-push.js): who or what,
 * then the thing, no app name, no exclamation marks, no em dashes.
 */
const { getMessaging } = require('firebase-admin/messaging');

const TZ = 'Australia/Brisbane';          // studio time - the app stores everything in it
const FOUNDERS = ['miles', 'luca', 'tannah'];

function brisbaneParts(now) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24, minute: parseInt(p.minute, 10) };
}

/* Enabled Command-app devices for these seats. */
async function tokensForSeats(db, seats) {
  const want = [...new Set((seats || []).filter(Boolean))];
  const out = [];
  for (let i = 0; i < want.length; i += 30) {
    const snap = await db.collection('pushTokens').where('seat', 'in', want.slice(i, i + 30)).get();
    snap.forEach((d) => {
      const t = d.data() || {};
      if (t.disabled) return;
      if (t.app !== 'command') return;
      out.push(d.id);
    });
  }
  return [...new Set(out)];
}

/* Seats whose page list includes `page` (e.g. 'outreach'), read off seats/<id>.nav. */
async function seatsWithPage(db, page) {
  const snap = await db.collection('seats').get();
  const out = [];
  snap.forEach((d) => { const nav = (d.data() || {}).nav; if (Array.isArray(nav) && nav.indexOf(page) >= 0) out.push(d.id); });
  return out;
}

/* Data-only message, matching the app's firebase-messaging-sw.js. Returns devices reached. */
async function sendToSeats(db, seats, title, body, url) {
  const tokens = await tokensForSeats(db, seats);
  console.log(JSON.stringify({ push: title, seats, devices: tokens.length }));
  if (!tokens.length) return 0;
  const link = url || '/app/';
  try {
    const res = await getMessaging().sendEachForMulticast({
      tokens,
      data: { title: String(title), body: String(body || ''), url: link },
      webpush: { headers: { Urgency: 'high', TTL: '86400' }, fcmOptions: { link } },
    });
    res.responses.forEach((r, i) => {
      const code = (!r.success && r.error && r.error.code) || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
        db.collection('pushTokens').doc(tokens[i]).delete().catch(() => {});
      }
    });
    return res.successCount;
  } catch (e) { console.error('command push failed:', e.message); return 0; }
}

/* A task or project date as YYYY-MM-DD, or null.
   The app stores `due` two ways: an ISO date ("2026-09-16"), or the label it showed when the
   date was picked ("Wed 16 Sep", "Mon 7 Sep · 10:00am-"). On 2026-09-13 that was 33 and 20 of
   the live tasks - reading only the ISO ones would silently drop two in five. A label has no
   year, so the year used is the one that puts the date nearest today. Anything else
   ("Unscheduled", unreadable text) is null: never guessed into a date. */
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad2 = (n) => String(n).padStart(2, '0');
function dayOf(raw, today) {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    /* Date.parse rolls 2026-02-31 over to 3 March rather than refusing it. */
    const t = new Date(Date.parse(m[0] + 'T00:00:00Z'));
    return !isNaN(t) && t.getUTCMonth() + 1 === +m[2] && t.getUTCDate() === +m[3] ? m[0] : null;
  }
  m = s.match(/\b(\d{1,2})\s+([A-Za-z]{3})/);
  if (!m) return null;
  const mi = MON.indexOf(m[2].toLowerCase());
  const dd = +m[1];
  if (mi < 0 || dd < 1 || dd > 31) return null;
  /* The label's weekday ("Tue 3 Mar") pins the year when it is there: 3 March was a Tuesday
     in 2026 and a Wednesday in 2027. Only without one does nearness to today decide. */
  const dw = s.match(/\b(sun|mon|tue|wed|thu|fri|sat)/i);
  const wantDow = dw ? ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(dw[1].toLowerCase()) : -1;
  const ty = +String(today).slice(0, 4);
  let best = null, gap = Infinity, bestDowOk = false;
  for (const y of [ty - 1, ty, ty + 1]) {
    const iso = `${y}-${pad2(mi + 1)}-${pad2(dd)}`;
    const t = Date.parse(iso + 'T00:00:00Z');
    if (isNaN(t) || new Date(t).getUTCDate() !== dd) continue;      // 31 Sep and friends
    const dowOk = wantDow < 0 || new Date(t).getUTCDay() === wantDow;
    const g = Math.abs(t - Date.parse(today + 'T00:00:00Z'));
    if ((dowOk && !bestDowOk) || (dowOk === bestDowOk && g < gap)) { gap = g; best = iso; bestDowOk = dowOk; }
  }
  return best;
}
/* "10:00", "10:00am", "2:30 pm" -> "HH:MM" (24h), or "". */
function timeOf(raw) {
  const m = String(raw || '').match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return '';
  let h = +m[1]; const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h > 23 || +m[2] > 59 ? '' : pad2(h) + ':' + m[2];
}

module.exports = { TZ, FOUNDERS, brisbaneParts, tokensForSeats, seatsWithPage, sendToSeats, dayOf, timeOf };
