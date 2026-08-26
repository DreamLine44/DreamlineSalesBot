/**
 * publishBookingDateFlow.mjs
 *
 * Upload and publish the booking date calendar Flow to Meta.
 *
 * Usage:
 *   META_ACCESS_TOKEN=... WABA_ID=... node src/scripts/publishBookingDateFlow.mjs
 *
 * After publishing, set BOOKING_DATE_FLOW_ID (or restart — auto-provision saves it).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLOW_JSON_PATH = path.join(__dirname, '../../flows/booking-date-picker.json');

const token   = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
const wabaId  = process.env.WABA_ID || process.env.META_WABA_ID;
const version = process.env.META_API_VERSION || 'v21.0';

if (!token || !wabaId) {
  console.error('Missing META_ACCESS_TOKEN and WABA_ID env vars.');
  process.exit(1);
}

const flowJson = fs.readFileSync(FLOW_JSON_PATH, 'utf8');
const flowName = process.env.BOOKING_DATE_FLOW_NAME || 'dreamline_booking_date_picker';

async function api(method, urlPath, body) {
  const resp = await fetch(`https://graph.facebook.com/${version}/${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(JSON.stringify(data));
  }
  return data;
}

async function findExisting() {
  const data = await api('GET', `${wabaId}/flows?fields=id,name,status`);
  return (data.data || []).find((f) => f.name === flowName && f.status !== 'DEPRECATED');
}

async function main() {
  const existing = await findExisting();
  if (existing?.id) {
    console.log('Flow already exists:', existing.id, `(${existing.status || 'unknown'})`);
    console.log(`Set in .env: BOOKING_DATE_FLOW_ID=${existing.id}`);
    return;
  }

  console.log('Creating and publishing Flow…');
  const created = await api('POST', `${wabaId}/flows`, {
    name:       flowName,
    categories: ['APPOINTMENT_BOOKING'],
    flow_json:  flowJson,
    publish:    true,
  });

  console.log('\n✅ Published successfully.');
  console.log(`Set in .env: BOOKING_DATE_FLOW_ID=${created.id}`);
}

main().catch((err) => {
  console.error('Publish failed:', err.message);
  process.exit(1);
});
