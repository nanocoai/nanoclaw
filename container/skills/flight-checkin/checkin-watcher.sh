#!/usr/bin/env bash
# Hourly Gmail watcher for airline check-in reminder emails.
# Intended as the `script` of a schedule_task recurring task — see SKILL.md.
# Prints {"wakeAgent": true, data: {...}} when a new reminder email is found,
# {"wakeAgent": false} otherwise. Fail-safe: any error, non-OK response, or
# timeout resolves to wakeAgent:false — a watcher script must never hang.
node --input-type=module << 'SCRIPT'
import { readFileSync, existsSync } from 'fs';
const PROCESSED = '/workspace/agent/.checkin_processed.json';
const processed = existsSync(PROCESSED) ? JSON.parse(readFileSync(PROCESSED, 'utf-8')) : [];
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
try {
  const threeHoursAgo = Math.floor((Date.now() - 3 * 3600 * 1000) / 1000);
  const query = `subject:("check-in" OR "check in" OR checkin) (flight OR boarding OR airline OR airways) after:${threeHoursAgo}`;
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=5`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) out({ wakeAgent: false });
  const data = await r.json();
  const msgs = (data.messages || []).filter(m => !processed.includes(m.id));
  if (msgs.length === 0) out({ wakeAgent: false });
  const msgR = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgs[0].id}?format=full`, { signal: AbortSignal.timeout(30000) });
  const msg = await msgR.json();
  const headers = msg.payload?.headers || [];
  const subject = headers.find(h => h.name === 'Subject')?.value || '';
  const from = headers.find(h => h.name === 'From')?.value || '';
  let body = msg.snippet || '';
  const parts = msg.payload?.parts || [msg.payload];
  for (const part of parts) { if (part?.mimeType === 'text/plain' && part?.body?.data) { body = Buffer.from(part.body.data, 'base64').toString('utf-8'); break; } }
  out({ wakeAgent: true, data: { emailId: msgs[0].id, from, subject, bodyPreview: body.slice(0, 4000) } });
} catch {
  out({ wakeAgent: false });
}
SCRIPT
