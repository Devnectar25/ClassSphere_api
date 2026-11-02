import { NextRequest } from 'next/server';
import { resolveRequestContext } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { findUser, issueSession } from '@/lib/api/session';

/**
 * Switch academy: members move between their academies; platform administrators open any academy
 * (or return to the platform scope with tenantId null).
 */
export async function POST(req: NextRequest) {
    const context = resolveRequestContext(req);
    if (!context) {
        return problem({ correlationId: crypto.randomUUID() }, req, 401, 'Unauthorized', 'Sign in to continue.');
    }
    try {
        const { tenantId } = await req.json();
        const user = await findUser(null, context.actorId);
        const session = user?.isActive ? await issueSession(user, tenantId ?? null) : null;
        if (!session) return problem(context, req, 403, 'Forbidden', 'You do not have access to that academy.');
        return ok(context, session);
    } catch (err) {
        return fail(err, context, req);
    }
}
