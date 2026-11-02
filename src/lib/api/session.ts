import { callFn } from '@/lib/db/db';
import { ROLE_PERMISSIONS, signToken, type UserRole } from '@/lib/auth';

export interface Membership {
    tenantId: string;
    tenantName: string;
    academyType: string;
    role: UserRole;
    branchId: string | null;
}

export interface AuthUser {
    userId: string;
    fullName: string;
    email: string;
    passwordHash: string;
    isActive: boolean;
    isPlatformAdmin: boolean;
    memberships: Membership[];
}

export function findUser(email: string | null, userId: string | null) {
    return callFn<AuthUser | null>('identity_app.fn_user_auth_lookup', email, userId);
}

/** Issues a session for the user in the given academy (or the platform scope for operators). */
export async function issueSession(user: AuthUser, tenantId: string | null) {
    const membership = tenantId ? user.memberships.find(m => m.tenantId === tenantId) : undefined;
    let role: UserRole;
    let branchId: string | null = null;
    let tenantName: string | null = null;

    if (membership) {
        role = membership.role;
        branchId = membership.branchId && membership.role !== 'TenantAdmin' ? membership.branchId : null;
        tenantName = membership.tenantName;
    } else if (user.isPlatformAdmin) {
        role = tenantId ? 'TenantAdmin' : 'PlatformAdmin';
        if (tenantId) {
            const workspace = await callFn<{ organization: { name: string } } | null>('tenant.fn_tenant_get', tenantId, user.userId);
            if (!workspace) return null;
            tenantName = workspace.organization.name;
        }
    } else {
        return null;
    }

    await callFn('identity_app.fn_user_login_record', user.userId, tenantId);
    const claims = { sub: user.userId, name: user.fullName, tid: tenantId, role, bid: branchId, pa: user.isPlatformAdmin };
    return {
        token: signToken(claims),
        user: { userId: user.userId, fullName: user.fullName, email: user.email, isPlatformAdmin: user.isPlatformAdmin },
        session: { tenantId, tenantName, role, branchId, permissions: ROLE_PERMISSIONS[role] },
        memberships: user.memberships,
    };
}
