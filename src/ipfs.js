/* Dezentrale Spiegelschicht der BSL-FUTURE-CHAIN auf IPFS.

   HAERTESTER GRUNDSATZ: Die kryptografische Identitaet eines Eintrags
   (prev_hash, entry_hash, signature) wird durch den Speicherort NIEMALS
   veraendert. IPFS speichert nur — die Identitaet kommt aus der Kette selbst:

     entry_hash = SHA256(prev_hash | ts | ai | SHA256(prompt) | SHA256(response))
     signature  = secp256k1( SHA256("BSL-FUTURE-CHAIN v1\n" + entry_hash) )

   Die CID ist bloss eine Adresse. Das kanonische Dokument enthaelt die
   signierten Felder BYTEIDENTISCH — plus prev_cid, damit die Kette auch
   rein auf IPFS vom Kopf bis zur Genesis durchlaufbar ist. */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const enc = new TextEncoder();

async function sha256bytes(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/* Base32 (RFC 4648, lower-case, ohne Padding) — fuer CIDv1 base32 */
function base32lower(bytes) {
  const abc = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += abc[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += abc[(value << (5 - bits)) & 31];
  return out;
}

/* CIDv1 (raw codec 0x55, multihash sha2-256) — deterministisch aus den Bytes.
   Dieselben Bytes ergeben fuer immer dieselbe CID, unabhaengig vom Pin-Dienst. */
export async function cidForBytes(bytes) {
  const digest = await sha256bytes(bytes);
  const cid = new Uint8Array(2 + 2 + digest.length);
  cid[0] = 0x01;       // CID-Version 1
  cid[1] = 0x55;       // raw codec
  cid[2] = 0x12;       // multihash: sha2-256
  cid[3] = 0x20;       // 32 Bytes
  cid.set(digest, 4);
  return 'b' + base32lower(cid);
}

/* Kanonisches Dokument — feste Schluesselreihenfolge, kompaktes JSON.
   NUR die signierte Identitaet + Rohtext + Verknuepfung.
   kind/horizon/meta sind bewusst NICHT Teil davon (sie sind nicht gehasht)
   und bleiben Index-Metadaten in D1. */
export function canonicalDoc(entry, prevCid) {
  const doc = {
    chain: 'BSL-FUTURE-CHAIN',
    protocol: 'v1',
    seq: entry.seq,
    ts: entry.ts,
    ai: entry.ai,
    prompt: entry.prompt,
    prompt_hash: entry.prompt_hash,
    response: entry.response,
    response_hash: entry.response_hash,
    prev_hash: entry.prev_hash,
    entry_hash: entry.entry_hash,
    signature: entry.signature,
    prev_cid: prevCid || null,
  };
  return enc.encode(JSON.stringify(doc));
}

export const ipfsGateways = (cid) => [
  `https://ipfs.io/ipfs/${cid}`,
  `https://dweb.link/ipfs/${cid}`,
];

/* Pin-Dienst-Adapter — Pinata-kompatibel (pinFileToIPFS) ODER Kubo (/api/v0/add).
   Konfiguration per Worker-Secrets:
     IPFS_PIN_URL   z. B. https://api.pinata.cloud/pinning/pinFileToIPFS
                    oder http://<eigener-kubo>:5001/api/v0/add
     IPFS_PIN_TOKEN Bearer-Token / JWT des Dienstes
   Ohne Konfiguration: CID wird trotzdem lokal bestimmt (deterministisch),
   Status "pending" — der Cron-Backfill pinnt nach, sobald der Dienst gesetzt ist. */
async function pinBytes(env, cid, bytes, name) {
  if (!env.IPFS_PIN_URL) return { pinned: false, reason: 'IPFS_PIN_URL nicht konfiguriert' };
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/json' }), name);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(env.IPFS_PIN_URL, {
      method: 'POST',
      headers: env.IPFS_PIN_TOKEN ? { Authorization: `Bearer ${env.IPFS_PIN_TOKEN}` } : {},
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) return { pinned: false, reason: `pin ${res.status}` };
    const j = await res.json().catch(() => ({}));
    const remoteCid = j.IpfsHash || j.Hash || null;
    // Der Dienst darf eine abweichende CID liefern (z. B. dag-json statt raw).
    // Massgeblich ist unsere lokale raw-CID — die Bytes sind identisch.
    return { pinned: true, remoteCid };
  } catch (e) {
    return { pinned: false, reason: String(e && e.name === 'AbortError' ? 'pin timeout' : e && e.message || e).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/* Einen Ketten-Eintrag auf IPFS spiegeln. Idempotent: CID bereits gesetzt → no-op.
   Gibt { cid, pinned, ... } zurueck und traegt die CID in D1 nach (Index-Spalte,
   NICHT Teil des Hashes). Aktualisiert den IPFS-Kopf (head) fuer die Traversierung. */
export async function pinEntry(env, entry) {
  if (entry.ipfs_cid) return { cid: entry.ipfs_cid, pinned: true, cached: true };
  const prev = entry.seq > 1
    ? await env.bsl_stats.prepare('SELECT ipfs_cid FROM future_chain WHERE seq = ?').bind(entry.seq - 1).first()
    : null;
  const bytes = canonicalDoc(entry, prev?.ipfs_cid || null);
  const cid = await cidForBytes(bytes);
  const pin = await pinBytes(env, cid, bytes, `bsl-chain-${String(entry.seq).padStart(6, '0')}.json`);
  // Den zum Pin-Zeitpunkt verwendeten prev_cid dauerhaft speichern — das
  // kanonische Dokument bleibt dadurch fuer immer reproduzierbar, auch wenn
  // der Vorgaenger erst spaeter gespiegelt wird. (Identitaet: unveraenderbar.)
  try { await env.bsl_stats.prepare(`ALTER TABLE future_chain ADD COLUMN ipfs_prev_cid TEXT`).run(); } catch { /* existiert */ }
  try { await env.bsl_stats.prepare(`ALTER TABLE future_chain ADD COLUMN ipfs_pinned INTEGER`).run(); } catch { /* existiert */ }
  await env.bsl_stats.prepare('UPDATE future_chain SET ipfs_cid = ?, ipfs_prev_cid = ?, ipfs_pinned = ? WHERE seq = ?')
    .bind(cid, prev?.ipfs_cid || null, pin.pinned ? 1 : 0, entry.seq).run();
  await env.bsl_stats.prepare(
    `INSERT OR REPLACE INTO counters (key, value) VALUES ('ipfs_head', ?)`)
    .bind(JSON.stringify({ seq: entry.seq, entry_hash: entry.entry_hash, cid, pinned: !!pin.pinned, at: entry.ts }))
    .run();
  return { cid, pinned: !!pin.pinned, reason: pin.reason || null };
}

/* Cron-Backfill: aelteste ungespiegelte Eintraege nachpinnt (kleine Baendchen). */
export async function pinBackfill(env, limit = 12) {
  try { await env.bsl_stats.prepare(`ALTER TABLE future_chain ADD COLUMN ipfs_cid TEXT`).run(); } catch { /* existiert */ }
  try { await env.bsl_stats.prepare(`ALTER TABLE future_chain ADD COLUMN ipfs_prev_cid TEXT`).run(); } catch { /* existiert */ }
  const rows = await env.bsl_stats.prepare(
    `SELECT seq, ts, ai, prompt, response, prompt_hash, response_hash, prev_hash, entry_hash, signature, ipfs_cid
     FROM future_chain WHERE ipfs_cid IS NULL ORDER BY seq ASC LIMIT ?`).bind(limit).all();
  let done = 0;
  for (const r of rows.results || []) {
    try { await pinEntry(env, r); done++; } catch { /* naechster Lauf */ }
  }
  return { attempted: (rows.results || []).length, done };
}

/* GET /api/future-chain/ipfs.json?seq=N — das kanonische IPFS-Dokument eines
   Eintrags samt CID, Gateways und der vollstaendigen Offline-Verifikation. */
export async function handleIpfsDoc(request, env) {
  const url = new URL(request.url);
  const seq = parseInt(url.searchParams.get('seq') || '', 10);
  if (!seq) {
    return Response.json({ ok: false, error: 'seq Parameter erforderlich', usage: 'GET /api/future-chain/ipfs.json?seq=1' },
      { status: 400, headers: CORS });
  }
  try { await env.bsl_stats.prepare(`ALTER TABLE future_chain ADD COLUMN ipfs_cid TEXT`).run(); } catch { /* ok */ }
  try { await env.bsl_stats.prepare(`ALTER TABLE future_chain ADD COLUMN ipfs_prev_cid TEXT`).run(); } catch { /* ok */ }
  const r = await env.bsl_stats.prepare(
    `SELECT seq, ts, ai, prompt, response, prompt_hash, response_hash, prev_hash, entry_hash, signature, ipfs_cid, ipfs_prev_cid
     FROM future_chain WHERE seq = ?`).bind(seq).first();
  if (!r) return Response.json({ ok: false, error: `Eintrag ${seq} nicht gefunden` }, { status: 404, headers: CORS });
  // Determinismus-Garantie: War der Eintrag bereits gespiegelt, gilt der zum
  // Pin-Zeitpunkt verwendete prev_cid — das Dokument ist byteidentisch reproduzierbar.
  let prevCid = r.ipfs_prev_cid || null;
  if (!r.ipfs_cid && !prevCid && seq > 1) {
    const prev = await env.bsl_stats.prepare('SELECT ipfs_cid FROM future_chain WHERE seq = ?').bind(seq - 1).first();
    prevCid = prev?.ipfs_cid || null;
  }
  const bytes = canonicalDoc(r, prevCid);
  const cid = await cidForBytes(bytes);
  if (url.searchParams.get('raw') === '1') {
    return new Response(bytes, { headers: { ...CORS, 'Content-Type': 'application/json',
      'X-IPFS-CID': cid, 'Cache-Control': 'public, max-age=31536000, immutable' } });
  }
  const head = await env.bsl_stats.prepare(`SELECT value FROM counters WHERE key = 'ipfs_head'`).first().catch(() => null);
  return Response.json({
    ok: true,
    principle: 'Der Speicherort aendert die kryptografische Identitaet NIE. entry_hash und signature sind byteidentisch aus der Kette uebernommen — die CID ist nur eine Adresse.',
    cid,
    cidPinnedAs: r.ipfs_cid || null,
    gateways: ipfsGateways(cid),
    document: JSON.parse(new TextDecoder().decode(bytes)),
    ipfsHead: head?.value ? JSON.parse(head.value) : null,
    offlineVerification: {
      step1: 'Dokument von einem Gateway laden (beliebiges — dezentral).',
      step2: 'entry_hash nachrechnen: SHA256(prev_hash | ts | ai | SHA256(prompt) | SHA256(response)) — muss document.entry_hash exakt treffen.',
      step3: 'digest = SHA256("BSL-FUTURE-CHAIN v1\\n" + entry_hash); secp256k1.verify(signature, digest, pubkey). Pubkey: GET /api/future-chain.json (wallet).',
      step4: 'Kette auf IPFS durchlaufen: document.prev_cid → naechstaelterer Eintrag — bis prev_hash = Genesis und prev_cid = null.',
    },
  }, { headers: { ...CORS, 'Cache-Control': 'public, max-age=31536000, immutable' } });
}

/* GET /api/future-chain/unpinned.json — vom eigenen Kubo-Pin-Daemon abgefragt:
   Eintraege mit bekannter CID, die noch nicht physisch auf IPFS liegen. */
export async function handleUnpinned(request, env) {
  try { await env.bsl_stats.prepare(`ALTER TABLE future_chain ADD COLUMN ipfs_pinned INTEGER`).run(); } catch { /* ok */ }
  const rows = await env.bsl_stats.prepare(
    `SELECT seq, ipfs_cid FROM future_chain
     WHERE ipfs_cid IS NOT NULL AND (ipfs_pinned IS NULL OR ipfs_pinned = 0)
     ORDER BY seq ASC LIMIT 200`).all();
  return Response.json({
    ok: true,
    count: (rows.results || []).length,
    entries: (rows.results || []).map((r) => ({
      seq: r.seq, cid: r.ipfs_cid,
      raw: `https://satoshi-interface.com/api/future-chain/ipfs.json?raw=1&seq=${r.seq}`,
    })),
    confirm: 'POST /api/future-chain/pinned {seq, cid, token} — nach erfolgreichem ipfs add + pin',
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* POST /api/future-chain/pinned — der Pin-Daemon bestaetigt das physische Pinning.
   Geschuetzt durch das Worker-Secret IPFS_CONFIRM_TOKEN. Die CID muss exakt der
   gespeicherten entsprechen — die Identitaet bleibt unantastbar. */
export async function handlePinnedConfirm(request, env) {
  if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405, headers: CORS });
  let b = {};
  try { b = await request.json(); } catch { /* unten 400 */ }
  if (!env.IPFS_CONFIRM_TOKEN || b.token !== env.IPFS_CONFIRM_TOKEN) {
    return Response.json({ ok: false, error: 'ungueltiger Token' }, { status: 403, headers: CORS });
  }
  const seq = parseInt(b.seq, 10);
  const cid = String(b.cid || '').slice(0, 100);
  if (!seq || !cid) return Response.json({ ok: false, error: 'seq und cid erforderlich' }, { status: 400, headers: CORS });
  const row = await env.bsl_stats.prepare('SELECT ipfs_cid FROM future_chain WHERE seq = ?').bind(seq).first();
  if (!row || row.ipfs_cid !== cid) {
    return Response.json({ ok: false, error: 'CID stimmt nicht mit der Kette ueberein — Identitaet unantastbar' }, { status: 409, headers: CORS });
  }
  await env.bsl_stats.prepare('UPDATE future_chain SET ipfs_pinned = 1 WHERE seq = ?').bind(seq).run();
  return Response.json({ ok: true, seq, cid, pinned: true }, { headers: CORS });
}

/* Eigener HTTPS-Gateway: /ipfs/{cid} — liefert die exakten kanonischen Bytes
   zu jeder bekannten CID, weltweit abrufbar, content-addressiert.
   Ueberbrueckt die DHT-Ausbreitungszeit oeffentlicher Gateways — die
   Verifikation bleibt identisch: Bytes → CID nachrechnen → entry_hash → Signatur. */
export async function handleIpfsGateway(request, env, cid) {
  try { await env.bsl_stats.prepare(`ALTER TABLE future_chain ADD COLUMN ipfs_cid TEXT`).run(); } catch { /* ok */ }
  try { await env.bsl_stats.prepare(`ALTER TABLE future_chain ADD COLUMN ipfs_prev_cid TEXT`).run(); } catch { /* ok */ }
  const r = await env.bsl_stats.prepare(
    `SELECT seq, ts, ai, prompt, response, prompt_hash, response_hash, prev_hash, entry_hash, signature, ipfs_cid, ipfs_prev_cid
     FROM future_chain WHERE ipfs_cid = ?`).bind(String(cid || '').slice(0, 100)).first();
  if (!r) return Response.json({ ok: false, error: 'CID unbekannt — nicht Teil dieser Kette' }, { status: 404, headers: CORS });
  const bytes = canonicalDoc(r, r.ipfs_prev_cid || null);
  const localCid = await cidForBytes(bytes);
  if (localCid !== r.ipfs_cid) {
    return Response.json({ ok: false, error: 'Integritaetsbruch: Bytes ergeben nicht die gespeicherte CID' }, { status: 500, headers: CORS });
  }
  return new Response(bytes, {
    headers: { ...CORS, 'Content-Type': 'application/json', 'X-IPFS-CID': r.ipfs_cid,
               'X-IPFS-Path': `/ipfs/${r.ipfs_cid}`,
               'Cache-Control': 'public, max-age=31536000, immutable' },
  });
}
