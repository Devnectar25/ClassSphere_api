/**
 * Course period and the installments that fit in it, from the existing course and batch records.
 * Starts at the later of the course and batch start date; ends on the batch end date, otherwise after the course duration.
 */
import { billingError, type Queryable } from '@/lib/billing/credit-ledger';

export type Frequency = 'monthly' | 'every_2_months' | 'quarterly' | 'half_yearly' | 'custom';
export const FREQUENCY_MONTHS: Record<Exclude<Frequency, 'custom'>, number> = { monthly: 1, every_2_months: 2, quarterly: 3, half_yearly: 6 };
export const MAX_INSTALLMENTS = 36;

export interface CoursePeriod {
    startDate: string; endDate: string | null; durationMonths: number | null; today: string;
    /** Last day of the course an installment may fall due on: within the duration and not after the batch ends */
    lastDueDate: string | null;
    /** First date an installment can sensibly fall due: course start, enrollment or today, whichever is latest */
    firstDueDate: string;
    /** Installments that fit between the first due date and the course end, per frequency */
    suggestedCounts: Record<Exclude<Frequency, 'custom'>, number>;
}

/** Same day of a later month; the last day when that month is shorter. */
export function addMonths(date: string, months: number): string {
    const [year, month, day] = date.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export function fittingInstallments(firstDueDate: string, endDate: string | null, stepMonths: number): number {
    if (!endDate) return 1;
    let count = 1;
    while (count < MAX_INSTALLMENTS && addMonths(firstDueDate, count * stepMonths) < endDate) count++;
    return count;
}

/** Calendar date in the academy's time zone; an unknown zone falls back to Asia/Kolkata, as the overdue job does. */
export function dateIn(timezone: string | null, at: Date): string {
    const format = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
    try {
        return format(timezone?.trim() || 'Asia/Kolkata');
    } catch {
        return format('Asia/Kolkata');
    }
}

export async function academyToday(db: Queryable, tenantId: string): Promise<string> {
    const [org] = await db.query<{ timezone: string | null }>(`SELECT timezone FROM tenant.organizations WHERE tenant_id = $1`, [tenantId]);
    return dateIn(org?.timezone ?? null, new Date());
}

async function readPeriod(db: Queryable, tenantId: string, where: string, id: string): Promise<CoursePeriod | null> {
    const [row] = await db.query<{ starts: string; ends: string | null; last_due: string | null; duration_months: number | null; timezone: string | null; enrolled: string | Date | null }>(
        `SELECT x.starts::text, x.duration_months, x.timezone, x.enrolled,
                LEAST(CASE WHEN x.end_date > x.starts THEN x.end_date END,
                      CASE WHEN x.duration_months > 0 THEN (x.starts + make_interval(months => x.duration_months))::date - 1 END)::text AS last_due,
                (CASE WHEN x.end_date > x.starts THEN x.end_date
                      WHEN x.duration_months > 0 THEN (x.starts + make_interval(months => x.duration_months))::date END)::text AS ends
         FROM (SELECT GREATEST(c.start_date, b.start_date) AS starts, b.end_date, c.duration_months,
                      o.timezone, ${where === 'enrollment' ? 'e.enrolled_at' : 'NULL::timestamptz'} AS enrolled
               FROM academics.batches b
               JOIN academics.courses c ON c.course_id = b.course_id
               JOIN tenant.organizations o ON o.tenant_id = b.tenant_id
               ${where === 'enrollment' ? 'JOIN academics.enrollments e ON e.batch_id = b.batch_id AND e.enrollment_id = $2' : ''}
               WHERE b.tenant_id = $1 ${where === 'enrollment' ? '' : 'AND b.batch_id = $2'}) x`,
        [tenantId, id]);
    if (!row) return null;
    const today = dateIn(row.timezone, new Date());
    const firstDueDate = [row.starts, row.enrolled ? dateIn(row.timezone, new Date(row.enrolled)) : '', today].sort().at(-1)!;
    const counts = Object.fromEntries(Object.entries(FREQUENCY_MONTHS).map(([f, step]) => [f, fittingInstallments(firstDueDate, row.last_due && addDays(row.last_due, 1), step)]));
    return {
        startDate: row.starts, endDate: row.ends, durationMonths: row.duration_months, today, lastDueDate: row.last_due, firstDueDate,
        suggestedCounts: counts as CoursePeriod['suggestedCounts'],
    };
}

export async function getEnrollmentPeriod(db: Queryable, tenantId: string, enrollmentId: string): Promise<CoursePeriod> {
    const period = await readPeriod(db, tenantId, 'enrollment', enrollmentId);
    if (!period) throw billingError('not_found', 'Enrollment not found.');
    return period;
}

export const getBatchPeriod = (db: Queryable, tenantId: string, batchId: string) => readPeriod(db, tenantId, 'batch', batchId);

export interface DurationOverride { allowBeyondDuration: boolean; beyondDurationReason: string | null }

/** An installment may fall due after the course ends only with an explicit authorization and its reason. */
export function assertWithinPeriod(period: CoursePeriod, lastDueDate: string, override: DurationOverride) {
    if (!period.lastDueDate || lastDueDate <= period.lastDueDate) return;
    if (!override.allowBeyondDuration) {
        throw billingError('invalid', `The last installment (${lastDueDate}) is after the course ends (${period.lastDueDate}). Use fewer installments or authorize the extension.`);
    }
    if (!override.beyondDurationReason) throw billingError('invalid', 'Enter the reason for installments after the course ends.');
}

/**
 * Installments chosen at enrollment or course transfer: every due date falls within the course. There is no override here;
 * only a later schedule adjustment by Finance can extend one, with a reason.
 */
export function assertInstallmentsWithinCourse(period: Pick<CoursePeriod, 'startDate' | 'lastDueDate'>, dueDates: string[], frequency: Frequency | null = null) {
    const { startDate, lastDueDate } = period;
    if (!lastDueDate) throw billingError('invalid', 'Set the course duration before using installments: every installment must be paid within the course.');
    const early = dueDates.findIndex(d => d < startDate);
    if (early >= 0) {
        throw billingError('invalid', `Installment ${early + 1} is due on ${dueDates[early]}, before the course starts. Installments must be paid within the course, from ${startDate} to ${lastDueDate}.`);
    }
    const late = dueDates.findIndex(d => d > lastDueDate);
    if (late < 0) return;
    const fits = frequency && frequency !== 'custom' && dueDates[0] <= lastDueDate
        ? fittingInstallments(dueDates[0], addDays(lastDueDate, 1), FREQUENCY_MONTHS[frequency]) : null;
    throw billingError('invalid', `Installment ${late + 1} is due on ${dueDates[late]}, after the course ends. Installments must be paid within the course, from ${startDate} to ${lastDueDate}.`
        + (fits ? ` At most ${fits} installment${fits === 1 ? '' : 's'} fit with this frequency.` : ''));
}

/** Period of a course before a batch is chosen: its own start date, or today. */
export async function getCoursePeriod(db: Queryable, tenantId: string, courseId: string): Promise<Pick<CoursePeriod, 'startDate' | 'lastDueDate'> | null> {
    const [row] = await db.query<{ start_date: string | null; duration_months: number | null; timezone: string | null }>(
        `SELECT c.start_date::text, c.duration_months, o.timezone FROM academics.courses c JOIN tenant.organizations o ON o.tenant_id = c.tenant_id
         WHERE c.tenant_id = $1 AND c.course_id = $2`, [tenantId, courseId]);
    if (!row) return null;
    const startDate = row.start_date ?? dateIn(row.timezone, new Date());
    return { startDate, lastDueDate: row.duration_months && row.duration_months > 0 ? addDays(addMonths(startDate, row.duration_months), -1) : null };
}
