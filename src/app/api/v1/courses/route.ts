import { NextRequest } from 'next/server';
import { callFn, query } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Course Catalogue & Subjects API
 * Traceability: TDD Section 10.4
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    try {
        return ok(context, await callFn('academics.fn_course_list', context.tenantId));
    } catch (err) {
        return fail(err, context, req);
    }
}

/** Creates a course with its subjects. */
export async function POST(req: NextRequest) {
    const context = await authorize(req, 'courses.write');
    if (context instanceof Response) return context;
    try {
        const { title, code, category, level, durationMonths, tuitionAmount, billingPeriod, description, subjects, isActive, branchId } = await req.json();
        if (!title?.trim() || !code?.trim() || !category?.trim()) {
            return problem(context, req, 400, 'Validation Error', 'Course title, code and category are required.');
        }

        const cleanCode = String(code).trim().toUpperCase();
        if (cleanCode.length < 1 || cleanCode.length > 30) {
            return problem(context, req, 400, 'Validation Error', 'Course code must be between 1 and 30 characters.');
        }
        if (!/^[A-Z0-9_\-\.\/]+$/.test(cleanCode)) {
            return problem(context, req, 400, 'Validation Error', 'Course code can only contain letters, numbers, hyphens, underscores, dots, and slashes.');
        }

        const cleanLevel = level !== undefined && level !== null && String(level).trim() ? String(level).trim() : null;
        if (cleanLevel && cleanLevel.length > 50) {
            return problem(context, req, 400, 'Validation Error', 'Course level cannot exceed 50 characters.');
        }
        if (cleanLevel && !/^[a-zA-Z0-9\s\-–—\(\)\.\/\&,]+$/.test(cleanLevel)) {
            return problem(context, req, 400, 'Validation Error', 'Course level contains invalid characters.');
        }

        const subjectList = Array.isArray(subjects) ? subjects.map(String).filter(s => s.trim()) : [];
        if (subjectList.length === 0) {
            return problem(context, req, 400, 'Validation Error', 'Add at least one subject to the course.');
        }
        const result = await callFn<{ courseId: string }>('academics.fn_course_create',
            context.tenantId, title.trim(), cleanCode, category.trim(), cleanLevel, durationMonths ? Number(durationMonths) : null,
            Number(tuitionAmount ?? 0), billingPeriod || 'monthly', description || null, subjectList, context.actorId);

        const safeBranchId = branchId && branchId !== 'all' ? String(branchId).trim() : null;
        if (result?.courseId) {
            await query(
                'UPDATE academics.courses SET is_active = COALESCE($1, is_active), branch_id = $2 WHERE course_id = $3 AND tenant_id = $4',
                [typeof isActive === 'boolean' ? isActive : null, safeBranchId, result.courseId, context.tenantId]
            );
        }

        return ok(context, result, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}

/** Updates course or adds a subject to an existing course. */
export async function PUT(req: NextRequest) {
    const context = await authorize(req, 'courses.write');
    if (context instanceof Response) return context;
    try {
        const body = await req.json();
        const { courseId, subject } = body;
        if (!courseId) {
            return problem(context, req, 400, 'Validation Error', 'courseId is required.');
        }

        // Backward compatibility: subject-only addition
        if (subject && !body.title) {
            return ok(context, await callFn('academics.fn_course_subject_add', context.tenantId, courseId, subject.trim(), context.actorId), 200);
        }

        // Full course update
        const { title, code, category, level, durationMonths, tuitionAmount, billingPeriod, description, isActive, subjects, branchId } = body;
        if (!title?.trim() || !code?.trim() || !category?.trim()) {
            return problem(context, req, 400, 'Validation Error', 'Course title, code and category are required.');
        }

        const cleanCode = String(code).trim().toUpperCase();
        if (cleanCode.length < 1 || cleanCode.length > 30) {
            return problem(context, req, 400, 'Validation Error', 'Course code must be between 1 and 30 characters.');
        }
        if (!/^[A-Z0-9_\-\.\/]+$/.test(cleanCode)) {
            return problem(context, req, 400, 'Validation Error', 'Course code can only contain letters, numbers, hyphens, underscores, dots, and slashes.');
        }

        const cleanLevel = level !== undefined && level !== null && String(level).trim() ? String(level).trim() : null;
        if (cleanLevel && cleanLevel.length > 50) {
            return problem(context, req, 400, 'Validation Error', 'Course level cannot exceed 50 characters.');
        }
        if (cleanLevel && !/^[a-zA-Z0-9\s\-–—\(\)\.\/\&,]+$/.test(cleanLevel)) {
            return problem(context, req, 400, 'Validation Error', 'Course level contains invalid characters.');
        }

        const subjectList = Array.isArray(subjects) ? subjects.map(String).filter(s => s.trim()) : null;

        const result = await callFn('academics.fn_course_update',
            context.tenantId, courseId, title.trim(), cleanCode, category.trim(), cleanLevel,
            durationMonths ? Number(durationMonths) : null,
            Number(tuitionAmount ?? 0), billingPeriod || 'monthly', description || null,
            typeof isActive === 'boolean' ? isActive : true, subjectList, context.actorId
        );

        if (branchId !== undefined) {
            const safeBranchId = branchId && branchId !== 'all' ? String(branchId).trim() : null;
            await query(
                'UPDATE academics.courses SET branch_id = $1 WHERE course_id = $2 AND tenant_id = $3',
                [safeBranchId, courseId, context.tenantId]
            );
        }

        return ok(context, result, 200);
    } catch (err) {
        return fail(err, context, req);
    }
}

export const PATCH = PUT;

/** Deletes a course (active or draft) if it has no assigned batches. */
export async function DELETE(req: NextRequest) {
    const context = await authorize(req, 'courses.write');
    if (context instanceof Response) return context;
    try {
        const searchParams = req.nextUrl.searchParams;
        let courseId = searchParams.get('courseId');
        if (!courseId) {
            const body = await req.json().catch(() => ({}));
            courseId = body?.courseId;
        }

        if (!courseId) {
            return problem(context, req, 400, 'Validation Error', 'courseId is required.');
        }

        // Check if course exists in tenant
        const courses = await query<{ course_id: string; title: string; code: string }>(
            'SELECT course_id, title, code FROM academics.courses WHERE course_id = $1 AND tenant_id = $2',
            [courseId, context.tenantId]
        );
        if (courses.length === 0) {
            return problem(context, req, 404, 'Not Found', 'Course not found.');
        }

        // Check if any batches reference this course
        const batchCheck = await query<{ count: string }>(
            'SELECT count(*)::text as count FROM academics.batches WHERE course_id = $1 AND tenant_id = $2',
            [courseId, context.tenantId]
        );
        const batchCount = parseInt(batchCheck[0]?.count || '0', 10);
        if (batchCount > 0) {
            return problem(
                context,
                req,
                400,
                'Course Has Associated Batches',
                `Cannot delete course '${courses[0].title}' because it has ${batchCount} active batch(es) assigned. Please delete or reassign the batches first, or set this course status to Draft.`
            );
        }

        // Unlink any fee plans
        await query(
            'UPDATE billing.fee_plans SET course_id = NULL WHERE course_id = $1 AND tenant_id = $2',
            [courseId, context.tenantId]
        );

        // Delete course subjects
        await query(
            'DELETE FROM academics.course_subjects WHERE course_id = $1 AND tenant_id = $2',
            [courseId, context.tenantId]
        );

        // Delete course
        await query(
            'DELETE FROM academics.courses WHERE course_id = $1 AND tenant_id = $2',
            [courseId, context.tenantId]
        );

        // Audit log
        await query(
            `INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
             VALUES ($1, $2, 'course.deleted', 'course', $3, gen_random_uuid()::text, $4::jsonb)`,
            [
                context.tenantId,
                context.actorId,
                courseId,
                JSON.stringify({ courseId, title: courses[0].title, code: courses[0].code })
            ]
        );

        return ok(context, { success: true, courseId, deletedTitle: courses[0].title }, 200);
    } catch (err) {
        return fail(err, context, req);
    }
}
