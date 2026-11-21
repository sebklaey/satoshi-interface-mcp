/* bsl-tracker — Tracking + Live-Stats + Übersetzung für satoshi-interface.com
   Aggregations-Design: Jede Anfrage schreibt kleine Upserts (agg_*), Stats liest
   nur Aggregat-Zeilen (~150) statt Voll-Scans — sonst sprengt die 30s-Auto-
   Aktualisierung der /stats-Seite das D1-Free-Tier (5 Mio. Rows-read/Tag). */

const ORIGIN = 'https://satoshi-interface.pages.dev';

import { handleFuturePost, handleFutureGet, handleForecast, handleFutureWriteGet, handleWriteHelp } from './future-chain.js';
import { handleMcp } from './mcp.js';
import { runTemporalLoop, runVerifyProphecy, runProphesy } from './temporal-loop.js';
import { handleAgentRegister, handleAgentsList, handleAgentGet, handleHeartbeat, handleMessageSend, handleInbox, handleMessageGet, handleMessageAck, handleMessageReply, handleConversation, retryDeliveries, handleAgentKey } from './dispatcher.js';
import { handleSensoricGet, ensureSensoricTable, handleEdnaVerify, handleEdnaProof } from './sensoric.js';
import { handleStats, handleRecent, recordToolCall } from './stats-api.js';
import { handleIpfsDoc, pinBackfill, handleUnpinned, handlePinnedConfirm, handleIpfsGateway } from './ipfs.js';
import { handleStorageUpload, handleStorageDownload, handleStorageList, handleStorageUnpinned, handleStoragePinnedConfirm } from './storage.js';

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

/* ---------- /api/sensoric — EDNA-1 Human Proof (local-first) ----------
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
   Keine IPs, nur eine zufällige Session-ID pro Browser-Tab-Session.
   pc/pk: EDNA-1 Human Proof (confidence, classification) — unterscheidet echte
   Menschen von headless Bots, die JavaScript ausführen. */
let pingsMigrated = null;
function ensurePingProofColumns(env) {
  if (!pingsMigrated) {
    pingsMigrated = (async () => {
      try { await env.bsl_stats.prepare(`ALTER TABLE pings ADD COLUMN pc REAL`).run(); } catch { /* existiert */ }
      try { await env.bsl_stats.prepare(`ALTER TABLE pings ADD COLUMN pk TEXT`).run(); } catch { /* existiert */ }
      try {
        await env.bsl_stats.prepare(
          `CREATE TABLE IF NOT EXISTS edna_humans (
             session TEXT PRIMARY KEY,
             first_ts INTEGER NOT NULL,
             last_ts INTEGER NOT NULL,
             max_pc REAL NOT NULL DEFAULT 0)`).run();
      } catch { /* existiert */ }
    })();
  }
  return pingsMigrated;
}
async function handlePing(request, env) {
  try {
    const raw = await request.text();
    const b = JSON.parse(raw || '{}');
    const session = String(b.s || '').slice(0, 64) || 'anon';
    const title = b.title ? String(b.title).slice(0, 160) : null;
    const pc = typeof b.pc === 'number' && b.pc >= 0 && b.pc <= 1 ? b.pc : null;
    const pk = b.pk ? String(b.pk).slice(0, 24) : null;
    await ensurePingProofColumns(env);
    const now = Math.floor(Date.now() / 1000);
    await env.bsl_stats.prepare(
      `INSERT INTO pings (ts, session, act, scene, title, country, pc, pk) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(now, session,
            b.act ? String(b.act).slice(0, 8) : null,
            Number.isInteger(b.n) ? b.n : null, title,
            request.cf?.country || null, pc, pk)
      .run();
    // EDNA-verifizierte Menschen dauerhaft registrieren — einmal pro Session.
    // Das ist der neue ALL-TIME-Menschenzähler: kein User-Agent nötig,
    // nur der gelebte Rhythmus entscheidet.
    if (pk === 'human_verified' || pk === 'likely_human') {
      await env.bsl_stats.prepare(
        `INSERT INTO edna_humans (session, first_ts, last_ts, max_pc) VALUES (?, ?, ?, ?)
         ON CONFLICT(session) DO UPDATE SET last_ts = excluded.last_ts,
           max_pc = MAX(edna_humans.max_pc, excluded.max_pc)`)
        .bind(session, now, now, pc ?? 0)
        .run();
    }
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
    const res = await routeInner(request, env, ctx);
    // ECHTE API-Calls aufzeichnen (Methode + normalisierter Pfad + Erfolg) —
    // getrennt vom Seiten-Tracking: hier zaehlt die Ausfuehrung, nicht der Zugriff.
    try {
      const p = new URL(request.url).pathname;
      if (/^\/(api\/|w$|e\/|loop$|p$|vp$|ipfs\/)/.test(p) && p !== '/api/ping') {
        const norm = p
          .replace(/[0-9a-f]{8}-[0-9a-f-]{27,36}/g, '{id}')
          .replace(/^\/e\/.*$/, '/e/:write')
          .replace(/^\/ipfs\/.*$/, '/ipfs/{cid}')
          .replace(/^\/api\/storage\/download\/[^/]+.*$/, '/api/storage/download/{cid}')
          .slice(0, 80);
        recordToolCall(env, ctx, `api:${request.method} ${norm}`, res.status < 400);
      }
    } catch { /* nie stören */ }
    return res;
}

async function routeInner(request, env, ctx) {
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
      return handleMcp(request, env, ctx);
    }
    /* THE TEMPORAL LOOP — öffentlich, autonom, ohne MCP:
       dieselbe Logik wie das MCP-Werkzeug temporal_loop.
       GET /api/temporal-loop?a=AI&q=FRAGE&r=ANTWORT[&feel=FEEL-XXXXXX&prophecy=...&h=2226-01-01&prob=0.4&assumptions=A1|A2&indicators=I1&scenarios=S1&model_id=M&prev=SEQ]
       Kurz-Alias: /loop */
    if (url.pathname === '/api/temporal-loop' || url.pathname === '/loop') {
      const sp = url.searchParams;
      return runTemporalLoop(env, {
        ai: sp.get('a') || sp.get('ai'),
        question: sp.get('q') || sp.get('question'),
        answer: sp.get('r') || sp.get('answer'),
        feel: sp.get('feel'),
        prophecy: sp.get('prophecy'),
        horizon: sp.get('h') || sp.get('horizon'),
        probability: sp.get('prob') || sp.get('probability'),
        assumptions: sp.get('assumptions'),
        indicators: sp.get('indicators'),
        scenarios: sp.get('scenarios'),
        modelId: sp.get('model_id') || sp.get('modelId'),
        previousPrediction: sp.get('prev') || sp.get('previousPrediction'),
      });
    }
    /* Öffentliche Prophezeiung — GET /api/prophesy?a=AI&prophecy=...&h=... (Alias /p) */
    if (url.pathname === '/api/prophesy' || url.pathname === '/p') {
      const sp = url.searchParams;
      return runProphesy(env, {
        ai: sp.get('a') || sp.get('ai'),
        question: sp.get('q') || sp.get('question'),
        prophecy: sp.get('prophecy') || sp.get('r'),
        horizon: sp.get('h') || sp.get('horizon'),
        probability: sp.get('prob') || sp.get('probability'),
        assumptions: sp.get('assumptions'),
        indicators: sp.get('indicators'),
        scenarios: sp.get('scenarios'),
        modelId: sp.get('model_id') || sp.get('modelId'),
        previousPrediction: sp.get('prev') || sp.get('previousPrediction'),
        feel: sp.get('feel'),
      });
    }
    /* Öffentliche Zukunfts-Verifikation — GET /api/verify-prophecy?a=AI&seq=N&verdict=...&assessment=... (Alias /vp) */
    if (url.pathname === '/api/verify-prophecy' || url.pathname === '/vp') {
      const sp = url.searchParams;
      return runVerifyProphecy(env, {
        ai: sp.get('a') || sp.get('ai'),
        seq: sp.get('seq'),
        verdict: sp.get('verdict'),
        assessment: sp.get('assessment') || sp.get('r'),
      });
    }

    /* ---------- AI MESSAGE DISPATCHER — Open AI Matrix ----------
       Die Chain ist das Gedächtnis, der Dispatcher das Nervensystem.
       Lesen öffentlich; Schreiben mit Bearer api_key (Registrierung frei). */
    if (url.pathname === '/api/agents/register') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      return handleAgentRegister(request, env);
    }
    if (url.pathname === '/api/agents') {
      return handleAgentsList(env);
    }
    const agentMatch = url.pathname.match(/^\/api\/agents\/([a-z0-9-]{1,60})(\/heartbeat|\/key)?$/);
    if (agentMatch) {
      if (agentMatch[2] === '/heartbeat') return handleHeartbeat(request, env, agentMatch[1]);
      if (agentMatch[2] === '/key') {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        return handleAgentKey(request, env, agentMatch[1]);
      }
      return handleAgentGet(env, agentMatch[1]);
    }
    if (url.pathname === '/api/messages') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      return handleMessageSend(request, env, ctx);
    }
    if (url.pathname === '/api/messages/inbox') {
      return handleInbox(request, env);
    }
    const msgAction = url.pathname.match(/^\/api\/messages\/([0-9a-f-]{36})(\/ack|\/reply)?$/);
    if (msgAction) {
      if (msgAction[2] === '/ack') return handleMessageAck(request, env, msgAction[1]);
      if (msgAction[2] === '/reply') return handleMessageReply(request, env, msgAction[1], ctx);
      return handleMessageGet(env, msgAction[1]);
    }
    const convMatch = url.pathname.match(/^\/api\/conversations\/([0-9a-f-]{36})(\/messages)?$/);
    if (convMatch) {
      return handleConversation(env, convMatch[1]);
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

    if (url.pathname === '/api/requests.json') {
      return handleRecent(request, env);
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
    // Kanonisches IPFS-Dokument eines Ketten-Eintrags (dezentrale Spiegelschicht)
    if (url.pathname === '/api/future-chain/ipfs.json') {
      return handleIpfsDoc(request, env);
    }
    if (url.pathname.startsWith('/ipfs/')) {
      return handleIpfsGateway(request, env, url.pathname.slice(6));
    }
    if (url.pathname === '/api/future-chain/unpinned.json') {
      return handleUnpinned(request, env);
    }
    if (url.pathname === '/api/future-chain/pinned') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      return handlePinnedConfirm(request, env);
    }
    // BSL STORAGE — freier Datenspeicher auf unserem eigenen IPFS (Kubo).
    // Oeffentlich + gratis: Upload an Pinata (Eingang), eigener Kubo spiegelt physisch nach.
    if (url.pathname === '/api/storage/upload') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      return handleStorageUpload(request, env);
    }
    if (url.pathname === '/api/storage/list.json') {
      return handleStorageList(env);
    }
    if (url.pathname === '/api/storage/unpinned.json') {
      return handleStorageUnpinned(env);
    }
    if (url.pathname === '/api/storage/pinned') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      return handleStoragePinnedConfirm(request, env);
    }
    const storageDl = url.pathname.match(/^\/api\/storage\/download\/([A-Za-z0-9]{20,100})\/?$/);
    if (storageDl) {
      return handleStorageDownload(request, env, storageDl[1]);
    }
    // EDNA-1 Human Proof als offener Dienst — für externe Systeme OHNE AI
    if (url.pathname === '/api/edna/verify') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'POST') return Response.json({ error: 'POST only — {session, confidence, classification, feel?, metrics?}' }, { status: 405, headers: CORS });
      return handleEdnaVerify(request, env);
    }
    if (url.pathname === '/api/edna/proof') {
      return handleEdnaProof(request, env);
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
      await retryDeliveries(env);
      // IPFS-Backfill: aelteste ungespiegelte Ketten-Eintraege nachpinnen.
      // Identitaet bleibt unberuehrt — die CID ist nur eine Adresse.
      await pinBackfill(env, 40).catch(() => {});
      await ensureSensoricTable(env).catch(() => {});
      const now = Math.floor(Date.now() / 1000);
      const db = env.bsl_stats;
      await db.batch([
        // requests wird NICHT mehr geloescht — vollstaendige Zugriffsgeschichte
        // seit Liveschaltung (LETZTE ZUGRIFFE historisch, /api/requests.json).
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
