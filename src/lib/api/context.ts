import { NextRequest } from 'next/server';
import { can, verifyToken, type Permission, type UserRole } from '@/lib/auth';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { callFn } from '@/lib/db/db';
import { staffMembership } from '@/lib/api/scope';

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
    /** Branch the account belongs to; unlike branchId never a branch view the user merely selected */
    restrictedBranchId: string | null;
    isPlatformAdmin: boolean;
    correlationId: string;
    idempotencyKey?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestedBranch(req: NextRequest): string | null {
    const id = req.headers.get('x-branch-id');
    return id && UUID.test(id) ? id : null;
}

export function resolveRequestContext(req: NextRequest): RequestContext | null {
    const header = req.headers.get('authorization') ?? '';
    const claims = header.startsWith('Bearer ') ? verifyToken(header.slice(7)) : null;
    if (!claims) return null;

    return {
        tenantId: claims.tid ?? '',
        actorId: claims.sub,
        actorRole: claims.role,
        branchId: claims.bid ?? requestedBranch(req),
        restrictedBranchId: claims.bid ?? null,
        isPlatformAdmin: claims.pa,
        correlationId: req.headers.get('x-correlation-id') || crypto.randomUUID(),
        idempotencyKey: req.headers.get('idempotency-key') || req.headers.get('x-idempotency-key') || undefined,
    };
}

interface AccessState {
    exists: boolean;
    isActive: boolean;
    isSuspended: boolean;
}

// Short-lived cache so each request does not hit the database; cleared for a user when their status changes
const ACCESS_TTL_MS = 10_000;
const accessCache = new Map<string, { state: AccessState; at: number }>();

export function invalidateUserAccess(userId: string) {
    accessCache.delete(userId);
}

async function userAccess(userId: string): Promise<AccessState> {
    const cached = accessCache.get(userId);
    if (cached && Date.now() - cached.at < ACCESS_TTL_MS) return cached.state;
    const state = await callFn<AccessState>('identity_app.fn_user_access_check', userId);
    accessCache.set(userId, { state, at: Date.now() });
    return state;
}

/**
 * Rejects sessions of accounts that were suspended, deactivated or removed after the token was issued.
 * Returns a problem response to send back, or null when the account may continue.
 */
export async function checkAccountAccess(req: NextRequest, context: RequestContext): Promise<Response | null> {
    const deny = (status: number, title: string, detail: string) =>
        createProblemDetailsResponse(status, title, detail, context.correlationId, req.nextUrl.pathname);
    const state = await userAccess(context.actorId);
    if (!state.exists) return deny(401, 'Unauthorized', 'This account no longer exists. Sign in again.');
    if (state.isSuspended) return deny(403, 'Account Suspended', 'Your account has been suspended. Please contact ClassSphere support.');
    if (!state.isActive) return deny(403, 'Account Inactive', 'This account is inactive. Please contact your administrator.');
    return null;
}

/**
 * Resolves the signed-in context and checks access. Returns the context, or a problem response to send back.
 * `permission` null = any signed-in academy member; 'platform' = platform administrators only.
 * Suspended or deactivated accounts are refused even while their session token is still valid.
 */
export async function authorize(req: NextRequest, permission: Permission | 'platform' | null): Promise<RequestContext | Response> {
    const context = resolveRequestContext(req);
    const correlationId = context?.correlationId ?? crypto.randomUUID();
    const deny = (status: number, title: string, detail: string) =>
        createProblemDetailsResponse(status, title, detail, correlationId, req.nextUrl.pathname);

    if (!context) return deny(401, 'Unauthorized', 'Sign in to continue.');
    const blocked = await checkAccountAccess(req, context);
    if (blocked) return blocked;
    if (permission === 'platform') {
        return context.isPlatformAdmin ? context : deny(403, 'Forbidden', 'Platform administrator access is required.');
    }
    if (!context.tenantId) return deny(403, 'Forbidden', 'Open an academy workspace first.');
    if (permission && !context.isPlatformAdmin && !can(context.actorRole, permission)) {
        return deny(403, 'Forbidden', `Your role (${context.actorRole}) does not allow this action.`);
    }
    // Branch and assignments of Staff can change while they are signed in
    if (context.actorRole === 'Staff' && !context.isPlatformAdmin) {
        const member = await staffMembership(context.tenantId, context.actorId);
        context.restrictedBranchId = member?.branchId ?? null;
        context.branchId = context.restrictedBranchId ?? requestedBranch(req);
    }
    return context;
}
