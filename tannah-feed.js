/**
 * Tannah's daily business/entrepreneur brief.
 * Uses Claude + web search to pull the day's significant developments in the
 * business/startup/entrepreneur world and writes them to feed/tannah-business.json,
 * which his personalised home screen reads.
 */
const fs = require('fs');
const path = require('path');
const AKEY = process.env.ANTHROPIC_API_KEY;
const OUT = process.env.TANNAH_OUT || path.join(__dirname, 'feed', 'tannah-business.json');

const PROMPT =
  'Using web search, find 4 significant developments from the last few days in the business, startup and ' +
  'entrepreneurship world — funding rounds, major company/market moves, notable founder news, or big AI/tech ' +
  'business trends. Prioritise things a young content-agency founder would find genuinely useful or motivating. ' +
  'For each, give: a punchy headline (max ~9 words), a single crisp sentence of detail, and the source name. ' +
  'Respond with ONLY a JSON object, no prose: {"news":[{"headline":"","detail":"","source":""}]}';

(async () => {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
      messages: [{ role: 'user', content: PROMPT }]
    })
  });
  const j = await r.json();
  if (j.type !== 'message') throw new Error('claude: ' + JSON.stringify(j).slice(0, 200));
  const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = txt.match(/\{[\s\S]*\}/);
  let data = { news: [] };
  if (m) { try { data = JSON.parse(m[0]); } catch (e) {} }
  if (!Array.isArray(data.news)) data.news = [];
  data.updated = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
  console.log('tannah feed written:', data.news.length, 'items ->', OUT);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
