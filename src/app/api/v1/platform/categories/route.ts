import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Platform Categories Management API
 */
export async function GET(req: NextRequest) {
    // Categories are accessible to both Platform Operators and public UI
    const context = { correlationId: req.headers.get('x-correlation-id') || crypto.randomUUID() };

    try {
        const categories = await callFn('platform.fn_categories_list');
        return ok(context, categories);
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const { categoryId, name, description, icon, displayOrder, isActive } = body;

        if (!name || !name.trim()) {
            return problem(context, req, 400, 'Validation Error', 'Category name is required.');
        }

        const category = await callFn(
            'platform.fn_category_upsert',
            categoryId || null,
            name.trim(),
            description || null,
            icon || 'BookOpen',
            displayOrder !== undefined ? Number(displayOrder) : 0,
            isActive !== undefined ? Boolean(isActive) : true,
            context.actorId || null
        );

        return ok(context, category);
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function DELETE(req: NextRequest) {
    const context = authorize(req, 'platform');
    if (context instanceof Response) return context;

    const categoryId = req.nextUrl.searchParams.get('id');
    if (!categoryId) {
        return problem(context, req, 400, 'Validation Error', 'Category id query parameter is required.');
    }

    try {
        const result = await callFn('platform.fn_category_delete', categoryId, context.actorId || null);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
