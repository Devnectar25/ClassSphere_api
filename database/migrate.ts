// Applies database scripts in order: migrations → functions → roles (→ seed with --seed).
// Usage: npm run db:migrate | npm run db:seed
// Target: DATABASE_URL (PostgreSQL / Supabase) if set, otherwise the local PGlite database in DATABASE_DIR.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { execScript, closeDb } from '../src/lib/db/db.ts';

const root = import.meta.dirname;

export async function applyScripts(folders: string[]) {
    for (const folder of folders) {
        const files = (await readdir(join(root, folder))).filter(f => f.endsWith('.sql')).sort();
        for (const file of files) {
            await execScript(await readFile(join(root, folder, file), 'utf8'));
            console.log(`applied ${folder}/${file}`);
        }
    }
}

async function ensurePostgresDatabase(url: string) {
    const target = new URL(url);
    const name = decodeURIComponent(target.pathname.slice(1));
    target.pathname = '/postgres';
    const admin = new pg.Client({ connectionString: target.toString() });
    await admin.connect();
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) {
        await admin.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
        console.log(`created database ${name}`);
    }
    await admin.end();
}

if (process.argv[1] === import.meta.filename) {
    if (process.env.DATABASE_URL) await ensurePostgresDatabase(process.env.DATABASE_URL);
    try {
        await applyScripts(['migrations', 'functions', 'roles', ...(process.argv.includes('--seed') ? ['seed'] : [])]);
    } finally {
        await closeDb();
    }
}
