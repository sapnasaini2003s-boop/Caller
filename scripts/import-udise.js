/**
 * Import a school CSV from the command line.
 *
 *   node scripts/import-udise.js bangalore-schools.csv
 *
 * Recognised columns (any order, extras ignored):
 *   udiseCode | udise_code      name | schoolName     district    block
 *   address   pincode           stdCode | std_code     phone
 *   email     headMaster | head_master  management
 *
 * Re-running updates rows that already exist, matched on udiseCode, so you
 * can refresh a district without creating duplicates.
 */
import fs from 'node:fs';
import { get, run } from '../src/db.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/import-udise.js <file.csv>');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1)
    .filter(r => r.some(v => v && v.trim()))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const pick = (r, ...keys) => {
  for (const k of keys) if (r[k]) return r[k];
  return null;
};

const rows = parseCsv(fs.readFileSync(file, 'utf8'));
if (!rows.length) {
  console.error('That file has no data rows.');
  process.exit(1);
}

const stmt = `
INSERT INTO schools (udise_code, name, district, block, address, pincode,
                     std_code, phone, email, head_master, management)
VALUES (?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(udise_code) DO UPDATE SET
  name = excluded.name, district = excluded.district, block = excluded.block,
  address = excluded.address, pincode = excluded.pincode,
  std_code = excluded.std_code, phone = excluded.phone,
  email = excluded.email, head_master = excluded.head_master,
  management = excluded.management`;

let ok = 0, skipped = 0;
for (const r of rows) {
  const name = pick(r, 'name', 'schoolName', 'school_name');
  if (!name) { skipped++; continue; }
  run(stmt,
    pick(r, 'udiseCode', 'udise_code', 'udiseschCode'),
    name,
    pick(r, 'district', 'districtName'),
    pick(r, 'block', 'blockName'),
    pick(r, 'address'),
    pick(r, 'pincode', 'pin'),
    pick(r, 'stdCode', 'std_code'),
    pick(r, 'phone', 'phoneRaw', 'landline'),
    pick(r, 'email'),
    pick(r, 'headMaster', 'head_master', 'headmaster'),
    pick(r, 'management', 'mgmt')
  );
  ok++;
}

console.log(`imported ${ok} rows${skipped ? `, skipped ${skipped} with no name` : ''}`);
console.log(`${get('SELECT COUNT(*) n FROM schools').n} schools on file`);
console.log(`${get("SELECT COUNT(*) n FROM schools WHERE assigned_to IS NULL").n} not yet assigned to a caller`);
