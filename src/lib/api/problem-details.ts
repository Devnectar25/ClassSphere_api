/**
 * RFC 7807 Problem Details Standard Error Model
 * Traceability: TDD Section 9.2, PLT-003
 */
export interface ProblemDetails {
    type: string;
    title: string;
    status: number;
    detail: string;
    instance?: string;
    correlationId: string;
    errors?: Record<string, string[]>;
}

/**
 * Builds a standard RFC 7807 Problem Details body object.
 */
export function buildProblemDetails(
    status: number,
    title: string,
    detail: string,
    correlationId: string,
    instance?: string,
    errors?: Record<string, string[]>
): ProblemDetails {
    return {
        type: `https://classsphere.io/errors/${title.toLowerCase().replace(/\s+/g, '-')}`,
        title,
        status,
        detail,
        instance,
        correlationId,
        errors,
    };
}

/**
 * Creates a standard Web API Response with RFC 7807 Problem Details payload.
 * Framework-agnostic — works in any environment with the Web Response API.
 */
export function createProblemDetailsResponse(
    status: number,
    title: string,
    detail: string,
    correlationId: string,
    instance?: string,
    errors?: Record<string, string[]>
): Response {
    const body = buildProblemDetails(status, title, detail, correlationId, instance, errors);

    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/problem+json',
            'X-Correlation-Id': correlationId,
        },
    });
}
