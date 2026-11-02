# ClassSphere

Multi-tenant class management and fee collection platform: students, guardians, courses and batches, attendance, invoicing and payments, notices, achievements, reports, a parent/student portal, and a platform admin console.

## Structure

```text
ClassSphere/
├── frontend/          Next.js web app (UI only) — port 3000
│   ├── src/app/       Pages: marketing, /register, /dashboard/*, /portal, /admin/*
│   ├── src/components/
│   ├── src/lib/       api.ts (HTTP client + hooks), session.ts (sign-in session), workspace.tsx (academy context)
│   ├── .env           NEXT_PUBLIC_API_BASE_URL (not committed)
│   └── package.json
├── backend/           Next.js route handlers (API only) — port 4000
│   ├── src/app/api/v1/   REST endpoints (/api/v1/*)
│   ├── src/lib/          db.ts (stored-function executor), auth.ts (sign-in, roles), api/ (context, errors)
│   ├── database/         migrations, functions, roles, seed, migrate.ts, dump.ts
│   ├── tests/            integration tests against PostgreSQL
│   ├── .env              DATABASE_URL / DATABASE_DIR, FRONTEND_ORIGIN, AUTH_SECRET (not committed)
│   └── package.json
├── Documents/         FRD, technical design, UI references
└── AGENTS.md, PROJECT.md, TASKS.md, DECISIONS.md, brand.md
```

The frontend never touches the database. All data flows through the backend API, and the backend
executes only PostgreSQL stored functions (`{schema}.fn_{entity}_{action}`) — no ad-hoc table CRUD.

## Prerequisites

- Node.js 22+
- No database server needed for local development: the backend embeds PostgreSQL 18 via
  [PGlite](https://pglite.dev), stored as files in `backend/database/local-db/`.
  Set `DATABASE_URL` to use a PostgreSQL / Supabase server instead.

## Setup

```bash
# 1. Backend
cd backend
cp .env.example .env        # never commit .env
npm install
npm run db:seed             # creates the local database, applies migrations, functions, roles + dev seed
npm run dev                 # http://localhost:4000/api/v1/health

# 2. Frontend (new terminal)
cd frontend
cp .env.example .env        # NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/api/v1
npm install
npm run dev                 # http://localhost:3000
```

Use `npm run db:migrate` to apply schema/function changes without the development seed.
To start over, stop the backend, delete `backend/database/local-db/` and run `npm run db:seed` again.

> The embedded database can be opened by **one process at a time**. Stop `npm run dev` before running
> `db:migrate`, `db:seed` or `db:dump`. (`npm test` uses its own in-memory database and is safe anytime.)

### Moving to Supabase / PostgreSQL

The local database is real PostgreSQL, so the same scripts run unchanged on Supabase:

1. **Schema only (recommended)** — set `DATABASE_URL` in `backend/.env` to the Supabase connection string and run
   `npm run db:migrate` (add the dev data with `npm run db:seed` if wanted).
2. **Schema + local data** — run `npm run db:dump` (writes `backend/database/local-dump.sql`), then
   `psql "<supabase connection string>" -f database/local-dump.sql`, then `npm run db:migrate` with `DATABASE_URL`
   set to re-apply the role grants.

## Environment variables

| App | Variable | Purpose |
| --- | --- | --- |
| backend | `DATABASE_URL` | Optional PostgreSQL/Supabase connection string (server-only secret); unset = embedded database |
| backend | `DATABASE_DIR` | Embedded database folder (default `./database/local-db`) |
| backend | `FRONTEND_ORIGIN` | Origin allowed by CORS (e.g. `http://localhost:3000`) |
| backend | `AUTH_SECRET` | Secret (≥ 32 chars) that signs session tokens (server-only) |
| frontend | `NEXT_PUBLIC_API_BASE_URL` | Backend API base URL (public) |

All `.env*` files except `.env.example` are excluded by `.gitignore`.

## Scripts

| Location | Command | Description |
| --- | --- | --- |
| backend | `npm run dev` / `build` / `start` | API server on port 4000 |
| backend | `npm run db:migrate` / `db:seed` | Apply database scripts (seed = local dev data) |
| backend | `npm run db:dump` | Export the embedded database as SQL for Supabase |
| backend | `npm test` | Integration tests on a fresh in-memory database (or `DATABASE_URL` if set) |
| backend, frontend | `npm run lint` | ESLint |
| frontend | `npm run dev` / `build` / `start` | Web app on port 3000 |

## API

Base path `/api/v1`. Responses use `{ success, data, correlationId }`; errors use RFC 7807 problem details.
The endpoint catalogue is served at `GET /api/v1/docs`.

Every request except `/health`, `/plans`, `/docs` and `/auth/login` needs a session token from `POST /api/v1/auth/login`
(`Authorization: Bearer …`). The academy, role and branch scope are claims of the signed token; staff who are not
branch-scoped may narrow a request to one branch with the `X-Branch-Id` header (consolidated view when absent).

## Sign-in, roles and branches

Open http://localhost:3000/login. The development seed creates these accounts (password **ClassSphere@2026** for all —
dev seed only, change or remove before any shared deployment):

| Account | Role | Lands on |
| --- | --- | --- |
| platform@classsphere.dev | Platform administrator — creates academies, opens any academy | /admin |
| sarah.jenkins@apex-conservatory.org | Academy Admin — all branches, users, settings | /dashboard |
| west.manager@apex-conservatory.org | Branch Manager — West Wing branch only | /dashboard |
| bursar@apex-conservatory.org | Finance — fees, invoices, payments, reports | /dashboard |
| marcus.vance@apex-conservatory.org | Instructor — batches, attendance, notices | /dashboard/students |
| eleanor.thompson@curator-arts.org | Parent / Guardian — parent portal | /portal |

| Role | Can |
| --- | --- |
| Academy Admin | Everything in the academy: all branches (consolidated or per branch), users & roles, branches, settings/logo |
| Branch Manager | Students, guardians, attendance, billing and notices of their own branch |
| Finance | Fees, invoices, payments and financial reports |
| Instructor | Students (read), batches, attendance, notices, test marks |
| Staff | Students, guardians, attendance and notices; billing read-only |
| Parent / Guardian | Each of their children's attendance, fees paid, dues, payment slips, published test results / report cards, academy notices and achievement board |

- **Academies** (platform admin → *Academies* → *Create Academy*): any type — Tuition, Music, Sports, Dance, Arts, Test Prep,
  Language, Other — each with its own admin sign-in, branches, users and data. *Open* switches into an academy.
- **Branches**: students belong to a home branch. The sidebar switches between *All branches (consolidated)* and one branch;
  branch-scoped users always see only their branch. Add branches under *Branches*, users under *Users & Roles*.
- **Courses & subjects**: *Courses* → *Create Course* suggests categories and subjects for the academy's type (Music, Tuition,
  Sports, …); subjects can be added later with *+ Subject*.
- **Tests & grading**: *Tests & Results* → *Schedule Test* (batch, subjects, max marks) → *Enter marks* (or mark absent) →
  *Publish*. Grades: A+ ≥ 90 %, A ≥ 80, B+ ≥ 70, B ≥ 60, C ≥ 50, D ≥ 40, F below. Published results and printable report cards
  appear in the parent portal.
- **Parent logins**: *Guardians* → *Add Parent* (link one or more children, tick *Create portal login*) or *Create login* /
  *Reset password* on an existing parent. The generated password is shown once, with *Copy message* and *Email to parent*.
- **Parent portal**: left navigation (Overview, Attendance, Fees & Payments, Test Results, Timetable, Practice Log, Notices,
  Achievements) with a child switcher for parents of several children.
- **Academy logo**: *Settings → Branding* (PNG/JPG/WEBP/SVG, ≤ 512 KB); shown on the parent portal and in the workspace.

See `TASKS.md` for remaining work.
