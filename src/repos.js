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

async function canWrite(repo, key) {
  if (repo.open_write) return true;
  if (!repo.key_hash) return true;              // kein Schluessel hinterlegt = offen
  if (!key) return false;
  return (await sha256hexStr(key)) === repo.key_hash;
}

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
    return Response.json({ error: 'POST only — JSON {id, name?, description?, visibility?, owner?, open_write?}' }, { status: 405, headers: CORS });
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
    return Response.json({ ok: false, error: 'Repo existiert bereits' }, { status: 409, headers: CORS });
  }
  const visibility = b.visibility === 'private' ? 'private' : 'public';
  const openWrite = b.open_write === true && visibility === 'public';
  const writeKey = openWrite ? null : (typeof b.api_key === 'string' && b.api_key.length >= 12 ? b.api_key : randKey());
  const keyHash = writeKey ? await sha256hexStr(writeKey) : null;
  await env.bsl_stats.prepare(
    `INSERT INTO repos (id, name, description, visibility, owner, key_hash, open_write, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, String(b.name || id).slice(0, 120), String(b.description || '').slice(0, 500),
      visibility, String(b.owner || 'anonymous').slice(0, 80), keyHash, openWrite ? 1 : 0,
      Math.floor(Date.now() / 1000)).run();
  return Response.json({
    ok: true, id, visibility, open_write: openWrite,
    ...(writeKey ? { write_key: writeKey, hinweis: 'Schreibschluessel — nur jetzt sichtbar. Gespeichert wird nur sein SHA-256.' } : {}),
    ...(visibility === 'private' ? { private_hinweis: 'v0: Inhalt clientseitig verschluesseln — der Server speichert nur Ciphertext.' } : {}),
    api: `${BASE}/api/repos/${id}.json`,
    write: `PUT ${BASE}/api/repos/${id}/files/{path} (+ x-repo-key)`,
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
  if (!(await canWrite(repo, key))) {
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
      ...(id === 'wiki' ? { published_url: `${BASE}/wiki?seite=${path}`, status: 'Saved in BeyondHub → Versioned → Anchored → Published' } : {}),
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
      published_url: `${BASE}/wiki?seite=${path}`,
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
