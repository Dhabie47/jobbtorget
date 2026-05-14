/**
 * Jobbtorget – Backend server
 * Node.js + Express
 *
 * Kör: node server.js
 * Öppna: http://localhost:3000
 *
 * Hämtar riktiga jobb från Arbetsförmedlingens JobStream API v2
 * Swagger: https://jobstream.api.jobtechdev.se
 * Ingen API-nyckel krävs – helt öppet!
 *
 * Flöde:
 *   1. Vid uppstart → GET /v2/snapshot  (alla ~100 000 aktiva annonser)
 *   2. Var 10:e minut → GET /v2/stream  (bara nya/ändrade/borttagna)
 */

const express = require('express');
const path    = require('path');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

/* ══════════════════════════════════════════
   KONFIGURATION
══════════════════════════════════════════ */
const AF_HOST  = 'jobstream.api.jobtechdev.se';
const SNAPSHOT = '/v2/snapshot';   // alla aktiva annonser
const STREAM   = '/v2/stream';     // förändringar sedan datum
const CACHE_TTL = 10 * 60 * 1000; // 10 minuter

/* ── State ── */
let jobMap     = new Map(); // id → jobb
let jobCache   = [];        // Array-version av jobMap
let lastStream = null;      // ISO-sträng för senaste stream-anrop
let lastFetch  = 0;
let totalFromAF = 0;

/* ══════════════════════════════════════════
   HTTPS-HJÄLPFUNKTION
══════════════════════════════════════════ */
function httpsGet(host, urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      path: urlPath,
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    };
    const req = https.request(options, res => {
      // Följ redirect
      if ([301, 302].includes(res.statusCode) && res.headers.location) {
        const loc = new URL(res.headers.location);
        return httpsGet(loc.hostname, loc.pathname + loc.search)
          .then(resolve).catch(reject);
      }
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.end();
  });
}

/* ══════════════════════════════════════════
   DATAOMVANDLING – AF-format → Jobbtorget
══════════════════════════════════════════ */
const COLOR_PAIRS = [
  ['#FFF3E0','#C46A00'], ['#E1F5EE','#0F6E56'], ['#E6F1FB','#185FA5'],
  ['#FBEAF0','#993556'], ['#EEEDFE','#534AB7'], ['#FFF8EE','#8A4500'],
  ['#EAF3DE','#3B6D11'], ['#F1EFE8','#5F5E5A']
];

function logoColor(name = '') {
  const i = (name.charCodeAt(0) || 0) % COLOR_PAIRS.length;
  return COLOR_PAIRS[i][0];
}
function logoText(name = '') {
  const i = (name.charCodeAt(0) || 0) % COLOR_PAIRS.length;
  return COLOR_PAIRS[i][1];
}
function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map(w => (w[0] || '').toUpperCase()).join('') || 'AF';
}
function mapType(label = '') {
  const l = label.toLowerCase();
  if (l.includes('deltid') || l.includes('part'))   return 'deltid';
  if (l.includes('distans') || l.includes('fjärr')) return 'distans';
  return 'heltid';
}
function isNew(dateStr) {
  if (!dateStr) return false;
  return Date.now() - new Date(dateStr).getTime() < 86400000;
}

function mapJob(raw) {
  if (!raw || !raw.id) return null;
  const name = raw.employer?.name || 'Okänd arbetsgivare';
  return {
    id:          raw.id,
    title:       raw.headline || 'Okänd titel',
    company:     name,
    city:        raw.workplace_address?.municipality || raw.workplace_address?.city || 'Sverige',
    type:        mapType(raw.working_hours_type?.label || raw.employment_type?.label || ''),
    badge:       isNew(raw.publication_date) ? 'new' : '',
    source:      'Platsbanken',
    logo:        initials(name),
    lc:          logoColor(name),
    lt:          logoText(name),
    url:         raw.webpage_url || raw.application_details?.url || '#',
    description: (raw.description?.text || '').substring(0, 250),
    published:   raw.publication_date || '',
    deadline:    raw.application_deadline || ''
  };
}

/* ══════════════════════════════════════════
   SNAPSHOT – hämtar alla aktiva annonser
══════════════════════════════════════════ */
async function fetchSnapshot() {
  console.log('📥 Hämtar snapshot från Arbetsförmedlingen...');
  const { status, body } = await httpsGet(AF_HOST, SNAPSHOT);
  if (status !== 200) throw new Error(`Snapshot: HTTP ${status}`);

  const lines = body.trim().split('\n').filter(Boolean);
  let count = 0;
  jobMap.clear();

  for (const line of lines) {
    try {
      const mapped = mapJob(JSON.parse(line));
      if (mapped) { jobMap.set(mapped.id, mapped); count++; }
    } catch { /* hoppa felaktiga rader */ }
  }

  totalFromAF = count;
  jobCache    = Array.from(jobMap.values());
  lastStream  = new Date().toISOString();
  console.log(`✅ Snapshot klar – ${count} annonser inlästa`);
}

/* ══════════════════════════════════════════
   STREAM – bara förändringar sedan senast
══════════════════════════════════════════ */
async function fetchStream() {
  if (!lastStream) return fetchSnapshot();
  const since = encodeURIComponent(lastStream);
  console.log(`🔄 Stream-uppdatering sedan ${lastStream}...`);
  const { status, body } = await httpsGet(AF_HOST, `${STREAM}?date=${since}`);
  if (status !== 200) throw new Error(`Stream: HTTP ${status}`);

  const lines = body.trim().split('\n').filter(Boolean);
  let added = 0, updated = 0, removed = 0;

  for (const line of lines) {
    try {
      const raw = JSON.parse(line);
      if (raw.removed === true) {
        jobMap.delete(raw.id); removed++;
      } else {
        const mapped = mapJob(raw);
        if (mapped) {
          jobMap.has(mapped.id) ? updated++ : added++;
          jobMap.set(mapped.id, mapped);
        }
      }
    } catch { /* hoppa */ }
  }

  totalFromAF = jobMap.size;
  jobCache    = Array.from(jobMap.values());
  lastStream  = new Date().toISOString();
  console.log(`✅ Stream klar – +${added} nya  ~${updated} uppdaterade  -${removed} borttagna`);
}

/* ══════════════════════════════════════════
   getJobs – cache-logik
══════════════════════════════════════════ */
async function getJobs() {
  const now = Date.now();

  // Första anropet → kör snapshot
  if (jobCache.length === 0) {
    try {
      await fetchSnapshot();
    } catch (err) {
      console.warn('⚠️  Snapshot misslyckades, använder fallback:', err.message);
      return FALLBACK_JOBS;
    }
    lastFetch = now;
    return jobCache;
  }

  // Cache fortfarande giltig
  if (now - lastFetch < CACHE_TTL) return jobCache;

  // TTL gått ut → uppdatera i bakgrunden, returnera befintlig cache
  lastFetch = now;
  fetchStream().catch(err =>
    console.warn('⚠️  Stream misslyckades:', err.message)
  );
  return jobCache;
}

/* ══════════════════════════════════════════
   FALLBACK-DATA (om AF API är nere)
══════════════════════════════════════════ */
const FALLBACK_JOBS = [
  { id:1,  title:'Lagermedarbetare',           company:'IKEA Sverige',       city:'Göteborg',  type:'heltid',  badge:'new',    source:'Platsbanken',   logo:'IK', lc:'#FFF3E0', lt:'#C46A00' },
  { id:2,  title:'Systemutvecklare – Backend',  company:'Junic AB',           city:'Stockholm', type:'distans', badge:'remote', source:'Junic',         logo:'JN', lc:'#E1F5EE', lt:'#0F6E56' },
  { id:3,  title:'Ekonomiassistent',            company:'One Partner Group',  city:'Malmö',     type:'heltid',  badge:'full',   source:'One Partner',   logo:'OP', lc:'#E6F1FB', lt:'#185FA5' },
  { id:4,  title:'Sjuksköterska – Akuten',      company:'VGR',                city:'Borås',     type:'heltid',  badge:'new',    source:'Arbetsgivaren', logo:'VG', lc:'#FBEAF0', lt:'#993556' },
  { id:5,  title:'Barista & Café-medarbetare',  company:'Espresso House',     city:'Sundsvall', type:'deltid',  badge:'',       source:'Platsbanken',   logo:'EH', lc:'#FFF8EE', lt:'#8A4500' },
  { id:6,  title:'IT-supporttekniker',          company:'Dustin AB',          city:'Stockholm', type:'heltid',  badge:'new',    source:'Arbetsgivaren', logo:'DU', lc:'#E6F1FB', lt:'#185FA5' },
  { id:7,  title:'Personlig assistent',         company:'Humana',             city:'Umeå',      type:'deltid',  badge:'',       source:'Platsbanken',   logo:'HU', lc:'#EEEDFE', lt:'#534AB7' },
  { id:8,  title:'Frontend-utvecklare – React', company:'Klarna',             city:'Stockholm', type:'distans', badge:'remote', source:'Arbetsgivaren', logo:'KL', lc:'#E1F5EE', lt:'#0F6E56' },
];

/* ══════════════════════════════════════════
   API-ROUTES
══════════════════════════════════════════ */

// GET /api/jobs  – alla jobb med valfritt filter
app.get('/api/jobs', async (req, res) => {
  try {
    let jobs = await getJobs();
    const { type, q } = req.query;

    if (type && type !== 'alla') {
      jobs = jobs.filter(j => j.type === type);
    }
    if (q) {
      const query = q.toLowerCase();
      jobs = jobs.filter(j =>
        j.title.toLowerCase().includes(query)   ||
        j.company.toLowerCase().includes(query) ||
        j.city.toLowerCase().includes(query)
      );
    }

    // Begränsa till 50 per sida (lägg till pagination senare)
    const paged = jobs.slice(0, 50);

    res.json({
      jobs:  paged,
      total: jobs.length,
      stats: {
        total:   totalFromAF || jobCache.length,
        sources: 340,
        today:   jobs.filter(j => j.badge === 'new').length
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Kunde inte hämta jobb', detail: err.message });
  }
});

// GET /api/jobs/:id
app.get('/api/jobs/:id', async (req, res) => {
  const jobs = await getJobs();
  const job = jobs.find(j => String(j.id) === req.params.id);
  if (!job) return res.status(404).json({ error: 'Jobbet hittades inte' });
  res.json(job);
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  await getJobs();
  res.json({
    total:   totalFromAF || jobCache.length,
    sources: 340,
    today:   jobCache.filter(j => j.badge === 'new').length,
    updated: lastStream
  });
});

// GET /api/sources
app.get('/api/sources', (_req, res) => {
  res.json({ sources: ['Platsbanken', 'Junic', 'One Partner', 'Arbetsgivares egna sidor'] });
});

// Allt annat → frontend
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ══════════════════════════════════════════
   STARTA SERVER
══════════════════════════════════════════ */
app.listen(PORT, async () => {
  console.log('');
  console.log('  ☀️  Jobbtorget körs på http://localhost:' + PORT);
  console.log('');
  console.log('  Hämtar jobb från Arbetsförmedlingen (JobStream v2)...');
  console.log('  Endpoints:');
  console.log('   Snapshot: https://' + AF_HOST + SNAPSHOT);
  console.log('   Stream:   https://' + AF_HOST + STREAM);
  console.log('');

  // Förhämta vid uppstart
  try {
    await fetchSnapshot();
  } catch (err) {
    console.warn('  ⚠️  Kunde inte hämta snapshot:', err.message);
    console.warn('  → Kör med fallback-data tills API:et svarar');
  }

  console.log('');
  console.log('  API-endpoints:');
  console.log('   GET /api/jobs              → alla jobb (max 50)');
  console.log('   GET /api/jobs?type=distans → filtrera på typ');
  console.log('   GET /api/jobs?q=stockholm  → fritextsökning');
  console.log('   GET /api/jobs/:id          → enskilt jobb');
  console.log('   GET /api/stats             → statistik + uppdateringstid');
  console.log('');
});
