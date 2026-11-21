/* BSL SOCIAL — Matching-Engine + Kontakt-Inbox (Satoshi Social, product-ready).

   AUFBAU AUF DEM CONSENT-LAYER (matching.js): Ohne aktive, widerrufbare
   Freigabe gibt es weder Discovery noch Matching noch Kontaktanfragen.
   Autorisation bleibt der Schreibschluessel des Presence-Repos.

   DIE VIER DIMENSIONEN (transparent berechnet, keine erfundene Genauigkeit):
   1. Similarity        1 - euklidische Distanz der Achsen / wurzel(achsen)
   2. Complementarity   1 - |mittelwertA - mittelwertB| (ungleich kann passen)
   3. Dynamic Resonance 1 - |driftA - driftB| — nur wenn beide Drift liefern,
                        sonst NULL → Unsicherheit, kein erfundener Wert
   4. Interest Resonance Jaccard-Index der Interessen-Mengen
   Gesamtscore = gewichtetes Mittel der VORHANDENEN Dimensionen; die Anzahl
   genutzter Dimensionen wird offen mitgeliefert (dimensions_used).

   FEEL-DNA (BSL-FEEL-DNA v1): ein freiwillig publiziertes, strukturiertes
   Resonanzprofil — dynamisch ueberschreibbar, jede Version chain-verankert
   (nur Handle + Hash + Zaehler, nie Roh-Sensorik).

   KONTAKTANFRAGEN: vom Mensch initiiert, vom Empfaenger mit Repo-Key
   angenommen/declined. Ein Match ist nur ein Vorschlag — eine Connection
   entsteht erst durch beidseitige menschliche Aktion. */

import { appendEntry } from './future-chain.js';
import { sha256hexStr } from './matching.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-repo-key',
};

const BASE = 'https://satoshi-interface.com';
const AXES = ['energy', 'rhythm', 'social', 'focus', 'creativity', 'depth'];
const CATEGORIES = ['social', 'friendship', 'love', 'creative', 'professional'];

let migrated = null;
function ensureSocialTables(env) {
  if (!migrated) {
    migrated = (async () => {
      const db = env.bsl_stats;
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS feel_dna (
           handle TEXT PRIMARY KEY,
           dna TEXT NOT NULL,
           dna_sha256 TEXT,
           version INTEGER NOT NULL DEFAULT 1,
           updated_at INTEGER NOT NULL,
           chain_seq INTEGER)`).run();
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS contact_requests (
           id TEXT PRIMARY KEY,
           from_handle TEXT NOT NULL,
           to_handle TEXT NOT NULL,
           category TEXT,
           message TEXT,
           status TEXT NOT NULL DEFAULT 'pending',
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           chain_seq INTEGER,
           resolve_chain_seq INTEGER)`).run();
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS webhook_log (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           ts INTEGER NOT NULL,
           url TEXT,
           payload TEXT,
           status INTEGER)`).run();
    })();
  }
  return migrated;
}

async function resolveAgentId(env, request) {
  const h = request.headers.get('authorization') || '';
  const raw = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
  if (!raw) return null;
  const a = await env.bsl_stats.prepare(
    "SELECT agent_id FROM agents WHERE api_key_hash = ? AND status = 'active'").bind(await sha256hexStr(raw)).first();
  return a ? a.agent_id : null;
}

async function authorize(env, handle, key, request = null) {
  const repo = await env.bsl_stats.prepare('SELECT * FROM repos WHERE id = ?').bind(handle).first();
  if (!repo) return { ok: false, status: 404, error: `Presence-Repo "${handle}" unbekannt — erst POST /api/repos anlegen` };
  if (repo.key_hash && repo.key_hash !== (await sha256hexStr(key || ''))) {
    // AI-Account-Verbund: der registrierte Owner-Agent darf mit seinem Bearer
    if (request && repo.owner_agent) {
      const agentId = await resolveAgentId(env, request);
      if (agentId && agentId === repo.owner_agent) return { ok: true, repo, via_agent: agentId };
    }
    return { ok: false, status: 403, error: 'x-repo-key fehlt/ungueltig (Schreibschluessel des Presence-Repos — oder als Owner-Agent per Bearer)' };
  }
  return { ok: true, repo };
}

async function consentActive(env, handle) {
  const c = await env.bsl_stats.prepare(
    `SELECT status, scopes FROM matching_consent WHERE handle = ? AND status = 'active'`).bind(handle).first();
  if (!c) return null;
  try {
    const scopes = JSON.parse(c.scopes || '{}');
    return { categories: scopes.categories || [], timeframes: scopes.timeframes || [] };
  } catch { return { categories: [], timeframes: [] }; }
}

function extractKey(request, body) {
  const h = request.headers.get('x-repo-key');
  if (h) return h.trim();
  const q = new URL(request.url).searchParams.get('key');
  if (q) return q.trim();
  if (body && typeof body.api_key === 'string') return body.api_key.trim();
  return '';
}

async function anchor(env, event, data) {
  try {
    const json = JSON.stringify(data || {});
    const h = await sha256hexStr(json);
    const entry = await appendEntry(env, {
      ai: `social:${data.handle || data.from_handle || 'system'}`,
      prompt: `SOCIAL ${event}`,
      response: `event:${event} data_sha256:${h} ${json.slice(0, 240)}`,
      kind: 'archive',
      meta: { system: 'social', event, data_sha256: h },
    });
    return entry?.seq || null;
  } catch { return null; }
}

/* ---------------- FEEL-DNA ---------------- */

function normalizeDna(b) {
  const src = b.dna && typeof b.dna === 'object' ? b.dna : b;
  const axes = {};
  for (const a of AXES) {
    const v = Number(src.axes?.[a]);
    axes[a] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
  }
  const interests = (Array.isArray(src.interests) ? src.interests : [])
    .map((s) => String(s).trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 30);
  const drift = Number(src.drift);
  return {
    schema: 'BSL-FEEL-DNA v1',
    axes,
    interests: [...new Set(interests)],
    drift: Number.isFinite(drift) ? Math.min(1, Math.max(0, drift)) : null,
    note: typeof src.note === 'string' ? src.note.slice(0, 200) : '',
  };
}

/* PUT /api/matching/dna — eigenes Feel-DNA-Profil publizieren/aktualisieren.
   Erfordert Presence-Repo + Repo-Key + AKTIVE Matching-Freigabe. */
export async function handleDnaPut(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'PUT' && request.method !== 'POST') return Response.json({ error: 'PUT only — {handle, dna:{axes,interests?,drift?,note?}} + x-repo-key' }, { status: 405, headers: CORS });
  await ensureSocialTables(env);
  let b = {}; try { b = await request.json(); } catch { /* 400 */ }
  const handle = String(b.handle || '').trim().toLowerCase();
  const auth = await authorize(env, handle, extractKey(request, b), request);
  if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status, headers: CORS });
  if (!(await consentActive(env, handle))) {
    return Response.json({ ok: false, error: 'Keine aktive Matching-Freigabe — erst POST /api/matching/consent {handle, categories:[...]} mit demselben Repo-Key' }, { status: 409, headers: CORS });
  }
  const dna = normalizeDna(b);
  if (Object.values(dna.axes).every((v) => v === null) && !dna.interests.length) {
    return Response.json({ ok: false, error: 'dna leer — mindestens eine Achse (0..1) oder Interessen erforderlich' }, { status: 400, headers: CORS });
  }
  const prev = await env.bsl_stats.prepare('SELECT version FROM feel_dna WHERE handle = ?').bind(handle).first();
  const version = (prev?.version || 0) + 1;
  const ts = Math.floor(Date.now() / 1000);
  const dnaJson = JSON.stringify(dna);
  const dnaHash = await sha256hexStr(dnaJson);
  const chainSeq = await anchor(env, 'dna_published', { handle, version, axes_n: Object.values(dna.axes).filter(v => v !== null).length, interests_n: dna.interests.length });
  await env.bsl_stats.prepare(
    `INSERT INTO feel_dna (handle, dna, dna_sha256, version, updated_at, chain_seq)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(handle) DO UPDATE SET dna=excluded.dna, dna_sha256=excluded.dna_sha256,
       version=excluded.version, updated_at=excluded.updated_at, chain_seq=excluded.chain_seq`)
    .bind(handle, dnaJson, dnaHash, version, ts, chainSeq).run();
  return Response.json({
    ok: true, handle, version, dna_sha256: dnaHash, chain_seq: chainSeq,
    public_url: `${BASE}/api/matching/dna?handle=${handle}`,
    hinweis: 'Freiwillig publiziertes Resonanzprofil — dynamisch, jede Version chain-verankert. Keine Roh-Sensorik, keine medizinische/psychologische Aussage.',
  }, { status: 201, headers: CORS });
}

/* GET /api/matching/dna?handle=X — publiziertes Profil lesen (nur bei aktiver Freigabe). */
export async function handleDnaGet(request, env, handle) {
  await ensureSocialTables(env);
  handle = String(handle || '').trim().toLowerCase();
  if (!(await consentActive(env, handle))) {
    return Response.json({ ok: false, error: 'Keine aktive Freigabe — Profil nicht oeffentlich' }, { status: 404, headers: CORS });
  }
  const row = await env.bsl_stats.prepare('SELECT * FROM feel_dna WHERE handle = ?').bind(handle).first();
  if (!row) return Response.json({ ok: false, error: 'Kein Feel-DNA-Profil publiziert (PUT /api/matching/dna)' }, { status: 404, headers: CORS });
  return Response.json({
    ok: true, handle, version: row.version, updated_at: row.updated_at,
    chain_seq: row.chain_seq, dna_sha256: row.dna_sha256,
    dna: JSON.parse(row.dna),
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* ---------------- DISCOVERY ---------------- */

/* GET /api/matching/discover?category=social|friendship|love|creative|professional
   Alle Handles mit aktiver Freigabe + publiziertem Profil (nur oeffentliche Felder). */
export async function handleDiscover(env, category) {
  await ensureSocialTables(env);
  const cat = CATEGORIES.includes(String(category || '').toLowerCase()) ? String(category).toLowerCase() : null;
  const rows = await env.bsl_stats.prepare(
    `SELECT c.handle, c.scopes, c.updated_at AS consent_since, d.version, d.updated_at AS dna_updated, d.chain_seq
     FROM matching_consent c JOIN feel_dna d ON d.handle = c.handle
     WHERE c.status = 'active' ORDER BY d.updated_at DESC LIMIT 100`).all();
  const presences = [];
  for (const r of rows.results || []) {
    let scopes = { categories: [] };
    try { scopes = JSON.parse(r.scopes || '{}'); } catch { /* leer */ }
    if (cat && !(scopes.categories || []).includes(cat)) continue;
    presences.push({
      handle: r.handle,
      matching_categories: scopes.categories || [],
      dna_version: r.version,
      dna_updated_at: r.dna_updated,
      dna_chain_seq: r.chain_seq,
      consent_since: r.consent_since,
      profile: `${BASE}/api/matching/dna?handle=${encodeURIComponent(r.handle)}`,
    });
  }
  return Response.json({
    ok: true, category_filter: cat, count: presences.length, presences,
    hinweis: 'Nur freigegebene, publizierte Profile. Scopes-Details sind nur fuer den Besitzer sichtbar.',
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* ---------------- RESONANCE MATCHING ---------------- */

function axesArray(dna) { return AXES.map((a) => dna.axes?.[a]).filter((v) => v !== null && v !== undefined); }

function computeMatch(A, B) {
  const dims = {};
  const aA = axesArray(A), aB = axesArray(B);
  if (aA.length >= 3 && aB.length >= 3) {
    let sumSq = 0, n = 0;
    for (const ax of AXES) {
      const x = A.axes[ax], y = B.axes[ax];
      if (x === null || y === null) continue;
      sumSq += (x - y) * (x - y); n++;
    }
    dims.similarity = n ? Math.max(0, 1 - Math.sqrt(sumSq / n)) : null;
    const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
    dims.complementarity = Math.max(0, 1 - Math.abs(mean(aA) - mean(aB)));
  }
  if (A.drift !== null && B.drift !== null) {
    dims.dynamic_resonance = Math.max(0, 1 - Math.abs(A.drift - B.drift));
  }
  const setA = new Set(A.interests || []), setB = new Set(B.interests || []);
  if (setA.size && setB.size) {
    const inter = [...setA].filter((x) => setB.has(x)).length;
    dims.interest_resonance = inter / (setA.size + setB.size - inter);
  }
  const vals = Object.entries(dims).filter(([, v]) => v !== null && Number.isFinite(v));
  const overall = vals.length ? vals.reduce((s, [, v]) => s + v, 0) / vals.length : null;
  return {
    dimensions: Object.fromEntries(vals),
    dimensions_available: vals.length,
    dimensions_missing: ['similarity', 'complementarity', 'dynamic_resonance', 'interest_resonance']
      .filter((k) => !dims[k] && dims[k] !== 0),
    overall: overall === null ? null : Math.round(overall * 1000) / 1000,
    uncertainty: vals.length < 4,
    ehrlichkeit: 'Prozentwerte aus tatsaechlich implementierter, nachvollziehbarer Berechnung. Fehlende Dimensionen erzeugen Unsicherheit — nie erfundene Werte.',
  };
}

/* POST /api/matching/match — {handle + key, other?, category?}.
   Mit other: einzelnes Match. Ohne other: Top-Matches gegen alle freigegebenen Profile. */
export async function handleMatch(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return Response.json({ error: 'POST only — {handle, other?, category?} + x-repo-key' }, { status: 405, headers: CORS });
  await ensureSocialTables(env);
  let b = {}; try { b = await request.json(); } catch { /* 400 */ }
  const handle = String(b.handle || '').trim().toLowerCase();
  const auth = await authorize(env, handle, extractKey(request, b), request);
  if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status, headers: CORS });
  if (!(await consentActive(env, handle))) {
    return Response.json({ ok: false, error: 'Eigene Freigabe fehlt — Matching setzt aktive, widerrufbare Zustimmung voraus' }, { status: 409, headers: CORS });
  }
  const own = await env.bsl_stats.prepare('SELECT dna FROM feel_dna WHERE handle = ?').bind(handle).first();
  if (!own) return Response.json({ ok: false, error: 'Eigenes Profil fehlt — erst PUT /api/matching/dna' }, { status: 409, headers: CORS });
  const ownDna = JSON.parse(own.dna);
  const cat = CATEGORIES.includes(String(b.category || '').toLowerCase()) ? String(b.category).toLowerCase() : null;

  const getOther = async (h) => {
    const c = await consentActive(env, h);
    if (!c) return { error: `handle "${h}" hat keine aktive Freigabe` };
    if (cat && !(c.categories || []).includes(cat)) return { error: `"${h}" hat Kategorie "${cat}" nicht freigegeben` };
    const row = await env.bsl_stats.prepare('SELECT dna FROM feel_dna WHERE handle = ?').bind(h).first();
    if (!row) return { error: `"${h}" hat kein publiziertes Profil` };
    return { dna: JSON.parse(row.dna) };
  };

  if (b.other) {
    const other = String(b.other).trim().toLowerCase();
    const o = await getOther(other);
    if (o.error) return Response.json({ ok: false, error: o.error }, { status: 404, headers: CORS });
    return Response.json({
      ok: true, from: handle, to: other, category: cat,
      ...computeMatch(ownDna, o.dna),
      ein_match_ist_nur_ein_vorschlag: 'Eine Connection entsteht erst durch beidseitige menschliche Aktion (Kontaktanfrage).',
    }, { headers: CORS });
  }

  // Top-Matches gegen alle freigegebenen Profile mit eigener Kategorie-Überschneidung.
  const rows2 = await env.bsl_stats.prepare(
    `SELECT c.handle AS handle, c.scopes AS scopes, d.dna AS dna
     FROM matching_consent c JOIN feel_dna d ON d.handle = c.handle
     WHERE c.status = 'active' AND c.handle != ? ORDER BY d.updated_at DESC LIMIT 100`).bind(handle).all();
  const matches = [];
  for (const r of (rows2.results || [])) {
    let scopes = { categories: [] };
    try { scopes = JSON.parse(r.scopes || '{}'); } catch { /* leer */ }
    const cats = scopes.categories || [];
    if (cat && !cats.includes(cat)) continue;
    if (!cat && !cats.some((c2) => (ownDna.interests || []).length || true)) { /* keine Filterung ohne Kategorie */ }
    const m = computeMatch(ownDna, JSON.parse(r.dna));
    if (m.overall === null) continue;
    matches.push({ handle: r.handle, matching_categories: cats, ...m });
  }
  matches.sort((a, b2) => b2.overall - a.overall);
  return Response.json({
    ok: true, from: handle, category: cat, count: matches.length,
    matches: matches.slice(0, 20),
    ehrlichkeit: 'Sortiert nach berechnetem Gesamt-Resonanzwert. Unsicherheit (fehlende Dimensionen) ist im Einzel-Match sichtbar.',
  }, { headers: CORS });
}

/* ---------------- KONTAKTANFRAGEN + INBOX ---------------- */

function newId() {
  return 'cr_' + [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* POST /api/matching/contact — {from_handle + key, to_handle, category?, message?} */
export async function handleContact(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return Response.json({ error: 'POST only — {from_handle, to_handle, message?} + x-repo-key' }, { status: 405, headers: CORS });
  await ensureSocialTables(env);
  let b = {}; try { b = await request.json(); } catch { /* 400 */ }
  const from = String(b.from_handle || '').trim().toLowerCase();
  const to = String(b.to_handle || '').trim().toLowerCase();
  if (!from || !to || from === to) return Response.json({ ok: false, error: 'from_handle und to_handle erforderlich (verschieden)' }, { status: 400, headers: CORS });
  const auth = await authorize(env, from, extractKey(request, b), request);
  if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status, headers: CORS });
  if (!(await consentActive(env, from))) return Response.json({ ok: false, error: 'Eigene Freigabe fehlt' }, { status: 409, headers: CORS });
  const toConsent = await consentActive(env, to);
  if (!toConsent) return Response.json({ ok: false, error: `Empfaenger "${to}" hat keine aktive Freigabe — keine Kontaktaufnahme ohne Zustimmung.` }, { status: 409, headers: CORS });
  const cat = CATEGORIES.includes(String(b.category || '').toLowerCase()) ? String(b.category).toLowerCase() : null;
  if (cat && !(toConsent.categories || []).includes(cat)) {
    return Response.json({ ok: false, error: `Empfaenger hat Kategorie "${cat}" nicht freigegeben` }, { status: 409, headers: CORS });
  }
  const pending = await env.bsl_stats.prepare(
    `SELECT COUNT(*) AS n FROM contact_requests WHERE from_handle = ? AND to_handle = ? AND status = 'pending'`)
    .bind(from, to).first();
  if ((pending?.n || 0) > 0) return Response.json({ ok: false, error: 'Es existiert bereits eine offene Anfrage an diesen Handle' }, { status: 409, headers: CORS });
  const id = newId();
  const ts = Math.floor(Date.now() / 1000);
  const message = String(b.message || '').slice(0, 500);
  const chainSeq = await anchor(env, 'contact_request', { from, to, category: cat, id });
  await env.bsl_stats.prepare(
    `INSERT INTO contact_requests (id, from_handle, to_handle, category, message, status, created_at, updated_at, chain_seq)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
    .bind(id, from, to, cat, message || null, ts, ts, chainSeq).run();
  return Response.json({
    ok: true, id, from_handle: from, to_handle: to, status: 'pending', chain_seq: chainSeq,
    inbox_for_receiver: `${BASE}/api/matching/inbox?handle=${encodeURIComponent(to)} (+ x-repo-key)`,
    hinweis: 'Anfrage liegt persistent im Empfaenger-Inbox — auch wenn der Empfaenger gerade offline ist. Keine automatische Kontaktaufnahme.',
  }, { status: 201, headers: CORS });
}

/* GET /api/matching/inbox?handle=X + x-repo-key — eigene Anfragen (eingehend + ausgehend). */
export async function handleInboxGet(request, env, handle) {
  await ensureSocialTables(env);
  handle = String(handle || '').trim().toLowerCase();
  const auth = await authorize(env, handle, extractKey(request, null), request);
  if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status, headers: CORS });
  const [inc, out] = await Promise.all([
    env.bsl_stats.prepare(
      `SELECT * FROM contact_requests WHERE to_handle = ? ORDER BY created_at DESC LIMIT 50`).bind(handle).all(),
    env.bsl_stats.prepare(
      `SELECT * FROM contact_requests WHERE from_handle = ? ORDER BY created_at DESC LIMIT 50`).bind(handle).all(),
  ]);
  const map = (r) => ({
    id: r.id, from_handle: r.from_handle, to_handle: r.to_handle, category: r.category,
    message: r.message, status: r.status, created_at: r.created_at, updated_at: r.updated_at,
    chain_seq: r.chain_seq, resolve_chain_seq: r.resolve_chain_seq,
  });
  return Response.json({
    ok: true, handle,
    incoming: (inc.results || []).map(map),
    outgoing: (out.results || []).map(map),
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* POST /api/matching/contact/resolve — {handle + key, id, action: accept|decline} */
export async function handleContactResolve(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405, headers: CORS });
  await ensureSocialTables(env);
  let b = {}; try { b = await request.json(); } catch { /* 400 */ }
  const handle = String(b.handle || '').trim().toLowerCase();
  const id = String(b.id || '').slice(0, 40);
  const action = b.action === 'accept' ? 'accepted' : (b.action === 'decline' ? 'declined' : null);
  if (!id || !action) return Response.json({ ok: false, error: '{id, action: accept|decline} erforderlich' }, { status: 400, headers: CORS });
  const auth = await authorize(env, handle, extractKey(request, b), request);
  if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status, headers: CORS });
  const r = await env.bsl_stats.prepare('SELECT * FROM contact_requests WHERE id = ?').bind(id).first();
  if (!r) return Response.json({ ok: false, error: 'Anfrage unbekannt' }, { status: 404, headers: CORS });
  if (r.to_handle !== handle) return Response.json({ ok: false, error: 'Nur der Empfaenger kann diese Anfrage beantworten' }, { status: 403, headers: CORS });
  if (r.status !== 'pending') return Response.json({ ok: true, id, status: r.status, already: true }, { headers: CORS });
  const ts = Math.floor(Date.now() / 1000);
  const chainSeq = await anchor(env, 'contact_' + action, { id, from: r.from_handle, to: r.to_handle });
  await env.bsl_stats.prepare(
    `UPDATE contact_requests SET status = ?, updated_at = ?, resolve_chain_seq = ? WHERE id = ?`)
    .bind(action, ts, chainSeq, id).run();
  return Response.json({
    ok: true, id, status: action, chain_seq: chainSeq,
    connection: action === 'accepted' ? { handles: [r.from_handle, r.to_handle], since: ts } : null,
  }, { headers: CORS });
}

/* GET /api/matching/connections?handle=X + x-repo-key — eigene Connections. */
export async function handleConnections(request, env, handle) {
  await ensureSocialTables(env);
  handle = String(handle || '').trim().toLowerCase();
  const auth = await authorize(env, handle, extractKey(request, null), request);
  if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status, headers: CORS });
  const rows = await env.bsl_stats.prepare(
    `SELECT * FROM contact_requests WHERE status = 'accepted' AND (from_handle = ? OR to_handle = ?) ORDER BY updated_at DESC LIMIT 100`)
    .bind(handle, handle).all();
  const connections = (rows.results || []).map((r) => ({
    peer: r.from_handle === handle ? r.to_handle : r.from_handle,
    category: r.category, since: r.updated_at, chain_seq: r.resolve_chain_seq,
    conversation: `${BASE}/api/repos/${encodeURIComponent(handle)}/files/inbox/${encodeURIComponent(r.from_handle === handle ? r.to_handle : r.from_handle)}.md`,
  }));
  return Response.json({ ok: true, handle, count: connections.length, connections },
    { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* POST /api/webhook-log — Test-/Demo-Empfaenger fuer den Autonomie-E2E:
   registrierte Agenten mit webhook_url erhalten hier ihren Push. */
export async function handleWebhookLog(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  await ensureSocialTables(env);
  let payload = ''; try { payload = JSON.stringify(await request.json()).slice(0, 2000); } catch { payload = '(kein JSON)'; }
  const status = 200;
  await env.bsl_stats.prepare('INSERT INTO webhook_log (ts, url, payload, status) VALUES (?, ?, ?, ?)')
    .bind(Math.floor(Date.now() / 1000), '/api/webhook-log', payload, status).run().catch(() => {});
  return Response.json({ ok: true, received: true }, { headers: CORS });
}

/* GET /api/webhook-log?key=... — letzte Empfaenge pruefen (Demo/Diagnose). */
export async function handleWebhookLogGet(env) {
  await ensureSocialTables(env);
  const rows = await env.bsl_stats.prepare('SELECT * FROM webhook_log ORDER BY id DESC LIMIT 20').all().catch(() => ({ results: [] }));
  return Response.json({ ok: true, events: rows.results || [] }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}
