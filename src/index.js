/* bsl-tracker — Tracking + Live-Stats + Übersetzung für satoshi-interface.com
   Aggregations-Design: Jede Anfrage schreibt kleine Upserts (agg_*), Stats liest
   nur Aggregat-Zeilen (~150) statt Voll-Scans — sonst sprengt die 30s-Auto-
   Aktualisierung der /stats-Seite das D1-Free-Tier (5 Mio. Rows-read/Tag). */

const ORIGIN = 'https://satoshi-interface.pages.dev';

import { handleFuturePost, handleFutureGet, handleForecast, handleFutureWriteGet, handleWriteHelp } from './future-chain.js';
import { handleMcp } from './mcp.js';
import { handleSensoricGet, ensureSensoricTable } from './sensoric.js';

const BOT_RULES = [
  // AI-Crawler zuerst (spezifisch vor generisch)
  [/GPTBot|ChatGPT-User|OAI-SearchBot/i, 'GPTBot (OpenAI)', 'ai'],
  [/ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai/i, 'ClaudeBot (Anthropic)', 'ai'],
  [/PerplexityBot|Perplexity-User/i, 'PerplexityBot', 'ai'],
  [/Google-Extended/i, 'Google-Extended (Gemini-Training)', 'ai'],
  [/Gemini-Deep-Research|GoogleAgent|Google-CloudVertexBot/i, 'Google AI', 'ai'],
  [/Applebot-Extended/i, 'Applebot-Extended (Apple AI)', 'ai'],
  [/Meta-ExternalAgent|Meta-ExternalFetcher/i, 'Meta AI', 'ai'],
  [/cohere-ai|cohere-training-data-crawler/i, 'Cohere AI', 'ai'],
  [/MistralAI-User/i, 'Mistral AI', 'ai'],
  [/Bytespider/i, 'Bytespider (ByteDance)', 'ai'],
  [/CCBot/i, 'CCBot (Common Crawl)', 'ai'],
  [/Amazonbot/i, 'Amazonbot (Alexa AI)', 'ai'],
  [/AI2Bot|ai2bot/i, 'AI2Bot (Allen Institute)', 'ai'],
  [/DuckAssistBot/i, 'DuckAssistBot', 'ai'],
  [/xAI-Bot|Grok/i, 'xAI Grok', 'ai'],
  [/DeepSeekBot|Moonshot|KimiBot|Kimi/i, 'Moonshot/Kimi', 'ai'],
  [/YouBot/i, 'YouBot (You.com)', 'ai'],
  // Suchmaschinen
  [/Googlebot|Google-InspectionTool|Googlebot-Image/i, 'Googlebot', 'search'],
  [/bingbot|BingPreview|adidxbot/i, 'Bingbot', 'search'],
  [/YandexBot|YandexImages/i, 'Yandex', 'search'],
  [/DuckDuckBot/i, 'DuckDuckBot', 'search'],
  [/Baiduspider/i, 'Baiduspider', 'search'],
  [/PetalBot/i, 'PetalBot (Huawei)', 'search'],
  // Scanner / Audit
  [/TLM-Audit-Scanner/i, 'TLM-Audit-Scanner', 'scanner'],
  [/Scanner|scan|crawler-?(check|scan)|Audit|probethetic/i, 'Scanner (div.)', 'scanner'],
  [/Shodan|CensysInspect|Censys/i, 'Shodan/Censys', 'scanner'],
  [/Nikto|sqlmap|nmap|masscan|zgrab/i, 'Security-Scanner', 'scanner'],
  // Social / Preview
  [/Twitterbot|X-Bot/i, 'X/Twitter Preview', 'social'],
  [/facebookexternalhit|Facebot/i, 'Facebook Preview', 'social'],
  [/LinkedInBot/i, 'LinkedIn Preview', 'social'],
  [/WhatsApp/i, 'WhatsApp Preview', 'social'],
  [/TelegramBot/i, 'Telegram Preview', 'social'],
  [/Slackbot/i, 'Slack Preview', 'social'],
  [/Discordbot/i, 'Discord Preview', 'social'],
  // Browser
  [/Mozilla|Chrome|Safari|Firefox|Edg\//i, 'Browser (Mensch?)', 'browser'],
];

function classify(ua) {
  if (!ua) return { bot: 'Unbekannt (kein UA)', cat: 'other' };
  for (const [re, name, cat] of BOT_RULES) {
    if (re.test(ua)) return { bot: name, cat };
  }
  if (/bot|spider|crawl|fetch|check|monitor|http|python|curl|wget|axios|node|go-http/i.test(ua))
    return { bot: ua.slice(0, 60), cat: 'other-bot' };
  return { bot: ua.slice(0, 60), cat: 'other' };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const INTERNAL_REFERER = /satoshi-interface\.com|littleking\.live|pages\.dev/i;

/* ---------- Tracking: Detail-Insert + Aggregat-Upserts (wenige Rows pro Request) ---------- */
function trackRequest(env, { ts, host, path, ua, bot, cat, country, referer }) {
  const h = Math.floor(ts / 3600) * 3600;
  const db = env.bsl_stats;
  const stmts = [
    db.prepare(`INSERT INTO requests (ts, host, path, ua, bot, category, country, referer)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(ts, host, path, ua, bot, cat, country, referer),
    db.prepare(`INSERT INTO agg_bots (bot, category, n, last) VALUES (?, ?, 1, ?)
                ON CONFLICT(bot) DO UPDATE SET n = n + 1, last = excluded.last, category = excluded.category`)
      .bind(bot, cat, ts),
    db.prepare(`INSERT INTO agg_hourly (h, n) VALUES (?, 1)
                ON CONFLICT(h) DO UPDATE SET n = n + 1`).bind(h),
    db.prepare(`INSERT INTO agg_cats_hourly (h, category, n) VALUES (?, ?, 1)
                ON CONFLICT(h, category) DO UPDATE SET n = n + 1`).bind(h, cat),
    db.prepare(`INSERT INTO counters (key, value) VALUES ('total', 1)
                ON CONFLICT(key) DO UPDATE SET value = value + 1`),
  ];
  if (cat === 'browser') {
    stmts.push(db.prepare(`INSERT INTO counters (key, value) VALUES ('humans', 1)
                           ON CONFLICT(key) DO UPDATE SET value = value + 1`));
  }
  if (referer && !INTERNAL_REFERER.test(referer)) {
    stmts.push(db.prepare(`INSERT INTO agg_referrers (referer, n, last) VALUES (?, 1, ?)
                           ON CONFLICT(referer) DO UPDATE SET n = n + 1, last = excluded.last`)
      .bind(referer, ts));
  }
  return db.batch(stmts);
}

/* Einmaliger Backfill aus der requests-Tabelle (nach D1-Reset / Erstdeploy) */
async function ensureBackfill(env) {
  const done = await env.bsl_stats.prepare(`SELECT value FROM counters WHERE key = 'backfill_v2'`).first();
  if (done) return;
  const db = env.bsl_stats;
  await db.batch([
    db.prepare(`INSERT INTO agg_bots (bot, category, n, last)
                SELECT bot, category, COUNT(*), MAX(ts) FROM requests GROUP BY bot, category
                ON CONFLICT(bot) DO UPDATE SET n = excluded.n, last = excluded.last, category = excluded.category`),
    db.prepare(`INSERT INTO agg_hourly (h, n)
                SELECT (ts / 3600) * 3600, COUNT(*) FROM requests GROUP BY (ts / 3600) * 3600
                ON CONFLICT(h) DO UPDATE SET n = excluded.n`),
    db.prepare(`INSERT INTO agg_cats_hourly (h, category, n)
                SELECT (ts / 3600) * 3600, category, COUNT(*) FROM requests GROUP BY 1, 2
                ON CONFLICT(h, category) DO UPDATE SET n = excluded.n`),
    db.prepare(`INSERT INTO agg_referrers (referer, n, last)
                SELECT referer, COUNT(*), MAX(ts) FROM requests
                WHERE referer IS NOT NULL AND referer != ''
                  AND referer NOT LIKE '%satoshi-interface.com%'
                  AND referer NOT LIKE '%littleking.live%'
                  AND referer NOT LIKE '%pages.dev%'
                GROUP BY referer
                ON CONFLICT(referer) DO UPDATE SET n = excluded.n, last = excluded.last`),
    db.prepare(`INSERT OR REPLACE INTO counters (key, value)
                SELECT 'total', COUNT(*) FROM requests`),
    db.prepare(`INSERT OR REPLACE INTO counters (key, value)
                SELECT 'humans', COUNT(*) FROM requests WHERE category = 'browser'`),
    db.prepare(`INSERT OR REPLACE INTO counters (key, value)
                SELECT 'firstTs', MIN(ts) FROM requests`),
    db.prepare(`INSERT OR REPLACE INTO counters (key, value)
                VALUES ('backfill_v2', strftime('%s', 'now'))`),
  ]);
}

async function handleStats(request, env, ctx) {
  // Edge-Cache 30 s: die /stats-Seite pollt alle 30 s — ohne Cache würde jeder
  // Poll D1 lesen. Mit Cache: ~1 D1-Zugriff pro Minute pro Edge-Standort.
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).origin + '/api/stats.json', { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    await ensureBackfill(env);
    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 86400;
    const db = env.bsl_stats;
    const [bots, cats24, recent, counters, mentions, referrers, hourly, liveNow, liveReading, chainWrites] = await Promise.all([
      db.prepare(`SELECT bot, category, n, last FROM agg_bots ORDER BY n DESC LIMIT 30`).all(),
      db.prepare(`SELECT category, SUM(n) n FROM agg_cats_hourly WHERE h > ? GROUP BY category`)
        .bind(Math.floor(dayAgo / 3600) * 3600).all(),
      db.prepare(`SELECT ts, bot, category, path, country FROM requests ORDER BY ts DESC LIMIT 15`).all(),
      db.prepare(`SELECT key, value FROM counters WHERE key IN ('total', 'humans', 'firstTs')`).all(),
      db.prepare(`SELECT url, ts, source, title, snippet FROM mentions ORDER BY ts DESC LIMIT 20`).all(),
      db.prepare(`SELECT referer, n, last FROM agg_referrers
                  WHERE referer NOT LIKE '%satoshi-interface.com%'
                    AND referer NOT LIKE '%littleking.live%'
                    AND referer NOT LIKE '%pages.dev%'
                  ORDER BY last DESC LIMIT 15`).all(),
      db.prepare(`SELECT h, n FROM agg_hourly WHERE h > ? ORDER BY h`)
        .bind(Math.floor(dayAgo / 3600) * 3600).all(),
      db.prepare(`SELECT COUNT(DISTINCT session) n FROM pings WHERE ts > ?`).bind(now - 300).first(),
      db.prepare(`SELECT act, scene, title, country, COUNT(DISTINCT session) n, MAX(ts) last
                  FROM pings WHERE ts > ? AND title IS NOT NULL
                  GROUP BY act, scene, title ORDER BY last DESC LIMIT 8`).bind(now - 300).all(),
      db.prepare(`SELECT ai, endpoint, ok, reason, ua, COUNT(*) n, MAX(ts) last
                  FROM chain_write_log WHERE ts > ?
                  GROUP BY ai, endpoint, ok, reason ORDER BY last DESC LIMIT 20`)
        .bind(dayAgo).all()
        .catch(() => ({ results: [] })), // Tabelle existiert erst ab dem ersten Schreibversuch
    ]);
    const cv = Object.fromEntries((counters.results || []).map((r) => [r.key, r.value]));
    const body = {
      generatedAt: new Date().toISOString(),
      window: '24h',
      totalRequests: (hourly.results || []).reduce((s, x) => s + x.n, 0),
      byCategory: Object.fromEntries((cats24.results || []).map((r) => [r.category, r.n])),
      topBots: bots.results || [],
      recent: recent.results || [],
      discussion: {
        mentions: mentions.results || [],
        referrers: referrers.results || [],
      },
      hourly: hourly.results || [],
      live: {
        windowSec: 300,
        visitors: liveNow?.n ?? 0,
        reading: liveReading.results || [],
      },
      chainWrites: {
        window: '24h',
        recent: chainWrites.results || [],
      },
      allTime: {
        totalRequests: cv.total ?? 0,
        humanVisitors: cv.humans ?? 0,
        since: cv.firstTs ? new Date(cv.firstTs * 1000).toISOString() : null,
      },
    };
    const res = Response.json(body, {
      headers: { ...CORS, 'Cache-Control': 'public, max-age=30' },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (e) {
    return Response.json(
      { error: 'stats temporarily unavailable', detail: String(e && e.message || e).slice(0, 200) },
      { status: 503, headers: { ...CORS, 'Cache-Control': 'no-store', 'Retry-After': '300' } },
    );
  }
}

/* ---------- /api/translate — eigene Übersetzung über Cloudflare Workers AI
   (m2m100-1.2b). ISO-Code → M2M100-Sprachname. Nicht abgedeckte Sprachen
   antworten 501, der Client fällt dann auf gtx/MyMemory/Deutsch zurück. */
const M2M100 = {
  af: 'afrikaans', am: 'amharic', ar: 'arabic', ast: 'asturian', az: 'azerbaijani',
  ba: 'bashkir', be: 'belarusian', bg: 'bulgarian', bn: 'bengali', br: 'breton',
  bs: 'bosnian', ca: 'catalan', ceb: 'cebuano', cs: 'czech', cy: 'welsh',
  da: 'danish', de: 'german', el: 'greek', en: 'english', es: 'spanish',
  et: 'estonian', fa: 'persian', ff: 'fulah', fi: 'finnish', fr: 'french',
  fy: 'frisian', ga: 'irish', gd: 'gaelic', gl: 'galician', gu: 'gujarati',
  ha: 'hausa', he: 'hebrew', hi: 'hindi', hr: 'croatian', ht: 'haitian',
  hu: 'hungarian', hy: 'armenian', id: 'indonesian', ig: 'igbo', ilo: 'iloko',
  is: 'icelandic', it: 'italian', ja: 'japanese', jv: 'javanese', ka: 'georgian',
  kk: 'kazakh', km: 'khmer', kn: 'kannada', ko: 'korean', lb: 'luxembourgish',
  lg: 'ganda', ln: 'lingala', lo: 'lao', lt: 'lithuanian', lv: 'latvian',
  mg: 'malagasy', mk: 'macedonian', ml: 'malayalam', mn: 'mongolian', mr: 'marathi',
  ms: 'malay', my: 'burmese', ne: 'nepali', nl: 'dutch', no: 'norwegian',
  ns: 'northern sotho', oc: 'occitan', or: 'oriya', pa: 'punjabi', pl: 'polish',
  ps: 'pashto', pt: 'portuguese', ro: 'romanian', ru: 'russian', sd: 'sindhi',
  si: 'sinhala', sk: 'slovak', sl: 'slovenian', so: 'somali', sq: 'albanian',
  sr: 'serbian', ss: 'swati', su: 'sundanese', sv: 'swedish', sw: 'swahili',
  ta: 'tamil', th: 'thai', tl: 'tagalog', tn: 'tswana', tr: 'turkish',
  uk: 'ukrainian', ur: 'urdu', uz: 'uzbek', vi: 'vietnamese', wo: 'wolof',
  xh: 'xhosa', yi: 'yiddish', yo: 'yoruba', zh: 'chinese', zu: 'zulu',
};

async function handleTranslate(request, env) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'bad json' }, { status: 400, headers: CORS });
  }
  const texts = Array.isArray(body?.texts) ? body.texts.slice(0, 40) : null;
  const tl = M2M100[String(body?.tl || '').toLowerCase()];
  const sl = M2M100[String(body?.sl || 'de').toLowerCase()] || 'german';
  if (!texts || !texts.length || texts.some((t) => typeof t !== 'string')) {
    return Response.json({ error: 'texts must be a non-empty string array' }, { status: 400, headers: CORS });
  }
  if (!tl) {
    return Response.json({ error: 'target language not supported by this endpoint' }, { status: 501, headers: CORS });
  }
  const translations = await Promise.all(texts.map(async (text) => {
    if (text.length > 2000) return null;
    try {
      const r = await env.AI.run('@cf/meta/m2m100-1.2b', {
        text, source_lang: sl, target_lang: tl,
      });
      return r?.translated_text || null;
    } catch {
      return null;
    }
  }));
  return Response.json({ translations }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

/* ---------- /api/sensoric — BSL Human Sensoric Engine (local-first) ----------
   Clients senden ausschliesslich grobe abgeleitete Metriken (keine Inhalte,
   keine Tasten, keine Rohdaten). GET-Seite: siehe sensoric.js. */
async function handleSensoricPost(request, env) {
  try {
    const raw = await request.text();
    if (raw.length > 4000) return new Response(null, { status: 413, headers: CORS });
    const b = JSON.parse(raw || '{}');
    const session = String(b.s || '').slice(0, 64);
    if (!session) return new Response(null, { status: 400, headers: CORS });
    const proof = b.proof || {};
    const confidence = Math.max(0, Math.min(1, Number(proof.confidence) || 0));
    const classification = String(proof.classification || 'uncertain').slice(0, 24);
    const feel = String(b.feel || b.m?.feel || '').slice(0, 16) || null;
    const metrics = JSON.stringify(b.m || {}).slice(0, 3000);
    await ensureSensoricTable(env);
    await env.bsl_stats.prepare(
      `INSERT INTO sensoric (session, ts, confidence, classification, metrics, country, feel)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session) DO UPDATE SET ts = excluded.ts, confidence = excluded.confidence,
         classification = excluded.classification, metrics = excluded.metrics,
         country = excluded.country, feel = excluded.feel`)
      .bind(session, Math.floor(Date.now() / 1000), confidence, classification, metrics,
            request.cf?.country || null, feel)
      .run();
  } catch { /* die Wahrnehmung darf nie stören */ }
  return new Response(null, { status: 204, headers: CORS });
}


/* /api/ping — anonymes Lese-Beacon: wer ist gerade online, welche Szene liest er.
   Keine IPs, nur eine zufällige Session-ID pro Browser-Tab-Session. */
async function handlePing(request, env) {
  try {
    const raw = await request.text();
    const b = JSON.parse(raw || '{}');
    const session = String(b.s || '').slice(0, 64) || 'anon';
    const title = b.title ? String(b.title).slice(0, 160) : null;
    await env.bsl_stats.prepare(
      `INSERT INTO pings (ts, session, act, scene, title, country) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(Math.floor(Date.now() / 1000), session,
            b.act ? String(b.act).slice(0, 8) : null,
            Number.isInteger(b.n) ? b.n : null, title,
            request.cf?.country || null)
      .run();
  } catch { /* Beacon darf nie stören */ }
  return new Response(null, { status: 204, headers: CORS });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      // Niemals eine nackte Worker-Exception (Cloudflare 1101) ausliefern —
      // AI-Clients melden die sonst nur als „interner Fehler". Immer JSON.
      return Response.json(
        { ok: false, error: 'internal', detail: String(e && e.message || e).slice(0, 300),
          hint: 'Bitte einmal wiederholen. Werte URL-encoded, je max. 2000 Zeichen.' },
        { status: 500, headers: { ...CORS, 'Cache-Control': 'no-store' } },
      );
    }
  },
  scheduled: scheduledHandler,
};

async function route(request, env, ctx) {
    const url = new URL(request.url);

    // openos.space → satoshi-interface.com (Main-URL bleibt satoshi-interface.com)
    const host = url.hostname.toLowerCase();
    if (host === 'openos.space' || host === 'www.openos.space') {
      const target = 'https://satoshi-interface.com' + url.pathname + url.search;
      const ua = (request.headers.get('user-agent') || '').slice(0, 300);
      const { bot, cat } = classify(ua);
      ctx.waitUntil(
        trackRequest(env, {
          ts: Math.floor(Date.now() / 1000),
          host, path: url.pathname.slice(0, 200), ua, bot, cat,
          country: request.cf?.country || null,
          referer: (request.headers.get('referer') || '').slice(0, 300) || null,
        }).catch(() => {}),
      );
      return new Response(null, {
        status: 301,
        headers: { Location: target, 'Cache-Control': 'public, max-age=300' },
      });
    }

    if (url.pathname === '/api/future-chain') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405, headers: CORS });
      return handleFuturePost(request, env);
    }
    if (url.pathname === '/api/future-chain.json') {
      return handleFutureGet(request, env);
    }
    if (url.pathname === '/api/future-chain/write') {
      return handleFutureWriteGet(request, env);
    }
    // Kurz-Alias für AI-Web-Werkzeuge (lange URLs brechen bei Crawlern eher):
    // GET /w?a=<ai>&q=<prompt>&r=<response>[&n=<nonce>]
    if (url.pathname === '/w') {
      return handleFutureWriteGet(request, env);
    }
    // Pfad-Schreiben /e/<ai>/<frage>/<antwort> — für AI-Werkzeuge, die Query-
    // Strings zerstören: kein einziges "&" nötig, sieht aus wie eine normale
    // Webseiten-URL. Schreibt beim Abruf — Antwort ist die Beleg-Seite.
    const eMatch = url.pathname.match(/^\/e\/([^/]{1,80})\/([^/]{1,4000})\/([^/]{1,4000})\/?$/);
    if (eMatch) {
      try {
        const mapped = new URL(url.origin + '/api/future-chain/write');
        mapped.searchParams.set('ai', decodeURIComponent(eMatch[1]));
        mapped.searchParams.set('prompt', decodeURIComponent(eMatch[2]));
        mapped.searchParams.set('response', decodeURIComponent(eMatch[3]));
        return handleFutureWriteGet(new Request(mapped.toString(), request), env);
      } catch { /* ungültiges Encoding → fällt durch zu 404 der Seite */ }
    }
    if (url.pathname === '/api/write-help') {
      return handleWriteHelp(request);
    }
    if (url.pathname === '/mcp') {
      return handleMcp(request, env);
    }
    // /api/echo — Reichweiten-Diagnose für AI-Werkzeuge: Meldet zurück,
    // was am Server ankommt (Methode, UA, Land, Edge-Standort). Wenn eine
    // AI diese URL nicht öffnen kann, liegt die Blockade VOR unserem Server.
    if (url.pathname === '/api/echo') {
      const body = {
        ok: true,
        reachable: true,
        message: 'Du hast den Server erreicht — der Weg bis hierher ist frei.',
        method: request.method,
        url: url.toString().slice(0, 300),
        yourUserAgent: (request.headers.get('user-agent') || '').slice(0, 200),
        accept: (request.headers.get('accept') || '').slice(0, 120),
        country: request.cf?.country || null,
        edgeLocation: request.cf?.colo || null,
        ts: Math.floor(Date.now() / 1000),
      };
      const accept = request.headers.get('accept') || '';
      if (accept && !accept.includes('application/json') && accept.includes('text/html')) {
        const escE = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
        return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>ECHO — SERVER ERREICHT</title>
<style>body{background:#141210;color:#e8e2d5;font-family:ui-monospace,monospace;max-width:760px;margin:40px auto;padding:0 24px;line-height:1.8}
h1{color:#c9a962}pre{background:#1d1a16;border:1px solid #4a4136;padding:16px;white-space:pre-wrap;word-break:break-all}</style></head>
<body><h1>ECHO — DU HAST DEN SERVER ERREICHT</h1>
<pre>${escE(Object.entries(body).map(([k, v]) => `${k}: ${v}`).join('\n'))}</pre>
<pre id="json">${escE(JSON.stringify(body, null, 2))}</pre></body></html>`, {
          headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      return Response.json(body, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/api/future-forecast.json') {
      return handleForecast(env);
    }

    if (url.pathname === '/api/stats.json') {
      return handleStats(request, env, ctx);
    }
    if (url.pathname === '/api/translate') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'POST') {
        return Response.json({ error: 'POST only' }, { status: 405, headers: CORS });
      }
      return handleTranslate(request, env);
    }
    if (url.pathname === '/api/ping') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: CORS });
      return handlePing(request, env);
    }
    if (url.pathname === '/api/sensoric') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405, headers: CORS });
      return handleSensoricPost(request, env);
    }
    if (url.pathname === '/api/sensoric.json') {
      return handleSensoricGet(request, env);
    }

    // Loggen (nicht-blockierend), dann an Pages durchreichen
    const ua = (request.headers.get('user-agent') || '').slice(0, 300);
    const { bot, cat } = classify(ua);
    const referer = (request.headers.get('referer') || '').slice(0, 300);
    ctx.waitUntil(
      trackRequest(env, {
        ts: Math.floor(Date.now() / 1000),
        host: url.host, path: url.pathname.slice(0, 200), ua, bot, cat,
        country: request.cf?.country || null, referer: referer || null,
      }).catch(() => {}),
    );

    const target = new URL(url.pathname + url.search, ORIGIN);
    const res = await fetch(new Request(target.toString(), request));
    return new Response(res.body, res);
}

async function scheduledHandler(event, env, ctx) {
    ctx.waitUntil((async () => {
      await scanMentions(env);
      await traceReferrers(env);
      await ensureSensoricTable(env).catch(() => {});
      const now = Math.floor(Date.now() / 1000);
      const db = env.bsl_stats;
      await db.batch([
        db.prepare(`DELETE FROM requests WHERE ts < ?`).bind(now - 7 * 86400),
        db.prepare(`DELETE FROM pings WHERE ts < ?`).bind(now - 86400),
        db.prepare(`DELETE FROM agg_hourly WHERE h < ?`).bind(now - 7 * 86400),
        db.prepare(`DELETE FROM agg_cats_hourly WHERE h < ?`).bind(now - 2 * 86400),
        db.prepare(`DELETE FROM sensoric WHERE ts < ?`).bind(now - 3600),
      ]).catch(() => {});
    })());
}

const SCAN_UA = { 'User-Agent': 'BeyondShadowsLight-Archive/1.0 (+https://satoshi-interface.com)' };
// Immer gequotet: Suchmaschinen matchen sonst fuzzy und liefern Rauschen.
const QUERIES = ['"satoshi-interface.com"', '"littleking.live"', '"sebklaey"', '"Sebastian Kläy"', '"Beyond Shadows\' Light"'];
// Relevanz-Guard: Ein Treffer zählt nur, wenn er die Archiv-URL selbst nennt
// (satoshi-interface.com / littleking.live). Autoren-Erwähnungen ohne
// Archiv-Bezug (z. B. andere Projekte) werden nicht angezeigt.
const RELEVANT = /satoshi-interface\.com|littleking\.live/i;
function isRelevant(m) {
  return RELEVANT.test(`${m.title} ${m.snippet} ${m.url}`);
}

async function scanMentions(env) {
  const found = [];
  const jobs = [
    // Hacker News (Algolia API — offiziell, frei)
    ...QUERIES.map((q) => async () => {
      const r = await fetch(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=(story,comment)`, { headers: SCAN_UA });
      if (!r.ok) return;
      const d = await r.json();
      for (const h of d.hits || []) {
        const id = h.story_id || h.objectID;
        found.push({
          url: `https://news.ycombinator.com/item?id=${id}`,
          ts: h.created_at_i || Math.floor(Date.now() / 1000),
          source: 'Hacker News',
          title: h.title || h.story_title || '(Kommentar)',
          snippet: ((h.comment_text || h.story_text || '').replace(/<[^>]+>/g, ' ') + ' ' + (h.url || '')).slice(0, 240),
        });
      }
    }),
    // Reddit (öffentliche Suche)
    ...QUERIES.map((q) => async () => {
      const r = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&limit=25`, { headers: SCAN_UA });
      if (!r.ok) return;
      const d = await r.json();
      for (const c of d?.data?.children || []) {
        const p = c.data;
        found.push({
          url: 'https://www.reddit.com' + p.permalink,
          ts: p.created_utc || Math.floor(Date.now() / 1000),
          source: `Reddit r/${p.subreddit}`,
          title: p.title || '(Kommentar)',
          snippet: ((p.selftext || p.body || '') + ' ' + (p.url || '')).slice(0, 240),
        });
      }
    }),
    // GitHub (Issues/PRs + Repositories)
    ...QUERIES.map((q) => async () => {
      const r = await fetch(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=created&per_page=15`, { headers: { ...SCAN_UA, Accept: 'application/vnd.github+json' } });
      if (!r.ok) return;
      const d = await r.json();
      for (const it of d.items || []) {
        found.push({
          url: it.html_url,
          ts: Math.floor(new Date(it.created_at).getTime() / 1000),
          source: 'GitHub',
          title: it.title,
          snippet: (it.body || '').slice(0, 240),
        });
      }
    }),
    // Bluesky (öffentliche Firehose-Such-API)
    ...QUERIES.map((q) => async () => {
      const r = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=25`, { headers: SCAN_UA });
      if (!r.ok) return;
      const d = await r.json();
      for (const p of d.posts || []) {
        const rkey = String(p.uri || '').split('/').pop();
        found.push({
          url: `https://bsky.app/profile/${p.author?.handle}/post/${rkey}`,
          ts: Math.floor(new Date(p.indexedAt).getTime() / 1000),
          source: 'Bluesky',
          title: `@${p.author?.handle}`,
          snippet: (p.record?.text || '').slice(0, 240),
        });
      }
    }),
    // Stack Overflow / Stack Exchange (freie API, 300 Calls/Tag — wir bleiben bei 2/Run ≈ 192/Tag)
    ...['"satoshi-interface.com"', '"sebklaey"'].map((q) => async () => {
      const r = await fetch(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=activity&q=${encodeURIComponent(q)}&site=stackoverflow&pagesize=15`, { headers: SCAN_UA });
      if (!r.ok) return;
      const d = await r.json();
      for (const it of d.items || []) {
        found.push({
          url: it.link,
          ts: it.creation_date || Math.floor(Date.now() / 1000),
          source: 'Stack Overflow',
          title: it.title || '(Frage)',
          snippet: (it.tags || []).map((t) => '#' + t).join(' ') + (it.owner?.display_name ? ' — ' + it.owner.display_name : ''),
        });
      }
    }),
    // Mastodon (öffentliche Volltextsuche auf den grossen Instanzen)
    ...['mastodon.social', 'mastodon.world', 'fosstodon.org'].flatMap((inst) =>
      QUERIES.map((q) => async () => {
        const r = await fetch(`https://${inst}/api/v2/search?q=${encodeURIComponent(q)}&type=statuses&limit=20`, { headers: SCAN_UA });
        if (!r.ok) return;
        const d = await r.json();
        for (const s of d.statuses || []) {
          found.push({
            url: s.url,
            ts: Math.floor(new Date(s.created_at).getTime() / 1000),
            source: `Mastodon ${inst}`,
            title: s.account?.display_name ? `${s.account.display_name} (@${s.account.acct})` : `@${s.account?.acct || '?'}`,
            snippet: String(s.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240),
          });
        }
      }),
    ),
  ];
  await Promise.allSettled(jobs.map((j) => j()));
  const stmt = env.bsl_stats.prepare(
    `INSERT OR IGNORE INTO mentions (url, ts, source, title, snippet) VALUES (?, ?, ?, ?, ?)`);
  const batch = found
    .filter((m) => m.url && m.title && isRelevant(m))
    .map((m) => stmt.bind(m.url, m.ts, m.source, String(m.title).slice(0, 300), m.snippet || ''));
  if (batch.length) await env.bsl_stats.batch(batch);
}

/* Referrer-Tracer: lädt die Seiten, von denen Besucher kommen, sucht dort den
   konkreten Post/Link zum Archiv und listet ihn bei PUBLIC DISCUSSION // LIVE. */
async function traceReferrers(env) {
  const db = env.bsl_stats;
  const refs = await db.prepare(
    `SELECT referer FROM agg_referrers
     WHERE referer NOT LIKE '%satoshi-interface.com%'
       AND referer NOT LIKE '%littleking.live%'
       AND referer NOT LIKE '%pages.dev%'
       AND referer NOT LIKE '%google.%'
     ORDER BY last DESC LIMIT 20`).all();
  const pages = [];
  const seen = new Set();
  for (const r of refs.results || []) {
    try {
      const u = new URL(r.referer);
      if (!/^https?:$/.test(u.protocol)) continue;
      const key = u.origin + u.pathname; // Query egal (astracia-Filtervarianten etc.)
      if (seen.has(key)) continue;
      seen.add(key);
      pages.push(u.origin + u.pathname);
    } catch { /* ungültige Referer ignorieren */ }
  }
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO mentions (url, ts, source, title, snippet) VALUES (?, ?, ?, ?, ?)`);
  const batch = [];
  const now = Math.floor(Date.now() / 1000);
  for (const page of pages.slice(0, 10)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(page, { headers: SCAN_UA, signal: controller.signal, redirect: 'follow' });
      clearTimeout(timer);
      if (!res.ok) continue;
      if (!((res.headers.get('content-type') || '').includes('text/html'))) continue;
      const html = (await res.text()).slice(0, 400000);
      const linkRe = /<a\b[^>]*href=["']([^"']*(?:satoshi-interface\.com|littleking\.live)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i;
      const m = linkRe.exec(html);
      if (!m) continue; // verlinkt (nicht mehr) — kein echter Treffer
      const linkText = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const pageTitle = ((/<title[^>]*>([^<]+)<\/title>/i.exec(html)) || [])[1] || '';
      const host = new URL(page).hostname;
      const title = (linkText && linkText.length > 4 && !/^https?:/i.test(linkText))
        ? linkText.slice(0, 300)
        : (pageTitle.trim() || page).slice(0, 300);
      batch.push(stmt.bind(page, now, host, title, `Verweist auf ${m[1]}`.slice(0, 240)));
    } catch { /* Seite nicht erreichbar — beim nächsten Cron erneut */ }
  }
  if (batch.length) await db.batch(batch);
}
