/**
 * ClassSphere Thin Stored Function Executor
 * Traceability: TDD Section 10.2-10.4; PLT-006, PLT-007, DECISION-002
 *
 * Application code never issues ad-hoc table CRUD. Every read and write executes an approved
 * PostgreSQL stored function ({schema}.fn_{entity}_{action}) with positional parameters.
 * Function results are JSONB; snake_case keys are converted to camelCase for API consumers.
 *
 * Connection: PostgreSQL/Supabase when DATABASE_URL is set, otherwise the embedded PGlite
 * PostgreSQL database stored in DATABASE_DIR (default ./database/local-db).
 */
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';

type Database = Pool | PGlite;

declare global {
    var __classSphereDb: Database | undefined;
}

export function databaseDir() {
    return process.env.DATABASE_DIR || './database/local-db';
}

// Connects lazily so build workers that load route modules never open the database
function database(): Database {
    if (!global.__classSphereDb) {
        if (process.env.DATABASE_URL) {
            const isLocal = process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1');
            const pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: isLocal ? false : { rejectUnauthorized: false },
                max: 10,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 8000,
                keepAlive: true,
                keepAliveInitialDelayMillis: 10000,
            });
            pool.on('error', (err) => {
                console.error('[Database Pool Error]', err.message);
            });
            global.__classSphereDb = pool;
        } else {
            global.__classSphereDb = new PGlite(databaseDir());
        }
    }
    return global.__classSphereDb;
}

/** Raw parameterized query — reserved for migrations, health checks and test fixtures. */
export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const db = database();
    const result = db instanceof PGlite ? await db.query<T>(sql, params) : await db.query(sql, params);
    return result.rows as T[];
}

/** Executes a multi-statement SQL script as one implicit transaction. */
export async function execScript(sql: string) {
    const db = database();
    if (db instanceof PGlite) await db.exec(sql);
    else await db.query(sql);
}

const FUNCTION_NAME = /^[a-z_]+\.fn_[a-z_]+$/;

function camelize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(camelize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, v]) => [key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()), camelize(v)])
        );
    }
    return value;
}

export async function callFn<T = unknown>(fn: string, ...args: unknown[]): Promise<T> {
    if (!FUNCTION_NAME.test(fn)) throw new Error(`Invalid stored function name: ${fn}`);
    const params = args.map((_, i) => `$${i + 1}`).join(', ');
    const [row] = await query<{ result: unknown }>(`SELECT ${fn}(${params}) AS result`, args);
    return camelize(row.result) as T;
}

export async function ping() {
    await query('SELECT 1');
}

export async function closeDb() {
    const db = global.__classSphereDb;
    global.__classSphereDb = undefined;
    if (db instanceof PGlite) await db.close();
    else await db?.end();
}
