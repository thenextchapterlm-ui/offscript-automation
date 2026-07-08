/**
 * OFFscript email agent worker.
 * Reads new (unread, unprocessed) inbox mail on admin@offscriptcrew.com.au,
 * uses Claude to classify + draft a reply per the matching agent's direction,
 * and creates a DRAFT reply in Outlook for a human to review/send.
 * Genuine cold prospects also get a Lead created in the pipeline.
 *
 * SAFETY (v1): never auto-sends — always drafts. Auto-send is a later flag.
 * Pass --dry to classify + draft with Claude but write nothing (no Outlook draft,
 * no lead, no processed marker).
 */
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const DRY = process.argv.includes('--dry');
const ADDR = 'admin@offscriptcrew.com.au';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
const LOOKBACK_DAYS = 5;
const MAX_PER_RUN = 8;

const TENANT = process.env.MS_TENANT_ID, CLIENT = process.env.MS_CLIENT_ID, SECRET = process.env.MS_CLIENT_SECRET;
const AKEY = process.env.ANTHROPIC_API_KEY;

function loadCreds() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  throw new Error('No Firebase creds');
}
initializeApp({ credential: cert(loadCreds()), projectId: 'offscript-platform-8deb4' });
const db = getFirestore();

const AUTOMATED = /(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|notifications?@|@microsoft\.com|@email\.microsoft|@.*\.microsoftonline|@mail\.instagram|@facebookmail|@linkedin\.com|@bounce)/i;

async function msToken() {
  const body = new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, { method: 'POST', body });
  const j = await r.json();
  if (!j.access_token) throw new Error('MS token: ' + (j.error_description || JSON.stringify(j)).slice(0, 160));
  return j.access_token;
}
async function graph(tok, method, path, body, extraHeaders) {
  const r = await fetch('https://graph.microsoft.com/v1.0' + path, {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, extraHeaders || {}),
    body: body ? JSON.stringify(body) : undefined
  });
  if (method === 'GET') { const j = await r.json(); if (!r.ok) throw new Error('graph GET ' + path + ': ' + JSON.stringify(j).slice(0,160)); return j; }
  if (!r.ok) { const t = await r.text(); throw new Error('graph ' + method + ' ' + path + ': ' + r.status + ' ' + t.slice(0,140)); }
  return r.status === 204 ? {} : r.json().catch(() => ({}));
}

async function claude(system, user) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages: [{ role: 'user', content: user }] })
  });
  const j = await r.json();
  if (j.type !== 'message') throw new Error('claude: ' + JSON.stringify(j).slice(0,160));
  return (j.content || []).map(c => c.text || '').join('').trim();
}
function parseJSON(txt) {
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

(async () => {
  // Agent configs
  const agentsSnap = await db.collection('agents').get();
  const agents = {}; agentsSnap.forEach(d => agents[d.id] = d.data());
  const responder = agents['email-responder'] || {};
  const cold = agents['cold-inbound'] || {};

  // Clients (for matching known senders + context)
  const clientsSnap = await db.collection('clients').get();
  const clients = clientsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const clientByEmail = {};
  clients.forEach(c => { if (c.email) clientByEmail[c.email.toLowerCase().trim()] = c; });

  // Processed state
  const stateRef = db.doc('automation/emailState');
  const stateDoc = await stateRef.get();
  const processed = stateDoc.exists ? (stateDoc.data().processed || {}) : {};

  const tok = await msToken();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const list = await graph(tok, 'GET',
    `/users/${ADDR}/mailFolders/inbox/messages?$filter=isRead eq false and receivedDateTime ge ${since}&$top=${MAX_PER_RUN}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,body`,
    null, { Prefer: 'outlook.body-content-type="text"' });

  const msgs = (list.value || []).filter(m => !processed[m.id]);
  let drafted = 0, sent = 0, leadsMade = 0, skipped = 0;

  // Pipeline (for lead creation)
  const pipeRef = db.doc('boards/pipeline');
  const pipeDoc = await pipeRef.get();
  let pipe = { leads: [] };
  if (pipeDoc.exists) { try { pipe = JSON.parse(pipeDoc.data().json); } catch (e) {} }
  if (!pipe.leads) pipe.leads = [];
  let pipeChanged = false;

  for (const m of msgs) {
    const fromAddr = ((m.from && m.from.emailAddress && m.from.emailAddress.address) || '').toLowerCase().trim();
    const fromName = (m.from && m.from.emailAddress && m.from.emailAddress.name) || fromAddr;
    if (!fromAddr || AUTOMATED.test(fromAddr) || fromAddr === ADDR) { processed[m.id] = Date.now(); skipped++; continue; }

    // Routing: known client OR an ongoing thread ("Re:"/"Fwd:") → Email Responder (reply in context);
    // only genuinely fresh first-contact mail goes to the Cold Inbound handler.
    const known = clientByEmail[fromAddr];
    const isThread = /^\s*(re|fw|fwd)\s*:/i.test(m.subject || '');
    const useResponder = !!known || isThread;
    const agent = useResponder ? responder : cold;
    if (!agent.enabled) { skipped++; continue; } // agent paused/off in the Agents tab → don't process (leave unread, unprocessed)

    const bodyText = ((m.body && m.body.content) || m.bodyPreview || '').replace(/\r/g, '').slice(0, 4000);
    const context = known
      ? `This sender is an EXISTING CLIENT: ${known.business || known.name} (${known.type || 'client'}). Reply helpfully in context.`
      : isThread
        ? `This is an ONGOING conversation (the subject is a reply). Treat it as a real relationship — reply helpfully in context. Only mark irrelevant if it is clearly automated/spam.`
        : `This sender is NOT known and this is a fresh first-contact email — treat as cold/new inbound.`;

    const system = (agent.instructions || 'You are OFFscript\'s email assistant.') +
      `\n\nContext: ${context}\n\nRespond ONLY with a JSON object, no prose, of the form:\n` +
      `{"category":"client|prospect|irrelevant","name":"sender full name","company":"their business or ''","shouldReply":true|false,"reply":"the full draft reply email body in plain text, signed off as the OFFscript team"}\n` +
      `Set category=irrelevant and shouldReply=false for spam, newsletters, or anything not worth a human reply.`;

    const userMsg = `From: ${fromName} <${fromAddr}>\nSubject: ${m.subject || '(no subject)'}\n\n${bodyText}`;

    let res;
    try { res = parseJSON(await claude(system, userMsg)); } catch (e) { console.error('claude fail for', m.id, e.message); continue; }
    if (!res) { console.error('no JSON for', m.id); continue; }

    console.log(`[${known ? 'CLIENT' : 'COLD'}] ${fromAddr} — cat=${res.category} reply=${res.shouldReply}` + (DRY ? '' : ''));

    if (res.shouldReply && res.reply) {
      // Auto-send ONLY for fresh cold outreach handled by the Cold Inbound agent when its autonomy
      // is "auto" (the team flips this on in the Agents tab after writing its direction). Everything
      // else — clients, ongoing threads — always drafts for human review.
      const autoSend = !known && !isThread && agent.autonomy === 'auto';
      if (DRY) {
        console.log('   [DRY] would ' + (autoSend ? 'AUTO-SEND' : 'draft') + ' (' + res.reply.length + ' chars)');
      } else if (autoSend) {
        try { await graph(tok, 'POST', `/users/${ADDR}/messages/${m.id}/reply`, { comment: res.reply }); sent++; console.log('   ✉ auto-SENT cold reply'); }
        catch (e) { console.error('   auto-send failed:', e.message); }
      } else {
        try { await graph(tok, 'POST', `/users/${ADDR}/messages/${m.id}/createReply`, { comment: res.reply }); drafted++; console.log('   ✓ draft reply created in Outlook'); }
        catch (e) { console.error('   draft failed:', e.message); }
      }
    }

    // Cold genuine prospect → create a pipeline lead (if not already present)
    if (!known && res.category === 'prospect') {
      const exists = pipe.leads.some(l => (l.email || '').toLowerCase() === fromAddr);
      if (!exists) {
        if (DRY) { console.log('   [DRY] would create pipeline lead:', res.name || fromName); }
        else {
          pipe.leads.push({
            id: Date.now().toString(36) + Math.random().toString(36).slice(2,5),
            name: res.name || fromName, company: res.company || '', email: fromAddr,
            stage: 'replied', notes: 'Auto-added from inbound email: ' + (m.subject || ''),
            addedAt: new Date().toISOString(), source: 'email-agent'
          });
          pipeChanged = true; leadsMade++;
        }
      }
    }

    if (!DRY) processed[m.id] = Date.now();
  }

  if (!DRY) {
    if (pipeChanged) await pipeRef.set({ json: JSON.stringify(pipe) }, { merge: true });
    // prune processed markers older than 30 days
    const cutoff = Date.now() - 30 * 86400000;
    for (const k in processed) if (processed[k] < cutoff) delete processed[k];
    await stateRef.set({ processed, lastRun: Date.now() }, { merge: true });
  }

  console.log(`email agent ${DRY ? '(DRY) ' : ''}done — new=${msgs.length} drafted=${drafted} sent=${sent} leads=${leadsMade} skipped=${skipped}`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
