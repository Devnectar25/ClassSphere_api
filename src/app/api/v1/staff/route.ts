import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { hashPassword } from '@/lib/auth';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Staff, Roles & Academy Users API — branch-scoped
 * Traceability: TDD Section 10.4, 13
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'staff.read');
    if (context instanceof Response) return context;
    try {
        return ok(context, await callFn('tenant.fn_staff_list', context.tenantId, context.branchId));
    } catch (err) {
        return fail(err, context, req);
    }
}

/** Creates a role-based academy user with a sign-in. */
export async function POST(req: NextRequest) {
    const context = authorize(req, 'staff.write');
    if (context instanceof Response) return context;
    try {
        const { fullName, email, phone, password, role, branchId, title } = await req.json();
        if (!fullName || !email || !role) {
            return problem(context, req, 400, 'Validation Error', 'fullName, email and role are required.');
        }
        if (!password || String(password).length < 8) {
            return problem(context, req, 400, 'Validation Error', 'A temporary password of at least 8 characters is required.');
        }
        const result = await callFn('tenant.fn_staff_create',
            context.tenantId, fullName, email, phone || null, hashPassword(password), role, branchId || null, title || null, context.actorId);
        return ok(context, result, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}

/** Activates or deactivates a staff member's access. */
export async function PUT(req: NextRequest) {
    const context = authorize(req, 'staff.write');
    if (context instanceof Response) return context;
    try {
        const { membershipId, isActive } = await req.json();
        if (!membershipId || typeof isActive !== 'boolean') {
            return problem(context, req, 400, 'Validation Error', 'membershipId and isActive are required.');
        }
        return ok(context, await callFn('tenant.fn_membership_set_active', context.tenantId, membershipId, isActive, context.actorId));
    } catch (err) {
        return fail(err, context, req);
    }
}
