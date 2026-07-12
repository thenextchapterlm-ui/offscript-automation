/**
 * OFFscript call-availability sync.
 *
 * Reads each team member's personal calendar (a private .ics feed URL — works for
 * BOTH Apple Calendar / iCloud and Google Calendar) and writes the UNION of their
 * busy times to Firestore `autoBusy/main` as { periods: [{start,end}] }.
 *
 * The public website booking page (website/public/book.html) already subtracts
 * busy `periods` when generating open call slots, so a slot is only offered when
 * nobody on the team has something on their calendar at that time.
 *
 * Runs on GitHub Actions (see .github/workflows/availability.yml). Never deletes
 * manual time-off (that lives in a separate `manualBusy/main` doc).
 *
 * Feeds are read from env vars (set as GitHub Actions secrets):
 *   ICS_LUCA, ICS_MILES, ICS_TANNAH   (each a private webcal/https .ics URL)
 * Optional: AVAIL_DAYS_AHEAD (default 21).
 */
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const ical = require('node-ical');

function loadCreds() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  throw new Error('No credentials (set FIREBASE_SERVICE_ACCOUNT)');
}
initializeApp({ credential: cert(loadCreds()), projectId: 'offscript-platform-8deb4' });
const db = getFirestore();

const DAYS_AHEAD = parseInt(process.env.AVAIL_DAYS_AHEAD || '21', 10);
const FEEDS = [
  { who: 'luca',   url: (process.env.ICS_LUCA   || '').trim() },
  { who: 'miles',  url: (process.env.ICS_MILES  || '').trim() },
  { who: 'tannah', url: (process.env.ICS_TANNAH || '').trim() },
].filter(f => f.url);

// Normalise a webcal:// URL to https:// so fetch works.
function httpUrl(u) { return u.replace(/^webcal:\/\//i, 'https://'); }

// Recurring events come back from node-ical with a tz offset drift across DST.
// This is the documented correction: re-apply the original start's offset.
function fixOffset(occurrence, originalStart) {
  const a = occurrence.getTimezoneOffset();
  const b = originalStart.getTimezoneOffset();
  return new Date(occurrence.getTime() + (a - b) * 60000);
}

async function collectFeed(feed, windowStart, windowEnd) {
  const periods = [];
  let data;
  try {
    data = await ical.async.fromURL(httpUrl(feed.url));
  } catch (e) {
    console.error(`  ! ${feed.who}: fetch/parse failed — ${e.message}`);
    return null; // signal failure so we don't wrongly open up slots
  }
  for (const key in data) {
    const ev = data[key];
    if (!ev || ev.type !== 'VEVENT') continue;
    if (ev.transparency === 'TRANSPARENT') continue;         // marked "free"
    if (ev.status === 'CANCELLED') continue;
    if (!ev.start || !ev.end) continue;
    const durMs = new Date(ev.end).getTime() - new Date(ev.start).getTime();

    if (ev.rrule) {
      let occ = [];
      try { occ = ev.rrule.between(windowStart, windowEnd, true); } catch (e) { occ = []; }
      for (const raw of occ) {
        const start = fixOffset(raw, new Date(ev.start));
        const dateKey = start.toISOString().slice(0, 10);
        // Skip explicitly excluded dates.
        if (ev.exdate && ev.exdate[dateKey]) continue;
        // Honour a modified single occurrence (recurrence override).
        if (ev.recurrences && ev.recurrences[dateKey]) {
          const r = ev.recurrences[dateKey];
          if (r.status === 'CANCELLED' || r.transparency === 'TRANSPARENT') continue;
          periods.push({ start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString() });
          continue;
        }
        periods.push({ start: start.toISOString(), end: new Date(start.getTime() + durMs).toISOString() });
      }
    } else {
      const s = new Date(ev.start), e = new Date(ev.end);
      if (e > windowStart && s < windowEnd) periods.push({ start: s.toISOString(), end: e.toISOString() });
    }
  }
  console.log(`  · ${feed.who}: ${periods.length} busy periods`);
  return periods;
}

(async () => {
  if (!FEEDS.length) {
    console.error('No calendar feeds configured (set ICS_LUCA / ICS_MILES / ICS_TANNAH). Nothing to do.');
    process.exit(0);
  }
  const now = new Date();
  const windowStart = new Date(now.getTime() - 60 * 60000);           // 1h back (in-progress meetings)
  const windowEnd = new Date(now.getTime() + DAYS_AHEAD * 86400000);

  let all = [];
  let anySuccess = false;
  for (const feed of FEEDS) {
    const p = await collectFeed(feed, windowStart, windowEnd);
    if (p === null) continue;      // this feed failed — skip, keep others
    anySuccess = true;
    all = all.concat(p);
  }

  if (!anySuccess) {
    console.error('All feeds failed — leaving existing autoBusy untouched (not opening up slots).');
    process.exit(1);
  }

  // Sort + merge overlapping/adjacent periods to keep the doc small.
  all.sort((a, b) => a.start.localeCompare(b.start));
  const merged = [];
  for (const p of all) {
    const last = merged[merged.length - 1];
    if (last && p.start <= last.end) { if (p.end > last.end) last.end = p.end; }
    else merged.push({ start: p.start, end: p.end });
  }

  await db.collection('autoBusy').doc('main').set({
    periods: merged,
    updatedAt: new Date().toISOString(),
    feeds: FEEDS.map(f => f.who),
    daysAhead: DAYS_AHEAD,
  });
  console.log(`autoBusy/main written: ${merged.length} merged busy periods across ${FEEDS.length} calendar(s).`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
