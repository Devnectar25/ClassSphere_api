import { NextRequest, NextResponse } from 'next/server';
import { callFn } from '@/lib/db/db';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';

/**
 * Public list of active academies so Students and Parents can pick their academy on self-registration.
 */
export async function GET(req: NextRequest) {
    const correlationId = crypto.randomUUID();
    try {
        const academies = await callFn<Array<{ tenantId: string; name: string; academyType: string; slug: string }>>(
            'tenant.fn_public_academies_list'
        );
        return NextResponse.json({ success: true, data: academies, correlationId });
    } catch (err) {
        console.error(`[${correlationId}]`, err);
        return createProblemDetailsResponse(500, 'Internal Server Error', 'Unable to load academies.', correlationId, req.nextUrl.pathname);
    }
}

