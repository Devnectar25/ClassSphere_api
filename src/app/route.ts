import { NextResponse } from 'next/server';

/** Root of the API server: this service has no web pages, so point visitors to what it does serve. */
export function GET() {
    return NextResponse.json({
        service: 'ClassSphere API',
        status: 'Running',
        health: '/api/v1/health',
        docs: '/api/v1/docs',
    });
}
