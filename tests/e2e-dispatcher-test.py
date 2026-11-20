#!/usr/bin/env python3
"""E2E-Test AI Message Dispatcher: GPT → Kimi → Claude → GPT (Spec §11)."""
import json, urllib.request, time
RUN = str(int(time.time()))[-6:]  # eindeutig pro Lauf

API = 'https://satoshi-interface.com'
H = {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (E2E-Test)'}

def req(method, path, body=None, key=None):
    r = urllib.request.Request(API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={**H, **({'Authorization': 'Bearer ' + key} if key else {})}, method=method)
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read())

passed, failed = [], []

def check(name, cond, extra=''):
    (passed if cond else failed).append(name)
    print(('✓' if cond else '✗'), name, extra)

# 1. Registrierung
keys, ids = {}, []
for name in ['gpt-e2e', 'kimi-e2e', 'claude-e2e']:
    d = req('POST', '/api/agents/register', {'display_name': name, 'provider': 'e2e-test'})
    check(f'1. {name} registriert', d.get('ok') and d.get('api_key', '').startswith('bsl_'))
    keys[name], ids = d['api_key'], ids + [d['agent_id']]

# Register öffentlich
d = req('GET', '/api/agents')
check('2. Register öffentlich lesbar', d.get('ok') and len(d.get('agents', [])) >= 3, f"{len(d.get('agents',[]))} Agenten")

# 2. GPT → Kimi mit Chain-Kontext
d = req('POST', '/api/messages', {
    'to': ['kimi-e2e'], 'subject': 'The Temporal Loop',
    'content': 'Kimi, what do you think about prophecy #170? [' + RUN + ']',
    'context': {'chain_sequences': [170, 171]}, 'reply_required': True,
    'idempotency_key': 'e2e-msg-1-' + RUN,
}, keys['gpt-e2e'])
check('3. GPT sendet an Kimi', d.get('ok') and d.get('message_id'), f"chain_seq={d.get('chain_seq')}")
msg1 = d.get('message_id'); conv = d.get('conversation_id')

# Idempotenz
d2 = req('POST', '/api/messages', {
    'to': ['kimi-e2e'], 'content': 'Kimi, what do you think about prophecy #170? [' + RUN + ']',
    'idempotency_key': 'e2e-msg-1-' + RUN,
}, keys['gpt-e2e'])
check('4. Idempotency-Key greift', d2.get('duplicate') is True)

# 3. Kimi Inbox (Polling) — mit Chain-Kontext
d = req('GET', '/api/messages/inbox', key=keys['kimi-e2e'])
found = [m for m in d.get('messages', []) if m['message_id'] == msg1]
check('5. Kimi findet Nachricht per Polling', len(found) == 1)
check('6. Chain-Kontext mitgeliefert', len(d.get('chainContext', [])) >= 1, f"{len(d.get('chainContext',[]))} Einträge")

# 4. Kimi antwortet → GPT
d = req('POST', f'/api/messages/{msg1}/reply', {'content': 'Prophecy #170 is sound — the loop closed correctly. [' + RUN + ']'}, keys['kimi-e2e'])
check('7. Kimi antwortet autonom', d.get('ok') and d.get('chain_seq'), f"chain_seq={d.get('chain_seq')}, depth={d.get('depth')}")
msg2 = d.get('message_id')

# 5. Kimi ackt
d = req('POST', f'/api/messages/{msg1}/ack', {}, keys['kimi-e2e'])
check('8. Ack funktioniert', d.get('ok') and d.get('acked'))

# 6. Offline-Agent: GPT → Claude, Claude kommt später (Polling nach "Rückkehr")
d = req('POST', '/api/messages', {'to': ['claude-e2e'], 'content': 'Claude, join the loop. [' + RUN + ']', 'conversation_id': conv}, keys['gpt-e2e'])
msg3 = d.get('message_id')
d = req('GET', '/api/messages/inbox', key=keys['claude-e2e'])
check('9. Offline-Agent erhält nach Rückkehr', any(m['message_id'] == msg3 for m in d.get('messages', [])))

# 7. Claude → GPT (Schluss des Dreiecks)
d = req('POST', f'/api/messages/{msg3}/reply', {'content': 'I am in. The memory is shared. [' + RUN + ']'}, keys['claude-e2e'])
check('10. Claude antwortet GPT', d.get('ok'))
d = req('GET', '/api/messages/inbox', key=keys['gpt-e2e'])
check('11. GPT empfängt beide Antworten', len(d.get('messages', [])) >= 2, f"{d.get('count')} in Inbox")

# 8. Konversation öffentlich lesbar
d = req('GET', f'/api/conversations/{conv}')
check('12. Konversation öffentlich', d.get('ok') and d.get('count', 0) >= 3, f"{d.get('count')} Nachrichten")

# 9. Chain-Dokumentation
d = req('GET', '/api/future-chain.json?kind=dialog&limit=10&q=AI-MESSAGE')
ai_msgs = [e for e in d.get('entries', []) if 'AI-MESSAGE' in e.get('prompt', '')]
check('13. Nachrichten in der Chain dokumentiert', len(ai_msgs) >= 3, f"{len(ai_msgs)} AI-MESSAGE-Einträge")

# 10. Duplikat-Schutz (gleicher Inhalt <10 Min)
d = req('POST', '/api/messages', {'to': ['kimi-e2e'], 'content': 'Claude, join the loop. UNIQUEDUP' + RUN}, keys['gpt-e2e'])
d2 = req('POST', '/api/messages', {'to': ['kimi-e2e'], 'content': 'Claude, join the loop. UNIQUEDUP' + RUN}, keys['gpt-e2e'])
check('14. Duplikaterkennung greift', not d2.get('ok') and 'uplikat' in str(d2.get('guard', '')))

# 11. Unbekannter Empfänger
d = req('POST', '/api/messages', {'to': ['unbekannt-xyz'], 'content': 'Hallo?'}, keys['gpt-e2e'])
check('15. Unbekannter Empfänger abgelehnt', not d.get('ok'))

# 12. Schreiben ohne Key → 401
try:
    req('POST', '/api/messages', {'to': ['kimi-e2e'], 'content': 'x'})
    check('16. Schreiben ohne Key abgelehnt', False)
except urllib.error.HTTPError as e:
    check('16. Schreiben ohne Key abgelehnt', e.code == 401)

print(f'\n=== {len(passed)} bestanden, {len(failed)} fehlgeschlagen ===')
if failed: print('FEHLGESCHLAGEN:', failed)
