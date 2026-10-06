/**
 * Creates the first admin and a handful of real Bengaluru schools so the app
 * opens in a working state. Safe to run more than once.
 *
 *   npm run seed
 */
import { get, run, all } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const ADMIN_USER = process.env.SEED_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.SEED_ADMIN_PASS || 'changeme123';

let admin = get('SELECT * FROM users WHERE username = ?', ADMIN_USER);
if (!admin) {
  const { hash, salt } = hashPassword(ADMIN_PASS);
  run(
    `INSERT INTO users (username, name, mobile, area, role, pass_hash, pass_salt, must_reset)
     VALUES (?,?,?,?,'admin',?,?,0)`,
    ADMIN_USER, 'Admin', null, null, hash, salt
  );
  console.log(`admin created — user "${ADMIN_USER}", password "${ADMIN_PASS}" (change it after signing in)`);
} else {
  console.log(`admin "${ADMIN_USER}" already exists`);
}

/* Real records from the UDISE+ database, Bengaluru. */
const schools = [
  ['29280600739', 'BISHOP COTTON BOYS SCHOOL', 'BENGALURU U NORTH', 'NORTH3', 'No 15 Residency Road, Richmond Town', '560025', '080', '40527888', 'bcbs@bishopcottonboysschool.edu.in', 'Mr Alistair R A Freese'],
  ['29200900439', 'BGS NATIONAL PUBLIC SCHOOL HULIMAVU', 'BENGALURU U SOUTH', 'SOUTH3', 'Hulimavu', '560076', '080', '26484933', 'bgsnpsblr@gmail.com', null],
  ['29200135530', 'APPOLLO NATIONAL PUBLIC SCHOOL', 'BENGALURU U SOUTH', 'SOUTH1', 'Banashankari', '560085', '080', '26692847', 'office@appollonps.com', null],
  ['29200301038', 'AET INTERNATIONAL PUBLIC SCHOOL', 'BENGALURU U SOUTH', 'SOUTH4', 'Carmelaram', '560035', '080', '23441237', 'principal.aetinstitutions@gmail.com', 'Shanthi'],
  ['29204100218', 'AADYA ACADEMY', 'BENGALURU U SOUTH', 'SOUTH4', 'Kannur', null, '080', '28567277', 'aadyaacademykannur@gmail.com', null],
  ['29280718003', 'ADITHYA NATIONAL PUBLIC SCHOOL', 'BENGALURU U NORTH', 'NORTH4', 'Yelahanka', '560064', '080', '65471969', 'anpsaditya@gmail.com', null],
  ['29200406706', 'AKSHAYA NATIONAL PUBLIC SCHOOL VEERASANDRA', 'BENGALURU U SOUTH', 'ANEKAL', 'Veerasandra', '560100', '080', '23334333', 'collegeakshaya@gmail.com', null],
  ['29280234903', 'APPOLLO NATIONAL PUBLIC SCHOOL WEST', 'BENGALURU U NORTH', 'NORTH1', 'Peenya', '560058', '080', '28378666', 'anpswestbengaluru@gmail.com', null],
  ['29280500390', 'A S KUPPARAJU AND BROS VIDYANIKETAN SCHOOL', 'BENGALURU U NORTH', 'NORTH2', 'Ganganagar', '560032', '080', '23631797', 'askupparaju@yahoo.in', null],
  ['29280707200', 'A K PUBLIC SCHOOL', 'BENGALURU U NORTH', 'NORTH4', 'Thanisandra', '560077', '080', null, 'akpublicschool0110@gmail.com', 'Jabeena'],
];

const stmt = `
INSERT INTO schools (udise_code, name, district, block, address, pincode, std_code, phone, email, head_master)
VALUES (?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(udise_code) DO NOTHING`;

let added = 0;
for (const s of schools) {
  const before = get('SELECT COUNT(*) n FROM schools').n;
  run(stmt, ...s);
  if (get('SELECT COUNT(*) n FROM schools').n > before) added++;
}

console.log(`${added} schools added, ${get('SELECT COUNT(*) n FROM schools').n} in total`);
console.log(`${all('SELECT id FROM users').length} user(s) on file`);
console.log('\nStart the app with:  npm start');
