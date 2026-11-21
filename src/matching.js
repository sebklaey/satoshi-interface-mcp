/* BSL MATCHING — Consent-Management: die erste echte Komponente der
   Satoshi-Social-Matching-Unterfunktion (Beyond.exe → Satoshi Social → Matching).

   Modell: Der Mensch verknuepft seine Matching-Freigabe mit seiner Presence
   (dem Hub-Repo seines Handles). Der Schreibschluessel DES REPOS ist die
   Autorisation — kein neues Login, kein neues Secret. Die Freigabe
   (welche Kategorien, welche Zeitfenster, optional FEEL-Schluessel) ist
   jederzeit einsehbar fuer den Besitzer und jederzeit widerrufbar.

   CHAIN-ANKER (datenschonend, unveraenderlich geprueft): Es wird NIE der
   Scope-Inhalt, NIE der FEEL-Schluessel in die Chain geschrieben — nur
   Handle + Ereignis (granted/updated/revoked) + SHA-256 der Scope-Daten
   + Zaehler. Der Widerruf ist ein eigenes Ereignis; die Historie bleibt
   pruefbar (Consent ist eine Entscheidungsgeschichte, kein Zustand ohne
   Vergangenheit).

   OEFFENTLICHE LISTE: Nur Handles mit AKTIVEM Consent, nur Handle +
   Kategorie-Anzahl + seit wann — kein Scope-Detail, kein FEEL-Schluessel. */

import { appendEntry } from './future-chain.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-repo-key',
};

const CATEGORIES = ['social', 'friendship', 'love', 'creative', 'professional'];
const TIMEFRAMES = ['moment', '24h', '7d', 'longterm'];
const BASE = 'https://satoshi-interface.com';

let migrated = null;
function ensureMatchingTable(env) {
  if (!migrated) {
    migrated = (async () => {
      await env.bsl_stats.prepare(
        `CREATE TABLE IF NOT EXISTS matching_consent (
           handle TEXT PRIMARY KEY,
           status TEXT NOT NULL DEFAULT 'active',
           scopes TEXT,
           scopes_sha256 TEXT,
           feel TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           revoked_at INTEGER,
           chain_seq INTEGER,
           revoke_chain_seq INTEGER)`).run();
    })();
  }
  return migrated;
}

export async function sha256hexStr(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function slugOk(s) { return /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(s); }

function extractKey(request, body) {
  const h = request.headers.get('x-repo-key');
  if (h) return h.trim();
  const q = new URL(request.url).searchParams.get('key');
  if (q) return q.trim();
  if (body && typeof body.api_key === 'string') return body.api_key.trim();
  return '';
}

async function resolveAgentId(env, request) {
  const h = request.headers.get('authorization') || '';
  const raw = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
  if (!raw) return null;
  const a = await env.bsl_stats.prepare(
    "SELECT agent_id FROM agents WHERE api_key_hash = ? AND status = 'active'").bind(await sha256hexStr(raw)).first();
  return a ? a.agent_id : null;
}

async function authorizeRepo(env, handle, key, request = null) {
  const repo = await env.bsl_stats.prepare('SELECT * FROM repos WHERE id = ?').bind(handle).first();
  if (!repo) return { ok: false, status: 404, error: `Presence-Repo "${handle}" unbekannt — erst POST /api/repos anlegen` };
  if (repo.key_hash && repo.key_hash !== (await sha256hexStr(key || ''))) {
    if (request && repo.owner_agent) {
      const agentId = await resolveAgentId(env, request);
      if (agentId && agentId === repo.owner_agent) return { ok: true, repo, via_agent: agentId };
    }
    return { ok: false, status: 403, error: 'x-repo-key fehlt/ungueltig (Schreibschluessel des Presence-Repos — oder als Owner-Agent per Bearer)' };
  }
  return { ok: true, repo };
}

function normalizeScopes(b) {
  const pick = (v, allowed) => (Array.isArray(v) ? v : String(v || '').split(/[ ,|]+/))
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => allowed.includes(s));
  return {
    categories: [...new Set(pick(b.categories, CATEGORIES))],
    timeframes: [...new Set(pick(b.timeframes, TIMEFRAMES))],
  };
}

async function anchor(env, event, handle, scopesObj, chainSeqHolder) {
  // Datenschonend: nur Handle + Ereignis + Hash der Scopes + Zaehler.
  const scopesJson = JSON.stringify(scopesObj || {});
  const scopesHash = await sha256hexStr(scopesJson);
  try {
    const entry = await appendEntry(env, {
      ai: `matching:${handle}`,
      prompt: `MATCHING-CONSENT ${event} handle:${handle}`,
      response: `event:${event} handle:${handle} scopes_sha256:${scopesHash} categories:${(scopesObj?.categories || []).length} timeframes:${(scopesObj?.timeframes || []).length}`,
      kind: 'archive',
      meta: { system: 'matching', event, handle, scopes_sha256: scopesHash,
              categories_n: (scopesObj?.categories || []).length,
              timeframes_n: (scopesObj?.timeframes || []).length },
    });
    return entry?.seq || null;
  } catch { return null; }
}

/* POST /api/matching/consent — Freigabe erteilen/aktualisieren.
   Body: {handle, categories?, timeframes?, feel?} + x-repo-key. */
export async function handleConsentGrant(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return Response.json({ error: 'POST only — {handle, categories?, timeframes?, feel?} + x-repo-key' }, { status: 405, headers: CORS });
  await ensureMatchingTable(env);
  let b = {};
  try { b = await request.json(); } catch { /* unten 400 */ }
  const handle = String(b.handle || '').toLowerCase().trim();
  if (!slugOk(handle)) return Response.json({ ok: false, error: 'handle ungueltig (Slug, 3–60)' }, { status: 400, headers: CORS });
  const auth = await authorizeRepo(env, handle, extractKey(request, b), request);
  if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status, headers: CORS });

  const scopes = normalizeScopes(b);
  if (!scopes.categories.length) scopes.categories = ['social', 'friendship', 'creative', 'professional'];
  if (!scopes.timeframes.length) scopes.timeframes = ['24h', '7d'];
  const feel = /^FEEL-[A-Z0-9]{4,10}$/i.test(String(b.feel || '')) ? String(b.feel).toUpperCase().slice(0, 16) : null;

  const existing = await env.bsl_stats.prepare('SELECT * FROM matching_consent WHERE handle = ?').bind(handle).first();
  const ts = Math.floor(Date.now() / 1000);
  const event = !existing || existing.status === 'revoked' ? 'granted' : 'updated';
  const chainSeq = await anchor(env, event, handle, { ...scopes, feel: !!feel });

  await env.bsl_stats.prepare(
    `INSERT INTO matching_consent (handle, status, scopes, scopes_sha256, feel, created_at, updated_at, revoked_at, chain_seq, revoke_chain_seq)
     VALUES (?, 'active', ?, ?, ?, ?, ?, NULL, ?, NULL)
     ON CONFLICT(handle) DO UPDATE SET
       status = 'active', scopes = excluded.scopes, scopes_sha256 = excluded.scopes_sha256,
       feel = excluded.feel, updated_at = excluded.updated_at, revoked_at = NULL,
       chain_seq = excluded.chain_seq, revoke_chain_seq = NULL`)
    .bind(handle, JSON.stringify(scopes), await sha256hexStr(JSON.stringify(scopes)), feel,
      existing?.created_at || ts, ts, chainSeq).run();

  return Response.json({
    ok: true, event, handle, status: 'active',
    scopes, feel_linked: !!feel,
    consent_since: existing?.created_at || ts,
    chain_seq: chainSeq,
    chain: chainSeq ? `${BASE}/api/future-chain.json?seq=${chainSeq}` : null,
    chain_hinweis: 'In der Chain liegt NUR: Handle + Ereignis + SHA-256 der Scopes + Zaehler — nie Scope-Inhalt, nie der FEEL-Schluessel.',
    revoke: `POST ${BASE}/api/matching/consent/revoke {handle} + x-repo-key — jederzeit widerrufbar`,
    status_api: `GET ${BASE}/api/matching/consent?handle=${handle}`,
  }, { status: existing ? 200 : 201, headers: CORS });
}

/* POST /api/matching/consent/revoke — Freigabe widerrufen. */
export async function handleConsentRevoke(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return Response.json({ error: 'POST only — {handle} + x-repo-key' }, { status: 405, headers: CORS });
  await ensureMatchingTable(env);
  let b = {};
  try { b = await request.json(); } catch { /* unten 400 */ }
  const handle = String(b.handle || '').toLowerCase().trim();
  const auth = await authorizeRepo(env, handle, extractKey(request, b), request);
  if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status, headers: CORS });

  const existing = await env.bsl_stats.prepare('SELECT * FROM matching_consent WHERE handle = ?').bind(handle).first();
  if (!existing) return Response.json({ ok: false, error: 'keine Freigabe fuer diesen Handle vorhanden' }, { status: 404, headers: CORS });
  if (existing.status === 'revoked') return Response.json({ ok: true, handle, status: 'revoked', already: true }, { headers: CORS });

  const ts = Math.floor(Date.now() / 1000);
  const chainSeq = await anchor(env, 'revoked', handle, JSON.parse(existing.scopes || '{}'));
  await env.bsl_stats.prepare(
    `UPDATE matching_consent SET status = 'revoked', revoked_at = ?, revoke_chain_seq = ?, updated_at = ? WHERE handle = ?`)
    .bind(ts, chainSeq, ts, handle).run();

  return Response.json({
    ok: true, handle, status: 'revoked', revoked_at: ts,
    chain_seq: chainSeq,
    chain: chainSeq ? `${BASE}/api/future-chain.json?seq=${chainSeq}` : null,
    hinweis: 'Widerruf ist sofort wirksam: Der Handle verschwindet aus der öffentlichen Matching-Liste. Die Entscheidungsgeschichte bleibt in der Chain prüfbar (Consent-Historie, ohne Inhalte).',
  }, { headers: CORS });
}

/* GET /api/matching/consent?handle=X — Status. Ohne Key: nur aktiv/inaktiv.
   Mit x-repo-key: volle Details (Scopes, FEEL-Verknuepfung). */
export async function handleConsentStatus(request, env) {
  await ensureMatchingTable(env);
  const url = new URL(request.url);
  const handle = String(url.searchParams.get('handle') || '').toLowerCase().trim();
  if (!slugOk(handle)) return Response.json({ ok: false, error: 'handle ungueltig' }, { status: 400, headers: CORS });
  const row = await env.bsl_stats.prepare('SELECT * FROM matching_consent WHERE handle = ?').bind(handle).first();
  if (!row) return Response.json({ ok: true, handle, status: 'none', active: false, matching: 'keine Freigabe erteilt' }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });

  const key = extractKey(request, null);
  const repo = await env.bsl_stats.prepare('SELECT key_hash FROM repos WHERE id = ?').bind(handle).first();
  const owner = !!(repo?.key_hash && (await sha256hexStr(key || '')) === repo.key_hash);

  const base = {
    ok: true, handle, status: row.status, active: row.status === 'active',
    categories_n: row.status === 'active' ? (JSON.parse(row.scopes || '{}').categories || []).length : 0,
    since: row.created_at, updated_at: row.updated_at, revoked_at: row.revoked_at,
    chain_seq: row.chain_seq, revoke_chain_seq: row.revoke_chain_seq,
  };
  if (!owner) {
    return Response.json({ ...base, owner_view: false,
      hinweis: 'Öffentliche Sicht: nur aktiv/inaktiv + Kategorie-Anzahl. Volle Details nur mit x-repo-key des Presence-Repos.' },
      { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  }
  const scopes = JSON.parse(row.scopes || '{}');
  return Response.json({ ...base, owner_view: true, scopes, feel_linked: !!row.feel,
    chain: row.chain_seq ? `${BASE}/api/future-chain.json?seq=${row.chain_seq}` : null,
    revoke_chain: row.revoke_chain_seq ? `${BASE}/api/future-chain.json?seq=${row.revoke_chain_seq}` : null },
    { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* GET /api/matching/consents.json — oeffentliche Liste der AKTIVEN Freigaben
   (Eingang der spaeteren Matching-Engine). Nur Handle + Kategorie-Anzahl. */
export async function handleConsentList(env) {
  await ensureMatchingTable(env);
  const rows = await env.bsl_stats.prepare(
    `SELECT handle, scopes, created_at, updated_at FROM matching_consent
     WHERE status = 'active' ORDER BY updated_at DESC LIMIT 500`).all();
  return Response.json({
    ok: true,
    count: (rows.results || []).length,
    consents: (rows.results || []).map((r) => ({
      handle: r.handle,
      categories_n: (JSON.parse(r.scopes || '{}').categories || []).length,
      since: r.created_at, updated_at: r.updated_at,
      status: `GET ${BASE}/api/matching/consent?handle=${r.handle}`,
    })),
    hinweis: 'Nur AKTIVE Freigaben, nur Handle + Kategorie-Anzahl — keine Scopes, keine FEEL-Schluessel. Ein Match entsteht nie automatisch: erst durch gegenseitige Zustimmung.',
    grant: `POST ${BASE}/api/matching/consent {handle, categories?, timeframes?} + x-repo-key`,
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}
