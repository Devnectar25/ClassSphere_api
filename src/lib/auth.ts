/**
 * Sign-in, session tokens and role-based permissions
 * Traceability: TDD Section 12-13; DECISION-005, DECISION-007
 *
 * Passwords: scrypt with a per-user random salt ("scrypt$<salt>$<hash>").
 * Sessions: HMAC-SHA256 signed tokens carrying verified claims (user, academy, role, branch scope).
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export type UserRole = 'PlatformAdmin' | 'TenantAdmin' | 'BranchManager' | 'Finance' | 'Instructor' | 'Staff' | 'Guardian';

export type Permission =
    | 'students.read' | 'students.write' | 'guardians.read' | 'guardians.write'
    | 'academics.read' | 'courses.write' | 'tests.write' | 'attendance.write' | 'billing.read' | 'billing.write'
    | 'notices.write' | 'reports.read' | 'audit.read'
    | 'staff.read' | 'staff.write' | 'branches.write' | 'settings.write' | 'portal.read';

const ALL: Permission[] = [
    'students.read', 'students.write', 'guardians.read', 'guardians.write', 'academics.read', 'courses.write', 'tests.write',
    'attendance.write', 'billing.read', 'billing.write', 'notices.write', 'reports.read', 'audit.read', 'staff.read', 'staff.write',
    'branches.write', 'settings.write', 'portal.read',
];

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
    PlatformAdmin: ALL,
    TenantAdmin: ALL,
    BranchManager: ['students.read', 'students.write', 'guardians.read', 'guardians.write', 'academics.read', 'tests.write', 'attendance.write',
        'billing.read', 'billing.write', 'notices.write', 'reports.read', 'staff.read', 'portal.read'],
    Finance: ['students.read', 'guardians.read', 'academics.read', 'billing.read', 'billing.write', 'reports.read'],
    Instructor: ['students.read', 'academics.read', 'tests.write', 'attendance.write', 'notices.write'],
    Staff: ['students.read', 'students.write', 'guardians.read', 'academics.read', 'attendance.write', 'billing.read',
        'notices.write', 'portal.read'],
    Guardian: [],
};

export function can(role: UserRole, permission: Permission) {
    return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function hashPassword(password: string) {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);
    return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** Readable temporary password, e.g. for a new parent-portal sign-in (shared once, then changed). */
export function generatePassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const chars = [...randomBytes(10)].map(b => alphabet[b % alphabet.length]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

export function verifyPassword(password: string, stored: string) {
    const [algorithm, salt, hash] = stored.split('$');
    if (algorithm !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64url');
    const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length);
    return timingSafeEqual(actual, expected);
}

export interface SessionClaims {
    sub: string;          // user id
    name: string;
    tid: string | null;   // academy (tenant) id; null for a platform operator outside any academy
    role: UserRole;
    bid: string | null;   // branch scope; null = all branches
    pa: boolean;          // platform administrator
    exp: number;          // expiry, epoch seconds
}

const SESSION_HOURS = 12;

function secret() {
    const value = process.env.AUTH_SECRET;
    if (!value || value.length < 32) throw new Error('AUTH_SECRET must be set to at least 32 characters (backend/.env)');
    return value;
}

const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url');

export function signToken(claims: Omit<SessionClaims, 'exp'>) {
    const payload = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600 })).toString('base64url');
    return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string): SessionClaims | null {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as SessionClaims;
    return claims.exp > Date.now() / 1000 ? claims : null;
}
