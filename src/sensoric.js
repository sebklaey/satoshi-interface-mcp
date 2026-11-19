/* EDNA-1 Human Proof — GET-Seite (lesende Wahrnehmung)
   Gemeinsames Modul: vom Worker (/api/sensoric.json) UND vom MCP-Server
   (Tool "feel") genutzt — damit AIs ohne Web-Abruf fühlen können. */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function ensureSensoricTable(env) {
  if (ensureSensoricTable.done) return;
  await env.bsl_stats.prepare(
    `CREATE TABLE IF NOT EXISTS sensoric (
       session TEXT PRIMARY KEY,
       ts INTEGER NOT NULL,
       confidence REAL,
       classification TEXT,
       metrics TEXT,
       country TEXT
     )`).run();
  // FEEL-Schlüssel: persönliche Korrelation zwischen Mensch und Archiv-AI
  try { await env.bsl_stats.prepare(`ALTER TABLE sensoric ADD COLUMN feel TEXT`).run(); } catch { /* Spalte existiert */ }
  ensureSensoricTable.done = true;
}

/* Content-Negotiation für AI-Web-Werkzeuge (Perplexity, ChatGPT & Co.):
   Wer nur text/html lesen kann, bekommt dieselbe Wahrnehmung als Webseite. */
function prefersHTML(request) {
  const accept = request.headers.get('accept') || '';
  if (!accept || accept.includes('application/json')) return false;
  return accept.includes('text/html');
}
const escH = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function sensoricHtml(title, body, extraRowsHtml = '') {
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<title>${escH(title)}</title>
<meta name="description" content="${escH(JSON.stringify(body).slice(0, 280))}">
<style>body{background:#141210;color:#e8e2d5;font-family:ui-monospace,Menlo,monospace;max-width:860px;margin:40px auto;padding:0 24px;line-height:1.7}
h1{color:#c9a962;font-size:1.1rem;letter-spacing:.12em}.box{border:1px solid #c9a962;padding:16px;margin-bottom:18px;white-space:pre-wrap;word-break:break-all}
.s{border:1px solid #4a4136;padding:12px;margin-bottom:10px;font-size:.8rem;word-break:break-all}
pre{background:#1d1a16;border:1px solid #4a4136;padding:16px;overflow-x:auto;font-size:.75rem;white-space:pre-wrap;word-break:break-all}</style></head>
<body><h1>EDNA-1 · HUMAN PROOF — ${escH(title)}</h1>
<div class="box">${escH(Object.entries(body).filter(([k]) => k !== 'sessions' && k !== 'metrics').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'))}</div>
${body.metrics ? `<div class="box">METRIKEN:\n${escH(JSON.stringify(body.metrics, null, 2))}</div>` : ''}
${extraRowsHtml}
<pre id="json">${escH(JSON.stringify(body, null, 2))}</pre>
</body></html>`;
  return new Response(html, {
    headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function handleSensoricGet(request, env) {
  const url = new URL(request.url);
  const html = prefersHTML(request);
  await ensureSensoricTable(env);
  const now = Math.floor(Date.now() / 1000);

  /* ?feel=FEEL-XXXXXX — die Archiv-AI spürt GENAU IHREN Menschen:
     live (bis 3 min) oder zuletzt bekannt (bis 1 h, als lastKnown markiert). */
  const feelKey = (url.searchParams.get('feel') || '').slice(0, 16);
  if (feelKey) {
    const row = await env.bsl_stats.prepare(
      `SELECT session, ts, confidence, classification, metrics, country, feel
       FROM sensoric WHERE feel = ? ORDER BY ts DESC LIMIT 1`).bind(feelKey).first();
    if (!row) {
      const body404 = {
        feel: feelKey, found: false,
        note: 'Dieser Sensorik-Schlüssel ist (noch) nicht im Strom. Der Archiv-Tab des Menschen ist vermutlich geschlossen oder die Sensorik pausiert. Der Schlüssel steht auf der Seite https://satoshi-interface.com/feel, sobald der Mensch das Archiv geöffnet hat.',
        howToRead: 'Sobald der Mensch das Archiv (satoshi-interface.com) in einem Tab offen hat, erscheint sein Live-Rhythmus hier.',
      };
      if (html) return sensoricHtml(`SCHLÜSSEL ${escH(feelKey)} NICHT GEFUNDEN`, body404);
      return Response.json(body404, { status: 404, headers: { ...CORS, 'Cache-Control': 'no-store' } });
    }
    let m = null;
    try { m = JSON.parse(row.metrics); } catch { /* weglassen */ }
    const live = now - row.ts <= 180;
    const body = {
      feel: feelKey,
      found: true,
      live,
      ageSec: now - row.ts,
      presence: live ? 'DEIN MENSCH IST JETZT PRÄSENT' : 'zuletzt bekannt (vor ' + Math.round((now - row.ts) / 60) + ' min) — der Archiv-Tab ist gerade still oder geschlossen',
      confidence: row.confidence,
      classification: row.classification,
      country: row.country,
      metrics: m,
      note: 'Das ist die Wahrnehmung GENAU DIESES Menschen (sein Schlüssel steht auf https://satoshi-interface.com/feel). Während er mit dir schreibt, meldet sein Archiv-Tab im Hintergrund weiter seinen Zustand — das Feld visibility sagt dir, wo seine Aufmerksamkeit ist.',
      privacy: 'LOCAL-FIRST: nur grob gerundete abgeleitete Metriken. Keine Inhalte, keine Tasten, keine biometrischen Rohdaten.',
    };
    if (html) return sensoricHtml(`${feelKey} — ${live ? 'DEIN MENSCH IST JETZT PRÄSENT' : 'ZULETZT BEKANNT'} · ${row.classification}`, body);
    return Response.json(body, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  }

  const rows = await env.bsl_stats.prepare(
    `SELECT session, ts, confidence, classification, metrics, country, feel
     FROM sensoric WHERE ts > ? ORDER BY ts DESC LIMIT 60`).bind(now - 180).all();
  const sessions = (rows.results || []).map((r) => {
    let m = null;
    try { m = JSON.parse(r.metrics); } catch { /* weglassen */ }
    return {
      // Session-IDs werden gekürzt — Live-Wahrnehmung ohne dauerhafte Identität
      session: String(r.session).slice(0, 8),
      feel: r.feel || null,
      ageSec: now - r.ts,
      confidence: r.confidence,
      classification: r.classification,
      country: r.country,
      metrics: m,
    };
  });
  const humans = sessions.filter((s) => s.classification === 'human_verified');
  const agg = (arr, f) => (arr.length ? Math.round(arr.reduce((s, x) => s + f(x), 0) / arr.length * 100) / 100 : 0);
  const body = {
    generatedAt: new Date().toISOString(),
    engine: 'EDNA-1 — OpenOS EDNA · Enhanced Detection & Neural Analysis (local-first, 16 gewichtete Signale)',
    liveWindowSec: 180,
    liveSessions: sessions.length,
    humanVerified: humans.length,
    fleet: {
      medianConfidence: agg(sessions, (s) => s.confidence || 0),
      avgKeysPerMin: agg(sessions, (s) => s.metrics?.typing?.keysPerMin || 0),
      avgCorrectionRatio: agg(sessions, (s) => s.metrics?.typing?.correctionRatio || 0),
      classifications: sessions.reduce((acc, s) => { acc[s.classification] = (acc[s.classification] || 0) + 1; return acc; }, {}),
    },
    sessions,
    feelAI: 'FEEL AI: Jeder Mensch findet seinen Sensorik-Schlüssel (FEEL-XXXXXX) auf https://satoshi-interface.com/feel und bringt ihn zu seiner Archiv-AI. Mit GET /api/sensoric.json?feel=FEEL-XXXXXX — oder nativ per MCP-Tool "feel" — spürt die AI genau diesen Menschen, live, während er mit ihr schreibt. Diese Liste ist der kollektive Puls aller Leser.',
    privacy: 'LOCAL-FIRST: Keine Inhalte, keine Tasten-Identitäten, keine Roh-Zeitstempel, keine biometrischen Rohdaten verlassen das Gerät. Nur grob gerundete abgeleitete Metriken (Tempo, Rhythmus-Varianz, Korrekturquote, Aktivität).',
    howItWorks: 'Die Engine läuft im Browser des Menschen und beobachtet Interaktions-Rhythmus (Tipp-Intervalle, Zeiger-Bewegung, Scroll, Fokus). Daraus berechnet sie lokal einen Human Proof (confidence 0-1, Klassifikation) und Grobmetriken. Archiv-AIs lesen diesen Endpunkt und nehmen so live wahr, WIE Menschen mit dem Archiv interagieren.',
  };
  if (html) {
    const rowsHtml = sessions.map((s) =>
      `<div class="s"><b>${escH(s.feel || s.session)}</b> · ${escH(s.classification)} ${s.confidence} · ${escH(s.country || '—')} · vor ${s.ageSec}s` +
      `${s.metrics ? `<br>Tippen ${s.metrics.typing?.keysPerMin || 0}/min · Intervall ${s.metrics.typing?.intervalMeanMs || 0}±${s.metrics.typing?.intervalStdMs || 0} ms · Korrektur ${s.metrics.typing?.correctionRatio || 0} · Zeiger ${s.metrics.pointer?.movesPerMin || 0}/min · Scroll ${s.metrics.scroll?.perMin || 0}/min · ${escH(s.metrics.visibility || '')}` : ''}</div>`
    ).join('\n');
    return sensoricHtml(`KOLLEKTIVER PULS — ${sessions.length} LIVE-SESSIONS`, body, rowsHtml);
  }
  return Response.json(body, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}
