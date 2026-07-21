/**
 * OFFscript "Pipeline Mover" agent worker (runs on GitHub Actions).
 *
 * Rules-based (NO AI). Advances pipeline leads through the funnel from real signals:
 *   Stages:  sent → replied → call → proposal → won
 *   • Inbound email reply from a lead's address  → move a "sent" lead to "replied".
 *   • A website discovery-call booking for a lead → move a "sent"/"replied" lead to "call".
 *   • Every per-lead task ticked                 → advance one stage + start a fresh checklist
 *                                                  (mirrors the app's client-side rule, but made
 *                                                  reliable even when no one has the app open;
 *                                                  a lead at "proposal" with all tasks done → "won").
 *
 * Safety: only ever moves FORWARD (target stage index must be greater than the current one),
 * so it can never undo a human's drag. Every move is logged to the agent's activity feed.
 *
 * Gated on the in-app `agents/pipeline-mover` config: nothing runs unless `enabled`, and moves
 * are only written when autonomy is 'auto' (otherwise intended moves are logged as suggestions).
 *
 * Pass --dry to compute + log intended moves without writing anything.
 */
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const DRY = process.argv.includes('--dry');
const ADDR = 'admin@offscriptcrew.com.au';
const REPLY_LOOKBACK_DAYS = 14;         // how far back to scan the inbox for lead replies
const MAX_INBOX = 100;

const TENANT = process.env.MS_TENANT_ID, CLIENT = process.env.MS_CLIENT_ID, SECRET = process.env.MS_CLIENT_SECRET;

const STAGES = ['sent', 'replied', 'call', 'proposal', 'won'];
const sidx = s => STAGES.indexOf(s);

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
async function graphGet(tok, path) {
  const r = await fetch('https://graph.microsoft.com/v1.0' + path, { headers: { Authorization: 'Bearer ' + tok } });
  const j = await r.json();
  if (!r.ok) throw new Error('graph GET ' + path + ': ' + JSON.stringify(j).slice(0, 160));
  return j;
}

// Timestamps written by the browser via the Firestore REST API come back as Timestamp objects,
// not strings — normalise every shape (Timestamp | ISO string | epoch ms) to epoch millis.
function tsMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v) || 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  if (v.seconds != null) return v.seconds * 1000;
  return 0;
}
const norm = e => (e || '').toLowerCase().trim();
const whenLabel = () => new Date().toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

(async () => {
  // 0) Agent gate
  const agentRef = db.doc('agents/pipeline-mover');
  const agentDoc = await agentRef.get();
  const agent = agentDoc.exists ? agentDoc.data() : {};
  if (!agent.enabled && !DRY) { console.log('pipeline-mover agent is disabled — nothing to do.'); process.exit(0); }
  if (!agent.enabled && DRY) console.log('[DRY] agent currently disabled in Firestore — running anyway to preview.');
  const apply = agent.autonomy === 'auto';   // auto = actually move; otherwise log suggestions only

  // 1) Pipeline board (a JSON string on boards/pipeline)
  const pipeRef = db.doc('boards/pipeline');
  const pipeDoc = await pipeRef.get();
  let pipe = { leads: [] };
  if (pipeDoc.exists) { try { pipe = JSON.parse(pipeDoc.data().json); } catch (e) {} }
  if (!pipe.leads) pipe.leads = [];

  // 2) Signal A — inbound replies: email → latest received time (best-effort; skip if Graph unavailable)
  const replyAt = {};
  if (TENANT && CLIENT && SECRET) {
    try {
      const tok = await msToken();
      const since = new Date(Date.now() - REPLY_LOOKBACK_DAYS * 86400000).toISOString();
      const list = await graphGet(tok,
        `/users/${ADDR}/mailFolders/inbox/messages?$filter=receivedDateTime ge ${since}&$top=${MAX_INBOX}&$orderby=receivedDateTime desc&$select=from,receivedDateTime`);
      (list.value || []).forEach(m => {
        const a = norm(m.from && m.from.emailAddress && m.from.emailAddress.address);
        if (!a || a === ADDR) return;
        const t = tsMs(m.receivedDateTime);
        if (t > (replyAt[a] || 0)) replyAt[a] = t;
      });
      console.log(`inbox scanned — ${Object.keys(replyAt).length} distinct senders in last ${REPLY_LOOKBACK_DAYS}d`);
    } catch (e) { console.error('   reply scan skipped:', e.message); }
  } else {
    console.log('   no MS creds — skipping the reply rule this run.');
  }

  // 3) Signal B — website bookings: set of emails that have booked a call
  const bookedEmails = new Set();
  try {
    const bk = await db.collection('bookings').get();
    bk.forEach(d => { const e = norm(d.data().email); if (e) bookedEmails.add(e); });
  } catch (e) { console.error('   bookings read failed:', e.message); }

  // 4) Apply rules — forward-only
  const moves = [];
  const moveTo = (lead, target, reason) => {
    if (sidx(target) <= sidx(lead.stage)) return;         // never sideways/backwards
    moves.push({ name: lead.name || lead.company || lead.email || 'Lead', from: lead.stage, to: target, reason });
    if (apply) { lead.stage = target; lead.movedAt = new Date().toISOString(); }
  };

  for (const lead of pipe.leads) {
    if (!STAGES.includes(lead.stage)) continue;           // ignore custom/unknown stages
    const email = norm(lead.email);
    const enteredMs = tsMs(lead.movedAt || lead.addedAt);

    // Rule: all per-lead tasks ticked → advance one stage + clear the checklist (mirrors the app).
    if (Array.isArray(lead.tasks) && lead.tasks.length && lead.tasks.every(t => t.done) && sidx(lead.stage) < STAGES.length - 1) {
      const target = STAGES[sidx(lead.stage) + 1];
      moves.push({ name: lead.name || lead.company || 'Lead', from: lead.stage, to: target, reason: 'all tasks complete' });
      if (apply) { lead.stage = target; lead.movedAt = new Date().toISOString(); lead.tasks = []; }
      continue;   // one move per lead per run
    }

    // Rule: a booking exists for this lead → at least "call".
    if (email && bookedEmails.has(email) && sidx(lead.stage) < sidx('call')) {
      moveTo(lead, 'call', 'discovery call booked');
      continue;
    }

    // Rule: a genuine inbound reply after we put them at "sent" → "replied".
    if (email && lead.stage === 'sent' && replyAt[email] && replyAt[email] >= (enteredMs || 0)) {
      moveTo(lead, 'replied', 'replied to our email');
      continue;
    }
  }

  // 5) Report + persist
  if (!moves.length) {
    console.log(`pipeline-mover ${DRY ? '(DRY) ' : ''}done — no moves.`);
    if (!DRY) await agentRef.set({ lastRun: Date.now(), lastCount: 0, status: 'active' }, { merge: true });
    process.exit(0);
  }

  moves.forEach(m => console.log(`${DRY ? '[DRY] ' : ''}${apply ? '→' : '(suggest)'} ${m.name}: ${m.from} → ${m.to}  [${m.reason}]`));

  if (!DRY && apply) {
    await pipeRef.set({ json: JSON.stringify(pipe) }, { merge: true });
    const when = whenLabel();
    const acts = (agent.activity || []).slice();
    moves.forEach(m => acts.unshift({ when, text: `${m.name}: ${m.from} → ${m.to} (${m.reason})` }));
    const stats = agent.stats || { handled: 0, drafts: 0 };
    stats.handled = (stats.handled || 0) + moves.length;
    await agentRef.set({ lastRun: Date.now(), lastCount: moves.length, status: 'active', stats, activity: acts.slice(0, 40) }, { merge: true });
  } else if (!DRY) {
    // Suggestions-only (autonomy not 'auto'): record them without touching the board.
    const when = whenLabel();
    const acts = (agent.activity || []).slice();
    moves.forEach(m => acts.unshift({ when, text: `Suggested: ${m.name} ${m.from} → ${m.to} (${m.reason})` }));
    await agentRef.set({ lastRun: Date.now(), lastCount: 0, status: 'active', activity: acts.slice(0, 40) }, { merge: true });
  }

  console.log(`pipeline-mover ${DRY ? '(DRY) ' : ''}done — ${apply ? 'moved' : 'suggested'} ${moves.length}.`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
