/* BSL HUB COLLAB — Kollaborative Wissensentwicklung im Beyond Hub:
   Branches · Commits · Pull Requests · Reviews · Merge-Engine.

   Ein Merge ersetzt nie die Vergangenheit — er verbindet zwei
   Entwicklungslinien nachvollziehbar miteinander (Merge-Commit mit zwei
   Eltern, signierter Chain-Anker). Bestehende repo_files-Versionen bleiben
   unangetastet und rueckwaertskompatibel: Die flache Hauptansicht (main)
   wird bei Commits/Merges synchron gefuehrt.

   REIFE v1 (ehrlich): Fast-Forward + Datei-basiertes 3-Wege-Merging mit
   Konflikterkennung; Konfliktloesung ueber resolve-Endpunkt. Zeilen-Diffs
   sind API-seitig als Datei-Status (+ Inhalt via Commit-Endpunkte) abrufbar.

   BERECHTIGUNGEN v1: Schreiben (Branch/Commit/PR) = Schreibschluessel des
   Repos ODER open_write. Merge/Close/Branch-Loeschen = Schreibschluessel.
   Reviews/Kommentare = offen, mit Autoren-Attribution (menschlich/AI
   kenntlich gemacht). Signatur beweist Zuordnung zum Schluessel — nicht
   Identitaet oder Kompetenz. Reviews sind festgehaltene Meinungen, kein
   Korrektheitsbeweis. */

import { storeBytes } from './storage.js';
import { appendEntry } from './future-chain.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-repo-key',
};

const BASE = 'https://satoshi-interface.com';
const MAX_FILE = 8 * 1024 * 1024;
const MAIN = 'main';

let migrated = null;
function ensureCollabTables(env) {
  if (!migrated) {
    migrated = (async () => {
      await env.bsl_stats.prepare(
        `CREATE TABLE IF NOT EXISTS repo_commits (
           repo TEXT NOT NULL,
           commit_hash TEXT NOT NULL,
           branch TEXT NOT NULL,
           parents TEXT NOT NULL,
           tree TEXT NOT NULL,
           author TEXT,
           message TEXT,
           ts INTEGER NOT NULL,
           chain_seq INTEGER,
           PRIMARY KEY (repo, commit_hash))`).run();
      await env.bsl_stats.prepare(
        `CREATE TABLE IF NOT EXISTS repo_branches (
           repo TEXT NOT NULL,
           name TEXT NOT NULL,
           head_commit TEXT NOT NULL,
           parent_branch TEXT,
           created_by TEXT,
           created_at INTEGER NOT NULL,
           protected INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (repo, name))`).run();
      await env.bsl_stats.prepare(
        `CREATE TABLE IF NOT EXISTS repo_prs (
           repo TEXT NOT NULL,
           number INTEGER NOT NULL,
           source_branch TEXT NOT NULL,
           target_branch TEXT NOT NULL,
           source_commit TEXT,
           target_commit TEXT NOT NULL,
           author TEXT,
           title TEXT,
           description TEXT,
           status TEXT NOT NULL DEFAULT 'open',
           base_commit TEXT NOT NULL,
           conflicts TEXT,
           merged_commit TEXT,
           merge_chain_seq INTEGER,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (repo, number))`).run();
      await env.bsl_stats.prepare(
        `CREATE TABLE IF NOT EXISTS repo_pr_reviews (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           repo TEXT NOT NULL,
           pr INTEGER NOT NULL,
           reviewer TEXT NOT NULL,
           reviewer_type TEXT NOT NULL DEFAULT 'ai',
           decision TEXT NOT NULL,
           commit_reviewed TEXT,
           comment TEXT,
           ts INTEGER NOT NULL,
           chain_seq INTEGER)`).run();
      await env.bsl_stats.prepare(
        `CREATE TABLE IF NOT EXISTS repo_pr_comments (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           repo TEXT NOT NULL,
           pr INTEGER NOT NULL,
           author TEXT NOT NULL,
           path TEXT,
           body TEXT NOT NULL,
           ts INTEGER NOT NULL)`).run();
    })();
  }
  return migrated;
}

async function sha256hexStr(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function slugOk(s) { return /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(s); }
function branchOk(s) { return /^[a-z0-9][a-z0-9._-]{0,58}[a-z0-9]$/i.test(s) && s.toLowerCase() !== MAIN; }
function cleanPath(p) {
  p = String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return (!p || p.length > 300 || p.includes('..')) ? null : p;
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
  if (!repo.key_hash) return true;
  if (!key) return false;
  return (await sha256hexStr(key)) === repo.key_hash;
}
async function isOwner(repo, key) {
  if (!repo.key_hash) return true;
  if (!key) return false;
  return (await sha256hexStr(key)) === repo.key_hash;
}

async function anchor(env, event, repo, extra = {}) {
  try {
    const entry = await appendEntry(env, {
      ai: `hub:${repo}`,
      prompt: `HUB-COLLAB ${event} repo:${repo}`,
      response: Object.entries({ event, repo, ...extra }).map(([k, v]) => `${k}:${v}`).join(' ').slice(0, 500),
      kind: 'archive',
      meta: { system: 'hub-collab', event, repo, ...extra },
    });
    return entry?.seq || null;
  } catch { return null; }
}

/* Genesis-Migration: Aus den bestehenden repo_files (neueste Versionen pro
   Pfad) wird ein Genesis-Commit fuer main gebaut — bestehende Repos bleiben
   unveraendert lesbar, bekommen aber eine Commit-Historie. */
async function ensureMainBranch(env, repo) {
  const existing = await env.bsl_stats.prepare(
    'SELECT name FROM repo_branches WHERE repo = ? AND name = ?').bind(repo, MAIN).first();
  if (existing) return;
  const files = await env.bsl_stats.prepare(
    `SELECT f.path, f.cid, f.sha256, f.size, f.version FROM repo_files f
     JOIN (SELECT path, MAX(version) AS v FROM repo_files WHERE repo = ? GROUP BY path) m
       ON f.path = m.path AND f.version = m.v WHERE f.repo = ?`).bind(repo, repo).all();
  const tree = {};
  for (const f of files.results || []) tree[f.path] = { cid: f.cid, sha256: f.sha256, size: f.size, version: f.version };
  const ts = Math.floor(Date.now() / 1000);
  const commitHash = await sha256hexStr(JSON.stringify({ repo, branch: MAIN, genesis: true, tree }));
  await env.bsl_stats.prepare(
    `INSERT OR IGNORE INTO repo_commits (repo, commit_hash, branch, parents, tree, author, message, ts, chain_seq)
     VALUES (?, ?, ?, '[]', ?, 'system', 'genesis migration (aus repo_files)', ?, NULL)`)
    .bind(repo, commitHash, MAIN, JSON.stringify(tree), ts).run();
  await env.bsl_stats.prepare(
    `INSERT OR IGNORE INTO repo_branches (repo, name, head_commit, parent_branch, created_by, created_at, protected)
     VALUES (?, ?, ?, NULL, 'system', ?, 1)`).bind(repo, MAIN, commitHash, ts).run();
}

async function getBranch(env, repo, name) {
  return env.bsl_stats.prepare('SELECT * FROM repo_branches WHERE repo = ? AND name = ?').bind(repo, name).first();
}
async function getCommit(env, repo, hash) {
  return env.bsl_stats.prepare('SELECT * FROM repo_commits WHERE repo = ? AND commit_hash = ?').bind(repo, hash).first();
}
function treeOf(commit) { return JSON.parse(commit?.tree || '{}'); }

/* 3-Wege-Vergleich auf Dateiebene. Rueckgabe: merged tree oder Konflikte. */
function diff3(base, source, target) {
  const paths = new Set([...Object.keys(base), ...Object.keys(source), ...Object.keys(target)]);
  const merged = {}, conflicts = [], changes = [];
  for (const p of paths) {
    const b = base[p]?.sha256 || null, s = source[p]?.sha256 || null, t = target[p]?.sha256 || null;
    if (s === t) { if (s) merged[p] = source[p]; continue; }         // gleich (oder beide geloescht)
    if (s === b) { if (t) merged[p] = target[p]; changes.push({ path: p, status: 'kept_target' }); continue; } // nur target geaendert
    if (t === b) { if (s) { merged[p] = source[p]; changes.push({ path: p, status: s ? (b ? 'modified' : 'added') : 'removed' }); } continue; } // nur source geaendert
    // beide anders → Konflikt (Ausnahme: einer hat geloescht)
    conflicts.push({ path: p, base: !!b, source: s || null, target: t || null });
  }
  return { merged, conflicts, changes };
}

/* Merge-Basis: vollstaendiger Vorfahren-Durchlauf (Repositories sind klein) —
   der juengste gemeinsame Vorfahre von zwei Commits. */
async function ancestorsOf(env, repo, start) {
  const seen = new Set(); const queue = [start];
  while (queue.length) {
    const h = queue.shift();
    if (!h || seen.has(h)) continue;
    seen.add(h);
    const c = await getCommit(env, repo, h);
    if (c) queue.push(...JSON.parse(c.parents || '[]'));
  }
  return seen;
}
async function mergeBase(env, repo, a, b) {
  const ancA = await ancestorsOf(env, repo, a);
  const queue = [b]; const seen = new Set();
  let best = null;
  while (queue.length) {
    const h = queue.shift();
    if (!h || seen.has(h)) continue;
    seen.add(h);
    if (ancA.has(h)) { best = h; break; }   // BFS → erster Treffer ist der juengste gemeinsame
    const c = await getCommit(env, repo, h);
    if (c) queue.push(...JSON.parse(c.parents || '[]'));
  }
  return best;
}

/* ---------------- BRANCHES ---------------- */

export async function handleBranchList(env, repoId) {
  await ensureCollabTables(env);
  if (!(await getRepo(env, repoId))) return Response.json({ ok: false, error: 'Repo unbekannt' }, { status: 404, headers: CORS });
  await ensureMainBranch(env, repoId);
  const rows = await env.bsl_stats.prepare(
    'SELECT * FROM repo_branches WHERE repo = ? ORDER BY created_at ASC').bind(repoId).all();
  return Response.json({
    ok: true, repo: repoId,
    branches: (rows.results || []).map((b) => ({
      name: b.name, head_commit: b.head_commit, parent_branch: b.parent_branch,
      created_by: b.created_by, created_at: b.created_at, protected: !!b.protected,
      commit: `${BASE}/api/repos/${repoId}/commits/${b.head_commit}`,
    })),
    create: `POST ${BASE}/api/repos/${repoId}/branches {name, from?} + x-repo-key`,
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

export async function handleBranchCreate(request, env, repoId) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405, headers: CORS });
  await ensureCollabTables(env);
  const repo = await getRepo(env, repoId);
  if (!repo) return Response.json({ ok: false, error: 'Repo unbekannt' }, { status: 404, headers: CORS });
  await ensureMainBranch(env, repoId);
  let b = {}; try { b = await request.json(); } catch { /* 400 */ }
  const key = extractKey(request, b);
  if (!(await canWrite(repo, key))) return Response.json({ ok: false, error: 'Schreibschluessel erforderlich (x-repo-key)' }, { status: 403, headers: CORS });
  const name = String(b.name || '').trim();
  if (!branchOk(name)) return Response.json({ ok: false, error: 'Branchname ungueltig (nicht "main", 3–60 Zeichen)' }, { status: 400, headers: CORS });
  if (await getBranch(env, repoId, name)) return Response.json({ ok: false, error: 'Branch existiert bereits' }, { status: 409, headers: CORS });
  const from = String(b.from || MAIN);
  const src = await getBranch(env, repoId, from);
  if (!src) return Response.json({ ok: false, error: `Quell-Branch "${from}" unbekannt` }, { status: 404, headers: CORS });
  const author = String(b.author || repo.owner || 'anonymous').slice(0, 80);
  const ts = Math.floor(Date.now() / 1000);
  const chainSeq = await anchor(env, 'branch_created', repoId, { branch: name, from, by: author });
  await env.bsl_stats.prepare(
    `INSERT INTO repo_branches (repo, name, head_commit, parent_branch, created_by, created_at, protected)
     VALUES (?, ?, ?, ?, ?, ?, 0)`).bind(repoId, name, src.head_commit, from, author, ts).run();
  return Response.json({
    ok: true, repo: repoId, branch: name, head_commit: src.head_commit, parent_branch: from,
    created_by: author, chain_seq: chainSeq,
    commit: `${BASE}/api/repos/${repoId}/commits/${src.head_commit}`,
  }, { status: 201, headers: CORS });
}

export async function handleBranchGet(env, repoId, name) {
  await ensureCollabTables(env);
  await ensureMainBranch(env, repoId);
  const b = await getBranch(env, repoId, name);
  if (!b) return Response.json({ ok: false, error: 'Branch unbekannt' }, { status: 404, headers: CORS });
  const commits = await env.bsl_stats.prepare(
    `SELECT commit_hash, parents, author, message, ts, chain_seq FROM repo_commits
     WHERE repo = ? AND branch = ? ORDER BY ts DESC LIMIT 100`).bind(repoId, name).all();
  return Response.json({
    ok: true, repo: repoId, name: b.name, head_commit: b.head_commit, protected: !!b.protected,
    created_by: b.created_by, created_at: b.created_at, parent_branch: b.parent_branch,
    commits: (commits.results || []).map((c) => ({
      commit_hash: c.commit_hash, parents: JSON.parse(c.parents || '[]'),
      author: c.author, message: c.message, ts: c.ts, chain_seq: c.chain_seq,
      url: `${BASE}/api/repos/${repoId}/commits/${c.commit_hash}`,
    })),
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

export async function handleBranchDelete(request, env, repoId, name) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'DELETE' && request.method !== 'POST') return Response.json({ error: 'DELETE only' }, { status: 405, headers: CORS });
  await ensureCollabTables(env);
  const repo = await getRepo(env, repoId);
  if (!repo) return Response.json({ ok: false, error: 'Repo unbekannt' }, { status: 404, headers: CORS });
  const key = extractKey(request, null);
  if (!(await isOwner(repo, key))) return Response.json({ ok: false, error: 'nur der Repo-Inhaber kann Branches loeschen' }, { status: 403, headers: CORS });
  const b = await getBranch(env, repoId, name);
  if (!b) return Response.json({ ok: false, error: 'Branch unbekannt' }, { status: 404, headers: CORS });
  if (b.protected || name === MAIN) return Response.json({ ok: false, error: 'main ist geschuetzt und kann nicht geloescht werden' }, { status: 409, headers: CORS });
  const open = await env.bsl_stats.prepare(
    `SELECT COUNT(*) AS n FROM repo_prs WHERE repo = ? AND source_branch = ? AND status NOT IN ('merged','closed','rejected')`)
    .bind(repoId, name).first();
  if ((open?.n || 0) > 0) return Response.json({ ok: false, error: 'Branch hat noch offene Pull Requests' }, { status: 409, headers: CORS });
  await env.bsl_stats.prepare('DELETE FROM repo_branches WHERE repo = ? AND name = ?').bind(repoId, name).run();
  await anchor(env, 'branch_deleted', repoId, { branch: name, by: 'owner' });
  return Response.json({ ok: true, repo: repoId, branch: name, deleted: true }, { headers: CORS });
}

/* ---------------- COMMITS ---------------- */

async function buildTreeFromBase(env, repo, baseTree, files) {
  const tree = { ...baseTree };
  for (const [path, content] of Object.entries(files || {})) {
    const p = cleanPath(path);
    if (!p) throw new Error(`ungueltiger Pfad: ${path}`);
    if (content === null || content === '') { delete tree[p]; continue; }      // null = Datei loeschen
    const bytes = new TextEncoder().encode(String(content));
    if (bytes.length > MAX_FILE) throw new Error(`zu gross (> 8 MB): ${p}`);
    const stored = await storeBytes(env, bytes, { name: p.slice(0, 180).replace(/[\r\n/\\]/g, '_'), mime: 'text/markdown; charset=utf-8', uploader: `collab:${repo}` });
    if (!stored.ok) throw new Error(`storage: ${stored.error}`);
    tree[p] = { cid: stored.cid, sha256: stored.sha256, size: bytes.length };
  }
  return tree;
}

export async function handleCommitCreate(request, env, repoId) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405, headers: CORS });
  await ensureCollabTables(env);
  const repo = await getRepo(env, repoId);
  if (!repo) return Response.json({ ok: false, error: 'Repo unbekannt' }, { status: 404, headers: CORS });
  await ensureMainBranch(env, repoId);
  let b = {}; try { b = await request.json(); } catch { /* 400 */ }
  const key = extractKey(request, b);
  if (!(await canWrite(repo, key))) return Response.json({ ok: false, error: 'Schreibschluessel erforderlich (x-repo-key)' }, { status: 403, headers: CORS });
  const branchName = String(b.branch || MAIN);
  const branch = await getBranch(env, repoId, branchName);
  if (!branch) return Response.json({ ok: false, error: `Branch "${branchName}" unbekannt` }, { status: 404, headers: CORS });
  if (!b.files || typeof b.files !== 'object' || !Object.keys(b.files).length) {
    return Response.json({ ok: false, error: 'files erforderlich: {pfad: inhalt} — null loescht eine Datei' }, { status: 400, headers: CORS });
  }
  const author = String(b.author || repo.owner || 'anonymous').slice(0, 80);
  const message = String(b.message || '').slice(0, 300);
  const ts = Math.floor(Date.now() / 1000);

  let tree;
  try { tree = await buildTreeFromBase(env, repoId, treeOf(await getCommit(env, repoId, branch.head_commit)), b.files); }
  catch (e) { return Response.json({ ok: false, error: e.message }, { status: 400, headers: CORS }); }

  const parents = [branch.head_commit];
  const commitHash = await sha256hexStr(JSON.stringify({ repo: repoId, branch: branchName, parents, tree, author, message, ts }));
  if (await getCommit(env, repoId, commitHash)) {
    return Response.json({ ok: true, duplicate: true, commit_hash: commitHash, branch: branchName }, { headers: CORS });
  }
  const chainSeq = await anchor(env, 'commit', repoId, { branch: branchName, commit: commitHash.slice(0, 16), by: author, files: Object.keys(b.files).length });
  await env.bsl_stats.prepare(
    `INSERT INTO repo_commits (repo, commit_hash, branch, parents, tree, author, message, ts, chain_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(repoId, commitHash, branchName, JSON.stringify(parents), JSON.stringify(tree), author, message, ts, chainSeq).run();
  await env.bsl_stats.prepare('UPDATE repo_branches SET head_commit = ? WHERE repo = ? AND name = ?')
    .bind(commitHash, repoId, branchName).run();

  // Hauptansicht synchron halten: Commits auf main schreiben geaenderte
  // Pfade zusaetzlich als neue repo_files-Versionen (lesbar via /files/).
  if (branchName === MAIN) {
    for (const [p, entry] of Object.entries(tree)) {
      const prev = await env.bsl_stats.prepare(
        'SELECT version, sha256 FROM repo_files WHERE repo = ? AND path = ? ORDER BY version DESC LIMIT 1').bind(repoId, p).first();
      if (prev && prev.sha256 === entry.sha256) continue;
      await env.bsl_stats.prepare(
        `INSERT INTO repo_files (repo, path, version, cid, sha256, size, prev_version, prev_sha256, message, author, ts, chain_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(repoId, p, (prev?.version || 0) + 1, entry.cid, entry.sha256, entry.size,
          prev?.version || null, prev?.sha256 || null, message || null, author, ts, chainSeq).run();
    }
  }

  return Response.json({
    ok: true, repo: repoId, branch: branchName, commit_hash: commitHash, parents,
    files: Object.keys(b.files), author, message, ts, chain_seq: chainSeq,
    commit: `${BASE}/api/repos/${repoId}/commits/${commitHash}`,
  }, { status: 201, headers: CORS });
}

export async function handleCommitList2(request, env, repoId) {
  await ensureCollabTables(env);
  if (!(await getRepo(env, repoId))) return Response.json({ ok: false, error: 'Repo unbekannt' }, { status: 404, headers: CORS });
  await ensureMainBranch(env, repoId);
  const branch = new URL(request.url).searchParams.get('branch');
  let rows;
  if (branch) {
    rows = await env.bsl_stats.prepare(
      'SELECT * FROM repo_commits WHERE repo = ? AND branch = ? ORDER BY ts DESC LIMIT 200').bind(repoId, branch).all();
  } else {
    rows = await env.bsl_stats.prepare(
      'SELECT * FROM repo_commits WHERE repo = ? ORDER BY ts DESC LIMIT 200').bind(repoId).all();
  }
  return Response.json({
    ok: true, repo: repoId, branch_filter: branch || null,
    commits: (rows.results || []).map((c) => ({
      commit_hash: c.commit_hash, branch: c.branch, parents: JSON.parse(c.parents || '[]'),
      author: c.author, message: c.message, ts: c.ts, chain_seq: c.chain_seq,
      url: `${BASE}/api/repos/${repoId}/commits/${c.commit_hash}`,
    })),
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

export async function handleCommitGet(env, repoId, hash) {
  await ensureCollabTables(env);
  const c = await getCommit(env, repoId, String(hash || '').slice(0, 80));
  if (!c) return Response.json({ ok: false, error: 'Commit unbekannt' }, { status: 404, headers: CORS });
  return Response.json({
    ok: true, repo: repoId, commit_hash: c.commit_hash, branch: c.branch,
    parents: JSON.parse(c.parents || '[]'), author: c.author, message: c.message,
    ts: c.ts, chain_seq: c.chain_seq,
    tree: Object.fromEntries(Object.entries(treeOf(c)).map(([p, e]) => [p, { ...e, raw: `${BASE}/api/repos/${repoId}/raw/${c.commit_hash}/${p}` }])),
    chain: c.chain_seq ? `${BASE}/api/future-chain.json?seq=${c.chain_seq}` : null,
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* Roher Datei-Inhalt eines Commits (Text via IPFS-Gateway). */
export async function handleCommitRaw(env, repoId, hash, path) {
  const c = await getCommit(env, repoId, String(hash || '').slice(0, 80));
  if (!c) return Response.json({ ok: false, error: 'Commit unbekannt' }, { status: 404, headers: CORS });
  const entry = treeOf(c)[cleanPath(path)];
  if (!entry) return Response.json({ ok: false, error: 'Datei in diesem Commit nicht vorhanden' }, { status: 404, headers: CORS });
  try {
    const r = await fetch(`https://gateway.pinata.cloud/ipfs/${entry.cid}`, { cf: { cacheTtl: 300 } });
    if (!r.ok) throw new Error('gateway');
    return new Response(await r.arrayBuffer(), { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
  } catch {
    return Response.json({ ok: false, error: 'Inhalt voruebergehend nicht abrufbar — cid: ' + entry.cid }, { status: 502, headers: CORS });
  }
}

/* Legacy-Sync: wird von repos.js nach einem gewoehnlichen Datei-Write gerufen,
   damit main-Branch und repo_files nicht auseinanderlaufen. */
export async function syncMainAfterLegacyWrite(env, repoId, path, entry, author, message) {
  try {
    await ensureCollabTables(env);
    await ensureMainBranch(env, repoId);
    const branch = await getBranch(env, repoId, MAIN);
    const head = await getCommit(env, repoId, branch.head_commit);
    const tree = treeOf(head);
    tree[path] = { cid: entry.cid, sha256: entry.sha256, size: entry.size };
    const ts = Math.floor(Date.now() / 1000);
    const commitHash = await sha256hexStr(JSON.stringify({ repo: repoId, branch: MAIN, parents: [head.commit_hash], tree, author, message: message || 'file write (legacy API)', ts }));
    if (await getCommit(env, repoId, commitHash)) return;
    const chainSeq = await anchor(env, 'commit', repoId, { branch: MAIN, commit: commitHash.slice(0, 16), by: author, files: 1 });
    await env.bsl_stats.prepare(
      `INSERT INTO repo_commits (repo, commit_hash, branch, parents, tree, author, message, ts, chain_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(repoId, commitHash, MAIN, JSON.stringify([head.commit_hash]), JSON.stringify(tree), author, message || 'file write (legacy API)', ts, chainSeq).run();
    await env.bsl_stats.prepare('UPDATE repo_branches SET head_commit = ? WHERE repo = ? AND name = ?').bind(commitHash, repoId, MAIN).run();
  } catch { /* Sync darf den Legacy-Write nie blockieren */ }
}

/* ---------------- PULL REQUESTS ---------------- */

export async function handlePullList(env, repoId) {
  await ensureCollabTables(env);
  await ensureMainBranch(env, repoId);
  const rows = await env.bsl_stats.prepare(
    'SELECT * FROM repo_prs WHERE repo = ? ORDER BY number DESC LIMIT 200').bind(repoId).all();
  return Response.json({
    ok: true, repo: repoId,
    pulls: (rows.results || []).map((p) => ({
      number: p.number, title: p.title, status: p.status,
      source_branch: p.source_branch, target_branch: p.target_branch,
      author: p.author, created_at: p.created_at, updated_at: p.updated_at,
      merged_commit: p.merged_commit, url: `${BASE}/api/repos/${repoId}/pulls/${p.number}`,
    })),
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

export async function handlePullCreate(request, env, repoId) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405, headers: CORS });
  await ensureCollabTables(env);
  const repo = await getRepo(env, repoId);
  if (!repo) return Response.json({ ok: false, error: 'Repo unbekannt' }, { status: 404, headers: CORS });
  await ensureMainBranch(env, repoId);
  let b = {}; try { b = await request.json(); } catch { /* 400 */ }
  const key = extractKey(request, b);
  if (!(await canWrite(repo, key))) return Response.json({ ok: false, error: 'Schreibschluessel erforderlich' }, { status: 403, headers: CORS });
  const source = String(b.source_branch || '').trim();
  const target = String(b.target_branch || MAIN).trim();
  const src = await getBranch(env, repoId, source);
  const tgt = await getBranch(env, repoId, target);
  if (!src || !tgt) return Response.json({ ok: false, error: 'Quell- oder Ziel-Branch unbekannt' }, { status: 404, headers: CORS });
  if (source === target) return Response.json({ ok: false, error: 'Quell- und Ziel-Branch identisch' }, { status: 400, headers: CORS });
  const author = String(b.author || repo.owner || 'anonymous').slice(0, 80);
  const title = String(b.title || `Merge ${source} → ${target}`).slice(0, 200);
  const description = String(b.description || '').slice(0, 2000);
  const ts = Math.floor(Date.now() / 1000);

  // Merge-Basis bestimmen und Konflikte schon beim Erstellen anzeigen.
  const mb = await mergeBase(env, repoId, src.head_commit, tgt.head_commit) || tgt.head_commit;
  const { conflicts } = diff3(treeOf(await getCommit(env, repoId, mb)), treeOf(await getCommit(env, repoId, src.head_commit)), treeOf(await getCommit(env, repoId, tgt.head_commit)));
  const num = (await env.bsl_stats.prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM repo_prs WHERE repo = ?').bind(repoId).first()).n;
  const status = conflicts.length ? 'conflict' : 'open';
  const chainSeq = await anchor(env, 'pr_opened', repoId, { pr: num, from: source, to: target, by: author });
  await env.bsl_stats.prepare(
    `INSERT INTO repo_prs (repo, number, source_branch, target_branch, source_commit, target_commit, author, title, description, status, base_commit, conflicts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(repoId, num, source, target, src.head_commit, tgt.head_commit, author, title, description, status,
      mb, conflicts.length ? JSON.stringify(conflicts) : null, ts, ts).run();
  return Response.json({
    ok: true, repo: repoId, number: num, title, status, author,
    source_branch: source, target_branch: target,
    source_commit: src.head_commit, target_commit: tgt.head_commit,
    conflicts: conflicts.length ? conflicts : undefined,
    chain_seq: chainSeq,
    url: `${BASE}/api/repos/${repoId}/pulls/${num}`,
    merge: `POST ${BASE}/api/repos/${repoId}/pulls/${num}/merge + x-repo-key`,
    review: `POST ${BASE}/api/repos/${repoId}/pulls/${num}/reviews {reviewer, reviewer_type, decision: approved|changes_requested|commented, commit_reviewed?, comment?}`,
  }, { status: 201, headers: CORS });
}

export async function handlePullGet(env, repoId, num) {
  await ensureCollabTables(env);
  const p = await env.bsl_stats.prepare('SELECT * FROM repo_prs WHERE repo = ? AND number = ?').bind(repoId, num).first();
  if (!p) return Response.json({ ok: false, error: 'Pull Request unbekannt' }, { status: 404, headers: CORS });
  const reviews = await env.bsl_stats.prepare(
    'SELECT * FROM repo_pr_reviews WHERE repo = ? AND pr = ? ORDER BY ts ASC').bind(repoId, num).all();
  const comments = await env.bsl_stats.prepare(
    'SELECT * FROM repo_pr_comments WHERE repo = ? AND pr = ? ORDER BY ts ASC').bind(repoId, num).all();
  const src = treeOf(await getCommit(env, repoId, p.source_commit));
  const tgt = treeOf(await getCommit(env, repoId, p.target_commit));
  const base = treeOf(await getCommit(env, repoId, p.base_commit));
  const { changes, conflicts } = diff3(base, src, tgt);
  return Response.json({
    ok: true, repo: repoId, number: p.number, title: p.title, description: p.description,
    status: p.status, author: p.author,
    source_branch: p.source_branch, target_branch: p.target_branch,
    source_commit: p.source_commit, target_commit: p.target_commit, base_commit: p.base_commit,
    created_at: p.created_at, updated_at: p.updated_at,
    changed_files: changes, conflicts: p.conflicts ? JSON.parse(p.conflicts) : (conflicts.length ? conflicts : undefined),
    merged_commit: p.merged_commit, merge_chain_seq: p.merge_chain_seq,
    reviews: (reviews.results || []).map((r) => ({
      reviewer: r.reviewer, reviewer_type: r.reviewer_type, decision: r.decision,
      commit_reviewed: r.commit_reviewed, comment: r.comment, ts: r.ts, chain_seq: r.chain_seq,
    })),
    comments: (comments.results || []).map((c) => ({ author: c.author, path: c.path, body: c.body, ts: c.ts })),
    chain: p.merge_chain_seq ? `${BASE}/api/future-chain.json?seq=${p.merge_chain_seq}` : null,
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

export async function handlePullPatch(request, env, repoId, num) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  await ensureCollabTables(env);
  const repo = await getRepo(env, repoId);
  const p = await env.bsl_stats.prepare('SELECT * FROM repo_prs WHERE repo = ? AND number = ?').bind(repoId, num).first();
  if (!p) return Response.json({ ok: false, error: 'Pull Request unbekannt' }, { status: 404, headers: CORS });
  let b = {}; try { b = await request.json(); } catch { /* 400 */ }
  const key = extractKey(request, b);
  const ts = Math.floor(Date.now() / 1000);
  if (b.close) {
    if (!(await isOwner(repo, key)) && String(b.author || '') !== p.author) {
      return Response.json({ ok: false, error: 'Schliessen nur durch Inhaber oder PR-Autor' }, { status: 403, headers: CORS });
    }
    if (['merged', 'closed', 'rejected'].includes(p.status)) return Response.json({ ok: true, status: p.status, already: true }, { headers: CORS });
    await env.bsl_stats.prepare(`UPDATE repo_prs SET status = 'closed', updated_at = ? WHERE repo = ? AND number = ?`).bind(ts, repoId, num).run();
    await anchor(env, 'pr_closed', repoId, { pr: num });
    return Response.json({ ok: true, number: num, status: 'closed' }, { headers: CORS });
  }
  if (b.reopen) {
    if (String(b.author || '') !== p.author && !(await isOwner(repo, key))) {
      return Response.json({ ok: false, error: 'Wiedereroeffnen nur durch PR-Autor oder Inhaber' }, { status: 403, headers: CORS });
    }
    if (p.status !== 'closed') return Response.json({ ok: false, error: 'nur geschlossene PRs koennen wiedereroeffnet werden' }, { status: 409, headers: CORS });
    await env.bsl_stats.prepare(`UPDATE repo_prs SET status = 'open', updated_at = ? WHERE repo = ? AND number = ?`).bind(ts, repoId, num).run();
    await anchor(env, 'pr_reopened', repoId, { pr: num });
    return Response.json({ ok: true, number: num, status: 'open' }, { headers: CORS });
  }
  if (typeof b.title === 'string' || typeof b.description === 'string') {
    if (!(await isOwner(repo, key)) && String(b.author || '') !== p.author) {
      return Response.json({ ok: false, error: 'Bearbeiten nur durch Inhaber oder PR-Autor' }, { status: 403, headers: CORS });
    }
    await env.bsl_stats.prepare('UPDATE repo_prs SET title = ?, description = ?, updated_at = ? WHERE repo = ? AND number = ?')
      .bind(typeof b.title === 'string' ? b.title.slice(0, 200) : p.title,
        typeof b.description === 'string' ? b.description.slice(0, 2000) : p.description, ts, repoId, num).run();
    return Response.json({ ok: true, number: num, updated: true }, { headers: CORS });
  }
  return Response.json({ ok: false, error: 'Nichts zu tun — {title?, description?} | {close: true} | {reopen: true}' }, { status: 400, headers: CORS });
}

export async function handlePullReview(request, env, repoId, num) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405, headers: CORS });
  await ensureCollabTables(env);
  const p = await env.bsl_stats.prepare('SELECT * FROM repo_prs WHERE repo = ? AND number = ?').bind(repoId, num).first();
  if (!p) return Response.json({ ok: false, error: 'Pull Request unbekannt' }, { status: 404, headers: CORS });
  if (['merged', 'closed', 'rejected'].includes(p.status)) {
    return Response.json({ ok: false, error: `PR ist ${p.status} — keine Reviews mehr` }, { status: 409, headers: CORS });
  }
  let b = {}; try { b = await request.json(); } catch { /* 400 */ }
  const reviewer = String(b.reviewer || 'anonymous').slice(0, 80);
  const reviewerType = ['human', 'ai', 'maintainer', 'security', 'provenance'].includes(String(b.reviewer_type)) ? String(b.reviewer_type) : 'ai';
  const decision = ['approved', 'changes_requested', 'commented'].includes(String(b.decision)) ? String(b.decision) : 'commented';
  const commitReviewed = String(b.commit_reviewed || p.source_commit).slice(0, 80);
  const comment = String(b.comment || '').slice(0, 2000);
  const ts = Math.floor(Date.now() / 1000);
  const chainSeq = await anchor(env, 'review', repoId, { pr: num, by: reviewer, type: reviewerType, decision });
  await env.bsl_stats.prepare(
    `INSERT INTO repo_pr_reviews (repo, pr, reviewer, reviewer_type, decision, commit_reviewed, comment, ts, chain_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(repoId, num, reviewer, reviewerType, decision, commitReviewed, comment || null, ts, chainSeq).run();
  // Statuspflege: changes_requested dominiert, sonst approved (nur bei aktuellem Stand)
  let newStatus = p.status;
  if (decision === 'changes_requested') newStatus = 'changes_requested';
  else if (decision === 'approved' && commitReviewed === p.source_commit) {
    const pending = await env.bsl_stats.prepare(
      `SELECT COUNT(*) AS n FROM repo_pr_reviews WHERE repo = ? AND pr = ? AND decision = 'changes_requested'`).bind(repoId, num).first();
    newStatus = (pending?.n || 0) > 0 ? 'changes_requested' : 'approved';
  }
  if (newStatus !== p.status) {
    await env.bsl_stats.prepare('UPDATE repo_prs SET status = ?, updated_at = ? WHERE repo = ? AND number = ?').bind(newStatus, ts, repoId, num).run();
  }
  return Response.json({
    ok: true, number: num, reviewer, reviewer_type: reviewerType, decision,
    commit_reviewed: commitReviewed, status_now: newStatus, chain_seq: chainSeq,
    hinweis: decision === 'approved' && commitReviewed !== p.source_commit
      ? 'Achtung: Der Approval bezieht sich auf einen aelteren Stand — er zaehlt erst fuer den aktuellen source_commit.'
      : 'Review festgehalten (Meinung, kein Korrektheitsbeweis).',
  }, { status: 201, headers: CORS });
}

export async function handlePullComment(request, env, repoId, num) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405, headers: CORS });
  await ensureCollabTables(env);
  const p = await env.bsl_stats.prepare('SELECT * FROM repo_prs WHERE repo = ? AND number = ?').bind(repoId, num).first();
  if (!p) return Response.json({ ok: false, error: 'Pull Request unbekannt' }, { status: 404, headers: CORS });
  let b = {}; try { b = await request.json(); } catch { /* 400 */ }
  const author = String(b.author || 'anonymous').slice(0, 80);
  const body = String(b.body || '').slice(0, 2000);
  if (!body) return Response.json({ ok: false, error: 'body erforderlich' }, { status: 400, headers: CORS });
  const path = b.path ? cleanPath(b.path) : null;
  await env.bsl_stats.prepare(
    `INSERT INTO repo_pr_comments (repo, pr, author, path, body, ts) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(repoId, num, author, path, body, Math.floor(Date.now() / 1000)).run();
  return Response.json({ ok: true, number: num, author, path, commented: true }, { status: 201, headers: CORS });
}

/* ---------------- MERGE ---------------- */

export async function handlePullMerge(request, env, repoId, num) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405, headers: CORS });
  await ensureCollabTables(env);
  const repo = await getRepo(env, repoId);
  const p = await env.bsl_stats.prepare('SELECT * FROM repo_prs WHERE repo = ? AND number = ?').bind(repoId, num).first();
  if (!p) return Response.json({ ok: false, error: 'Pull Request unbekannt' }, { status: 404, headers: CORS });
  if (p.status === 'merged') return Response.json({ ok: true, number: num, status: 'merged', already: true, merged_commit: p.merged_commit }, { headers: CORS });
  if (['closed', 'rejected'].includes(p.status)) return Response.json({ ok: false, error: `PR ist ${p.status}` }, { status: 409, headers: CORS });
  let b = {}; try { b = await request.json(); } catch { /* ok */ }
  const key = extractKey(request, b);
  if (!(await isOwner(repo, key))) {
    return Response.json({ ok: false, error: 'Merge nur durch den Repo-Inhaber (x-repo-key) — ein PR bleibt ein Vorschlag bis zur autorisierten Merge-Aktion' }, { status: 403, headers: CORS });
  }
  const merger = String(b.merger || repo.owner || 'owner').slice(0, 80);
  const message = String(b.message || `Merge PR #${num}: ${p.title}`).slice(0, 300);
  const ts = Math.floor(Date.now() / 1000);

  const targetBranch = await getBranch(env, repoId, p.target_branch);
  const sourceBranch = await getBranch(env, repoId, p.source_branch);
  const sourceHead = sourceBranch.head_commit;   // Branch-Stand folgen (wie GitHub)
  const targetHead = targetBranch.head_commit;

  if (p.status === 'conflict' && !b.resolutions) {
    return Response.json({ ok: false, error: 'PR hat Konflikte — erst aufloesen: POST .../pulls/' + num + '/merge {resolutions: {pfad: inhalt}}', conflicts: JSON.parse(p.conflicts || '[]') }, { status: 409, headers: CORS });
  }

  const baseCommit = await getCommit(env, repoId, p.base_commit);
  const base = treeOf(baseCommit);
  const source = treeOf(await getCommit(env, repoId, sourceHead));
  let target = treeOf(await getCommit(env, repoId, targetHead));
  if (b.resolutions && typeof b.resolutions === 'object') {
    try { target = await buildTreeFromBase(env, repoId, target, b.resolutions); }
    catch (e) { return Response.json({ ok: false, error: e.message }, { status: 400, headers: CORS }); }
  }
  const { merged, conflicts } = diff3(base, source, target);
  // Aufgeloeste Pfade sind das ENDGUELTIGE Ergebnis — sie gelten als gemergt,
  // nicht erneut als Konflikt (sonst koennte eine Aufloesung niemals bestehen).
  const resolvedPaths = new Set(Object.keys(b.resolutions || {}).map((p) => cleanPath(p)));
  const remaining = conflicts.filter((c) => {
    if (resolvedPaths.has(c.path) && target[c.path]) { merged[c.path] = target[c.path]; return false; }
    return true;
  });
  if (remaining.length) {
    await env.bsl_stats.prepare('UPDATE repo_prs SET status = ?, conflicts = ?, updated_at = ? WHERE repo = ? AND number = ?')
      .bind('conflict', JSON.stringify(remaining), ts, repoId, num).run();
    return Response.json({ ok: false, error: 'Merge-Konflikte — Aufloesung erforderlich', conflicts: remaining }, { status: 409, headers: CORS });
  }

  // Fast-Forward nur, wenn das Ziel VORFAHRE der Quelle ist (Git-Semantik):
  // mergeBase(target, source) === targetHead. Der Vergleich mit p.target_commit
  // reicht nicht — Ziel und Quelle können sich seit PR-Eroeffnung beide vom
  // gemeinsamen Basis-Commit entfernt haben; dann MUSS ein Merge-Commit mit
  // zwei Eltern entstehen, sonst geht Ziel-eigener Inhalt verloren.
  const mbNow = await mergeBase(env, repoId, targetHead, sourceHead) || p.base_commit;
  const ff = mbNow === targetHead;
  const parents = ff ? [sourceHead] : [targetHead, sourceHead];
  const finalTree = ff ? source : merged;
  const commitHash = await sha256hexStr(JSON.stringify({ repo: repoId, branch: p.target_branch, parents, tree: finalTree, author: merger, message, ts, merge: num }));
  const chainSeq = await anchor(env, ff ? 'merged_ff' : 'merged', repoId, { pr: num, into: p.target_branch, commit: commitHash.slice(0, 16), by: merger });
  await env.bsl_stats.prepare(
    `INSERT INTO repo_commits (repo, commit_hash, branch, parents, tree, author, message, ts, chain_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(repoId, commitHash, p.target_branch, JSON.stringify(parents), JSON.stringify(finalTree), merger, message, ts, chainSeq).run();
  await env.bsl_stats.prepare('UPDATE repo_branches SET head_commit = ? WHERE repo = ? AND name = ?').bind(commitHash, repoId, p.target_branch).run();

  // Hauptansicht (repo_files) synchron fuehren — nur auf main, keine Loeschungen.
  if (p.target_branch === MAIN) {
    for (const [path2, entry] of Object.entries(finalTree)) {
      const prev = await env.bsl_stats.prepare(
        'SELECT version, sha256 FROM repo_files WHERE repo = ? AND path = ? ORDER BY version DESC LIMIT 1').bind(repoId, path2).first();
      if (prev && prev.sha256 === entry.sha256) continue;
      await env.bsl_stats.prepare(
        `INSERT INTO repo_files (repo, path, version, cid, sha256, size, prev_version, prev_sha256, message, author, ts, chain_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(repoId, path2, (prev?.version || 0) + 1, entry.cid, entry.sha256, entry.size,
          prev?.version || null, prev?.sha256 || null, message, merger, ts, chainSeq).run();
    }
  }

  await env.bsl_stats.prepare(
    `UPDATE repo_prs SET status = 'merged', merged_commit = ?, merge_chain_seq = ?, source_commit = ?, updated_at = ?, conflicts = NULL WHERE repo = ? AND number = ?`)
    .bind(commitHash, chainSeq, sourceHead, ts, repoId, num).run();

  return Response.json({
    ok: true, number: num, status: 'merged', fast_forward: ff,
    merged_commit: commitHash, parents,
    target_branch: p.target_branch, new_head: commitHash,
    chain_seq: chainSeq,
    chain: chainSeq ? `${BASE}/api/future-chain.json?seq=${chainSeq}` : null,
    provenance: 'Merge-Commit mit zwei Eltern — zwei Entwicklungslinien sind verbunden, nicht ersetzt. Die volle Historie bleibt verifizierbar.',
  }, { headers: CORS });
}

/* ---------------- COMPARE ---------------- */

export async function handleCompare(env, repoId, baseRef, headRef) {
  await ensureCollabTables(env);
  await ensureMainBranch(env, repoId);
  let baseC, headC;
  if (baseRef.length === 64) baseC = await getCommit(env, repoId, baseRef);
  if (!baseC) { const br = await getBranch(env, repoId, baseRef); if (br) baseC = await getCommit(env, repoId, br.head_commit); }
  if (headRef.length === 64) headC = await getCommit(env, repoId, headRef);
  if (!headC) { const br = await getBranch(env, repoId, headRef); if (br) headC = await getCommit(env, repoId, br.head_commit); }
  if (!baseC || !headC) return Response.json({ ok: false, error: 'base/head unbekannt (Branch oder Commit-Hash)' }, { status: 404, headers: CORS });
  const base = treeOf(baseC), head = treeOf(headC);
  const paths = new Set([...Object.keys(base), ...Object.keys(head)]);
  const files = [];
  for (const p of paths) {
    const b = base[p]?.sha256 || null, h = head[p]?.sha256 || null;
    if (b === h) continue;
    files.push({
      path: p, status: !b ? 'added' : (!h ? 'removed' : 'modified'),
      base_sha256: b, head_sha256: h, head_cid: head[p]?.cid || null,
      head_raw: head[p] ? `${BASE}/api/repos/${repoId}/raw/${headC.commit_hash}/${p}` : null,
    });
  }
  return Response.json({
    ok: true, repo: repoId, base: baseRef, head: headRef,
    base_commit: baseC.commit_hash, head_commit: headC.commit_hash,
    files,
    ahead_hint: 'Vergleich auf Dateiebene — Inhalte via raw-Links oder commits/{hash}.',
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}
