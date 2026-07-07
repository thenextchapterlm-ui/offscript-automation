/**
 * OFFscript calendar feed generator.
 * Reads shoot days, meetings and client follow-ups from Firestore and writes an
 * .ics feed that Google/Apple Calendar can subscribe to. Run by GitHub Actions;
 * the file is committed to the repo and served over its raw URL.
 *
 * Times are emitted as "floating" local times (no timezone) so they show at the
 * wall-clock time on whatever device is viewing — simplest correct behaviour for a
 * single team. All-day when no time is given.
 */
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

const OUT = process.env.CAL_OUT || path.join(__dirname, 'feed', 'offscript-cal-8x3f.ics');

function loadCreds() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  throw new Error('No credentials');
}
initializeApp({ credential: cert(loadCreds()), projectId: 'offscript-platform-8deb4' });
const db = getFirestore();

const pad = n => String(n).padStart(2, '0');
function stamp() {
  const d = new Date();
  return d.getUTCFullYear() + pad(d.getUTCMonth()+1) + pad(d.getUTCDate()) + 'T' +
         pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
}
function esc(s) { return String(s == null ? '' : s).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n'); }
function fold(line) {
  // RFC5545: lines longer than 75 octets should be folded
  if (line.length <= 74) return line;
  let out = line.slice(0, 74); let rest = line.slice(74);
  while (rest.length) { out += '\r\n ' + rest.slice(0, 73); rest = rest.slice(73); }
  return out;
}
function ymd(dateStr) { return dateStr.replace(/-/g, ''); }
function nextDay(dateStr) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate()+1); return d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate()); }
function plusHour(dateStr, timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date(dateStr + 'T00:00:00'); d.setHours(h+1, m || 0, 0, 0);
  return d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+'T'+pad(d.getHours())+pad(d.getMinutes())+'00';
}

const lines = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OFFscript//Platform//EN',
  'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:OFFscript', 'X-WR-CALDESC:Shoots, meetings & follow-ups'
];
let count = 0;
function addEvent(uid, item, summary) {
  if (!item.date) return;
  lines.push('BEGIN:VEVENT');
  lines.push('UID:' + uid + '@offscript');
  lines.push('DTSTAMP:' + stamp());
  if (item.time) {
    lines.push('DTSTART:' + ymd(item.date) + 'T' + item.time.replace(':', '') + '00');
    lines.push('DTEND:' + plusHour(item.date, item.time));
  } else {
    lines.push('DTSTART;VALUE=DATE:' + ymd(item.date));
    lines.push('DTEND;VALUE=DATE:' + nextDay(item.date));
  }
  lines.push(fold('SUMMARY:' + esc(summary)));
  lines.push('END:VEVENT');
  count++;
}

(async () => {
  const clients = await db.collection('clients').get();
  clients.forEach(doc => {
    const c = doc.data();
    const biz = c.business || c.name || 'Client';
    (c.shootDays || []).forEach((s, i) => addEvent('shoot-'+doc.id+'-'+i, s, 'Shoot — ' + biz + (s.note ? ' (' + s.note + ')' : '')));
    (c.meetings  || []).forEach((m, i) => addEvent('mtg-'+doc.id+'-'+i, m, 'Meeting — ' + biz + (m.title ? ': ' + m.title : '')));
    if (c.nextTouch) addEvent('follow-'+doc.id, { date: c.nextTouch }, 'Follow-up — ' + biz);
  });

  // Standalone quick-add events (no client)
  try {
    const events = await db.collection('events').get();
    events.forEach(doc => {
      const e = doc.data();
      const kind = e.type === 'shoot' ? 'Shoot' : 'Meeting';
      addEvent('ev-'+doc.id, e, kind + ' — ' + (e.title || 'Untitled'));
    });
  } catch (e) { /* events collection may not exist yet */ }

  lines.push('END:VCALENDAR');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\r\n') + '\r\n');
  console.log('calendar written:', OUT, '| events:', count);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
