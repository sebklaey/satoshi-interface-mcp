/* BSL SECURITY — Härtungs-Layer: Security Headers, D1-Rate-Limiting,
   Privacy-Pseudonymisierung. Ein Ort, damit alles nachvollziehbar bleibt.

   Grundsätze:
   - Rate-Limits sind Missbrauchsschutz, keine Zensur: IP wird NIE gespeichert,
     nur ein transienter SHA-256(ip + bucket + zeitfenster) als Zähler.
   - Security Headers werden zentral in index.js mit withSec() auf JEDE
     Worker-Antwort gesetzt (API + MCP inklusive) — nichts fällt durchs Raster.
   - Pseudonymisierung kürzt/kettet identifizierende Details, bevor sie in D1
     landen (vollständiger UA, Referer-Query-Strings). */

const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/* Ergänzt eine bestehende Response um Sicherheits-Header (bereits gesetzte
   werden nicht überschrieben). */
export function withSec(response) {
  try {
    const h = new Headers(response.headers);
    for (const [k, v] of Object.entries(SEC)) if (!h.has(k)) h.set(k, v);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
  } catch {
    return response;
  }
}

/* IP nur transient für den Zähler — niemals persistieren. */
export function clientIp(request) {
  return (request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || '0.0.0.0').slice(0, 45);
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let rateTableReady = false;

/* Gleitendes Fenster in D1: pro IP+Bucket+Zeitfenster ein Hash-Zähler.
   Bei Übertretung 429 mit Retry-After. Schlägt D1 fehl, wird durchgelassen —
   Verfügbarkeit geht vor Blockade. */
export async function rateLimit(request, env, bucket, limit, windowSec = 10) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const w = Math.floor(now / windowSec);
    if (!rateTableReady) {
      await env.bsl_stats.prepare('CREATE TABLE IF NOT EXISTS rate_limits (k TEXT PRIMARY KEY, n INTEGER, exp INTEGER)').run();
      rateTableReady = true;
    }
    const key = (await sha256hex(`${clientIp(request)}:${bucket}:${w}`)).slice(0, 32);
    await env.bsl_stats.prepare(
      'INSERT INTO rate_limits (k, n, exp) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1')
      .bind(key, now + windowSec * 2).run();
    const row = await env.bsl_stats.prepare('SELECT n, exp FROM rate_limits WHERE k = ?').bind(key).first();
    if (row && row.n > limit) {
      // Opportunistische Bereinigung abgelaufener Zähler (einmal pro Übertretung).
      if (row.n === limit + 1) {
        env.bsl_stats.prepare('DELETE FROM rate_limits WHERE exp < ?').bind(now).run().catch(() => {});
      }
      return { allowed: false, retryAfter: Math.max(1, (row.exp || now + windowSec) - now) };
    }
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}

/* Pseudonymisierung: voller UA → Browser-Familie (prägnant) + kurzer Hash als
   Trenn-Merkmal. Detailgrad der Versionen/Build-Strings geht verloren — Absicht. */
export function pseudoUa(ua) {
  const raw = String(ua || '').slice(0, 300);
  if (!raw) return '';
  const family = raw.split(/[\/;()]/)[0].trim().slice(0, 32) || raw.slice(0, 32);
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  return `${family} #${(h >>> 0).toString(16).slice(0, 6)}`;
}

/* Referer-Query-Strings können fremde Tokens enthalten — niemals speichern. */
export function cleanReferer(ref) {
  const r = String(ref || '');
  if (!r) return '';
  try {
    const u = new URL(r);
    return (u.origin + u.pathname).slice(0, 160);
  } catch {
    return r.split(/[?#]/)[0].slice(0, 160);
  }
}
