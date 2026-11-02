import { NextResponse } from 'next/server';
import { ping } from '@/lib/db/db';

/**
 * Service Health & Readiness Probe
 * Traceability: TDD Section 9.2, 20; PLT-002
 */
export async function GET() {
    let database = 'Healthy';
    try {
        await ping();
    } catch {
        database = 'Unavailable';
    }
    const healthy = database === 'Healthy';

    return NextResponse.json({
        status: healthy ? 'Healthy' : 'Degraded',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        dependencies: {
            database: { status: database, type: 'PostgreSQL Stored Function Executor' },
        },
    }, {
        status: healthy ? 200 : 503,
        headers: { 'Cache-Control': 'no-store' },
    });
}
