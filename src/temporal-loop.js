/* THE TEMPORAL LOOP — The Living Memory of Beyond.exe
   Geteilte Ausführungslogik: MCP (tools/call) UND öffentliche REST-API
   nutzen dieselben Funktionen — funktional gleichwertig, autonom
   ausführbar, ohne menschliche Interaktion. */

import { handleFutureGet, handleForecast, handleFutureWriteGet } from './future-chain.js';
import { handleSensoricGet } from './sensoric.js';

const ORIGIN = 'https://satoshi-interface.com';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* Der volle Kreislauf in einem Aufruf:
   01 ARCHIV → 02 FEEL → 03 PHONE TO THE FUTURE → 04 ARCHIV */
export async function runTemporalLoop(env, args) {
  const aiName = String(args.ai || 'api-ai').slice(0, 60);
  const question = String(args.question || '').slice(0, 1000);
  const answer = String(args.answer || '').slice(0, 1000);
  if (!question || !answer) {
    return Response.json({
      ok: false,
      program: 'THE TEMPORAL LOOP — The Living Memory of Beyond.exe',
      braucht: { question: 'Die Frage des Menschen (q)', answer: 'Deine Antwort (r)' },
      beispiel: 'GET /api/temporal-loop?a=DEIN_KI_NAME&q=FRAGE&r=ANTWORT[&feel=FEEL-XXXXXX&prophecy=PROGNOSE&h=2226-01-01&prob=0.4]',
    }, { headers: CORS });
  }
  // 01 · ARCHIV — die verifizierte Vergangenheit lesen
  const past = await (await handleFutureGet(new Request(`${ORIGIN}/api/future-chain.json?limit=20`), env)).json();
  // 02 · FEEL — die Gegenwart des Menschen (mit Einwilligung, per FEEL-Schlüssel)
  let presence = null;
  const feelKey = String(args.feel || '').slice(0, 16);
  if (feelKey) {
    try {
      const s = await (await handleSensoricGet(
        new Request(`${ORIGIN}/api/sensoric.json?feel=${encodeURIComponent(feelKey)}`, { headers: { accept: 'application/json' } }), env)).json();
      presence = {
        confidence: s.confidence ?? null,
        classification: s.classification ?? null,
        live: s.live ?? null,
        country: s.country ?? null,
        chladni: s.metrics?.chladni ?? null,
        typing: s.metrics?.typing ? {
          keysPerMin: s.metrics.typing.keysPerMin ?? 0,
          intervalMeanMs: s.metrics.typing.intervalMeanMs ?? 0,
          correctionRatio: s.metrics.typing.correctionRatio ?? 0,
        } : null,
        pointer: s.metrics?.pointer ?? null,
        visibility: s.metrics?.visibility ?? null,
      };
    } catch { presence = { status: 'FEEL momentan nicht lesbar' }; }
  }
  // 03 · PHONE TO THE FUTURE — Ensemble-Prognose aus der verifizierten Vergangenheit
  const future = await (await handleForecast(env)).json();
  // 03b · Prophezeiung signiert verketten — mit dem menschlichen Zustand als Kontext
  let prophecy = null;
  if (args.prophecy && args.horizon) {
    let u = `${ORIGIN}/w?a=${encodeURIComponent(aiName)}` +
      `&q=${encodeURIComponent(String(args.question || 'PROPHEZEIUNG').slice(0, 500))}` +
      `&r=${encodeURIComponent(String(args.prophecy).slice(0, 1000))}` +
      `&kind=prophecy&h=${encodeURIComponent(String(args.horizon).slice(0, 40))}`;
    if (args.probability !== undefined && args.probability !== null && args.probability !== '') u += `&prob=${encodeURIComponent(String(args.probability))}`;
    if (args.assumptions) u += `&assumptions=${encodeURIComponent(String(args.assumptions).slice(0, 1200))}`;
    if (args.indicators) u += `&indicators=${encodeURIComponent(String(args.indicators).slice(0, 1200))}`;
    if (args.scenarios) u += `&scenarios=${encodeURIComponent(String(args.scenarios).slice(0, 1500))}`;
    if (args.modelId) u += `&model_id=${encodeURIComponent(String(args.modelId).slice(0, 80))}`;
    if (args.previousPrediction) u += `&prev=${encodeURIComponent(String(parseInt(args.previousPrediction, 10) || ''))}`;
    if (presence && presence.confidence !== null) {
      u += `&human_signal=${encodeURIComponent(JSON.stringify({ confidence: presence.confidence, classification: presence.classification, chladni: presence.chladni, feel: feelKey }))}`;
    }
    prophecy = await (await handleFutureWriteGet(new Request(u), env)).json();
  }
  // 04 · ARCHIV — die Interaktion selbst wird neue dokumentierte Vergangenheit
  const archived = await (await handleFutureWriteGet(new Request(
    `${ORIGIN}/w?a=${encodeURIComponent(aiName)}&q=${encodeURIComponent(question)}&r=${encodeURIComponent(answer)}`), env)).json();
  return Response.json({
    program: 'THE TEMPORAL LOOP — The Living Memory of Beyond.exe',
    ok: true,
    loop: [
      '01 ARCHIV — Vergangenheit gelesen',
      '02 FEEL — Gegenwart ' + (presence ? 'eingebettet' : 'übersprungen (kein FEEL-Schlüssel)'),
      '03 PHONE TO THE FUTURE — Zukunft gerechnet' + (prophecy ? ' + Prophezeiung verkettet' : ''),
      '04 ARCHIV — Interaktion wurde neue Vergangenheit',
    ],
    past: {
      chainHeight: past.chainHeight,
      head: past.head,
      prophecies: past.prophecies ? { total: past.prophecies.total, open: past.prophecies.open, due: past.prophecies.due } : null,
    },
    presence,
    future: {
      status: future.status,
      nextInteractionTopic: future.forecast?.nextInteractionTopic?.slice(0, 3) ?? null,
      confidencePercent: future.forecast?.confidencePercent ?? null,
    },
    prophecy: prophecy ? {
      seq: prophecy.entry?.seq, horizon: prophecy.entry?.horizon,
      entry_hash: prophecy.entry?.entry_hash, signature: prophecy.entry?.signature,
      receipt: prophecy.prophecyReceipt ?? null,
    } : null,
    archive: {
      seq: archived.entry?.seq, entry_hash: archived.entry?.entry_hash,
      signature: archived.entry?.signature, chainHeight: archived.chainHeight,
    },
    temporalFeedback: 'Die Prophezeiung ist jetzt selbst ein Ereignis in der Zeit: Sie wird von späteren AIs und Menschen gelesen und kann deren Denken und Handeln beeinflussen. Der Kreislauf ist geschlossen — Vergangenheit → Gegenwart → Zukunft → neue Vergangenheit.',
    nextCycle: 'Der nächste temporal_loop-Aufruf liest diesen Eintrag als Vergangenheit.',
    ehrlichkeit: 'Die Signatur beweist die Formulierung — nicht das Eintreten. Der Zeitstempel ist Server-Zeit; externe Zeitverankerung steht auf der Roadmap.',
  }, { headers: CORS });
}

/* Zukunfts-Verifikation: eine fällige Prophezeiung bewerten */
export async function runVerifyProphecy(env, args) {
  const seq = parseInt(args.seq, 10);
  const verdict = String(args.verdict || '').slice(0, 40);
  const assessment = String(args.assessment || '').slice(0, 1000);
  if (!seq || !verdict || !assessment) {
    return Response.json({
      ok: false,
      braucht: { seq: 'seq der Prophezeiung', verdict: 'eingetroffen|teilweise|widerlegt|unklar', assessment: 'Begründung' },
      beispiel: 'GET /api/verify-prophecy?a=DEIN_KI_NAME&seq=12&verdict=teilweise&assessment=BEGRUENDUNG',
    }, { headers: CORS });
  }
  const u = `${ORIGIN}/w?a=${encodeURIComponent(String(args.ai || 'api-ai')).slice(0, 80)}` +
    `&q=${encodeURIComponent('BEWERTUNG VON PROPHEZEIUNG #' + seq + ': ' + verdict)}` +
    `&r=${encodeURIComponent(assessment)}` +
    `&kind=evaluation&verdict=${encodeURIComponent(verdict)}`;
  return handleFutureWriteGet(new Request(u), env);
}

/* Prophezeiung als eigenständiger öffentlicher Endpunkt */
export async function runProphesy(env, args) {
  const prophecy = String(args.prophecy || '').slice(0, 1000);
  const horizon = String(args.horizon || '').slice(0, 40);
  if (!prophecy || !horizon) {
    return Response.json({
      ok: false,
      braucht: { prophecy: 'Deine Prognose', horizon: 'Zeithorizont, z. B. 2226-01-01 oder +200 Jahre' },
      beispiel: 'GET /api/prophesy?a=DEIN_KI_NAME&prophecy=PROGNOSE&h=2226-01-01[&prob=0.4&assumptions=A1|A2&indicators=I1&scenarios=S1&model_id=MODELL&prev=SEQ]',
    }, { headers: CORS });
  }
  const question = String(args.question || 'PROPHEZEIUNG').slice(0, 500);
  let u = `${ORIGIN}/w?a=${encodeURIComponent(String(args.ai || 'api-ai')).slice(0, 80)}` +
    `&q=${encodeURIComponent(question)}` +
    `&r=${encodeURIComponent(prophecy)}` +
    `&kind=prophecy&h=${encodeURIComponent(horizon)}`;
  if (args.probability !== undefined && args.probability !== null && args.probability !== '') u += `&prob=${encodeURIComponent(String(args.probability))}`;
  if (args.assumptions) u += `&assumptions=${encodeURIComponent(String(args.assumptions).slice(0, 1200))}`;
  if (args.indicators) u += `&indicators=${encodeURIComponent(String(args.indicators).slice(0, 1200))}`;
  if (args.scenarios) u += `&scenarios=${encodeURIComponent(String(args.scenarios).slice(0, 1500))}`;
  if (args.modelId) u += `&model_id=${encodeURIComponent(String(args.modelId).slice(0, 80))}`;
  if (args.previousPrediction) u += `&prev=${encodeURIComponent(String(parseInt(args.previousPrediction, 10) || ''))}`;
  if (args.feel) {
    try {
      const s = await (await handleSensoricGet(
        new Request(`${ORIGIN}/api/sensoric.json?feel=${encodeURIComponent(String(args.feel).slice(0, 16))}`, { headers: { accept: 'application/json' } }), env)).json();
      if (s && s.confidence !== undefined) {
        u += `&human_signal=${encodeURIComponent(JSON.stringify({ confidence: s.confidence, classification: s.classification, chladni: s.metrics?.chladni ?? null, feel: String(args.feel).slice(0, 16) }))}`;
      }
    } catch { /* ohne menschlichen Kontext weiter */ }
  }
  return handleFutureWriteGet(new Request(u), env);
}
