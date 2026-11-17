import { NextResponse } from 'next/server';

export async function GET() {
    return NextResponse.json({
        service: 'ClassSphere API',
        status: 'Running',
        health: '/api/v1/health',
        docs: '/api/v1/docs',
    });
}

