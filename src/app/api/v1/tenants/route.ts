import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { ACADEMY_TYPES, hashPassword } from '@/lib/auth';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { branchIdsInScope, staffScope } from '@/lib/api/scope';

/**
 * Academy Workspace, Settings & Provisioning API
 * Traceability: TDD Section 10.4, 11; PLT-005, PLT-006
 */
const MAX_LOGO_BYTES = 512 * 1024;

export async function GET(req: NextRequest) {
    const context = await authorize(req, null);
    if (context instanceof Response) return context;
    try {
        const workspace = await callFn<{ branches?: Array<{ branchId: string }> } | null>('tenant.fn_tenant_get', context.tenantId, context.actorId);
        if (!workspace) {
            return problem(context, req, 404, 'Not Found', 'Academy workspace not found.');
        }
        const branches = await branchIdsInScope(context);
        const scope = await staffScope(context);
        return ok(context, {
            ...workspace,
            ...(branches ? { branches: (workspace.branches ?? []).filter(b => branches.has(b.branchId)) } : {}),
            // Staff limited to their assigned courses and batches
            staffAccess: scope ? { courses: scope.courseIds.length, batches: scope.batchIds.length } : null,
        });
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function PUT(req: NextRequest) {
    const context = await authorize(req, 'settings.write');
    if (context instanceof Response) return context;

    try {
        const { name, currency, timezone, branding, settings } = await req.json();
        const logo = branding?.logoUrl;
        if (logo && (typeof logo !== 'string' || !/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(logo) || logo.length > MAX_LOGO_BYTES * 1.37)) {
            return problem(context, req, 400, 'Validation Error', 'Logo must be a PNG, JPG, WEBP or SVG image of at most 512 KB.');
        }
        if (currency !== undefined && currency !== null && (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency.trim()))) {
            return problem(context, req, 400, 'Validation Error', 'Currency must be a valid 3-letter ISO currency code (e.g. INR, USD, EUR).');
        }
        const safeCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : null;
        const result = await callFn('tenant.fn_tenant_settings_update',
            context.tenantId, name || null, safeCurrency, timezone || null, branding ?? null, settings ?? null, context.actorId);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}

/** Provisions a new academy and its administrator sign-in (platform administrators only). */
export async function POST(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const { name, slug, academyType, currency, timezone, planTier, adminName, adminEmail, adminPassword } = await req.json();

        if (!name || !slug) {
            return problem(context, req, 400, 'Validation Error', 'Academy name and slug are required.');
        }
        if (academyType && !ACADEMY_TYPES.includes(academyType)) {
            return problem(context, req, 400, 'Validation Error', `Academy type must be one of: ${ACADEMY_TYPES.join(', ')}.`);
        }
        if (adminEmail && adminPassword && String(adminPassword).length < 8) {
            return problem(context, req, 400, 'Validation Error', 'The admin password must be at least 8 characters.');
        }
        if (currency && (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency.trim()))) {
            return problem(context, req, 400, 'Validation Error', 'Currency must be a valid 3-letter ISO currency code (e.g. INR, USD, EUR).');
        }

        const safeCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : null;
        const result = await callFn('tenant.fn_tenant_create',
            name, slug, academyType || null, safeCurrency, timezone || null, planTier || null,
            adminName || null, adminEmail || null, adminPassword ? hashPassword(adminPassword) : null, context.actorId);
        return ok(context, result, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}
