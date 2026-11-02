import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Course Catalogue & Subjects API
 * Traceability: TDD Section 10.4
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    try {
        return ok(context, await callFn('academics.fn_course_list', context.tenantId));
    } catch (err) {
        return fail(err, context, req);
    }
}

/** Creates a course with its subjects. */
export async function POST(req: NextRequest) {
    const context = authorize(req, 'courses.write');
    if (context instanceof Response) return context;
    try {
        const { title, code, category, level, durationMonths, tuitionAmount, billingPeriod, description, subjects } = await req.json();
        if (!title || !code || !category) {
            return problem(context, req, 400, 'Validation Error', 'Course title, code and category are required.');
        }
        const subjectList = Array.isArray(subjects) ? subjects.map(String).filter(s => s.trim()) : [];
        if (subjectList.length === 0) {
            return problem(context, req, 400, 'Validation Error', 'Add at least one subject to the course.');
        }
        const result = await callFn('academics.fn_course_create',
            context.tenantId, title, code, category, level || null, durationMonths ? Number(durationMonths) : null,
            Number(tuitionAmount ?? 0), billingPeriod || 'monthly', description || null, subjectList, context.actorId);
        return ok(context, result, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}

/** Adds a subject to an existing course. */
export async function PUT(req: NextRequest) {
    const context = authorize(req, 'courses.write');
    if (context instanceof Response) return context;
    try {
        const { courseId, subject } = await req.json();
        if (!courseId || !subject?.trim()) {
            return problem(context, req, 400, 'Validation Error', 'courseId and subject name are required.');
        }
        return ok(context, await callFn('academics.fn_course_subject_add', context.tenantId, courseId, subject, context.actorId), 201);
    } catch (err) {
        return fail(err, context, req);
    }
}
