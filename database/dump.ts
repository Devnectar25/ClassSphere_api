// Exports the local PGlite database (schema, functions and data) as plain SQL for import into
// Supabase/PostgreSQL:  npm run db:dump  →  psql "<supabase connection string>" -f database/local-dump.sql
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgDump } from '@electric-sql/pglite-tools/pg_dump';
import { databaseDir } from '../src/lib/db/db.ts';

if (process.env.DATABASE_URL) {
    throw new Error('db:dump exports the local PGlite database. Unset DATABASE_URL, or use pg_dump against that server.');
}

const pg = new PGlite(databaseDir());
try {
    const dump = await pgDump({ pg, args: ['--no-owner', '--no-privileges'] });
    const target = join(import.meta.dirname, 'local-dump.sql');
    await writeFile(target, await dump.text());
    console.log(`wrote ${target}`);
} finally {
    await pg.close();
}
