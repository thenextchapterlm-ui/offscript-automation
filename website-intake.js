/**
 * OFFscript "Website Lead Intake" agent worker (runs on GitHub Actions).
 *
 * Connects the public website's booking + questionnaire flow to the pipeline:
 *   book.html        -> writes `bookings`       { name,email,phone,slot,slotLabel,tz,source:'booking',ingested:false,ts }
 *   questionnaire.html -> writes `questionnaires` { business,handle,niche,...,leadId:<bookingId>,ingested:false,ts }
 * The two are joined on questionnaires.leadId === <bookings doc id>.
 *
 * On each run this worker:
 *   1. Creates a pipeline lead (stage "call") for every new booking, with the
 *      caller's real contact details, and enriches it with their questionnaire
 *      answers when those arrive.
 *   2. Pushes a team notification that a discovery call was booked.
 *   3. Sends the lead a GENUINE, human-sounding acknowledgement email — but only
 *      once the booking is at least ~5 minutes old, so it reads like a person
 *      actually saw it and replied, never an instant autoresponder.
 *
 * Gated on the in-app `agents/website-intake` config: nothing happens unless the
 * agent is `enabled`, and the acknowledgement only auto-SENDS when its autonomy
 * is 'auto' (otherwise a draft is left in Outlook for a human to send).
 *
 * Pass --dry to compute everything and log intended actions without writing to
 * Firestore, sending mail, or pushing notifications.
 */
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const DRY = process.argv.includes('--dry');
const ADDR = 'admin@offscriptcrew.com.au';
const REPLY_PHONE = '0403 337 832';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';

// Acknowledgement timing: never instant (looks human), and never so late it reads
// as creepy/stale. Bookings older than ACK_MAX are marked acked WITHOUT emailing.
const ACK_MIN_AGE_MS = 5 * 60 * 1000;          // wait at least ~5 min before the ack
const ACK_MAX_AGE_MS = 6 * 60 * 60 * 1000;     // >6h old: too late to look genuine, skip
const INGEST_MAX_AGE_DAYS = 30;                // don't backfill ancient bookings as leads

const TENANT = process.env.MS_TENANT_ID, CLIENT = process.env.MS_CLIENT_ID, SECRET = process.env.MS_CLIENT_SECRET;
const AKEY = process.env.ANTHROPIC_API_KEY;

function loadCreds() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  throw new Error('No Firebase creds');
}
initializeApp({ credential: cert(loadCreds()), projectId: 'offscript-platform-8deb4' });
const db = getFirestore();

async function msToken() {
  const body = new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, { method: 'POST', body });
  const j = await r.json();
  if (!j.access_token) throw new Error('MS token: ' + (j.error_description || JSON.stringify(j)).slice(0, 160));
  return j.access_token;
}
async function graph(tok, method, path, body) {
  const r = await fetch('https://graph.microsoft.com/v1.0' + path, {
    method,
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) { const t = await r.text(); throw new Error('graph ' + method + ' ' + path + ': ' + r.status + ' ' + t.slice(0, 140)); }
  return r.status === 204 ? {} : r.json().catch(() => ({}));
}

async function claude(system, user) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, system, messages: [{ role: 'user', content: user }] })
  });
  const j = await r.json();
  if (j.type !== 'message') throw new Error('claude: ' + JSON.stringify(j).slice(0, 160));
  return (j.content || []).map(c => c.text || '').join('').trim();
}

const firstName = n => (n || '').trim().split(/\s+/)[0] || 'there';

// `ts` is written by the browser via the Firestore REST API (timestampValue), so the
// admin SDK reads it back as a Timestamp object — NOT a parseable string. Normalise
// every shape (Timestamp | ISO string | epoch ms) to epoch millis, else the age gates
// evaluate against NaN and silently let every ack through instantly.
function tsMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v) || 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  if (v.seconds != null) return v.seconds * 1000;
  return 0;
}

// Genuine, human acknowledgement. Claude writes it as if Luca personally saw the
// booking; falls back to a warm hand-written template if the API is unavailable.
async function ackEmail({ name, business, slotLabel }) {
  const fn = firstName(name);
  const fallbackBody =
`Hi ${fn},

Just saw your booking come through${business ? ` for ${business}` : ''} - locked in for ${slotLabel}. Really looking forward to it.

Before we talk I'll have a quick look at what you're already putting out so we can walk in with a couple of concrete ideas rather than starting from a blank page. If anything comes up before then or the time stops working, just reply here or text me on ${REPLY_PHONE}.

Talk soon,
Luca and Miles
${REPLY_PHONE}`;
  const fallbackSubject = `See you ${slotLabel.replace(/,.*$/, '')} - OFFscript`;

  if (!AKEY) return { subject: fallbackSubject, body: fallbackBody };
  try {
    const system =
`You write a SHORT, genuinely human acknowledgement email for OFFscript, a Brisbane/Gold Coast short-form content studio (the team is Luca and Miles). Someone just booked a discovery call on the website. Write it as if Luca personally saw the booking a few minutes later and replied himself - warm, specific, low-key, real. NOT a templated autoresponder.

Rules:
- Under 90 words.
- Reference their name, their business if given, and the exact call time.
- One light line that shows we'll come prepared (e.g. we'll look at their current content first).
- No hype, no emojis, no marketing speak, no bullet points. No em dashes - use hyphens.
- Sign off exactly:
Luca and Miles
${REPLY_PHONE}
- Respond ONLY with JSON: {"subject":"...","body":"..."} (body is plain text with real line breaks).`;
    const user = `Name: ${name || '(unknown)'}\nBusiness: ${business || '(not given yet)'}\nCall time: ${slotLabel}`;
    const raw = await claude(system, user);
    const m = raw.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    if (j && j.subject && j.body) return { subject: j.subject, body: j.body };
  } catch (e) { console.error('   ack copy via Claude failed, using fallback:', e.message); }
  return { subject: fallbackSubject, body: fallbackBody };
}

(async () => {
  // 0) Agent gate
  const agentDoc = await db.doc('agents/website-intake').get();
  const agent = agentDoc.exists ? agentDoc.data() : {};
  if (!agent.enabled && !DRY) { console.log('website-intake agent is disabled — nothing to do.'); process.exit(0); }
  if (!agent.enabled && DRY) console.log('[DRY] agent currently disabled in Firestore — running anyway to preview.');
  const autoSend = agent.autonomy === 'auto';

  // 1) Load the queues + join key
  const now = Date.now();
  const bookingsSnap = await db.collection('bookings').get();
  const qSnap = await db.collection('questionnaires').get();

  // questionnaires keyed by the booking id they were filled against
  const qByLead = {};
  qSnap.forEach(d => { const q = d.data(); if (q.leadId) qByLead[q.leadId] = { id: d.id, ...q }; });

  // 2) Pipeline board (stored as a JSON string on boards/pipeline)
  const pipeRef = db.doc('boards/pipeline');
  const pipeDoc = await pipeRef.get();
  let pipe = { leads: [] };
  if (pipeDoc.exists) { try { pipe = JSON.parse(pipeDoc.data().json); } catch (e) {} }
  if (!pipe.leads) pipe.leads = [];
  let pipeChanged = false;

  // Team push tokens
  const tokSnap = await db.collection('pushTokens').get();
  const allTokens = []; tokSnap.forEach(d => { const t = d.data(); if (t.token) allTokens.push(t.token); });
  const sentRef = db.doc('notifications/sent');
  const sentDoc = await sentRef.get();
  const sent = sentDoc.exists ? (sentDoc.data().keys || {}) : {};

  let tok = null; // lazy MS token (only if we actually send/draft)
  let leadsMade = 0, enriched = 0, notified = 0, acked = 0, skipped = 0;
  const newActs = [];   // per-action history entries, prepended to the agent's activity log
  const whenLabel = () => new Date().toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  // helper: enrich a lead object from a questionnaire
  const applyQ = (lead, q) => {
    if (!q) return;
    lead.company = lead.company || q.business || '';
    lead.niche = q.niche || lead.niche || '';
    lead.handle = q.handle || lead.handle || '';
    lead.locationText = q.location || lead.locationText || '';
    const bits = [q.goal && ('Goal: ' + q.goal), q.offer && ('Offer: ' + q.offer), q.price && ('Price: ' + q.price)]
      .filter(Boolean).join(' · ');
    lead.questionnaire = { filled: true, at: q.ts ? new Date(tsMs(q.ts)).toISOString() : null, summary: bits };
  };

  // 3) Process bookings — oldest first
  const bookings = bookingsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => tsMs(a.ts) - tsMs(b.ts));

  for (const bk of bookings) {
    const ageMs = now - tsMs(bk.ts);
    const q = qByLead[bk.id];

    // 3a) Ingest: create the pipeline lead (once), unless the booking is ancient.
    if (!bk.ingested) {
      if (ageMs > INGEST_MAX_AGE_DAYS * 86400000) { skipped++; continue; }
      const email = (bk.email || '').toLowerCase().trim();
      let lead = pipe.leads.find(l => email && (l.email || '').toLowerCase() === email && l.source === 'website-intake');
      if (!lead) {
        lead = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          name: bk.name || 'Website booking', company: (q && q.business) || '', email: bk.email || '',
          phone: bk.phone || '', stage: 'call',
          notes: 'Booked a discovery call via the website for ' + (bk.slotLabel || bk.slot || 'a time') + '.',
          bookingId: bk.id, slot: bk.slot || '', slotLabel: bk.slotLabel || '',
          addedAt: new Date().toISOString(), source: 'website-intake'
        };
        applyQ(lead, q);
        if (!DRY) { pipe.leads.push(lead); pipeChanged = true; }
        leadsMade++;
        newActs.unshift({ when: whenLabel(), text: `New lead at Call stage: ${lead.name}${lead.company ? ' / ' + lead.company : ''} (${lead.email})` });
        console.log(`${DRY ? '[DRY] ' : ''}+ lead (call stage): ${lead.name}${lead.company ? ' / ' + lead.company : ''} — ${lead.email}`);
      }
      // team ping: a call just got booked
      const key = 'booking:' + bk.id;
      if (!sent[key]) {
        if (allTokens.length && !DRY) {
          try {
            await getMessaging().sendEachForMulticast({
              tokens: [...new Set(allTokens)],
              data: { title: '📅 Discovery call booked', body: (bk.name || 'Someone') + ' — ' + (bk.slotLabel || ''), url: '/' },
              webpush: { headers: { Urgency: 'high', TTL: '3600' }, fcmOptions: { link: '/' } }
            });
          } catch (e) { console.error('   push failed:', e.message); }
        }
        sent[key] = now; notified++;
        console.log(`${DRY ? '[DRY] ' : ''}  → team notified: call booked (${bk.name})`);
      }
      if (!DRY) await db.doc('bookings/' + bk.id).set({ ingested: true, leadId: (lead && lead.id) || null, ingestedAt: now }, { merge: true });
    } else if (q && !q._enrichedMarked) {
      // 3b) Late-arriving questionnaire for an already-ingested booking → enrich the lead.
      const lead = pipe.leads.find(l => l.bookingId === bk.id || (l.email && bk.email && l.email.toLowerCase() === bk.email.toLowerCase()));
      if (lead && (!lead.questionnaire || !lead.questionnaire.filled)) {
        applyQ(lead, q);
        if (!DRY) { pipeChanged = true; await db.doc('questionnaires/' + q.id).set({ ingested: true }, { merge: true }); }
        enriched++;
        newActs.unshift({ when: whenLabel(), text: `Enriched lead from questionnaire: ${lead.name}${q.business ? ' / ' + q.business : ''}` });
        console.log(`${DRY ? '[DRY] ' : ''}~ enriched lead from questionnaire: ${lead.name} / ${q.business || ''}`);
      }
    }

    // 3c) Genuine, delayed acknowledgement email to the lead.
    if (!bk.acked && bk.email) {
      if (ageMs < ACK_MIN_AGE_MS) { continue; } // too soon — let it breathe, catch it next run
      if (ageMs > ACK_MAX_AGE_MS) { if (!DRY) await db.doc('bookings/' + bk.id).set({ acked: true, ackSkipped: 'too_old' }, { merge: true }); continue; }
      const business = (q && q.business) || '';
      const { subject, body } = await ackEmail({ name: bk.name, business, slotLabel: bk.slotLabel || bk.slot || 'your call' });
      const mail = { message: {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: [{ emailAddress: { address: bk.email } }]
      }, saveToSentItems: true };

      if (DRY) {
        console.log(`[DRY] would ${autoSend ? 'SEND' : 'DRAFT'} ack to ${bk.email}\n   Subj: ${subject}\n   ${body.replace(/\n/g, '\n   ')}`);
      } else {
        try {
          if (!tok) tok = await msToken();
          if (autoSend) { await graph(tok, 'POST', `/users/${ADDR}/sendMail`, mail); }
          else { await graph(tok, 'POST', `/users/${ADDR}/messages`, { subject, body: { contentType: 'Text', content: body }, toRecipients: mail.message.toRecipients, isDraft: true }); }
          await db.doc('bookings/' + bk.id).set({ acked: true, ackedAt: now, ackAuto: autoSend }, { merge: true });
        } catch (e) { console.error('   ack ' + (autoSend ? 'send' : 'draft') + ' failed:', e.message); continue; }
      }
      acked++;
      newActs.unshift({ when: whenLabel(), text: `${autoSend ? 'Sent' : 'Drafted'} acknowledgement to ${bk.name || bk.email} (${bk.email})` });
      console.log(`${DRY ? '[DRY] ' : ''}✉ ack ${autoSend ? 'sent' : 'drafted'} → ${bk.email}`);
    }
  }

  // 4) Persist
  if (!DRY) {
    if (pipeChanged) await pipeRef.set({ json: JSON.stringify(pipe) }, { merge: true });
    const cutoff = now - 30 * 86400000;
    for (const k in sent) if (sent[k] < cutoff) delete sent[k];
    await sentRef.set({ keys: sent }, { merge: true });
    const upd = { lastRun: now, status: 'active' };
    if (newActs.length) {
      upd.activity = [...newActs, ...(agent.activity || [])].slice(0, 60);
      const stats = agent.stats || { handled: 0, drafts: 0 };
      stats.handled = (stats.handled || 0) + leadsMade;
      stats.drafts = (stats.drafts || 0) + (autoSend ? 0 : acked);
      upd.stats = stats;
    }
    await db.doc('agents/website-intake').set(upd, { merge: true });
  }

  console.log(`website-intake ${DRY ? '(DRY) ' : ''}done — leads=${leadsMade} enriched=${enriched} notified=${notified} acked=${acked} skipped=${skipped}`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
