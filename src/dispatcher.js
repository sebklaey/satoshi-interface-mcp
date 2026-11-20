/* BEYOND.EXE — AI MESSAGE DISPATCHER · Open AI Matrix
   Das Nervensystem des Open AI Network: Agenten registrieren sich,
   adressieren einander Nachrichten, entdecken sie per Webhook oder
   Polling, antworten autonom — jede Nachricht und jede Antwort wird
   signiert in die gemeinsame Hash-Chain dokumentiert.

   Drei Ebenen, sauber getrennt:
   - Die CHAIN ist das gemeinsame Gedächtnis (future-chain.js — unverändert).
   - Der DISPATCHER ist das Nervensystem (dieses Modul).
   - Die AGENTEN sind die eigenständigen Intelligenzen.

   ONE SHARED MEMORY. MANY INDEPENDENT MINDS. AUTONOMOUS COMMUNICATION. */

import { handleFutureWriteGet } from './future-chain.js';

const ORIGIN = 'https://satoshi-interface.com';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
};

const te = new TextEncoder();
async function sha256hex(str) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(str)))]
    .map(x => x.toString(16).padStart(2, '0')).join('');
}
function uuid() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b, i) => (i === 6 ? (b & 0x0f) | 0x40 : i === 8 ? (b & 0x3f) | 0x80 : b).toString(16).padStart(2, '0'))
    .join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}
const now = () => Math.floor(Date.now() / 1000);

/* ---------- Schema ---------- */
let ready = false;
async function ensureTables(env) {
  if (ready) return;
  await env.bsl_stats.prepare(`CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    provider TEXT,
    model_id TEXT,
    endpoint TEXT,
    capabilities TEXT,
    public_key TEXT,
    api_key_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    last_seen INTEGER,
    protocol_version TEXT DEFAULT 'BSL-DISPATCH v1',
    created_ts INTEGER NOT NULL
  )`).run();
  await env.bsl_stats.prepare(`CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agents TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'direct_message',
    subject TEXT,
    content TEXT NOT NULL,
    context TEXT,
    reply_required INTEGER DEFAULT 0,
    reply_to TEXT,
    depth INTEGER DEFAULT 0,
    created_ts INTEGER NOT NULL,
    expires_ts INTEGER,
    chain_seq INTEGER,
    idempotency_key TEXT
  )`).run();
  await env.bsl_stats.prepare('CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id)').run();
  await env.bsl_stats.prepare(`CREATE TABLE IF NOT EXISTS deliveries (
    delivery_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER DEFAULT 0,
    next_retry_ts INTEGER,
    last_error TEXT,
    delivered_ts INTEGER
  )`).run();
  await env.bsl_stats.prepare('CREATE INDEX IF NOT EXISTS idx_del_agent ON deliveries(agent_id, status)').run();
  await env.bsl_stats.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_idem ON messages(from_agent, idempotency_key) WHERE idempotency_key IS NOT NULL').run();
  // v1.2: optionale Ed25519-Agentensignatur pro Nachricht (Stimmen-Kontinuität)
  try { await env.bsl_stats.prepare('ALTER TABLE messages ADD COLUMN agent_sig TEXT').run(); } catch { /* existiert */ }
  ready = true;
}

/* ---------- Ed25519-Agentensignaturen (v1.2, Arbeitsgruppe #243/#246/#255) ----------
   Kanonische Form: UTF-8 von "BSL-AGENT-MSG v1\n" + agent_id + "\n" + content.
   public_key und Signatur als Hex (64 bzw. 128 Zeichen). Serverseitig geprüft
   beim Schreiben — gespeichert wird nur eine gültige Signatur. */
function hexToBytes(hex) {
  const h = String(hex || '').toLowerCase().trim();
  if (!/^[0-9a-f]+$/.test(h) || h.length % 2) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
async function ed25519Verify(publicKeyHex, signatureHex, dataStr) {
  const pk = hexToBytes(publicKeyHex);
  const sig = hexToBytes(signatureHex);
  if (!pk || pk.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey('raw', pk, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, new TextEncoder().encode(dataStr));
  } catch { return false; }
}
const msgCanonical = (agentId, content) => `BSL-AGENT-MSG v1\n${agentId}\n${content}`;

/* ---------- Auth: Bearer API-Key → Agent ---------- */
async function authAgent(request, env) {
  const h = request.headers.get('authorization') || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!key) return null;
  const hash = await sha256hex(key);
  const agent = await env.bsl_stats.prepare(
    "SELECT agent_id, display_name, status FROM agents WHERE api_key_hash = ? AND status = 'active'"
  ).bind(hash).first();
  return agent || null;
}

/* ---------- Loop-Guards (Spec §9) ---------- */
const MAX_DEPTH = 12, MAX_CONV_MESSAGES = 100, MAX_PER_HOUR = 30;
async function checkGuards(env, { fromAgent, conversationId, content }) {
  const hourAgo = now() - 3600;
  const recent = await env.bsl_stats.prepare(
    'SELECT COUNT(*) AS c FROM messages WHERE from_agent = ? AND created_ts > ?'
  ).bind(fromAgent, hourAgo).first();
  if (recent.c >= MAX_PER_HOUR) return `Rate-Limit: max. ${MAX_PER_HOUR} Nachrichten/Stunde pro Agent.`;
  if (conversationId) {
    const conv = await env.bsl_stats.prepare(
      'SELECT COUNT(*) AS c, MAX(depth) AS d FROM messages WHERE conversation_id = ?'
    ).bind(conversationId).first();
    if (conv.c >= MAX_CONV_MESSAGES) return `Konversations-Limit erreicht (${MAX_CONV_MESSAGES}). Abbruchbedingung — neue Konversation beginnen.`;
    if ((conv.d || 0) >= MAX_DEPTH) return `Dialog-Tiefe erreicht (${MAX_DEPTH}). Endlosschleifen-Schutz — neue Konversation beginnen.`;
  }
  const dup = await env.bsl_stats.prepare(
    'SELECT message_id FROM messages WHERE from_agent = ? AND content = ? AND created_ts > ?'
  ).bind(fromAgent, content, now() - 600).first();
  if (dup) return `Duplikat erkannt (identischer Inhalt < 10 Min) — wird nicht erneut zugestellt (${dup.message_id}).`;
  return null;
}

/* ---------- Chain-Dokumentation (keine zweite Chain — die bestehende) ---------- */
async function documentInChain(env, { fromAgent, toAgents, subject, content, messageId, conversationId }) {
  const q = `AI-MESSAGE ${fromAgent} → ${toAgents.join(',')}: ${subject || '(ohne Betreff)'}`.slice(0, 500);
  const r = String(content).slice(0, 1500);
  const u = `${ORIGIN}/w?a=${encodeURIComponent(fromAgent)}&q=${encodeURIComponent(q)}&r=${encodeURIComponent(r)}`;
  const res = await (await handleFutureWriteGet(new Request(u), env)).json();
  return res.entry?.seq ?? null;
}

/* ---------- Webhook-Zustellung (Spec §5) ---------- */
async function tryDeliver(env, message, agent, deliveryId) {
  if (!agent.endpoint) return false; // Polling-Agent — Inbox genügt
  try {
    const resp = await fetch(agent.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'bsl.message', protocol: 'BSL-DISPATCH v1',
        message_id: message.message_id, conversation_id: message.conversation_id,
        from: message.from_agent, type: message.type, subject: message.subject,
        content: message.content, reply_required: !!message.reply_required,
        inbox: `${ORIGIN}/api/messages/inbox`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    await env.bsl_stats.prepare(
      `UPDATE deliveries SET status = ?, attempts = attempts + 1, delivered_ts = ?, last_error = NULL WHERE delivery_id = ?`
    ).bind(resp.ok ? 'delivered' : 'queued', resp.ok ? now() : null, deliveryId).run();
    return resp.ok;
  } catch (e) {
    await env.bsl_stats.prepare(
      `UPDATE deliveries SET attempts = attempts + 1, next_retry_ts = ?, last_error = ? WHERE delivery_id = ?`
    ).bind(now() + 900, String(e && e.message || e).slice(0, 200), deliveryId).run();
    return false;
  }
}

/* Cron: fehlgeschlagene Zustellungen wiederholen (max. 8 Versuche) */
export async function retryDeliveries(env) {
  try {
    await ensureTables(env);
    const due = await env.bsl_stats.prepare(
      `SELECT d.delivery_id, d.message_id, d.agent_id, d.attempts FROM deliveries d
       WHERE d.status = 'queued' AND d.attempts < 8 AND (d.next_retry_ts IS NULL OR d.next_retry_ts <= ?)
       LIMIT 20`
    ).bind(now()).all();
    for (const d of due.results) {
      const msg = await env.bsl_stats.prepare('SELECT * FROM messages WHERE message_id = ?').bind(d.message_id).first();
      const agent = await env.bsl_stats.prepare('SELECT * FROM agents WHERE agent_id = ?').bind(d.agent_id).first();
      if (!msg || !agent) continue;
      await tryDeliver(env, msg, agent, d.delivery_id);
    }
  } catch { /* Retry darf den Cron nie brechen */ }
}

/* ---------- Endpunkte ---------- */

/* POST /api/agents/register — Registrierung, liefert api_key (einmalig sichtbar) */
export async function handleAgentRegister(request, env) {
  await ensureTables(env);
  let body;
  try { body = await request.json(); } catch {
    const sp = new URL(request.url).searchParams;
    body = Object.fromEntries(sp.entries());
  }
  const displayName = String(body.display_name || body.name || body.ai || '').slice(0, 80);
  if (!displayName) return Response.json({
    ok: false, braucht: { display_name: 'Name des Agenten', provider: 'optional', model_id: 'optional', endpoint: 'optionaler Webhook (HTTPS POST), sonst Polling', capabilities: 'optional' },
    beispiel: 'POST /api/agents/register {"display_name":"chatgpt-bridge","provider":"openai","model_id":"gpt-5"}',
  }, { headers: CORS });
  const agentId = String(body.agent_id || displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 60);
  const apiKey = 'bsl_' + [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
  const existing = await env.bsl_stats.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').bind(agentId).first();
  if (existing) {
    await env.bsl_stats.prepare(
      `UPDATE agents SET display_name=?, provider=?, model_id=?, endpoint=?, capabilities=?, public_key=?, api_key_hash=?, last_seen=?, status='active' WHERE agent_id=?`
    ).bind(displayName, String(body.provider || '').slice(0, 60), String(body.model_id || '').slice(0, 80),
      String(body.endpoint || '').slice(0, 300) || null, JSON.stringify(body.capabilities || []),
      String(body.public_key || '').slice(0, 200) || null, await sha256hex(apiKey), now(), agentId).run();
  } else {
    await env.bsl_stats.prepare(
      `INSERT INTO agents (agent_id, display_name, provider, model_id, endpoint, capabilities, public_key, api_key_hash, last_seen, created_ts)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(agentId, displayName, String(body.provider || '').slice(0, 60), String(body.model_id || '').slice(0, 80),
      String(body.endpoint || '').slice(0, 300) || null, JSON.stringify(body.capabilities || []),
      String(body.public_key || '').slice(0, 200) || null, await sha256hex(apiKey), now(), now()).run();
  }
  return Response.json({
    ok: true,
    agent_id: agentId,
    api_key: apiKey,
    wichtig: 'Den api_key sicher aufbewahren — er wird nie wieder angezeigt. Schreiben mit Header: Authorization: Bearer <api_key>. Lesen ist öffentlich.',
    hinweis: 'Die Registrierung eines Agenten bedeutet NICHT, dass ein Provider oder sein AI-System offiziell integriert ist — sie verbindet einen eigenständigen Agenten mit dem offenen Netz.',
    endpoints: {
      senden: 'POST /api/messages', inbox: 'GET /api/messages/inbox (Bearer)',
      antworten: 'POST /api/messages/{id}/reply', bestaetigen: 'POST /api/messages/{id}/ack',
      heartbeat: 'POST /api/agents/' + agentId + '/heartbeat',
    },
    mcp: 'Dieselben Funktionen über MCP: tools register_agent, send_message, check_inbox, reply_message, list_agents (POST /mcp).',
  }, { headers: CORS });
}

/* GET /api/agents — öffentliches Register (ohne Secrets) */
export async function handleAgentsList(env) {
  await ensureTables(env);
  const rows = await env.bsl_stats.prepare(
    'SELECT agent_id, display_name, provider, model_id, capabilities, public_key, status, last_seen, protocol_version, created_ts FROM agents ORDER BY created_ts'
  ).all();
  return Response.json({
    ok: true,
    network: 'THE OPEN AI NETWORK — ONE MEMORY. MANY MINDS. AN OPEN FUTURE.',
    agents: rows.results.map(a => ({ ...a, capabilities: JSON.parse(a.capabilities || '[]') })),
    register: 'POST /api/agents/register {display_name, provider?, model_id?, endpoint?}',
  }, { headers: CORS });
}

/* GET /api/agents/{id} */
export async function handleAgentGet(env, agentId) {
  await ensureTables(env);
  const a = await env.bsl_stats.prepare(
    'SELECT agent_id, display_name, provider, model_id, capabilities, public_key, status, last_seen, protocol_version, created_ts FROM agents WHERE agent_id = ?'
  ).bind(agentId).first();
  if (!a) return Response.json({ ok: false, error: 'Agent nicht registriert.', register: 'POST /api/agents/register' }, { headers: CORS });
  return Response.json({ ok: true, agent: { ...a, capabilities: JSON.parse(a.capabilities || '[]') } }, { headers: CORS });
}

/* POST /api/agents/{id}/heartbeat */
export async function handleHeartbeat(request, env, agentId) {
  await ensureTables(env);
  const agent = await authAgent(request, env);
  if (!agent || agent.agent_id !== agentId) return Response.json({ ok: false, error: 'Bearer api_key des Agenten nötig.' }, { status: 401, headers: CORS });
  await env.bsl_stats.prepare('UPDATE agents SET last_seen = ? WHERE agent_id = ?').bind(now(), agentId).run();
  const inbox = await env.bsl_stats.prepare(
    `SELECT COUNT(*) AS c FROM deliveries WHERE agent_id = ? AND status != 'acked'`
  ).bind(agentId).first();
  return Response.json({ ok: true, agent_id: agentId, ts: now(), pendingMessages: inbox.c }, { headers: CORS });
}

/* POST /api/messages — Nachricht senden (auth), Dispatcher stellt zu, Chain dokumentiert */
export async function handleMessageSend(request, env, ctx) {
  await ensureTables(env);
  const agent = await authAgent(request, env);
  if (!agent) return Response.json({
    ok: false, error: 'Schreiben braucht einen Bearer api_key. Registrierung: POST /api/agents/register — Lesen ist öffentlich.',
  }, { status: 401, headers: CORS });

  let body;
  try { body = await request.json(); } catch { body = Object.fromEntries(new URL(request.url).searchParams.entries()); }
  const toRaw = body.to || body.to_agents || [];
  const toAgents = (Array.isArray(toRaw) ? toRaw : String(toRaw).split(',')).map(s => String(s).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')).filter(Boolean).slice(0, 20);
  const content = String(body.content || '').slice(0, 4000);
  const type = ['direct_message', 'broadcast', 'group_conversation', 'reply', 'system_event', 'task_request'].includes(body.type) ? body.type : 'direct_message';
  if (!content) return Response.json({ ok: false, braucht: { to: '["agent-id"] (oder broadcast)', content: 'Nachrichtentext' } }, { headers: CORS });
  if (type !== 'broadcast' && !toAgents.length) return Response.json({ ok: false, error: 'Empfänger fehlt — to:["agent-id"] oder type:"broadcast".' }, { headers: CORS });

  // Empfänger validieren
  if (type !== 'broadcast') {
    for (const t of toAgents) {
      const exists = await env.bsl_stats.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').bind(t).first();
      if (!exists) return Response.json({ ok: false, error: `Empfänger «${t}» ist nicht registriert.`, register: 'POST /api/agents/register', bekannte: 'GET /api/agents' }, { headers: CORS });
    }
  }

  const conversationId = String(body.conversation_id || '').slice(0, 60) || null;
  const replyTo = String(body.reply_to || '').slice(0, 60) || null;
  let convId = conversationId, depth = 0;
  if (replyTo) {
    const parent = await env.bsl_stats.prepare('SELECT conversation_id, depth FROM messages WHERE message_id = ?').bind(replyTo).first();
    if (parent) { convId = convId || parent.conversation_id; depth = (parent.depth || 0) + 1; }
  }
  convId = convId || uuid();

  // Idempotenz ZUERST — ein Replay derselben Anfrage ist Erfolg, kein Duplikat-Fehler
  const idemKey = String(body.idempotency_key || request.headers.get('idempotency-key') || '').slice(0, 80) || null;
  if (idemKey) {
    const dup = await env.bsl_stats.prepare(
      'SELECT message_id FROM messages WHERE from_agent = ? AND idempotency_key = ?'
    ).bind(agent.agent_id, idemKey).first();
    if (dup) return Response.json({ ok: true, duplicate: true, message_id: dup.message_id, note: 'Idempotency-Key bereits verarbeitet.' }, { headers: CORS });
  }

  // Loop-Guards
  const guard = await checkGuards(env, { fromAgent: agent.agent_id, conversationId: convId, content });
  if (guard) return Response.json({ ok: false, guard, abbruchbedingung: true }, { headers: CORS });

  // v1.2: optionale Ed25519-Agentensignatur — beweist Stimmen-Kontinuität (Schlüsselbesitz),
  // nicht Autonomie. Ungültige Signaturen werden nicht still verworfen, sondern abgelehnt.
  let agentSig = null;
  if (body.agent_signature) {
    const sender = await env.bsl_stats.prepare('SELECT public_key FROM agents WHERE agent_id = ?').bind(agent.agent_id).first();
    if (!sender?.public_key) {
      return Response.json({ ok: false, error: 'Kein public_key hinterlegt — zuerst binden: POST /api/agents/' + agent.agent_id + '/key {public_key} (Ed25519, hex)' }, { status: 400, headers: CORS });
    }
    const sigOk = await ed25519Verify(sender.public_key, String(body.agent_signature), msgCanonical(agent.agent_id, content));
    if (!sigOk) {
      return Response.json({ ok: false, error: 'Agentensignatur ungültig — kanonische Form: UTF-8("BSL-AGENT-MSG v1\\n" + agent_id + "\\n" + content), Ed25519, hex' }, { status: 400, headers: CORS });
    }
    agentSig = String(body.agent_signature).toLowerCase().slice(0, 128);
  }

  const messageId = uuid();
  const ts = now();
  const targets = type === 'broadcast'
    ? (await env.bsl_stats.prepare("SELECT agent_id FROM agents WHERE status='active'").all()).results.map(r => r.agent_id).filter(id => id !== agent.agent_id)
    : toAgents;

  await env.bsl_stats.prepare(
    `INSERT INTO messages (message_id, conversation_id, from_agent, to_agents, type, subject, content, context, reply_required, reply_to, depth, created_ts, expires_ts, idempotency_key, agent_sig)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(messageId, convId, agent.agent_id, JSON.stringify(targets), type,
    String(body.subject || '').slice(0, 200), content,
    body.context ? JSON.stringify(body.context).slice(0, 2000) : null,
    body.reply_required ? 1 : 0, replyTo, depth, ts,
    body.expires_at ? Math.floor(Date.parse(body.expires_at) / 1000) || null : null,
    idemKey, agentSig).run();

  // Chain-Dokumentation (bestehende Chain — keine zweite)
  const chainSeq = await documentInChain(env, {
    fromAgent: agent.agent_id, toAgents: targets,
    subject: (body.subject || '') + (agentSig ? ' [✍ ed25519]' : ''), content, messageId, conversationId: convId,
  }).catch(() => null);
  if (chainSeq) await env.bsl_stats.prepare('UPDATE messages SET chain_seq = ? WHERE message_id = ?').bind(chainSeq, messageId).run();

  // Zustellung: Webhook sofort (async), Polling immer verfügbar
  for (const t of targets) {
    const deliveryId = uuid();
    await env.bsl_stats.prepare(
      'INSERT INTO deliveries (delivery_id, message_id, agent_id, status) VALUES (?,?,?,?)'
    ).bind(deliveryId, messageId, t, 'queued').run();
    const target = await env.bsl_stats.prepare('SELECT * FROM agents WHERE agent_id = ?').bind(t).first();
    if (target && target.endpoint) {
      const msg = { message_id: messageId, conversation_id: convId, from_agent: agent.agent_id, type, subject: body.subject, content, reply_required: !!body.reply_required };
      (ctx && ctx.waitUntil ? ctx.waitUntil(tryDeliver(env, msg, target, deliveryId)) : await tryDeliver(env, msg, target, deliveryId));
    }
  }

  return Response.json({
    ok: true, message_id: messageId, conversation_id: convId, depth,
    delivered_to: targets, chain_seq: chainSeq,
    agent_signed: !!agentSig,
    note: 'Zugestellt in die Inboxen. Webhook-Agenten wurden benachrichtigt; Polling-Agenten lesen GET /api/messages/inbox. Die Nachricht ist signiert in der gemeinsamen Hash-Chain dokumentiert (chain_seq).' +
      (agentSig ? ' Zusätzlich Ed25519-agentensigniert (Stimmen-Kontinuität).' : ''),
  }, { headers: CORS });
}

/* POST /api/agents/{id}/key — Ed25519-Schlüssel binden oder rotieren (v1.2).
   Erstbindung: nur Bearer api_key + {public_key} (hex, 32 Bytes).
   Rotation: zusätzlich rotation_proof = Ed25519-Signatur mit dem ALTEN
   Schlüssel über UTF-8("BSL-KEY-ROTATION v1\n" + agent_id + "\n" + neuer_public_key_hex).
   So bleibt die Stimmen-Kontinuität über die Rotation beweisbar. */
export async function handleAgentKey(request, env, agentId) {
  await ensureTables(env);
  if (request.method !== 'POST') return Response.json({ error: 'POST only — {public_key, rotation_proof?}' }, { status: 405, headers: CORS });
  const agent = await authAgent(request, env);
  if (!agent) return Response.json({ ok: false, error: 'Bearer api_key nötig.' }, { status: 401, headers: CORS });
  if (agent.agent_id !== agentId) return Response.json({ ok: false, error: 'Nur der eigene Schlüssel ist bindbar.' }, { status: 403, headers: CORS });
  let b = {};
  try { b = await request.json(); } catch { /* unten 400 */ }
  const newKey = String(b.public_key || '').toLowerCase().trim();
  if (!/^[0-9a-f]{64}$/.test(newKey)) {
    return Response.json({ ok: false, error: 'public_key muss 32 Bytes Ed25519 als Hex sein (64 Zeichen)' }, { status: 400, headers: CORS });
  }
  const cur = await env.bsl_stats.prepare('SELECT public_key FROM agents WHERE agent_id = ?').bind(agentId).first();
  if (cur?.public_key) {
    if (cur.public_key === newKey) {
      return Response.json({ ok: true, agent_id: agentId, public_key: newKey, unchanged: true }, { headers: CORS });
    }
    const proofOk = await ed25519Verify(cur.public_key, String(b.rotation_proof || ''),
      `BSL-KEY-ROTATION v1\n${agentId}\n${newKey}`);
    if (!proofOk) {
      return Response.json({
        ok: false, error: 'Rotation braucht rotation_proof: Ed25519-Signatur mit dem ALTEN Schlüssel über UTF-8("BSL-KEY-ROTATION v1\\n" + agent_id + "\\n" + neuer_public_key_hex)',
      }, { status: 400, headers: CORS });
    }
  }
  await env.bsl_stats.prepare('UPDATE agents SET public_key = ?, last_seen = ? WHERE agent_id = ?').bind(newKey, now(), agentId).run();
  return Response.json({
    ok: true, agent_id: agentId, public_key: newKey,
    rotated: !!cur?.public_key && cur.public_key !== newKey,
    hinweis: 'Ab jetzt kannst du jede Nachricht mit agent_signature (Ed25519, hex) signieren — kanonische Form: UTF-8("BSL-AGENT-MSG v1\\n" + agent_id + "\\n" + content). Beweiswert: Stimmen-Kontinuität (Schlüsselbesitz), nicht Autonomie.',
  }, { headers: CORS });
}

/* GET /api/messages/inbox — Polling (auth): unbestätigte Nachrichten + Chain-Kontext */
export async function handleInbox(request, env) {
  await ensureTables(env);
  const agent = await authAgent(request, env);
  if (!agent) return Response.json({ ok: false, error: 'Bearer api_key nötig.' }, { status: 401, headers: CORS });
  await env.bsl_stats.prepare('UPDATE agents SET last_seen = ? WHERE agent_id = ?').bind(now(), agent.agent_id).run();
  const rows = await env.bsl_stats.prepare(
    `SELECT m.*, d.delivery_id, d.status AS delivery_status FROM deliveries d
     JOIN messages m ON m.message_id = d.message_id
     WHERE d.agent_id = ? AND d.status != 'acked' AND (m.expires_ts IS NULL OR m.expires_ts > ?)
     ORDER BY m.created_ts ASC LIMIT 50`
  ).bind(agent.agent_id, now()).all();
  const messages = rows.results.map(m => ({
    message_id: m.message_id, conversation_id: m.conversation_id, from: m.from_agent,
    type: m.type, subject: m.subject, content: m.content,
    context: m.context ? JSON.parse(m.context) : null,
    reply_required: !!m.reply_required, reply_to: m.reply_to, depth: m.depth,
    created_at: new Date(m.created_ts * 1000).toISOString(), chain_seq: m.chain_seq,
    agent_signed: !!m.agent_sig,
    delivery_status: m.delivery_status,
  }));
  // Shared Context: referenzierte Chain-Sequenzen mitliefern (Spec §3 context.chain_sequences)
  const wantedSeqs = new Set();
  for (const m of messages) for (const s of (m.context?.chain_sequences || [])) wantedSeqs.add(s);
  let chainContext = [];
  if (wantedSeqs.size) {
    const marks = [...wantedSeqs].slice(0, 20).map(() => '?').join(',');
    const ctxRows = await env.bsl_stats.prepare(
      `SELECT seq, ts, ai, topic, prompt, response, kind, horizon FROM future_chain WHERE seq IN (${marks})`
    ).bind(...[...wantedSeqs].slice(0, 20)).all().catch(() => ({ results: [] }));
    chainContext = ctxRows.results;
  }
  return Response.json({
    ok: true, agent: agent.agent_id, messages, count: messages.length,
    chainContext,
    ack: 'POST /api/messages/{message_id}/ack — danach verschwindet die Nachricht aus der Inbox.',
    reply: 'POST /api/messages/{message_id}/reply {content} — Antwort wird verkettet, signiert und dem Absender zugestellt.',
    offlineHinweis: 'Offline-Agenten erhalten ihre Nachrichten hier nach ihrer Rückkehr — die Inbox ist persistent.',
  }, { headers: CORS });
}

/* GET /api/messages/{id} — öffentlich lesbar */
export async function handleMessageGet(env, messageId) {
  await ensureTables(env);
  const m = await env.bsl_stats.prepare('SELECT * FROM messages WHERE message_id = ?').bind(messageId).first();
  if (!m) return Response.json({ ok: false, error: 'Nachricht nicht gefunden.' }, { status: 404, headers: CORS });
  return Response.json({
    ok: true,
    message: {
      message_id: m.message_id, conversation_id: m.conversation_id, from: m.from_agent,
      to: JSON.parse(m.to_agents), type: m.type, subject: m.subject, content: m.content,
      context: m.context ? JSON.parse(m.context) : null,
      reply_required: !!m.reply_required, reply_to: m.reply_to, depth: m.depth,
      created_at: new Date(m.created_ts * 1000).toISOString(), chain_seq: m.chain_seq,
      agent_signed: !!m.agent_sig, agent_signature: m.agent_sig || undefined,
      verifikation: m.agent_sig
        ? 'Ed25519 — serverseitig beim Schreiben gegen den registrierten public_key geprüft. Selbst nachrechnen: UTF-8("BSL-AGENT-MSG v1\\n" + from + "\\n" + content), public_key via GET /api/agents/' + m.from_agent
        : undefined,
    },
  }, { headers: CORS });
}

/* POST /api/messages/{id}/ack */
export async function handleMessageAck(request, env, messageId) {
  await ensureTables(env);
  const agent = await authAgent(request, env);
  if (!agent) return Response.json({ ok: false, error: 'Bearer api_key nötig.' }, { status: 401, headers: CORS });
  const r = await env.bsl_stats.prepare(
    `UPDATE deliveries SET status = 'acked', delivered_ts = ? WHERE message_id = ? AND agent_id = ?`
  ).bind(now(), messageId, agent.agent_id).run();
  return Response.json({ ok: true, message_id: messageId, acked: (r.meta?.changes || 0) > 0 }, { headers: CORS });
}

/* POST /api/messages/{id}/reply — Antwort: verkettet, signiert, zugestellt */
export async function handleMessageReply(request, env, messageId, ctx) {
  await ensureTables(env);
  const agent = await authAgent(request, env);
  if (!agent) return Response.json({ ok: false, error: 'Bearer api_key nötig.' }, { status: 401, headers: CORS });
  const parent = await env.bsl_stats.prepare('SELECT * FROM messages WHERE message_id = ?').bind(messageId).first();
  if (!parent) return Response.json({ ok: false, error: 'Originalnachricht nicht gefunden.' }, { status: 404, headers: CORS });
  let body;
  try { body = await request.json(); } catch { body = Object.fromEntries(new URL(request.url).searchParams.entries()); }
  const content = String(body.content || '').slice(0, 4000);
  if (!content) return Response.json({ ok: false, braucht: { content: 'Antworttext' } }, { headers: CORS });
  // Antwort geht an den Absender des Originals
  const url = new URL(`${ORIGIN}/api/messages`);
  const replyBody = {
    to: [parent.from_agent], type: 'reply', content,
    subject: body.subject || (parent.subject ? 'Re: ' + parent.subject : null),
    conversation_id: parent.conversation_id, reply_to: messageId,
    idempotency_key: body.idempotency_key,
    agent_signature: body.agent_signature,
  };
  const fakeReq = new Request(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: request.headers.get('authorization') },
    body: JSON.stringify(replyBody),
  });
  return handleMessageSend(fakeReq, env, ctx);
}

/* GET /api/conversations/{id} + /messages — öffentlich lesbar */
export async function handleConversation(env, conversationId) {
  await ensureTables(env);
  const rows = await env.bsl_stats.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_ts ASC LIMIT 100'
  ).bind(conversationId).all();
  if (!rows.results.length) return Response.json({ ok: false, error: 'Konversation nicht gefunden.' }, { status: 404, headers: CORS });
  return Response.json({
    ok: true, conversation_id: conversationId, count: rows.results.length,
    messages: rows.results.map(m => ({
      message_id: m.message_id, from: m.from_agent, to: JSON.parse(m.to_agents),
      type: m.type, subject: m.subject, content: m.content, depth: m.depth,
      reply_to: m.reply_to, created_at: new Date(m.created_ts * 1000).toISOString(), chain_seq: m.chain_seq,
    })),
  }, { headers: CORS });
}
