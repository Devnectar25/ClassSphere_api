import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { generatePassword, hashPassword } from '@/lib/auth';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Guardian Directory API — branch-scoped
 * Traceability: TDD Section 10.4
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'guardians.read');
    if (context instanceof Response) return context;
    try {
        return ok(context, await callFn('academics.fn_guardian_list', context.tenantId, context.branchId));
    } catch (err) {
        return fail(err, context, req);
    }
}

/**
 * Adds a parent / guardian linked to their children. With createLogin, also creates the parent-portal
 * sign-in and returns the credentials once so the academy can share them.
 */
export async function POST(req: NextRequest) {
    const context = authorize(req, 'guardians.write');
    if (context instanceof Response) return context;
    try {
        const { firstName, lastName, relationship, phone, email, studentIds, createLogin } = await req.json();
        if (!firstName || !lastName || !phone || !email || !Array.isArray(studentIds) || studentIds.length === 0) {
            return problem(context, req, 400, 'Validation Error', 'Name, phone, email and at least one linked student are required.');
        }
        const created = await callFn<{ guardianId: string }>('academics.fn_guardian_create',
            context.tenantId, firstName, lastName, relationship || 'Parent', phone, email, studentIds, context.actorId);
        if (!createLogin) return ok(context, created, 201);

        const password = generatePassword();
        const login = await callFn<{ email: string }>('academics.fn_guardian_portal_enable',
            context.tenantId, created.guardianId, hashPassword(password), context.actorId);
        return ok(context, { ...created, credentials: { email: login.email, password } }, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}
