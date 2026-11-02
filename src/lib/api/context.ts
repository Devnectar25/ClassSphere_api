import { NextRequest } from 'next/server';
import { can, verifyToken, type Permission, type UserRole } from '@/lib/auth';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';

/**
 * Tenant Context Derivation & RBAC Resolution
 * Traceability: TDD Section 11, 13; PLT-004, PLT-005, DECISION-005
 *
 * Identity comes only from a verified session token (Authorization: Bearer …). The academy and branch
 * scope are claims of that token; a user who is not branch-scoped may narrow a request to one branch with
 * the X-Branch-Id header (consolidated view when absent). Tenant ids are never read from request bodies.
 */
export type { UserRole };

export interface RequestContext {
    tenantId: string;
    actorId: string;
    actorRole: UserRole;
    branchId: string | null;
    isPlatformAdmin: boolean;
    correlationId: string;
    idempotencyKey?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveRequestContext(req: NextRequest): RequestContext | null {
    const header = req.headers.get('authorization') ?? '';
    const claims = header.startsWith('Bearer ') ? verifyToken(header.slice(7)) : null;
    if (!claims) return null;

    const requestedBranch = req.headers.get('x-branch-id');
    return {
        tenantId: claims.tid ?? '',
        actorId: claims.sub,
        actorRole: claims.role,
        branchId: claims.bid ?? (requestedBranch && UUID.test(requestedBranch) ? requestedBranch : null),
        isPlatformAdmin: claims.pa,
        correlationId: req.headers.get('x-correlation-id') || crypto.randomUUID(),
        idempotencyKey: req.headers.get('idempotency-key') || req.headers.get('x-idempotency-key') || undefined,
    };
}

/**
 * Resolves the signed-in context and checks access. Returns the context, or a problem response to send back.
 * `permission` null = any signed-in academy member; 'platform' = platform administrators only.
 */
export function authorize(req: NextRequest, permission: Permission | 'platform' | null): RequestContext | Response {
    const context = resolveRequestContext(req);
    const correlationId = context?.correlationId ?? crypto.randomUUID();
    const deny = (status: number, title: string, detail: string) =>
        createProblemDetailsResponse(status, title, detail, correlationId, req.nextUrl.pathname);

    if (!context) return deny(401, 'Unauthorized', 'Sign in to continue.');
    if (permission === 'platform') {
        return context.isPlatformAdmin ? context : deny(403, 'Forbidden', 'Platform administrator access is required.');
    }
    if (!context.tenantId) return deny(403, 'Forbidden', 'Open an academy workspace first.');
    if (permission && !context.isPlatformAdmin && !can(context.actorRole, permission)) {
        return deny(403, 'Forbidden', `Your role (${context.actorRole}) does not allow this action.`);
    }
    return context;
}
