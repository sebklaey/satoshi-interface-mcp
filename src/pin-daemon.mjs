#!/usr/bin/env node
/* BSL IPFS Pin-Daemon — unser eigener Pin-Dienst (Pull-Design).
   Holt ungespiegelte Ketten-Eintraege vom Worker, legt die exakten
   kanonischen Bytes in den lokalen Kubo-Knoten (ipfs add --raw-leaves —
   dieselbe CID, Identitaet unantastbar), pinnt sie und bestaetigt
   dem Worker das physische Pinning. Kein eingehender Port noetig. */

const API = process.env.KUBO_API || 'http://127.0.0.1:5001';
const ORIGIN = 'https://satoshi-interface.com';
const TOKEN = process.env.IPFS_CONFIRM_TOKEN || '';
const PINATA_KEY = process.env.PINATA_KEY || '';
const PINATA_SECRET = process.env.PINATA_SECRET || '';
const PINATA_JWT = process.env.PINATA_JWT || '';
const UA = 'BSL-IPFS-Pin-Daemon/1.1 (kubo+pinata, openos)';

if (!TOKEN) { console.error('[pin-daemon] IPFS_CONFIRM_TOKEN fehlt'); process.exit(1); }

async function kuboAdd(bytes, name) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/json' }), name);
  const res = await fetch(`${API}/api/v0/add?cid-version=1&raw-leaves=true&pin=true&quieter=true`, {
    method: 'POST', body: form,
  });
  if (!res.ok) throw new Error(`kubo add ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const j = JSON.parse((await res.text()).trim().split('\n').pop());
  return j.Hash;
}

/* Zweitanker: Pinata per pinByHash — pinnt die EXISTIERENDE raw-CID (die Bytes
   holt Pinata aus dem Netz; unser Kubo kuendigt sie im DHT an). So bleibt die
   CID exakt dieselbe — Identitaet unantastbar. (pinFileToIPFS wuerde die Bytes
   in UnixFS einwickeln und eine ANDERE CID erzeugen — darum nicht.) */
async function pinataPinCid(cid) {
  if (!PINATA_JWT && !(PINATA_KEY && PINATA_SECRET)) return null;
  const headers = {
    'Content-Type': 'application/json',
    ...(PINATA_JWT ? { Authorization: `Bearer ${PINATA_JWT}` }
                   : { pinata_api_key: PINATA_KEY, pinata_secret_api_key: PINATA_SECRET }),
  };
  const res = await fetch('https://api.pinata.cloud/pinning/pinByHash', {
    method: 'POST', headers, body: JSON.stringify({ hashToPin: cid }),
  });
  if (!res.ok) { console.error('[pinata]', res.status, (await res.text()).slice(0, 120)); return null; }
  return (await res.json().catch(() => ({}))).ipfsHash || cid;
}

async function sha256hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* BSL STORAGE: freie Nutzer-Dateien physisch auf den eigenen Kubo spiegeln.
   Eingang war Pinata (weltweit erreichbar) — wir holen die Bytes von dort,
   pruefen SHA-256 (Identitaet), pinnen die CID lokal und bestaetigen. */
async function kuboPin(cid) {
  const res = await fetch(`${API}/api/v0/pin/add?arg=${encodeURIComponent(cid)}`, {
    method: 'POST', signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`kubo pin ${res.status}: ${(await res.text()).slice(0, 120)}`);
}

async function storageCycle() {
  const listRes = await fetch(`${ORIGIN}/api/storage/unpinned.json`, { headers: { 'User-Agent': UA } });
  if (!listRes.ok) throw new Error(`storage unpinned ${listRes.status}`);
  const list = await listRes.json();
  if (!list.count) return;
  let pinned = 0;
  for (const e of list.entries) {
    try {
      // 1. Bytes holen + Integritaet pruefen
      const dl = await fetch(e.fetch, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) });
      if (!dl.ok) { console.error(`storage ${e.cid}: fetch ${dl.status}`); continue; }
      const bytes = await dl.arrayBuffer();
      if (e.sha256 && (await sha256hex(bytes)) !== e.sha256) {
        console.error(`storage ${e.cid}: SHA-256-MISMATCH — uebersprungen`);
        continue;
      }
      // 2. In den eigenen Knoten legen (lokale Kopie der Bytes) + Pinata-CID pinnen
      await kuboAdd(new Uint8Array(bytes), `bsl-storage/${e.name || e.cid}`);
      await kuboPin(e.cid);
      // 3. Bestaetigen
      const conf = await fetch(`${ORIGIN}/api/storage/pinned`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ cid: e.cid, token: TOKEN }),
      });
      const cj = await conf.json();
      if (cj.ok) { pinned++; console.log(`storage gepinnt: ${e.cid} (${e.name || '?'}, ${e.size} B)`); }
      else console.error(`storage ${e.cid}: confirm fehlgeschlagen:`, cj.error);
    } catch (err) {
      console.error(`storage ${e.cid}:`, err.message);
    }
  }
  if (pinned) console.log(`[pin-daemon] ${pinned} Storage-Dateien physisch gepinnt`);
}

async function cycle() {
  const listRes = await fetch(`${ORIGIN}/api/future-chain/unpinned.json`, { headers: { 'User-Agent': UA } });
  if (!listRes.ok) throw new Error(`unpinned ${listRes.status}`);
  const list = await listRes.json();
  if (!list.count) return;
  let pinned = 0;
  for (const e of list.entries) {
    try {
      const raw = await fetch(e.raw, { headers: { 'User-Agent': UA } });
      if (!raw.ok) { console.error(`#${e.seq}: raw ${raw.status}`); continue; }
      const serverCid = raw.headers.get('x-ipfs-cid');
      const bytes = await raw.arrayBuffer();
      const cid = await kuboAdd(bytes, `bsl-chain-${String(e.seq).padStart(6, '0')}.json`);
      if (cid !== e.cid || (serverCid && cid !== serverCid)) {
        console.error(`#${e.seq}: CID-MISMATCH lokal=${cid} kette=${e.cid} — Identitaet verletzt, uebersprungen`);
        continue;
      }
      // Zweitanker Pinata per pinByHash (dieselbe CID — Identitaet unantastbar)
      const pCid = await pinataPinCid(cid);
      if (pCid) console.log(`#${e.seq} bei Pinata angemeldet (pinByHash)`);
      const conf = await fetch(`${ORIGIN}/api/future-chain/pinned`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ seq: e.seq, cid, token: TOKEN }),
      });
      const cj = await conf.json();
      if (cj.ok) { pinned++; console.log(`#${e.seq} gepinnt: ${cid}`); }
      else console.error(`#${e.seq}: confirm fehlgeschlagen:`, cj.error);
    } catch (err) {
      console.error(`#${e.seq}:`, err.message);
    }
  }
  if (pinned) console.log(`[pin-daemon] ${pinned} Eintraege physisch auf IPFS gepinnt`);
}

async function main() {
  console.log('[pin-daemon] gestartet — Kubo:', API);
  for (;;) {
    try { await cycle(); }
    catch (e) { console.error('[pin-daemon]', e.message); }
    try { await storageCycle(); }
    catch (e) { console.error('[pin-daemon storage]', e.message); }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}
main();
