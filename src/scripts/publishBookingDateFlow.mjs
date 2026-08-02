/**
 * publishBookingDateFlow.mjs
 *
 * Upload and publish the booking date calendar Flow to Meta.
 *
 * Usage:
 *   META_ACCESS_TOKEN=... WABA_ID=... node src/scripts/publishBookingDateFlow.mjs
 *
 * After publishing, set BOOKING_DATE_FLOW_ID (or business.whatsappFlows.bookingDateFlowId).
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

async function main() {
  console.log('Creating Flow asset...');
  const created = await api('POST', `${wabaId}/flows`, {
    name:     flowName,
    categories: ['APPOINTMENT_BOOKING'],
  });
  const flowId = created.id;
  console.log('Flow ID:', flowId);

  console.log('Uploading Flow JSON...');
  await api('POST', `${flowId}/assets`, {
    name:       'flow.json',
    asset_type: 'FLOW_JSON',
    file:       flowJson,
  });

  console.log('Publishing Flow...');
  await api('POST', `${flowId}/publish`);

  console.log('\n✅ Published successfully.');
  console.log(`Set in .env: BOOKING_DATE_FLOW_ID=${flowId}`);
}

main().catch((err) => {
  console.error('Publish failed:', err.message);
  process.exit(1);
});
