/**
 * OFFscript "Pipeline Mover" agent worker (runs on GitHub Actions every 10 min).
 *
 * Reconnected to OFFscript Command (2026-09-13): it moves cards on the app's Outreach
 * board (appLeads) instead of the old dashboard's `boards/pipeline` JSON blob.
 *
 * Rules-based, NO AI. The Command board's stages are
 *     LEAD -> CALL BOOKED -> PROPOSAL -> NEGOTIATION -> WON
 * and there is one signal a machine can read for certain:
 *   - someone on the board at LEAD has booked a discovery call on the website with the
 *     same email address -> CALL BOOKED.
 *
 * The old version had two more rules that do not survive the move, and were dropped rather
 * than bent to fit: "replied to our email -> replied" (the Command board has no Replied
 * stage) and "every per-lead task ticked -> next stage" (Command leads have no checklist).
 *
 * Safety: forward only, so it can never undo a person's move. Gated on agents/pipeline-mover:
 * nothing runs unless `enabled`, and moves are only written when autonomy is 'auto' -
 * otherwise they are logged to the agent's activity as suggestions.
 *
 * Pass --dry to compute and log intended moves without writing anything.
 */
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const DRY = process.argv.includes('--dry');
const STAGES = ['LEAD', 'CALL BOOKED', 'PROPOSAL', 'NEGOTIATION', 'WON'];
const sidx = (s) => STAGES.indexOf(s || 'LEAD');

function loadCreds() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  throw new Error('No Firebase creds');
}
initializeApp({ credential: cert(loadCreds()), projectId: 'offscript-platform-8deb4' });
const db = getFirestore();

const norm = (e) => String(e || '').toLowerCase().trim();
const whenLabel = () => new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

(async () => {
  const agentRef = db.doc('agents/pipeline-mover');
  const agentDoc = await agentRef.get();
  const agent = agentDoc.exists ? agentDoc.data() : {};
  if (!agent.enabled && !DRY) { console.log('pipeline-mover agent is disabled - nothing to do.'); process.exit(0); }
  if (!agent.enabled && DRY) console.log('[DRY] agent currently disabled - running anyway to preview.');
  const apply = agent.autonomy === 'auto';

  const bookedEmails = new Set();
  (await db.collection('bookings').get()).forEach((d) => { const e = norm(d.data().email); if (e) bookedEmails.add(e); });

  const leads = await db.collection('appLeads').get();
  const moves = [];
  leads.forEach((d) => {
    const l = d.data() || {};
    const email = norm(l.email);
    if (!email || !bookedEmails.has(email)) return;
    if (sidx(l.stage) < 0 || sidx(l.stage) >= sidx('CALL BOOKED')) return;   // unknown, or already there or past
    moves.push({ id: d.id, name: l.company || l.name || email, from: l.stage || 'LEAD', to: 'CALL BOOKED', reason: 'discovery call booked' });
  });

  moves.forEach((m) => console.log(`${DRY ? '[DRY] ' : ''}${apply ? '->' : '(suggest)'} ${m.name}: ${m.from} -> ${m.to}  [${m.reason}]`));
  if (DRY) { console.log(`pipeline-mover (DRY) done - ${moves.length} move(s).`); process.exit(0); }

  if (apply) for (const m of moves) await db.doc('appLeads/' + m.id).set({ stage: m.to, updatedAt: new Date().toISOString(), updatedBy: 'pipeline-mover' }, { merge: true });
  const upd = { lastRun: Date.now(), lastCount: apply ? moves.length : 0, status: 'active' };
  if (moves.length) {
    const when = whenLabel();
    const acts = (agent.activity || []).slice();
    moves.forEach((m) => acts.unshift({ when, text: `${apply ? '' : 'Suggested: '}${m.name}: ${m.from} -> ${m.to} (${m.reason})` }));
    upd.activity = acts.slice(0, 40);
    if (apply) { const stats = agent.stats || { handled: 0, drafts: 0 }; stats.handled = (stats.handled || 0) + moves.length; upd.stats = stats; }
  }
  await agentRef.set(upd, { merge: true });
  console.log(`pipeline-mover done - ${apply ? 'moved' : 'suggested'} ${moves.length}.`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
