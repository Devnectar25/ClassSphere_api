import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { generatePassword, hashPassword } from '@/lib/auth';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Creates or resets a guardian's parent-portal sign-in (email from the guardian record).
 * Returns the temporary password once; only its hash is stored.
 */
export async function POST(req: NextRequest) {
    const context = authorize(req, 'guardians.write');
    if (context instanceof Response) return context;
    try {
        const { guardianId, password } = await req.json();
        if (!guardianId) return problem(context, req, 400, 'Validation Error', 'guardianId is required.');
        if (password && String(password).length < 8) {
            return problem(context, req, 400, 'Validation Error', 'Passwords must be at least 8 characters.');
        }
        const secret = password ? String(password) : generatePassword();
        const login = await callFn<{ email: string }>('academics.fn_guardian_portal_enable',
            context.tenantId, guardianId, hashPassword(secret), context.actorId);
        return ok(context, { credentials: { email: login.email, password: secret } });
    } catch (err) {
        return fail(err, context, req);
    }
}
