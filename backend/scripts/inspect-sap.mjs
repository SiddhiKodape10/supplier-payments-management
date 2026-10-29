// backend/scripts/inspect-sap.mjs  — READ-ONLY. Prints real field names + sample rows.
// Usage: node backend/scripts/inspect-sap.mjs   (adjust the import to your sapService's real export)
// Replace sapGet with whatever your sapService.js uses for authenticated GET requests.
import { sapGet } from '../src/services/sapService.js';   // <-- CHANGE to your actual export

const SERVICE = '/sap/opu/odata/sap/FAP_VENDOR_LINE_ITEMS_SRV';   // confirm the path in your config

const meta = await sapGet(`${SERVICE}/$metadata`, { raw: true });
const text = typeof meta === 'string' ? meta : JSON.stringify(meta);
console.log('--- EntitySets ---');
for (const m of text.matchAll(/<EntitySet Name="([^"]+)" EntityType="([^"]+)"/g)) console.log(m[1], '->', m[2]);
console.log('\n--- Properties per EntityType ---');
for (const t of text.matchAll(/<EntityType Name="([^"]+)"[\s\S]*?<\/EntityType>/g)) {
  const props = [...t[0].matchAll(/<Property Name="([^"]+)" Type="([^"]+)"/g)].map((p) => `${p[1]}:${p[2].replace('Edm.', '')}`);
  console.log(`\n${t[1]}\n  ${props.join(', ')}`);
}
const ENTITY_SET = process.argv[2];   // e.g. node inspect-sap.mjs VendorLineItems
if (ENTITY_SET) {
  const r = await sapGet(`${SERVICE}/${ENTITY_SET}?$top=20&$format=json`);
  const rows = r?.d?.results || r?.value || [];
  console.log(`\n--- ${rows.length} sample rows; populated-field counts ---`);
  const counts = {};
  rows.forEach((row) => Object.entries(row).forEach(([k, v]) => { if (v !== null && v !== '' && !/^0{4,}/.test(String(v))) counts[k] = (counts[k] || 0) + 1; }));
  console.table(counts);
  console.log(JSON.stringify(rows.slice(0, 3), null, 2));
}
