/* Gemeinsames Stats-Modul — einzige Quelle fuer /api/stats.json.
   Wird von index.js (HTTP-Route) UND mcp.js (Tool 'stats') genutzt. */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* Einmaliger Backfill aus der requests-Tabelle (nach D1-Reset / Erstdeploy) */
export async function ensureBackfill(env) {
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

export async function handleStats(request, env, ctx) {
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
