import { Client } from 'pg';
const pg = new Client({ connectionString: process.env.DATABASE_URL });
await pg.connect();
const r = await pg.query(`
  select id, email, last_sign_in_at::text, created_at::text,
         recovery_sent_at::text, email_confirmed_at::text
  from auth.users
  order by created_at desc
`);
console.log(JSON.stringify(r.rows, null, 2));
await pg.end();
