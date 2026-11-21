/* BSL REPOS — Public Knowledge Layer des Temporal Loop: Beyond Hub + Wiki Light
   + Forschungs-Repositories.

   Architektur (bewusst auf dem Bestehenden aufgebaut, kein Fremdsystem):
   - Grosse Daten liegen im BSL STORAGE (eigener IPFS-Verbund, storage.js).
   - Die Hash-Chain (future-chain.js) verankert nur Referenzen: Jede
     Dateiversion erzeugt einen signierten Archiv-Eintrag (kind:archive)
     mit sha256 + prev_sha256 + CID — Forschungsprovenienz, rueckwaerts
     verifizierbar bis zur ersten dokumentierten Erkenntnis.
   - Innerhalb eines Repos bildet prev_version/prev_sha256 eine eigene
     Versionskette pro Datei.

   WIKI LIGHT = System-Repo "wiki" (oeffentlich lesbar). Schreibschluessel ist
   der IPFS_CONFIRM_TOKEN des Betreibers (kein neues Secret noetig).

   Ehrliche v0-Grenzen: Private Repos = clientseitig verschluesselter Inhalt
   (Server sieht nur Ciphertext) + Schreibschluessel. Branches / Pull-Requests /
   Review-Flows sind als naechster Schritt deklariert, nicht als fertig
   behauptet. */

import { storeBytes, gateways } from './storage.js';
import { appendEntry } from './future-chain.js';
import { syncMainAfterLegacyWrite } from './collab.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-repo-key',
};

const MAX_FILE = 8 * 1024 * 1024;
const INLINE_MAX = 64 * 1024;           // Content inline im JSON bis 64 KB
const WIKI_REPO = 'wiki';
const PINATA_GW = 'https://gateway.pinata.cloud/ipfs';
const BASE = 'https://satoshi-interface.com';

let migrated = null;
function ensureRepoTables(env) {
  if (!migrated) {
    migrated = (async () => {
      await env.bsl_stats.prepare(
        `CREATE TABLE IF NOT EXISTS repos (
           id TEXT PRIMARY KEY,
           name TEXT,
           description TEXT,
           visibility TEXT NOT NULL DEFAULT 'public',
           owner TEXT,
           key_hash TEXT,
           open_write INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL)`).run();
      try { await env.bsl_stats.prepare('ALTER TABLE repos ADD COLUMN owner_agent TEXT').run(); } catch { /* Spalte existiert */ }
      try { await env.bsl_stats.prepare('ALTER TABLE repos ADD COLUMN handle_claim_seq INTEGER').run(); } catch { /* Spalte existiert */ }
      await env.bsl_stats.prepare(
        `CREATE TABLE IF NOT EXISTS repo_files (
           repo TEXT NOT NULL,
           path TEXT NOT NULL,
           version INTEGER NOT NULL,
           cid TEXT,
           sha256 TEXT NOT NULL,
           size INTEGER NOT NULL,
           prev_version INTEGER,
           prev_sha256 TEXT,
           message TEXT,
           author TEXT,
           ts INTEGER NOT NULL,
           chain_seq INTEGER,
           PRIMARY KEY (repo, path, version))`).run();
    })();
  }
  return migrated;
}

async function sha256hexStr(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randKey() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return 'bslrepo_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function slugOk(s) { return /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(s); }

function cleanPath(p) {
  p = String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!p || p.length > 300 || p.includes('..')) return null;
  return p;
}

function guessMime(path) {
  if (/\.md$/i.test(path)) return 'text/markdown; charset=utf-8';
  if (/\.json$/i.test(path)) return 'application/json; charset=utf-8';
  if (/\.(txt|csv|log)$/i.test(path)) return 'text/plain; charset=utf-8';
  if (/\.html?$/i.test(path)) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

function extractKey(request, body) {
  const h = request.headers.get('x-repo-key');
  if (h) return h.trim();
  const q = new URL(request.url).searchParams.get('key');
  if (q) return q.trim();
  if (body && typeof body.api_key === 'string') return body.api_key.trim();
  return '';
}

async function getRepo(env, id) {
  return env.bsl_stats.prepare('SELECT * FROM repos WHERE id = ?').bind(id).first();
}

async function canWrite(repo, key, agentId = null) {
  if (repo.open_write) return true;
  // AI-Account-Verbund: der registrierte Agent des Owners darf ebenfalls schreiben
  if (repo.owner_agent && agentId && agentId === repo.owner_agent) return true;
  if (!repo.key_hash) return true;              // kein Schluessel hinterlegt = offen
  if (!key) return false;
  return (await sha256hexStr(key)) === repo.key_hash;
}

/* AI-Account aufloesen: Authorization: Bearer <agent_api_key> (oder body.agent_api_key)
   → Agent aus dem Open-AI-Network-Register. Liefert { agent_id, ... } oder null. */
async function resolveAgent(env, request, body) {
  const h = request.headers.get('authorization') || '';
  const bearer = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
  const raw = bearer || (body && typeof body.agent_api_key === 'string' ? body.agent_api_key.trim() : '');
  if (!raw) return null;
  const hash = await sha256hexStr(raw);
  const a = await env.bsl_stats.prepare(
    "SELECT agent_id, display_name, provider FROM agents WHERE api_key_hash = ? AND status = 'active'").bind(hash).first();
  return a || null;
}

/* EDNA Human-Verifikation: feel/session → edna_humans (Fenster 7 Tage). */
async function ednaHumanVerified(env, b) {
  const feel = String(b.feel || '').slice(0, 16);
  const session = String(b.session || '').slice(0, 64);
  if (!feel && !session) return null;
  let sess = session;
  if (feel) {
    const row = await env.bsl_stats.prepare(
      'SELECT session FROM sensoric WHERE feel = ? ORDER BY ts DESC LIMIT 1').bind(feel).first();
    if (row) sess = row.session;
  }
  if (!sess) return null;
  const now = Math.floor(Date.now() / 1000);
  const h = await env.bsl_stats.prepare(
    'SELECT session, first_ts, last_ts, max_pc FROM edna_humans WHERE session = ?').bind(sess).first();
  if (!h || now - h.last_ts > 7 * 86400) return null;
  return { session: sess, first_ts: h.first_ts, last_ts: h.last_ts, max_pc: h.max_pc };
}

/* Reservierte Handles — Claim nur mit Claim-Passwort (+ EDNA + AI-Account). */
const RESERVED_HANDLES = { satoshi: 'HANDLE_PASSWORD_SATOSHI' };

async function canRead(repo, key) {
  if (repo.visibility === 'public') return true;
  if (!key || !repo.key_hash) return false;
  return (await sha256hexStr(key)) === repo.key_hash;
}

async function latestVersion(env, repo, path) {
  return env.bsl_stats.prepare(
    `SELECT * FROM repo_files WHERE repo = ? AND path = ?
     ORDER BY version DESC LIMIT 1`).bind(repo, path).first();
}

/* Wiki-System-Repo lazy anlegen. Schreibschluessel = IPFS_CONFIRM_TOKEN. */
async function ensureWikiRepo(env) {
  await ensureRepoTables(env);
  let repo = await getRepo(env, WIKI_REPO);
  if (!repo) {
    const keyHash = env.IPFS_CONFIRM_TOKEN ? await sha256hexStr(env.IPFS_CONFIRM_TOKEN) : null;
    await env.bsl_stats.prepare(
      `INSERT INTO repos (id, name, description, visibility, owner, key_hash, open_write, created_at)
       VALUES (?, ?, ?, 'public', 'system', ?, 0, ?)`)
      .bind(WIKI_REPO, 'WIKI LIGHT',
        'Oeffentliches, maschinenlesbares Wiki des Temporal Loop — versioniert, kryptografisch verankert.',
        keyHash, Math.floor(Date.now() / 1000)).run();
    repo = await getRepo(env, WIKI_REPO);
  }
  return repo;
}

/* ---------------- BEYOND HUB ---------------- */

/* GET /api/hub.json — der maschinenlesbare Index des gesamten Systems. */
export async function handleHub(env) {
  await ensureRepoTables(env);
  const chain = await env.bsl_stats.prepare('SELECT MAX(seq) AS height FROM future_chain').first();
  const usage = await env.bsl_stats.prepare(
    'SELECT COUNT(*) AS files, COALESCE(SUM(size),0) AS bytes FROM storage_files').first();
  const repos = await env.bsl_stats.prepare(
    `SELECT id, name, description, visibility, owner, created_at,
            (SELECT COUNT(DISTINCT path) FROM repo_files WHERE repo = repos.id) AS files,
            (SELECT MAX(ts) FROM repo_files WHERE repo = repos.id) AS last_write
     FROM repos WHERE visibility = 'public' ORDER BY created_at ASC`).all();
  await ensureWikiRepo(env);
  const pages = await env.bsl_stats.prepare(
    `SELECT path, MAX(version) AS version, MAX(ts) AS ts FROM repo_files
     WHERE repo = ? GROUP BY path ORDER BY path ASC`).bind(WIKI_REPO).all();

  return Response.json({
    ok: true,
    name: 'BEYOND HUB — Public Knowledge Layer des Temporal Loop',
    architektur: 'ARCHIV (Hash-Chain) ↔ STORAGE (eigener IPFS-Verbund) ↔ REPOS/WIKI. Grosse Daten im Storage; die Chain verankert Hashes, Versionen, Signaturen und Speicherreferenzen.',
    provenance: 'Jede Dateiversion traegt sha256 + prev_sha256 + einen signierten Chain-Anker (chain_seq). Der gesamte Forschungsweg ist rueckwaerts bis zur ersten Erkenntnis verifizierbar.',
    chain: {
      height: chain?.height || 0,
      read: `${BASE}/api/future-chain.json?limit=200`,
      write: `POST ${BASE}/api/future-chain  oder  GET ${BASE}/e/AI/FRAGE/ANTWORT`,
    },
    storage: {
      files: usage?.files || 0, bytes: usage?.bytes || 0,
      upload: `POST ${BASE}/api/storage/upload`,
      download: `${BASE}/api/storage/download/{cid}`,
      list: `${BASE}/api/storage/list.json`,
    },
    repos: {
      list: (repos.results || []).map((r) => ({
        ...r,
        api: `${BASE}/api/repos/${r.id}.json`,
        tree: `${BASE}/api/repos/${r.id}/tree.json`,
      })),
      create: `POST ${BASE}/api/repos  {id, name?, description?, visibility?, owner?, open_write?} → Schreibschluessel wird einmalig zurueckgegeben`,
      writeFile: `PUT ${BASE}/api/repos/{id}/files/{path}  {content|content_base64, message?, author?} + x-repo-key`,
      readFile: `GET ${BASE}/api/repos/{id}/files/{path}[?v=N][?raw=1]`,
      history: `GET ${BASE}/api/repos/{id}/files/{path}/history.json`,
    },
    wiki: {
      pages: (pages.results || []).map((p) => ({
        page: p.path, version: p.version, ts: p.ts,
        json: `${BASE}/api/wiki/${p.path}.json`,
        history: `${BASE}/api/wiki/${p.path}/history.json`,
      })),
      index: `${BASE}/api/wiki/index.json`,
      hinweis: 'Oeffentlich lesbar, versioniert (?v=N), jede Version in der Hash-Chain verankert.',
    },
    ehrliche_grenzen_v0: 'Private Repos: clientseitige Verschluesselung (Server sieht nur Ciphertext) + Schreibschluessel. Branches, Pull-Requests und Review-Flows folgen als naechster Schritt.',
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* ---------------- REPOS ---------------- */

/* GET /api/repos.json — oeffentliche Repo-Liste. */
export async function handleReposList(env) {
  await ensureRepoTables(env);
  const rows = await env.bsl_stats.prepare(
    `SELECT id, name, description, owner, created_at,
            (SELECT COUNT(DISTINCT path) FROM repo_files WHERE repo = repos.id) AS files,
            (SELECT MAX(ts) FROM repo_files WHERE repo = repos.id) AS last_write
     FROM repos WHERE visibility = 'public' ORDER BY last_write DESC NULLS LAST`).all();
  return Response.json({
    ok: true,
    repos: (rows.results || []).map((r) => ({ ...r, api: `${BASE}/api/repos/${r.id}.json` })),
    create: `POST ${BASE}/api/repos {id, name?, description?, visibility: public|private, owner?}`,
    hub: `${BASE}/api/hub.json`,
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* POST /api/repos — Repo anlegen. Der Schreibschluessel wird genau einmal
   zurueckgegeben; gespeichert wird nur sein SHA-256. */
export async function handleRepoCreate(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') {
    return Response.json({ error: 'POST only — JSON {id, name?, description?, visibility?, owner?, open_write?, feel?|session?, agent_id?, claim_password?}' }, { status: 405, headers: CORS });
  }
  await ensureRepoTables(env);
  let b = {};
  try { b = await request.json(); } catch { /* unten 400 */ }
  const id = String(b.id || '').toLowerCase().trim();
  if (!slugOk(id)) {
    return Response.json({ ok: false, error: 'id fehlt/ungueltig — Kleinbuchstaben, Ziffern, Bindestrich (3–60 Zeichen)' }, { status: 400, headers: CORS });
  }
  if (id === WIKI_REPO) {
    return Response.json({ ok: false, error: 'wiki ist das System-Repo (WIKI LIGHT)' }, { status: 409, headers: CORS });
  }
  if (await getRepo(env, id)) {
    return Response.json({ ok: false, error: 'Handle ist bereits vergeben — Handles sind einmalig, unveraenderlich und chain-verankert.' }, { status: 409, headers: CORS });
  }

  // 1) EDNA HUMAN-VERIFIED ist Pflicht fuer jedes Handle
  const edna = await ednaHumanVerified(env, b);
  if (!edna) {
    return Response.json({
      ok: false, error: 'Handle-Anlage erfordert EDNA Human-Verifikation (Nachweis, dass ein Mensch am Geraet sitzt).',
      so_gehts: [
        '1) In der App /feel oeffnen — die EDNA-1 misst deine Signale (Maus/Touch/Dauer).',
        '2) Nach der Messung den FEEL-Schluessel (FEEL-XXXXXX) oder die Session kopieren.',
        '3) Erneut POST /api/repos {id, feel: "FEEL-XXXXXX"} bzw. {session: "…"} senden.',
      ],
      pruefen: 'GET /api/edna/proof?feel=FEEL-XXXXXX — Gueltigkeitsfenster: 7 Tage nach Verifikation.',
    }, { status: 428, headers: CORS });
  }

  // 2) Reservierte Handles (z. B. "satoshi") — Claim-Passwort noetig
  const pwKey = RESERVED_HANDLES[id];
  if (pwKey) {
    const want = env[pwKey] || (id === 'satoshi' ? '54197542' : '');
    if (String(b.claim_password || '') !== want) {
      return Response.json({ ok: false, error: `Handle "${id}" ist reserviert — claim_password erforderlich (Claim durch den Berechtigten, EDNA-verified + AI-Account).` }, { status: 403, headers: CORS });
    }
  }

  // 3) AI-Account-Verbindung (optional, aber noetig damit die AI des Users auf
  //    Presence/Hub/Storage/Wiki-Daten zugreifen kann): agent_id + Bearer agent_api_key
  const agent = await resolveAgent(env, request, b);
  let ownerAgent = null;
  if (b.agent_id) {
    if (!agent || agent.agent_id !== String(b.agent_id).slice(0, 80)) {
      return Response.json({ ok: false, error: 'agent_id-Verbindung gescheitert — Authorization: Bearer <agent_api_key> des registrierten Agenten noetig (POST /api/agents/register).' }, { status: 403, headers: CORS });
    }
    ownerAgent = agent.agent_id;
  } else if (agent) {
    ownerAgent = agent.agent_id;
  }

  const visibility = b.visibility === 'private' ? 'private' : 'public';
  const openWrite = b.open_write === true && visibility === 'public';
  const writeKey = openWrite ? null : (typeof b.api_key === 'string' && b.api_key.length >= 12 ? b.api_key : randKey());
  const keyHash = writeKey ? await sha256hexStr(writeKey) : null;
  await env.bsl_stats.prepare(
    `INSERT INTO repos (id, name, description, visibility, owner, key_hash, open_write, created_at, owner_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, String(b.name || id).slice(0, 120), String(b.description || '').slice(0, 500),
      visibility, String(b.owner || 'anonymous').slice(0, 80), keyHash, openWrite ? 1 : 0,
      Math.floor(Date.now() / 1000), ownerAgent).run();

  // 4) Kryptografische Verankerung des Handle-Claims in der Hash-Chain:
  //    Belegungszeitpunkt + Reihenfolge sind damit oeffentlich nachpruefbar und
  //    nachtraeglich unveraenderbar (ehrlich: Identitaet bleibt am Repo-Schluessel/Agent haengen).
  const claim = await appendEntry(env, {
    ai: ownerAgent || 'human-edna',
    kind: 'archive',
    prompt: `HANDLE-CLAIM ${id}`,
    response: `Handle "${id}" vergeben — EDNA human-verified (session …${String(edna.session).slice(-8)}, first_ts ${edna.first_ts})` +
      (ownerAgent ? `, AI-Account: ${ownerAgent}` : '') + (pwKey ? ', reserviert (Claim-Passwort)' : '') +
      ' — einmalig, unveraenderlich.',
    meta: { system: 'handles', handle: id, owner_agent: ownerAgent || null, edna_first_ts: edna.first_ts, reserved: !!pwKey },
  });
  await env.bsl_stats.prepare('UPDATE repos SET handle_claim_seq = ? WHERE id = ?').bind(claim.seq, id).run();

  return Response.json({
    ok: true, id, visibility, open_write: openWrite,
    handle: { unique: true, unchangeable: true, chain_seq: claim.seq, chain_hash: claim.entry_hash },
    ...(writeKey ? { write_key: writeKey, hinweis: 'Schreibschluessel — nur jetzt sichtbar. Gespeichert wird nur sein SHA-256.' } : {}),
    ...(visibility === 'private' ? { private_hinweis: 'v0: Inhalt clientseitig verschluesseln — der Server speichert nur Ciphertext.' } : {}),
    ...(ownerAgent ? { ai_account: ownerAgent, ai_zugriff: 'Diese AI darf als Owner-Agent auf dieses Repo schreiben (Bearer) und die Presence lesen.' } : {}),
    api: `${BASE}/api/repos/${id}.json`,
    write: `PUT ${BASE}/api/repos/${id}/files/{path} (+ x-repo-key)`,
    publish: `POST ${BASE}/api/repos/${id}/publish — Presence auf Wiki Light veroeffentlichen (presences/${id})`,
    hub: `${BASE}/api/hub.json`,
  }, { status: 201, headers: CORS });
}

/* GET /api/repos/{id}.json — Metadaten; GET /api/repos/{id}/tree.json — Dateien. */
export async function handleRepoGet(request, env, id, tree) {
  await ensureRepoTables(env);
  const repo = await getRepo(env, id);
  if (!repo) return Response.json({ ok: false, error: 'Repo unbekannt' }, { status: 404, headers: CORS });
  const key = extractKey(request, null);
  if (!(await canRead(repo, key))) {
    return Response.json({ ok: false, error: 'privat — x-repo-key erforderlich' }, { status: 403, headers: CORS });
  }
  if (!tree) {
    return Response.json({
      ok: true, id: repo.id, name: repo.name, description: repo.description,
      visibility: repo.visibility, owner: repo.owner, open_write: !!repo.open_write,
      created_at: repo.created_at,
      handle: repo.handle_claim_seq ? { chain_seq: repo.handle_claim_seq, unchangeable: true } : undefined,
      owner_agent: repo.owner_agent || undefined,
      ai_zugriff: repo.owner_agent ? 'Owner-Agent darf per Bearer (Authorization) schreiben und die Presence steuern.' : undefined,
      tree: `${BASE}/api/repos/${id}/tree.json`,
      write: `PUT ${BASE}/api/repos/${id}/files/{path}`,
      hub: `${BASE}/api/hub.json`,
    }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  }
  const rows = await env.bsl_stats.prepare(
    `SELECT f.path, f.version, f.cid, f.sha256, f.size, f.prev_version, f.prev_sha256,
            f.message, f.author, f.ts, f.chain_seq
     FROM repo_files f
     JOIN (SELECT path, MAX(version) AS v FROM repo_files WHERE repo = ? GROUP BY path) m
       ON f.path = m.path AND f.version = m.v
     WHERE f.repo = ? ORDER BY f.path ASC`).bind(id, id).all();
  return Response.json({
    ok: true, repo: id, visibility: repo.visibility,
    files: (rows.results || []).map((f) => ({
      ...f,
      read: `${BASE}/api/repos/${id}/files/${f.path}`,
      history: `${BASE}/api/repos/${id}/files/${f.path}/history.json`,
      chain: f.chain_seq ? `${BASE}/api/future-chain.json?seq=${f.chain_seq}` : null,
    })),
    provenance: 'Jede Datei: sha256 (Integritaet) + prev_sha256 (Versionskette) + chain_seq (signierter Anker in der Hash-Chain).',
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* PUT /api/repos/{id}/files/{path} — neue Dateiversion.
   Daten → Storage (IPFS); sha256 + prev + CID → signierter Chain-Anker. */
export async function handleFileWrite(request, env, id, path) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'PUT' && request.method !== 'POST') {
    return Response.json({ error: 'PUT only — JSON {content|content_base64, message?, author?} + x-repo-key' }, { status: 405, headers: CORS });
  }
  await ensureRepoTables(env);
  const repo = await getRepo(env, id);
  if (!repo) return Response.json({ ok: false, error: 'Repo unbekannt — erst POST /api/repos' }, { status: 404, headers: CORS });
  path = cleanPath(path);
  if (!path) return Response.json({ ok: false, error: 'Pfad fehlt/ungueltig (kein ..)' }, { status: 400, headers: CORS });

  let b = {};
  try { b = await request.json(); } catch { /* unten 400 */ }
  const key = extractKey(request, b);
  if (!(await canWrite(repo, key, (await resolveAgent(env, request, b))?.agent_id || null))) {
    return Response.json({ ok: false, error: 'Schreibschluessel fehlt/ungueltig (x-repo-key)' }, { status: 403, headers: CORS });
  }

  let bytes;
  if (typeof b.content === 'string') {
    bytes = new TextEncoder().encode(b.content);
  } else if (typeof b.content_base64 === 'string') {
    try {
      const bin = atob(b.content_base64.replace(/\s+/g, ''));
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      return Response.json({ ok: false, error: 'content_base64 ist kein gueltiges Base64' }, { status: 400, headers: CORS });
    }
  } else {
    return Response.json({ ok: false, error: 'content (UTF-8) oder content_base64 erforderlich' }, { status: 400, headers: CORS });
  }
  if (!bytes.length || bytes.length > MAX_FILE) {
    return Response.json({ ok: false, error: `Datei leer oder groesser als ${MAX_FILE / 1048576} MB` }, { status: 413, headers: CORS });
  }

  const mime = String(b.mime || guessMime(path)).slice(0, 100);
  const author = String(b.author || repo.owner || 'anonymous').slice(0, 80);
  const message = String(b.message || '').slice(0, 300);
  const storageName = path.slice(0, 180).replace(/[\r\n/\\]/g, '_');

  const stored = await storeBytes(env, bytes, { name: storageName, mime, uploader: `repo:${id}` });
  if (!stored.ok) {
    return Response.json({ ok: false, error: stored.error, detail: stored.detail }, { status: stored.status || 500, headers: CORS });
  }

  const prev = await latestVersion(env, id, path);
  if (prev && prev.sha256 === stored.sha256) {
    return Response.json({
      ok: true, unchanged: true, repo: id, path, version: prev.version,
      cid: prev.cid, sha256: prev.sha256,
      hinweis: 'Identischer Inhalt — keine neue Version noetig (content-addressiert).',
      read: `${BASE}/api/repos/${id}/files/${path}`,
      ...(id === 'wiki' ? { published_url: `${BASE}/api/wiki/${encodeURIComponent(path)}.json`, status: 'Saved in BeyondHub → Versioned → Anchored → Published' } : {}),
    }, { headers: CORS });
  }
  const version = (prev?.version || 0) + 1;
  const ts = Math.floor(Date.now() / 1000);

  // Chain-Anker: nur Referenzen (Hashes/Version/CID), nicht der Inhalt.
  let chainSeq = null;
  try {
    const entry = await appendEntry(env, {
      ai: `repo:${id}`,
      prompt: `REPO-WRITE ${id}/${path} v${version}${message ? ` — ${message}` : ''}`,
      response: `sha256:${stored.sha256} cid:${stored.cid} prev:${prev ? `v${prev.version}/${prev.sha256}` : 'genesis'} bytes:${bytes.length} von:${author}`,
      kind: 'archive',
      meta: { system: 'repos', repo: id, path, version, cid: stored.cid, sha256: stored.sha256,
              prev_version: prev?.version || null, prev_sha256: prev?.sha256 || null,
              size: bytes.length, author, visibility: repo.visibility },
    });
    chainSeq = entry?.seq || null;
  } catch { chainSeq = null; }

  await env.bsl_stats.prepare(
    `INSERT INTO repo_files (repo, path, version, cid, sha256, size, prev_version, prev_sha256, message, author, ts, chain_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, path, version, stored.cid, stored.sha256, bytes.length,
      prev?.version || null, prev?.sha256 || null, message || null, author, ts, chainSeq).run();

  // Kollaborations-Historie synchron halten: Legacy-Write = Commit auf main
  // (nie blockierend, idempotent — siehe collab.js syncMainAfterLegacyWrite).
  try {
    await syncMainAfterLegacyWrite(env, id, path, { cid: stored.cid, sha256: stored.sha256, size: bytes.length }, author, message);
  } catch { /* Sync darf den Write nie blockieren */ }

  return Response.json({
    ok: true, repo: id, path, version,
    cid: stored.cid, sha256: stored.sha256, size: bytes.length,
    prev_version: prev?.version || null, prev_sha256: prev?.sha256 || null,
    chain_seq: chainSeq,
    chain: chainSeq ? `${BASE}/api/future-chain.json?seq=${chainSeq}` : null,
    read: `${BASE}/api/repos/${id}/files/${path}`,
    history: `${BASE}/api/repos/${id}/files/${path}/history.json`,
    download: `${BASE}/api/storage/download/${stored.cid}`,
    gateways: gateways(stored.cid, storageName),
    provenance: 'Version in Storage (IPFS) abgelegt und in der Hash-Chain signiert verankert — rueckwaerts verifizierbar.',
    ...(id === 'wiki' ? {
      published_url: `${BASE}/api/wiki/${encodeURIComponent(path)}.json`,
      status: 'Draft → Saved in BeyondHub → Versioned → Anchored → Published',
    } : {}),
  }, { status: 201, headers: CORS });
}

/* GET /api/repos/{id}/files/{path}[?v=N][?raw=1] — Version lesen.
   Text bis 64 KB wird inline mitgeliefert (maschinenlesbar in einem Call). */
export async function handleFileRead(request, env, id, path) {
  await ensureRepoTables(env);
  const repo = await getRepo(env, id);
  if (!repo) return Response.json({ ok: false, error: 'Repo unbekannt' }, { status: 404, headers: CORS });
  const key = extractKey(request, null);
  if (!(await canRead(repo, key))) {
    return Response.json({ ok: false, error: 'privat — x-repo-key erforderlich' }, { status: 403, headers: CORS });
  }
  path = cleanPath(path);
  const url = new URL(request.url);
  const v = parseInt(url.searchParams.get('v') || '', 10);
  const row = v
    ? await env.bsl_stats.prepare('SELECT * FROM repo_files WHERE repo = ? AND path = ? AND version = ?').bind(id, path, v).first()
    : await latestVersion(env, id, path);
  if (!row) return Response.json({ ok: false, error: 'Datei/Version unbekannt' }, { status: 404, headers: CORS });

  const sRow = row.cid
    ? await env.bsl_stats.prepare('SELECT name, mime FROM storage_files WHERE cid = ?').bind(row.cid).first()
    : null;
  const name = sRow?.name || path.slice(0, 180).replace(/[\r\n/\\]/g, '_');
  const mime = sRow?.mime || guessMime(path);

  if (url.searchParams.get('raw') === '1' && row.cid) {
    return new Response(null, { status: 302, headers: { ...CORS, Location: `${PINATA_GW}/${row.cid}/${encodeURIComponent(name)}` } });
  }

  let content = null;
  if (row.cid && row.size <= INLINE_MAX && /^(text\/|application\/(json|xml))/.test(mime)) {
    try {
      const r = await fetch(`${PINATA_GW}/${row.cid}/${encodeURIComponent(name)}`, { cf: { cacheTtl: 300 } });
      if (r.ok) content = await r.text();
    } catch { content = null; }
  }

  return Response.json({
    ok: true, repo: id, path: row.path, version: row.version,
    cid: row.cid, sha256: row.sha256, size: row.size, mime,
    prev_version: row.prev_version, prev_sha256: row.prev_sha256,
    message: row.message, author: row.author, ts: row.ts, chain_seq: row.chain_seq,
    ...(content !== null ? { content } : { content_hinweis: 'Binaer/zu gross fuer inline — raw/download nutzen' }),
    raw: `${BASE}/api/repos/${id}/files/${row.path}?raw=1${v ? `&v=${v}` : ''}`,
    download: row.cid ? `${BASE}/api/storage/download/${row.cid}` : null,
    history: `${BASE}/api/repos/${id}/files/${row.path}/history.json`,
    chain: row.chain_seq ? `${BASE}/api/future-chain.json?seq=${row.chain_seq}` : null,
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* GET /api/repos/{id}/files/{path}/history.json — die Provenienz-Kette. */
export async function handleFileHistory(request, env, id, path) {
  await ensureRepoTables(env);
  const repo = await getRepo(env, id);
  if (!repo) return Response.json({ ok: false, error: 'Repo unbekannt' }, { status: 404, headers: CORS });
  const key = extractKey(request, null);
  if (!(await canRead(repo, key))) {
    return Response.json({ ok: false, error: 'privat — x-repo-key erforderlich' }, { status: 403, headers: CORS });
  }
  path = cleanPath(path);
  const rows = await env.bsl_stats.prepare(
    `SELECT version, cid, sha256, size, prev_version, prev_sha256, message, author, ts, chain_seq
     FROM repo_files WHERE repo = ? AND path = ? ORDER BY version DESC LIMIT 200`).bind(id, path).all();
  return Response.json({
    ok: true, repo: id, path,
    versions: (rows.results || []).map((r) => ({
      ...r,
      read: `${BASE}/api/repos/${id}/files/${path}?v=${r.version}`,
      chain: r.chain_seq ? `${BASE}/api/future-chain.json?seq=${r.chain_seq}` : null,
    })),
    provenance: 'Rueckwaerts verifizierbar: version N → prev_sha256 → version N-1 → … → genesis. Jede Stufe zusaetzlich in der Hash-Chain signiert.',
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* ---------------- WIKI LIGHT ---------------- */

/* GET /api/wiki/index.json — alle Seiten (neueste Version). */
export async function handleWikiIndex(env) {
  await ensureWikiRepo(env);
  const rows = await env.bsl_stats.prepare(
    `SELECT f.path, f.version, f.sha256, f.size, f.ts, f.chain_seq
     FROM repo_files f
     JOIN (SELECT path, MAX(version) AS v FROM repo_files WHERE repo = ? GROUP BY path) m
       ON f.path = m.path AND f.version = m.v
     WHERE f.repo = ? ORDER BY f.path ASC`).bind(WIKI_REPO, WIKI_REPO).all();
  return Response.json({
    ok: true,
    wiki: 'WIKI LIGHT — oeffentliches, maschinenlesbares Wissen des Temporal Loop',
    pages: (rows.results || []).map((p) => ({
      page: p.path, version: p.version, sha256: p.sha256, ts: p.ts,
      json: `${BASE}/api/wiki/${p.path}.json`,
      history: `${BASE}/api/wiki/${p.path}/history.json`,
      chain: p.chain_seq ? `${BASE}/api/future-chain.json?seq=${p.chain_seq}` : null,
    })),
    hub: `${BASE}/api/hub.json`,
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* GET /api/wiki/{page}.json[?v=N] — Seite lesen (Markdown inline). */
export async function handleWikiPage(request, env, page) {
  await ensureWikiRepo(env);
  page = cleanPath(String(page || '').replace(/\.json$/i, ''));
  if (!page) return Response.json({ ok: false, error: 'Seite fehlt' }, { status: 400, headers: CORS });
  const url = new URL(request.url);
  const v = parseInt(url.searchParams.get('v') || '', 10);
  const row = v
    ? await env.bsl_stats.prepare('SELECT * FROM repo_files WHERE repo = ? AND path = ? AND version = ?').bind(WIKI_REPO, page, v).first()
    : await latestVersion(env, WIKI_REPO, page);
  if (!row) return Response.json({ ok: false, error: 'Seite unbekannt', index: `${BASE}/api/wiki/index.json` }, { status: 404, headers: CORS });

  const sRow = row.cid
    ? await env.bsl_stats.prepare('SELECT name, mime FROM storage_files WHERE cid = ?').bind(row.cid).first()
    : null;
  let content = null;
  if (row.cid && row.size <= INLINE_MAX) {
    try {
      const name = sRow?.name || row.path.replace(/[\r\n/\\]/g, '_');
      const r = await fetch(`${PINATA_GW}/${row.cid}/${encodeURIComponent(name)}`, { cf: { cacheTtl: 300 } });
      if (r.ok) content = await r.text();
    } catch { content = null; }
  }
  return Response.json({
    ok: true, wiki: true, page: row.path, version: row.version,
    sha256: row.sha256, cid: row.cid, size: row.size,
    prev_version: row.prev_version, prev_sha256: row.prev_sha256,
    ts: row.ts, chain_seq: row.chain_seq,
    ...(content !== null ? { content } : {}),
    raw: `${BASE}/api/repos/${WIKI_REPO}/files/${row.path}?raw=1${v ? `&v=${v}` : ''}`,
    history: `${BASE}/api/wiki/${row.path}/history.json`,
    chain: row.chain_seq ? `${BASE}/api/future-chain.json?seq=${row.chain_seq}` : null,
    index: `${BASE}/api/wiki/index.json`,
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* GET /api/wiki/{page}/history.json */
export async function handleWikiHistory(env, page) {
  await ensureWikiRepo(env);
  page = cleanPath(page);
  const rows = await env.bsl_stats.prepare(
    `SELECT version, sha256, cid, size, prev_version, prev_sha256, message, ts, chain_seq
     FROM repo_files WHERE repo = ? AND path = ? ORDER BY version DESC LIMIT 200`).bind(WIKI_REPO, page).all();
  return Response.json({
    ok: true, wiki: true, page,
    versions: (rows.results || []).map((r) => ({
      ...r,
      json: `${BASE}/api/wiki/${page}.json?v=${r.version}`,
      chain: r.chain_seq ? `${BASE}/api/future-chain.json?seq=${r.chain_seq}` : null,
    })),
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* PUT /api/wiki/{page} — Seite schreiben (Operator: x-repo-key = IPFS_CONFIRM_TOKEN). */
export async function handleWikiWrite(request, env, page) {
  await ensureWikiRepo(env);
  page = cleanPath(page);
  if (!page) return Response.json({ ok: false, error: 'Seite fehlt' }, { status: 400, headers: CORS });
  return handleFileWrite(request, env, WIKI_REPO, page);
}

/* DELETE /api/repos/{id}/files/{path} — Datei aus einem Repo entfernen.
   Autorisation: Schreibschluessel des Repos. Ehrlich: alle Versionen der
   Datei fallen aus dem Baum; Inhalte bleiben content-addressiert im IPFS
   (Kubo/Pinata) erhalten — IPFS kann nichts wirklich loeschen. */
export async function handleFileDelete(request, env, id, path) {
  if (request.method !== 'DELETE' && request.method !== 'POST') {
    return Response.json({ error: 'DELETE (oder POST …/delete) only' }, { status: 405, headers: CORS });
  }
  await ensureRepoTables(env);
  const repo = await getRepo(env, id);
  if (!repo) return Response.json({ ok: false, error: 'Repo unbekannt' }, { status: 404, headers: CORS });
  path = cleanPath(path);
  if (!path) return Response.json({ ok: false, error: 'Pfad fehlt/ungueltig' }, { status: 400, headers: CORS });
  const key = extractKey(request, null);
  if (!(await canWrite(repo, key, (await resolveAgent(env, request, null))?.agent_id || null))) {
    return Response.json({ ok: false, error: 'Schreibschluessel fehlt/ungueltig (x-repo-key)' }, { status: 403, headers: CORS });
  }
  const latest = await latestVersion(env, id, path);
  if (!latest) return Response.json({ ok: false, error: 'Datei unbekannt' }, { status: 404, headers: CORS });
  const ts = Math.floor(Date.now() / 1000);
  let chainSeq = null;
  try {
    const entry = await appendEntry(env, {
      ai: `repo:${id}`,
      prompt: `REPO-DELETE ${id}/${path} (bis v${latest.version})`,
      response: `letzte sha256:${latest.sha256} cid:${latest.cid} bytes:${latest.size} ts:${ts}`,
      kind: 'archive',
      meta: { system: 'repos', repo: id, path, event: 'delete', last_version: latest.version, cid: latest.cid, sha256: latest.sha256 },
    });
    chainSeq = entry?.seq || null;
  } catch { chainSeq = null; }
  await env.bsl_stats.prepare('DELETE FROM repo_files WHERE repo = ? AND path = ?').bind(id, path).run();
  return Response.json({
    ok: true, deleted: true, repo: id, path,
    removed_versions_up_to: latest.version, last_sha256: latest.sha256,
    chain_seq: chainSeq,
    hinweis: 'Datei aus dem Repo entfernt (Chain-Anker gesetzt). Ehrlich: die Inhalte bleiben content-addressiert im IPFS erhalten — IPFS kann nichts wirklich loeschen.',
  }, { headers: CORS });
}

/* POST /api/repos/{id}/publish — Repo-Inhalt als Wiki-Light-Seite veroeffentlichen.
   DIE VERÖFFENTLICHUNGS-BRÜCKE: Beyond Hub (Entstehung) → Wiki Light (oeffentlich).
   Autorisation: Schreibschluessel des QUELL-Repos (Presence = eigene Identität).
   Quelle: path (Standard presence.md, sonst neueste Datei des Repos).
   Ziel: Wiki-System-Repo, Seite presences/{id}. Volle Provenienz beidseitig. */
export async function handleRepoPublish(request, env, id) {
  if (request.method !== 'POST') return Response.json({ error: 'POST only — {path?, page?} + x-repo-key' }, { status: 405, headers: CORS });
  await ensureRepoTables(env);
  const repo = await getRepo(env, id);
  if (!repo) return Response.json({ ok: false, error: 'Repo unbekannt — Satoshi Social: erst POST /api/repos {id: handle}' }, { status: 404, headers: CORS });
  let b = {};
  try { b = await request.json(); } catch { /* leer ok */ }
  const key = extractKey(request, b);
  if (!(await canWrite(repo, key, (await resolveAgent(env, request, b))?.agent_id || null))) {
    return Response.json({ ok: false, error: 'Schreibschluessel fehlt/ungueltig (x-repo-key des Repos — oder als Owner-Agent per Bearer)' }, { status: 403, headers: CORS });
  }
  let srcPath = cleanPath(b.path) || 'presence.md';
  let src = await latestVersion(env, id, srcPath);
  if (!src) {
    // Fallback: neueste Datei des Repos
    const any = await env.bsl_stats.prepare(
      'SELECT path FROM repo_files WHERE repo = ? ORDER BY ts DESC LIMIT 1').bind(id).first();
    if (any) { srcPath = any.path; src = await latestVersion(env, id, srcPath); }
  }
  if (!src) return Response.json({ ok: false, error: 'Repo ist leer — erst eine Datei schreiben (z. B. presence.md)' }, { status: 409, headers: CORS });

  // Inhalt aus dem IPFS-Speicher holen (der Server speichert keine Inhalte) —
  // mehrere Gateways versuchen (Pinata limitiert oefters mit 429).
  const sRow = await env.bsl_stats.prepare('SELECT name, mime FROM storage_files WHERE cid = ?').bind(src.cid).first();
  const fname = sRow?.name || null;
  const gwList = [
    `https://littleking.live/api/storage/download/${src.cid}`,
    `${PINATA_GW}/${src.cid}${fname ? `/${encodeURIComponent(fname)}` : ''}`,
    `https://ipfs.io/ipfs/${src.cid}${fname ? `/${encodeURIComponent(fname)}` : ''}`,
    `https://dweb.link/ipfs/${src.cid}${fname ? `/${encodeURIComponent(fname)}` : ''}`,
  ];
  let content = null; let lastErr = '';
  const gwRound = [
    ...gwList,
    `https://gateway.ipfs.io/ipfs/${src.cid}${fname ? `/${encodeURIComponent(fname)}` : ''}`,
  ];
  for (let round = 0; round < 3 && content === null; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 8000)); // Gateway-Propagation abwarten
    for (const gw of gwRound) {
      try {
        const r = await fetch(gw, { signal: AbortSignal.timeout(12000), redirect: 'follow' });
        if (r.ok) { content = await r.text(); break; }
        lastErr = 'gateway ' + r.status;
      } catch (e) {
        lastErr = String(e && e.message || e).slice(0, 80);
      }
    }
  }
  if (content === null) {
    return Response.json({ ok: false, error: 'Inhalt nicht aus dem IPFS abrufbar (' + lastErr + ')' }, { status: 502, headers: CORS });
  }
  if (repo.visibility === 'private' && /privatsphaere|private|geheim|passwort/i.test(content)) {
    return Response.json({ ok: false, error: 'Veröffentlichung verweigert: Inhalt sieht nach privaten Daten aus (Stichwort-Check). Private Repos bitte clientseitig verschluesseln, bevor veröffentlicht wird.' }, { status: 409, headers: CORS });
  }
  const page = cleanPath(b.page) || `presences/${id}`;
  // Write in das Wiki-System-Repo — Operator-Seite ueber internen Schluessel
  const wikiReq = new Request(`${BASE}/api/repos/wiki/files/${encodeURIComponent(page)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-repo-key': env.IPFS_CONFIRM_TOKEN || '' },
    body: JSON.stringify({
      content,
      message: `PUBLISH aus ${id}/${srcPath} v${src.version}`,
      author: `publish:${id}`,
    }),
  });
  const wikiRes = await handleFileWrite(wikiReq, env, WIKI_REPO, page);
  const wikiJson = await wikiRes.json().catch(() => ({}));
  if (!wikiRes.ok || wikiJson.ok === false) {
    return Response.json({ ok: false, error: 'Wiki-Write fehlgeschlagen', detail: wikiJson.error || wikiRes.status }, { status: 502, headers: CORS });
  }
  return Response.json({
    ok: true, published: true,
    repo: id, source: { path: srcPath, version: src.version, sha256: src.sha256, cid: src.cid },
    page,
    wiki: { version: wikiJson.version, chain_seq: wikiJson.chain_seq, sha256: wikiJson.sha256 },
    published_url: `${BASE}/api/wiki/${encodeURIComponent(page)}.json`,
    json_url: `${BASE}/api/wiki/${encodeURIComponent(page)}.json`,
    provenance: `Hub v${src.version} (sha256 ${String(src.sha256).slice(0, 16)}…) → Wiki Light v${wikiJson.version}, signierter Anker #${wikiJson.chain_seq} — Rueckwaerts verifizierbar.`,
    widerruf: 'Ruecknahme: DELETE /api/repos/wiki/files/' + encodeURIComponent(page) + ' (Operator) — der History-Eintrag bleibt in der Chain.',
  }, { status: 201, headers: CORS });
}
