/**
 * OFFscript calendar feed generator (GitHub Actions, every 15 min).
 *
 * Reconnected to OFFscript Command (2026-09-13). It used to read the old dashboard -
 * client shootDays/meetings, standalone events and the boards/tasks blob - none of which
 * the team writes any more. It now publishes what the Command app's studio calendar shows:
 *
 *   - shoots        appProjects with isShoot: the day it happens, at its call time if one was set
 *   - meetings      appProjects with isMeeting: start, and endTime or one hour, as the app does
 *   - project dues  any project's `due` date, all-day, like the app's calendar
 *   - tasks         appTasks with a readable due date that are not done
 *
 * Times: the app stores everything in studio time (Australia/Brisbane, UTC+10, no daylight
 * saving). The old feed wrote "floating" local times, which put a 10:00 Brisbane meeting at
 * 10:00 in Rome on Stefano's phone. These are written in UTC, so every device shows the
 * moment on its own clock.
 *
 * The file is committed to a PUBLIC repository and served over its raw URL: anyone with the
 * link can read every title in it. That was true of the old feed as well.
 */
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');
const { brisbaneParts, dayOf, timeOf } = require('./command');

const OUT = process.env.CAL_OUT || path.join(__dirname, 'feed', 'offscript-cal-8x3f.ics');
const STUDIO_OFFSET_H = 10;   // Brisbane: UTC+10 all year

function loadCreds() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  throw new Error('No credentials');
}
initializeApp({ credential: cert(loadCreds()), projectId: 'offscript-platform-8deb4' });
const db = getFirestore();

const pad = (n) => String(n).padStart(2, '0');
const stampOf = (d) => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  if (line.length <= 74) return line;
  let out = line.slice(0, 74); let rest = line.slice(74);
  while (rest.length) { out += '\r\n ' + rest.slice(0, 73); rest = rest.slice(73); }
  return out;
}
/* Studio date + HH:MM -> a UTC instant. */
function studioInstant(iso, hhmm) {
  const [y, mo, d] = iso.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - STUDIO_OFFSET_H, mi, 0));
}
const ymd = (iso) => iso.replace(/-/g, '');
function nextDay(iso) { const t = new Date(Date.parse(iso + 'T00:00:00Z') + 86400000); return t.getUTCFullYear() + pad(t.getUTCMonth() + 1) + pad(t.getUTCDate()); }
const hhmmToMin = (s) => { const m = String(s || '').match(/^(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };

const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OFFscript//Command//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
  'X-WR-CALNAME:OFFscript', 'X-WR-CALDESC:Shoots, meetings and what is due', 'X-WR-TIMEZONE:Australia/Brisbane'];
let count = 0;
const now = new Date();

function addEvent(uid, date, time, endMin, summary) {
  if (!date) return;
  lines.push('BEGIN:VEVENT', 'UID:' + uid + '@offscript', 'DTSTAMP:' + stampOf(now));
  if (time) {
    const start = studioInstant(date, time);
    const lenMin = endMin != null ? Math.max(15, endMin - hhmmToMin(time)) : 60;
    lines.push('DTSTART:' + stampOf(start), 'DTEND:' + stampOf(new Date(start.getTime() + lenMin * 60000)));
  } else {
    lines.push('DTSTART;VALUE=DATE:' + ymd(date), 'DTEND;VALUE=DATE:' + nextDay(date));
  }
  lines.push(fold('SUMMARY:' + esc(summary)), 'END:VEVENT');
  count++;
}

(async () => {
  const { date: today } = brisbaneParts(now);
  const label = (p) => [p.client && p.client !== 'OFFscript' ? p.client : '', p.title || 'Untitled'].filter(Boolean).join(' - ');

  (await db.collection('appProjects').get()).forEach((doc) => {
    const p = doc.data() || {};
    if (p.deleted) return;
    const on = dayOf(p.on, today);
    const time = hhmmToMin(p.time) != null ? String(p.time).slice(0, 5) : '';
    if (p.isMeeting && on) {
      const end = hhmmToMin(p.endTime);
      addEvent('mtg-' + doc.id, on, time, end, 'Meeting - ' + label(p));
    } else if (p.isShoot && on) {
      addEvent('shoot-' + doc.id, on, time, null, 'Shoot - ' + label(p));
    }
    const due = dayOf(p.due, today);
    if (due && due !== on && !p.done) addEvent('due-' + doc.id, due, '', null, 'Due - ' + label(p));
  });

  (await db.collection('appTasks').get()).forEach((doc) => {
    const t = doc.data() || {};
    if (t.done || t.deleted) return;
    const due = dayOf(t.due, today);
    if (!due) return;
    addEvent('task-' + doc.id, due, timeOf(t.due), null, (t.title || 'Task') + (t.client && t.client !== 'OFFscript' ? ' - ' + t.client : ''));
  });

  lines.push('END:VCALENDAR');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\r\n') + '\r\n');
  console.log('calendar written:', OUT, '| events:', count);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
