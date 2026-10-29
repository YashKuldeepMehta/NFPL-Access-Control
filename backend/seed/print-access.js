// Prints every person's access in plain language, from the seeded rows:  npm run readme:access
import { pool } from '../src/db.js';
import { getRef } from '../src/services/ref.js';
import { describeGrant } from '../src/services/describe.js';

try {
  const ref = await getRef();
  const users = (await pool.query(`SELECT id, name, email, type FROM users WHERE email <> 'bootstrap@nfpl.test' ORDER BY id`)).rows;
  const grants = (await pool.query(
    `SELECT g.*, u.name AS user_name, r.code AS role_code, r.name AS role_name FROM grants g
       JOIN users u ON u.id = g.user_id JOIN roles r ON r.id = g.role_id ORDER BY g.user_id, g.valid_from`)).rows;
  const absences = (await pool.query(
    `SELECT a.*, u.name AS user_name, d.name AS delegate_name FROM absences a
       JOIN users u ON u.id = a.user_id LEFT JOIN users d ON d.id = a.delegate_id ORDER BY a.user_id`)).rows;
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  for (const u of users) {
    console.log(`\n### ${u.name} (${u.type}, ${u.email})`);
    const mine = grants.filter((g) => g.user_id === u.id);
    if (!mine.length) console.log('- (no grants)');
    for (const g of mine) console.log(`- ${describeGrant(g, ref).description}`);
    for (const a of absences.filter((x) => x.user_id === u.id)) {
      console.log(`- ${u.name} is absent ${day(a.valid_from)} to ${day(a.valid_to)}; ${a.delegate_name ? `${a.delegate_name} covers for them` : 'nobody covers for them'}.`);
    }
    for (const a of absences.filter((x) => x.delegate_id === u.id)) {
      console.log(`- ${u.name} covers for ${a.user_name} ${day(a.valid_from)} to ${day(a.valid_to)} (delegable roles only).`);
    }
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
