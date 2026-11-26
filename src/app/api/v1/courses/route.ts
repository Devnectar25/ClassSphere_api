import { NextRequest } from 'next/server';
import { callFn, query } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { staffScope } from '@/lib/api/scope';

/**
 * Course Catalogue & Subjects API
 * Traceability: TDD Section 10.4
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    try {
        const branchParam = req.nextUrl.searchParams.get('branchId');
        const effectiveBranch = context.restrictedBranchId ?? ((branchParam && branchParam !== 'all' && branchParam !== 'academy_wide') ? branchParam : null);

        const courses = await callFn<Array<{ courseId: string; branchId: string | null; batchCount: number; studentCount: number }>>('academics.fn_course_list', context.tenantId);
        const scope = await staffScope(context);
        const branch = effectiveBranch;
        if (!scope && !branch && branchParam !== 'academy_wide') return ok(context, courses);

        // Counted within the user's own branch and batches
        const counts = new Map((await query<{ course_id: string; batches: number; students: number }>(
            `SELECT b.course_id, COUNT(DISTINCT b.batch_id)::int AS batches, COUNT(DISTINCT e.student_id)::int AS students
             FROM academics.batches b LEFT JOIN academics.enrollments e ON e.batch_id = b.batch_id AND e.status IN ('enrolled', 'confirmed', 'active', 'approved')
             WHERE b.tenant_id = $1 AND ($2::uuid IS NULL OR b.branch_id = $2::uuid) AND ($3::uuid[] IS NULL OR b.batch_id = ANY($3::uuid[]))
             GROUP BY b.course_id`, [context.tenantId, branch, scope?.batchIds ?? null])).map(r => [r.course_id, r]));
        return ok(context, courses
            .filter(c => {
                if (branchParam === 'academy_wide') return !c.branchId;
                return (scope ? scope.courseIds.includes(c.courseId) : !c.branchId || c.branchId === branch || counts.has(c.courseId));
            })
            .map(c => ({ ...c, batchCount: counts.get(c.courseId)?.batches ?? 0, studentCount: counts.get(c.courseId)?.students ?? 0 })));
    } catch (err) {
        return fail(err, context, req);
    }
}

/** Creates a course with its subjects. */
export async function POST(req: NextRequest) {
    const context = await authorize(req, 'courses.write');
    if (context instanceof Response) return context;
    try {
        const { title, code, category, level, durationMonths, tuitionAmount, billingPeriod, description, subjects, isActive, branchId, startDate, completionPolicy } = await req.json();
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

        const safeBranchId = context.restrictedBranchId || (branchId && branchId !== 'all' ? String(branchId).trim() : null);
        const safeStartDate = startDate && String(startDate).trim() ? String(startDate).trim() : null;
        if (result?.courseId) {
            await query(
                'UPDATE academics.courses SET is_active = COALESCE($1, is_active), branch_id = $2, start_date = $3, completion_policy = CASE WHEN $4::boolean THEN $5::jsonb ELSE completion_policy END WHERE course_id = $6 AND tenant_id = $7',
                [typeof isActive === 'boolean' ? isActive : null, safeBranchId, safeStartDate, completionPolicy !== undefined, JSON.stringify(completionPolicy || {}), result.courseId, context.tenantId]
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
        const { title, code, category, level, durationMonths, tuitionAmount, billingPeriod, description, isActive, subjects, branchId, startDate, completionPolicy } = body;
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

        if (branchId !== undefined || startDate !== undefined || completionPolicy !== undefined) {
            if (context.restrictedBranchId && branchId && branchId !== 'all' && branchId !== context.restrictedBranchId) {
                return problem(context, req, 403, 'Forbidden', 'Cannot move course to another branch.');
            }
            const safeBranchId = context.restrictedBranchId || (branchId && branchId !== 'all' ? String(branchId).trim() : null);
            const safeStartDate = startDate && String(startDate).trim() ? String(startDate).trim() : null;
            await query(
                `UPDATE academics.courses 
                 SET branch_id = CASE WHEN $1::boolean THEN $2::uuid ELSE branch_id END,
                     start_date = CASE WHEN $3::boolean THEN $4::date ELSE start_date END,
                     completion_policy = CASE WHEN $5::boolean THEN $6::jsonb ELSE completion_policy END
                 WHERE course_id = $7 AND tenant_id = $8`,
                [
                    branchId !== undefined, safeBranchId,
                    startDate !== undefined, safeStartDate,
                    completionPolicy !== undefined, JSON.stringify(completionPolicy || {}),
                    courseId, context.tenantId
                ]
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
