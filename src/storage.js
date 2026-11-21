/* BSL STORAGE — freier Datenspeicher auf unserem eigenen IPFS (Kubo-Knoten).
   Upload: Bytes gehen an Pinata (pinFileToIPFS — sofort weltweit abrufbar),
   unser Pin-Daemon spiegelt sie danach physisch auf den eigenen Kubo-Knoten
   (Pull-Design, kein eingehender Port noetig). Download: oeffentliche
   Gateways. Die SHA-256-Pruefsumme liegt in der Datenbank — jeder kann
   Bytes → SHA-256 nachrechnen, die Integritaet ist unabhaengig pruefbar.

   Ehrliche Grenzen (statt falschem "unbegrenzt"): 8 MB pro Datei,
   200 MB pro Tag, 900 MB gesamt (Pinata-Free 1 GB als Eingangspuffer —
   der eigene Kubo-Knoten hat kein Software-Limit, nur die Festplatte). */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MAX_FILE = 8 * 1024 * 1024;        // 8 MB Rohdaten pro Datei
const MAX_B64 = Math.ceil(MAX_FILE / 3) * 4 + 64;
const DAY_CAP = 200 * 1024 * 1024;       // Missbrauchs-Schutz
const TOTAL_CAP = 900 * 1024 * 1024;     // Pinata-Free-Puffer

const PINATA_GW = 'https://gateway.pinata.cloud/ipfs';

let migrated = null;
function ensureStorageTable(env) {
  if (!migrated) {
    migrated = (async () => {
      await env.bsl_stats.prepare(
        `CREATE TABLE IF NOT EXISTS storage_files (
           cid TEXT PRIMARY KEY,
           name TEXT,
           size INTEGER NOT NULL,
           mime TEXT,
           sha256 TEXT NOT NULL,
           uploader TEXT,
           created_at INTEGER NOT NULL,
           pinata INTEGER NOT NULL DEFAULT 0,
           pinned_local INTEGER NOT NULL DEFAULT 0)`).run();
    })();
  }
  return migrated;
}

function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* POST /api/storage/upload — {name?, data_base64, mime?, uploader?} → {ok, cid, …}
   Oeffentlich und gratis. Groesse/Schutzkappen siehe Kopf. */
export async function handleStorageUpload(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'POST only — JSON {name?, data_base64, mime?, uploader?}' }, { status: 405, headers: CORS });
  }
  if (!env.PINATA_JWT) {
    return Response.json({ ok: false, error: 'Speicher-Eingang nicht konfiguriert (PINATA_JWT fehlt)' }, { status: 503, headers: CORS });
  }
  let b = {};
  try { b = await request.json(); } catch { /* unten 400 */ }
  const b64 = String(b.data_base64 || '');
  if (!b64 || b64.length > MAX_B64) {
    return Response.json({ ok: false, error: `data_base64 fehlt oder zu gross (max. ${MAX_FILE / 1048576} MB Rohdaten)` }, { status: 413, headers: CORS });
  }
  let bytes;
  try { bytes = b64ToBytes(b64); } catch {
    return Response.json({ ok: false, error: 'data_base64 ist kein gueltiges Base64' }, { status: 400, headers: CORS });
  }
  if (!bytes.length || bytes.length > MAX_FILE) {
    return Response.json({ ok: false, error: `Datei leer oder groesser als ${MAX_FILE / 1048576} MB` }, { status: 413, headers: CORS });
  }
  const name = String(b.name || 'datei').slice(0, 180).replace(/[\r\n/\\]/g, '_');
  const mime = String(b.mime || 'application/octet-stream').slice(0, 100);
  const uploader = String(b.uploader || 'anonymous').slice(0, 80);
  const stored = await storeBytes(env, bytes, { name, mime, uploader });
  if (!stored.ok) {
    return Response.json(
      { ok: false, error: stored.error, ...(stored.detail ? { detail: stored.detail } : {}) },
      { status: stored.status || 500, headers: CORS });
  }
  return Response.json({
    ok: true, cid: stored.cid, size: bytes.length, sha256: stored.sha256, name, mime,
    ...(stored.deduped ? { deduped: true } : {}),
    pinned_local: stored.pinned_local,
    ...(stored.deduped ? {} : { hinweis: 'Sofort weltweit abrufbar; unser eigener Kubo-Knoten spiegelt die Datei innert Minuten physisch (pinned_local). Integritaet: Bytes → SHA-256 nachrechnen.' }),
    download: `https://satoshi-interface.com/api/storage/download/${stored.cid}`,
    gateways: gateways(stored.cid, name),
  }, { headers: CORS });
}

/* Interner Helfer: Bytes content-addressiert ablegen — Schutzkappen, Dedupe,
   Pinata-Eingang, storage_files-Eintrag. Wird auch vom Repo-Layer (repos.js)
   benutzt. Rueckgabe: {ok:true, cid, sha256, size, deduped, pinned_local}
   oder {ok:false, status, error, detail?}. */
export async function storeBytes(env, bytes, { name = 'datei', mime = 'application/octet-stream', uploader = 'anonymous' } = {}) {
  await ensureStorageTable(env);

  // Schutzkappen (Missbrauch) — der eigene Knoten selbst hat kein Software-Limit.
  const dayStart = Math.floor(Date.now() / 1000) - 86400;
  const usage = await env.bsl_stats.prepare(
    `SELECT COALESCE(SUM(size),0) AS total,
            COALESCE(SUM(CASE WHEN created_at >= ? THEN size ELSE 0 END),0) AS today
     FROM storage_files`).bind(dayStart).first();
  if ((usage?.total || 0) + bytes.length > TOTAL_CAP || (usage?.today || 0) + bytes.length > DAY_CAP) {
    return { ok: false, status: 429, error: 'Tages-/Gesamtkapazitaet des Gratis-Speichers erreicht — morgen wieder frei' };
  }

  const sha256 = await sha256hex(bytes);

  // Dedupe: dieselben Bytes schon da? → bestehende CID zurueck (content-addressiert).
  const dup = await env.bsl_stats.prepare(
    'SELECT cid, pinned_local FROM storage_files WHERE sha256 = ? AND size = ?').bind(sha256, bytes.length).first();
  if (dup) {
    return { ok: true, cid: dup.cid, sha256, size: bytes.length, deduped: true, pinned_local: !!dup.pinned_local };
  }

  // Eingang ueber Pinata (weltweit sofort abrufbar); eigener Kubo spiegelt nach.
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), name);
  form.append('pinataMetadata', JSON.stringify({ name: `bsl-storage/${name}`, keyvalues: { sha256, uploader } }));
  const up = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.PINATA_JWT}` },
    body: form,
  });
  if (!up.ok) {
    const detail = (await up.text()).slice(0, 200);
    return { ok: false, status: 502, error: `IPFS-Eingang fehlgeschlagen (${up.status})`, detail };
  }
  const cid = String((await up.json().catch(() => ({}))).IpfsHash || '');
  if (!cid) return { ok: false, status: 502, error: 'IPFS-Eingang ohne CID' };

  await env.bsl_stats.prepare(
    `INSERT INTO storage_files (cid, name, size, mime, sha256, uploader, created_at, pinata, pinned_local)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`)
    .bind(cid, name, bytes.length, mime, sha256, uploader, Math.floor(Date.now() / 1000))
    .run();

  return { ok: true, cid, sha256, size: bytes.length, deduped: false, pinned_local: false };
}

export function gateways(cid, name) {
  const p = name ? `/${encodeURIComponent(name)}` : '';
  return [
    `https://satoshi-interface.com/api/storage/download/${cid}`,
    `${PINATA_GW}/${cid}${p}`,
    `https://ipfs.io/ipfs/${cid}${p}`,
    `https://dweb.link/ipfs/${cid}${p}`,
  ];
}

/* GET /api/storage/download/{cid}[?json=1] — 302 auf ein oeffentliches Gateway
   (Pinata: sofort; unser eigener Knoten kuendigt im DHT, sobald gespiegelt). */
export async function handleStorageDownload(request, env, cid) {
  await ensureStorageTable(env);
  cid = String(cid || '').slice(0, 100);
  const row = await env.bsl_stats.prepare(
    'SELECT cid, name, size, mime, sha256, uploader, created_at, pinata, pinned_local FROM storage_files WHERE cid = ?').bind(cid).first();
  if (!row) return Response.json({ ok: false, error: 'CID unbekannt — nicht in diesem Speicher' }, { status: 404, headers: CORS });
  const url = new URL(request.url);
  if (url.searchParams.get('json') === '1') {
    return Response.json({ ok: true, ...row, pinned_local: !!row.pinned_local, pinata: !!row.pinata, gateways: gateways(row.cid, row.name) }, { headers: CORS });
  }
  const p = row.name ? `/${encodeURIComponent(row.name)}` : '';
  return new Response(null, {
    status: 302,
    headers: { ...CORS, Location: `${PINATA_GW}/${row.cid}${p}` },
  });
}

/* GET /api/storage/list.json — oeffentliches Verzeichnis des freien Speichers. */
export async function handleStorageList(env) {
  await ensureStorageTable(env);
  const rows = await env.bsl_stats.prepare(
    `SELECT cid, name, size, mime, sha256, uploader, created_at, pinata, pinned_local
     FROM storage_files ORDER BY created_at DESC LIMIT 200`).all();
  const usage = await env.bsl_stats.prepare(
    'SELECT COALESCE(SUM(size),0) AS total, COUNT(*) AS files FROM storage_files').first();
  return Response.json({
    ok: true,
    files: (rows.results || []).map((r) => ({
      ...r, pinata: !!r.pinata, pinned_local: !!r.pinned_local,
      download: `https://satoshi-interface.com/api/storage/download/${r.cid}`,
    })),
    usage: { files: usage?.files || 0, bytes: usage?.total || 0, cap_bytes: TOTAL_CAP, per_file_max: MAX_FILE, per_day_cap: DAY_CAP },
    upload: 'POST /api/storage/upload {name?, data_base64, mime?, uploader?} — oeffentlich, gratis, eigener IPFS-Knoten',
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* GET /api/storage/unpinned.json — Pull-Queue fuer den eigenen Pin-Daemon. */
export async function handleStorageUnpinned(env) {
  await ensureStorageTable(env);
  const rows = await env.bsl_stats.prepare(
    `SELECT cid, name, size, sha256 FROM storage_files
     WHERE pinned_local = 0 ORDER BY created_at ASC LIMIT 100`).all();
  return Response.json({
    ok: true,
    count: (rows.results || []).length,
    entries: (rows.results || []).map((r) => ({
      ...r, fetch: `${PINATA_GW}/${r.cid}${r.name ? `/${encodeURIComponent(r.name)}` : ''}`,
    })),
    confirm: 'POST /api/storage/pinned {cid, token} — nach ipfs pin add',
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* POST /api/storage/pinned — Daemon bestaetigt das physische Pinning auf dem
   eigenen Kubo. Geschuetzt durch IPFS_CONFIRM_TOKEN (wie die Kette). */
export async function handleStoragePinnedConfirm(request, env) {
  if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405, headers: CORS });
  let b = {};
  try { b = await request.json(); } catch { /* unten 403/400 */ }
  if (!env.IPFS_CONFIRM_TOKEN || b.token !== env.IPFS_CONFIRM_TOKEN) {
    return Response.json({ ok: false, error: 'ungueltiger Token' }, { status: 403, headers: CORS });
  }
  const cid = String(b.cid || '').slice(0, 100);
  if (!cid) return Response.json({ ok: false, error: 'cid erforderlich' }, { status: 400, headers: CORS });
  await ensureStorageTable(env);
  const r = await env.bsl_stats.prepare('UPDATE storage_files SET pinned_local = 1 WHERE cid = ?').bind(cid).run();
  if (!r.meta?.changes) return Response.json({ ok: false, error: 'CID unbekannt' }, { status: 404, headers: CORS });
  return Response.json({ ok: true, cid, pinned_local: true }, { headers: CORS });
}
