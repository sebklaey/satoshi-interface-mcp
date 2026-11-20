#!/usr/bin/env node
/* pin-app.mjs — die gesamte Beyond-Shadows'-Light-App auf IPFS spiegeln.
   Doppel-Anker: eigener Kubo-Knoten + Pinata (weltweit erreichbar).
   Nach jedem App-Deploy ausfuehren:  node pin-app.mjs
   Die Domains (satoshi-interface.com, openos.space, littleking.live) bleiben
   unberuehrt — IPFS ist der dezentrale Zwilling, kein Ersatz. */

import fs from 'node:fs';
import path from 'node:path';

const DIST = new URL('../app/dist', import.meta.url).pathname;
const KUBO = process.env.KUBO_API || 'http://127.0.0.1:5001';
const JWT = process.env.PINATA_JWT || '';

const files = [];
(function walk(d, rel = '') {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f), r = rel ? rel + '/' + f : f;
    if (fs.statSync(p).isDirectory()) walk(p, r); else files.push([p, r]);
  }
})(DIST);

const build = (prefix) => {
  const form = new FormData();
  for (const [p, r] of files) form.append('file', new Blob([fs.readFileSync(p)]), prefix + r);
  return form;
};

// 1. Eigener Kubo-Knoten
const kRes = await fetch(`${KUBO}/api/v0/add?recursive=true&cid-version=1&pin=true&wrap-with-directory=true`, {
  method: 'POST', body: build(''),
});
const kLines = (await kRes.text()).trim().split('\n').map((l) => JSON.parse(l));
const kuboCid = kLines[kLines.length - 1].Hash;
console.log(`KUBO   : ${files.length} Dateien → ${kuboCid}`);
console.log(`         http://127.0.0.1:8080/ipfs/${kuboCid}/`);

// 2. Pinata (weltweit erreichbar)
if (JWT) {
  const form = build('bsl-app/');
  form.append('pinataMetadata', JSON.stringify({ name: 'beyond-shadows-light-app' }));
  form.append('pinataOptions', JSON.stringify({ cidVersion: 1, wrapWithDirectory: true }));
  const pRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST', headers: { Authorization: `Bearer ${JWT}` }, body: form,
  });
  const j = await pRes.json().catch(() => ({}));
  if (pRes.ok && j.IpfsHash) {
    console.log(`PINATA : ${files.length} Dateien → ${j.IpfsHash}`);
    console.log(`         https://ipfs.io/ipfs/${j.IpfsHash}/`);
  } else {
    console.error('PINATA :', pRes.status, JSON.stringify(j).slice(0, 200));
  }
} else {
  console.log('PINATA : uebersprungen (PINATA_JWT fehlt)');
}
