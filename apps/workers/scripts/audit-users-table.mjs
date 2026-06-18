import { Client } from 'pg';
const pg = new Client({ connectionString: process.env.DATABASE_URL });
await pg.connect();

console.log('=== public.users columns ===');
const cols = (await pg.query(`
  select column_name, data_type, is_nullable, column_default
  from information_schema.columns
  where table_schema='public' and table_name='users'
  order by ordinal_position
`)).rows;
for (const c of cols)
  console.log(' -', c.column_name, ':', c.data_type, c.is_nullable === 'NO' ? 'NOT NULL' : '', c.column_default ? `DEFAULT ${c.column_default}` : '');

console.log('\n=== public.users RLS policies ===');
const pols = (await pg.query(`
  select policyname, cmd, roles, qual, with_check
  from pg_policies where schemaname='public' and tablename='users'
  order by policyname
`)).rows;
for (const p of pols) {
  const u = (p.qual || '').replace(/\s+/g, ' ');
  const w = (p.with_check || '').replace(/\s+/g, ' ');
  console.log(' -', p.policyname, '|', p.cmd, '| to', p.roles);
  console.log('     USING:', u || '∅');
  if (w) console.log('     WITH CHECK:', w);
}

console.log('\n=== existing GRANTS on public.users ===');
const gr = (await pg.query(`
  select grantee, privilege_type
  from information_schema.role_table_grants
  where table_schema='public' and table_name='users'
  order by grantee, privilege_type
`)).rows;
for (const g of gr) console.log(' -', g.grantee, ':', g.privilege_type);

console.log('\n=== column-level GRANTS on public.users (if any) ===');
const cgr = (await pg.query(`
  select grantee, column_name, privilege_type
  from information_schema.column_privileges
  where table_schema='public' and table_name='users'
  order by grantee, column_name
`)).rows;
console.log(cgr.length === 0 ? ' (none)' : JSON.stringify(cgr, null, 2));

await pg.end();
