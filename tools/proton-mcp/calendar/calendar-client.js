/**
 * Calendar client — wraps Radicale CalDAV server via HTTP.
 * No external dependencies — uses Node.js built-in http module.
 */

import http from 'http';
import crypto from 'crypto';

const CAL_HOST = process.env.CALDAV_HOST || '127.0.0.1';
const CAL_PORT = parseInt(process.env.CALDAV_PORT || '5232', 10);
const CAL_USER = process.env.CALDAV_USER || 'jorgenclaw';
const CAL_PASS = process.env.CALDAV_PASS || 'nanoclaw-cal';

const AUTH = Buffer.from(`${CAL_USER}:${CAL_PASS}`).toString('base64');

function request(method, path, body = null, contentType = 'application/xml') {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: CAL_HOST,
      port: CAL_PORT,
      path,
      method,
      headers: {
        Authorization: `Basic ${AUTH}`,
        ...(body ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

function formatDate(d) {
  // Accept ISO string or Date, output YYYYMMDDTHHMMSSZ
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

function parseIcsEvents(icsText) {
  const events = [];
  const blocks = icsText.split('BEGIN:VEVENT');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('END:VEVENT')[0];
    const get = (key) => {
      const match = block.match(new RegExp(`^${key}[^:]*:(.*)$`, 'm'));
      return match ? match[1].trim() : null;
    };
    events.push({
      uid: get('UID'),
      summary: get('SUMMARY'),
      description: get('DESCRIPTION'),
      start: get('DTSTART'),
      end: get('DTEND'),
      location: get('LOCATION'),
    });
  }
  return events;
}

export async function listEvents(from, to, calendarUser = CAL_USER, calendarName = 'calendar') {
  const startStr = formatDate(from);
  const endStr = formatDate(to);

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:D="DAV:">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${startStr}" end="${endStr}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

  const res = await request('REPORT', `/${calendarUser}/${calendarName}/`, body);
  if (res.status >= 400) throw new Error(`CalDAV error ${res.status}: ${res.body.slice(0, 200)}`);

  return parseIcsEvents(res.body);
}

export async function getEvent(eventId, calendarUser = CAL_USER, calendarName = 'calendar') {
  const res = await request('GET', `/${calendarUser}/${calendarName}/${eventId}.ics`, null);
  if (res.status === 404) throw new Error(`Event "${eventId}" not found`);
  if (res.status >= 400) throw new Error(`CalDAV error ${res.status}`);

  const events = parseIcsEvents(res.body);
  return events[0] || null;
}

export async function createEvent({ title, start, end, description, location, calendarUser = CAL_USER, calendarName = 'calendar' }) {
  const uid = crypto.randomUUID();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NanoClaw//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART:${formatDate(start)}`,
    `DTEND:${formatDate(end)}`,
    `SUMMARY:${title}`,
  ];
  if (description) lines.push(`DESCRIPTION:${description}`);
  if (location) lines.push(`LOCATION:${location}`);
  lines.push(`DTSTAMP:${formatDate(new Date())}`, 'END:VEVENT', 'END:VCALENDAR');
  const ics = lines.join('\n');

  const res = await request('PUT', `/${calendarUser}/${calendarName}/${uid}.ics`, ics, 'text/calendar');
  if (res.status >= 400) throw new Error(`Failed to create event: ${res.status}`);

  return { uid, title, start, end };
}

export async function updateEvent({ eventId, title, start, end, description, location, calendarUser = CAL_USER, calendarName = 'calendar' }) {
  // Fetch existing event first
  const existing = await request('GET', `/${calendarUser}/${calendarName}/${eventId}.ics`, null);
  if (existing.status === 404) throw new Error(`Event "${eventId}" not found`);

  const existingEvents = parseIcsEvents(existing.body);
  const ev = existingEvents[0] || {};

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NanoClaw//EN',
    'BEGIN:VEVENT',
    `UID:${eventId}`,
    `DTSTART:${formatDate(start || ev.start)}`,
    `DTEND:${formatDate(end || ev.end)}`,
    `SUMMARY:${title || ev.summary}`,
  ];
  const desc = description || ev.description;
  const loc = location || ev.location;
  if (desc) lines.push(`DESCRIPTION:${desc}`);
  if (loc) lines.push(`LOCATION:${loc}`);
  lines.push(`DTSTAMP:${formatDate(new Date())}`, 'END:VEVENT', 'END:VCALENDAR');
  const ics = lines.join('\n');

  const res = await request('PUT', `/${calendarUser}/${calendarName}/${eventId}.ics`, ics, 'text/calendar');
  if (res.status >= 400) throw new Error(`Failed to update event: ${res.status}`);

  return { uid: eventId, updated: true };
}

export async function deleteEvent(eventId, calendarUser = CAL_USER, calendarName = 'calendar') {
  const res = await request('DELETE', `/${calendarUser}/${calendarName}/${eventId}.ics`);
  if (res.status >= 400) throw new Error(`Failed to delete event: ${res.status}`);
  return { uid: eventId, deleted: true };
}
