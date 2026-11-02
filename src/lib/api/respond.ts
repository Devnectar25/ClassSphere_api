import { NextRequest, NextResponse } from 'next/server';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';

type Correlated = { correlationId: string };

/** Standard success envelope with correlation header. */
export function ok(context: Correlated, data: unknown, status = 200) {
    return NextResponse.json(
        { success: true, data, correlationId: context.correlationId },
        { status, headers: { 'X-Correlation-Id': context.correlationId } }
    );
}

export function problem(context: Correlated, req: NextRequest, status: number, title: string, detail: string) {
    return createProblemDetailsResponse(status, title, detail, context.correlationId, req.nextUrl.pathname);
}

// PostgreSQL error classes raised by stored functions and constraints
const CLIENT_ERRORS: Record<string, [number, string]> = {
    '22P02': [400, 'Validation Error'], // invalid text representation (e.g. malformed UUID)
    '22007': [400, 'Validation Error'], // invalid datetime format
    '22008': [400, 'Validation Error'], // datetime out of range
    '22003': [400, 'Validation Error'], // numeric out of range
    '22023': [400, 'Validation Error'], // invalid parameter value (business rule)
    '23502': [400, 'Validation Error'], // not-null violation
    '23514': [400, 'Validation Error'], // check violation
    '23503': [400, 'Validation Error'], // foreign key violation
    '23505': [409, 'Conflict'], // unique violation
    P0002: [404, 'Not Found'], // no data found
};

/** Maps malformed payloads and stored-function errors to RFC 7807 problem details. */
export function fail(err: unknown, context: Correlated, req: NextRequest) {
    if (err instanceof SyntaxError) {
        return problem(context, req, 400, 'Malformed Request', 'Request payload must be valid JSON.');
    }
    const code = (err as { code?: string }).code;
    const mapped = code ? CLIENT_ERRORS[code] : undefined;
    if (mapped) {
        return problem(context, req, mapped[0], mapped[1], (err as Error).message);
    }
    console.error(`[${context.correlationId}]`, err);
    return problem(context, req, 500, 'Internal Server Error', 'An unexpected error occurred.');
}
