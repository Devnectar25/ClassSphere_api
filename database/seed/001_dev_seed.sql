-- ============================================================================
-- ClassSphere Development Seed: 001_dev_seed.sql
-- Local development fixture only (AGENTS.md §4). Never run against production.
-- Seeds one tenant workspace; dates are relative to CURRENT_DATE so dashboards stay current.
-- Re-runnable: every row uses a fixed id with ON CONFLICT DO NOTHING.
-- Seed users carry an unusable password hash ('!') — they cannot sign in.
-- ============================================================================

-- Tenant workspace, subscription and branches
INSERT INTO tenant.organizations (tenant_id, name, slug, currency, timezone, branding, settings) VALUES
('00000000-0000-0000-0000-000000000001', 'Apex Music & Arts Conservatory', 'apex-conservatory', 'INR', 'America/New_York',
 '{"primaryColor": "#1E3A8A", "logoUrl": null, "tagline": "Excellence in Performance"}',
 '{"category": "Music & Performing Arts", "email": "office@apex-conservatory.org", "phone": "+1 (555) 019-2800",
   "city": "New York, NY", "academicSession": "Academic Session 2026–2027 • Michaelmas Term Recital Registration Active",
   "notificationTriggers": [
     {"key": "invoice_generated", "label": "Invoice Generated", "description": "Notify guardian when a new invoice is created", "channels": ["Email", "SMS"], "enabled": true},
     {"key": "fee_due_reminder", "label": "Fee Due Reminder", "description": "Remind 3 days before the due date", "channels": ["Email", "SMS"], "enabled": true},
     {"key": "payment_successful", "label": "Payment Successful", "description": "Confirmation after a successful payment", "channels": ["Email"], "enabled": true},
     {"key": "absence_alert", "label": "Absence Alert", "description": "Notify guardian if a student is absent", "channels": ["SMS"], "enabled": false}
   ]}')
ON CONFLICT DO NOTHING;

INSERT INTO platform.subscriptions (subscription_id, tenant_id, plan_tier, status, max_seats, max_branches, mrr, current_period_end) VALUES
('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000001', 'Enterprise', 'active', 500, 25, 4999.00, CURRENT_DATE + 60)
ON CONFLICT DO NOTHING;

INSERT INTO identity_app.users (user_id, email, password_hash, full_name, phone, last_login_at) VALUES
('00000000-0000-0000-0000-0000000000a1', 'sarah.jenkins@apex-conservatory.org', '!', 'Sarah Jenkins', '+1 (555) 019-2801', now() - INTERVAL '2 hours'),
('00000000-0000-0000-0000-0000000000a2', 'marcus.vance@apex-conservatory.org', '!', 'Prof. Marcus Vance', '+1 (555) 019-2802', now() - INTERVAL '1 day'),
('00000000-0000-0000-0000-0000000000a3', 'elena.rostova@apex-conservatory.org', '!', 'Dr. Elena Rostova', '+1 (555) 019-2803', now() - INTERVAL '5 hours'),
('00000000-0000-0000-0000-0000000000a4', 'julian.ross@apex-conservatory.org', '!', 'Maestro Julian Ross', '+1 (555) 019-2804', now() - INTERVAL '3 days'),
('00000000-0000-0000-0000-0000000000a5', 'bursar@apex-conservatory.org', '!', 'Daniel Okafor', '+1 (555) 019-2805', now() - INTERVAL '6 hours'),
('00000000-0000-0000-0000-0000000000a6', 'eleanor.thompson@curator-arts.org', '!', 'Eleanor Thompson', '+1 (555) 382-9910', now() - INTERVAL '1 day')
ON CONFLICT DO NOTHING;

INSERT INTO tenant.branches (branch_id, tenant_id, name, code, address, phone, email, head_user_id, is_primary) VALUES
('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'Main Conservatory Campus', 'MAIN',
 '100 Symphony Lane, Suite 400', '+1 (555) 019-2830', 'main@apex-conservatory.org', '00000000-0000-0000-0000-0000000000a1', TRUE),
('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000001', 'West Wing Piano Studios', 'WEST',
 '42 Conservatory Promenade', '+1 (555) 019-2831', 'west@apex-conservatory.org', '00000000-0000-0000-0000-0000000000a4', FALSE)
ON CONFLICT DO NOTHING;

INSERT INTO tenant.memberships (membership_id, tenant_id, user_id, branch_id, role, title, profile, permissions) VALUES
('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', NULL, 'TenantAdmin', 'Provost', '{}', ARRAY['*']),
('00000000-0000-0000-0000-000000000802', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b1', 'Instructor',
 'Chair, Department of Piano & Chamber Literature', '{"office": "Studio IV", "distinction": "Former Royal Concertgebouw Soloist"}', ARRAY[]::TEXT[]),
('00000000-0000-0000-0000-000000000803', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000b1', 'Instructor',
 'Concertmaster & Senior Violin Instructor', '{"office": "Studio II-B", "distinction": "Principal Soloist, Philharmonic Sinfonia"}', ARRAY[]::TEXT[]),
('00000000-0000-0000-0000-000000000804', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000b2', 'Instructor',
 'Director of Ensembles', '{"office": "Recital Hall North"}', ARRAY[]::TEXT[]),
('00000000-0000-0000-0000-000000000805', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000b1', 'Finance', 'Bursar', '{}', ARRAY[]::TEXT[]),
('00000000-0000-0000-0000-000000000806', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a6', NULL, 'Guardian', NULL, '{}', ARRAY[]::TEXT[])
ON CONFLICT DO NOTHING;

-- Courses, batches and weekly schedules
INSERT INTO academics.courses (course_id, tenant_id, title, code, category, level, duration_months, tuition_amount, billing_period) VALUES
('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'Senior Keyboard Studies & Composition', 'MUS-701', 'Music', 'Grade VII', 12, 1450.00, 'term'),
('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-000000000001', 'Junior String Orchestral Preparatory', 'STR-401', 'Music', 'Grade IV', 12, 350.00, 'monthly'),
('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-000000000001', 'Schenkerian Analysis & 19th c. Harmony', 'THY-502', 'Academics', 'Grade V–VII', 6, 420.00, 'monthly')
ON CONFLICT DO NOTHING;

INSERT INTO academics.courses (course_id, tenant_id, title, code, category, level, duration_months, tuition_amount, billing_period, is_active) VALUES
('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-000000000001', 'Jazz Improvisation Lab', 'JAZ-301', 'Music', 'Grade III–V', 8, 300.00, 'monthly', FALSE)
ON CONFLICT DO NOTHING;

INSERT INTO academics.batches (batch_id, tenant_id, course_id, branch_id, name, instructor_user_id, room, capacity, start_date) VALUES
('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1',
 'Keyboard Solo Intensive — Studio 4B', '00000000-0000-0000-0000-0000000000a2', 'Studio 4B (Steinway Grand D)', 25, CURRENT_DATE - 60),
('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b1',
 'Junior String Ensemble & Suzuki Sectionals', '00000000-0000-0000-0000-0000000000a3', 'Studio II-B (Strings Salon)', 20, CURRENT_DATE - 60),
('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000b2',
 'Chamber Literature & Score Analysis', '00000000-0000-0000-0000-0000000000a4', 'Recital Hall North', 30, CURRENT_DATE - 60)
ON CONFLICT DO NOTHING;

INSERT INTO academics.batch_schedules (schedule_id, tenant_id, batch_id, weekday, start_time, end_time, session_type) VALUES
('00000000-0000-0000-0000-000000000d11', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d1', 2, '09:30', '11:00', 'Intensive'),
('00000000-0000-0000-0000-000000000d12', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d1', 4, '09:30', '11:00', 'Intensive'),
('00000000-0000-0000-0000-000000000d21', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d2', 3, '16:00', '17:30', 'Masterclass'),
('00000000-0000-0000-0000-000000000d22', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d2', 5, '16:30', '18:00', 'Rehearsal'),
('00000000-0000-0000-0000-000000000d31', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d3', 6, '10:00', '12:30', 'Ensemble')
ON CONFLICT DO NOTHING;

-- Students, guardians and enrollments
INSERT INTO academics.students (student_id, tenant_id, first_name, last_name, preferred_name, email, phone, date_of_birth,
                                enrollment_number, status, academic_standing, matriculation_year, profile, created_at) VALUES
('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', 'Leo Alexander', 'Thompson', 'Leo', 'leo.thompson@curator-arts.org', '+1 (555) 382-9911', '2008-04-12',
 'APX-2021-089', 'active', 'Summa Cum Laude', '2021',
 '{"division": "Division of Keyboard Studies & Composition", "track": "Senior Preparatory Diploma Candidate (Grade VII Performance with Distinction Track)",
   "standingRoster": "Dean’s Merit Roster 2026", "juryStatus": "Qualified", "juryDate": "Winter Juried Evaluation scheduled Dec 14",
   "practiceSuite": {"room": "Room C-12", "schedule": "Daily 4:00 PM – 6:00 PM"}}', CURRENT_DATE - 400),
('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-000000000001', 'Maya Claire', 'Thompson', 'Maya', 'maya.thompson@curator-arts.org', '+1 (555) 382-9912', '2012-07-25',
 'APX-2023-144', 'active', 'First Class Honors', '2023',
 '{"division": "Division of Strings & Orchestral Performance", "track": "Junior String Preparatory Program (Grade IV Violin)",
   "standingRoster": "Conductor’s Honor Roll 2026", "juryStatus": "Scheduled", "juryDate": "Autumn Progress Assessment scheduled Nov 20",
   "practiceSuite": {"room": "Room V-04", "schedule": "Mon, Wed, Fri 3:00 PM – 4:00 PM"}}', CURRENT_DATE - 300),
('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000000000001', 'Riya', 'Sharma', NULL, 'riya.sharma@example.com', '+1 (555) 234-5678', '2009-02-14',
 'APX-2022-031', 'active', 'Distinction Track', '2022', '{}', CURRENT_DATE - 200),
('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-000000000001', 'Arjun', 'Mehta', NULL, 'arjun.mehta@example.com', '+1 (555) 345-6789', '2010-09-18',
 'APX-2024-012', 'active', 'Good Standing', '2024', '{}', CURRENT_DATE - 10),
('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-000000000001', 'Priya', 'Patel', NULL, 'priya.patel@example.com', '+1 (555) 456-7890', '2009-11-03',
 'APX-2022-054', 'on-hold', 'Honor Roll', '2022', '{}', CURRENT_DATE - 150),
('00000000-0000-0000-0000-0000000000e6', '00000000-0000-0000-0000-000000000001', 'Aarav', 'Kapoor', NULL, 'aarav.kapoor@example.com', '+1 (555) 567-8901', '2011-06-21',
 'APX-2026-007', 'inquiry', 'Good Standing', '2026', '{}', CURRENT_DATE - 3)
ON CONFLICT DO NOTHING;

INSERT INTO academics.guardians (guardian_id, tenant_id, user_id, household_code, first_name, last_name, relationship, phone, email) VALUES
('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a6', 'APX-8820-T', 'Eleanor', 'Thompson', 'Mother', '+1 (555) 382-9910', 'eleanor.thompson@curator-arts.org'),
('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-000000000001', NULL, 'APX-4410-S', 'Rajesh', 'Sharma', 'Father', '+1 (555) 234-5600', 'rajesh.sharma@example.com'),
('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-000000000001', NULL, 'APX-5521-P', 'Meena', 'Patel', 'Mother', '+1 (555) 456-7800', 'meena.patel@example.com')
ON CONFLICT DO NOTHING;

INSERT INTO academics.student_guardian_links (link_id, tenant_id, student_id, guardian_id, is_primary) VALUES
('00000000-0000-0000-0000-000000000f11', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', TRUE),
('00000000-0000-0000-0000-000000000f12', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f1', TRUE),
('00000000-0000-0000-0000-000000000f21', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000f2', TRUE),
('00000000-0000-0000-0000-000000000f31', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000f3', TRUE)
ON CONFLICT DO NOTHING;

INSERT INTO academics.enrollments (enrollment_id, tenant_id, student_id, batch_id, enrolled_at) VALUES
('00000000-0000-0000-0000-000000000e11', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', CURRENT_DATE - 60),
('00000000-0000-0000-0000-000000000e13', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d3', CURRENT_DATE - 59),
('00000000-0000-0000-0000-000000000e22', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000d2', CURRENT_DATE - 60),
('00000000-0000-0000-0000-000000000e33', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000d3', CURRENT_DATE - 60),
('00000000-0000-0000-0000-000000000e41', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000d1', CURRENT_DATE - 10),
('00000000-0000-0000-0000-000000000e52', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000d2', CURRENT_DATE - 60)
ON CONFLICT DO NOTHING;

-- Attendance for scheduled sessions over the last three weeks (deterministic pattern)
INSERT INTO academics.attendance_records (tenant_id, batch_id, student_id, session_date, status, recorded_by_actor_id)
SELECT e.tenant_id, e.batch_id, e.student_id, d::date,
       CASE WHEN (EXTRACT(DOY FROM d)::int + ascii(right(e.student_id::text, 1))) % 13 = 0 THEN 'absent'
            WHEN (EXTRACT(DOY FROM d)::int + ascii(right(e.student_id::text, 1))) % 7 = 0 THEN 'late'
            ELSE 'present' END,
       b.instructor_user_id
FROM academics.enrollments e
JOIN academics.batches b ON b.batch_id = e.batch_id
JOIN academics.batch_schedules s ON s.batch_id = e.batch_id
CROSS JOIN generate_series(CURRENT_DATE - 21, CURRENT_DATE - 1, INTERVAL '1 day') d
WHERE e.tenant_id = '00000000-0000-0000-0000-000000000001' AND EXTRACT(ISODOW FROM d) = s.weekday
ON CONFLICT DO NOTHING;

-- Fee structure
INSERT INTO billing.fee_heads (fee_head_id, tenant_id, code, name, frequency, is_active) VALUES
('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 'FH-001', 'Tuition', 'term', TRUE),
('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000001', 'FH-002', 'Admission Fee', 'one-time', TRUE),
('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000001', 'FH-003', 'Annual Masterclass & Guild Fee', 'annual', TRUE),
('00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000001', 'FH-004', 'Juried Evaluation Fee', 'one-time', TRUE),
('00000000-0000-0000-0000-000000000105', '00000000-0000-0000-0000-000000000001', 'FH-005', 'Instrument Locker Fee', 'annual', FALSE)
ON CONFLICT DO NOTHING;

INSERT INTO billing.fee_plans (plan_id, tenant_id, name, course_id, discount_percent) VALUES
('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000001', 'Senior Keyboard Diploma', '00000000-0000-0000-0000-0000000000c1', 0),
('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000001', 'Junior Strings Preparatory', '00000000-0000-0000-0000-0000000000c2', 0),
('00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000001', 'Sibling Household Plan', NULL, 10)
ON CONFLICT DO NOTHING;

INSERT INTO billing.fee_plan_items (plan_id, fee_head_id, amount) VALUES
('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000101', 1450.00),
('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000102', 250.00),
('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000103', 220.00),
('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000101', 350.00),
('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000102', 150.00),
('00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000101', 1300.00),
('00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000103', 200.00)
ON CONFLICT DO NOTHING;

-- Invoices (balances reconcile with the payments below)
INSERT INTO billing.invoices (invoice_id, tenant_id, invoice_number, student_id, billing_period, subtotal_amount, total_amount,
                              paid_amount, balance_amount, due_date, status, designation, created_at) VALUES
('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000001', 'INV-SEED-0001', '00000000-0000-0000-0000-0000000000e1', to_char(CURRENT_DATE - 150, 'Mon YYYY'),
 185.00, 185.00, 185.00, 0, CURRENT_DATE - 135, 'paid', 'Trinity Guild Juried Evaluation Assessment', CURRENT_DATE - 150),
('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000001', 'INV-SEED-0002', '00000000-0000-0000-0000-0000000000e1', to_char(CURRENT_DATE - 75, 'Mon YYYY'),
 220.00, 220.00, 220.00, 0, CURRENT_DATE - 60, 'paid', 'Annual Masterclass & Juried Guild Fee', CURRENT_DATE - 75),
('00000000-0000-0000-0000-000000000303', '00000000-0000-0000-0000-000000000001', 'INV-SEED-0003', '00000000-0000-0000-0000-0000000000e1', to_char(CURRENT_DATE - 20, 'Mon YYYY'),
 1450.00, 1450.00, 1450.00, 0, CURRENT_DATE - 5, 'paid', 'Autumn Term Conservatory Tuition — Senior Keyboard', CURRENT_DATE - 20),
('00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-000000000001', 'INV-SEED-0004', '00000000-0000-0000-0000-0000000000e2', to_char(CURRENT_DATE - 90, 'Mon YYYY'),
 140.00, 140.00, 140.00, 0, CURRENT_DATE - 75, 'paid', 'Annual Sheet Music & Instrument Locker Fee', CURRENT_DATE - 90),
('00000000-0000-0000-0000-000000000305', '00000000-0000-0000-0000-000000000001', 'INV-SEED-0005', '00000000-0000-0000-0000-0000000000e2', to_char(CURRENT_DATE - 2, 'Mon YYYY'),
 350.00, 350.00, 0, 350.00, CURRENT_DATE + 13, 'pending', 'Term II Orchestral Studio Fee — Junior Strings', CURRENT_DATE - 2),
('00000000-0000-0000-0000-000000000306', '00000000-0000-0000-0000-000000000001', 'INV-SEED-0006', '00000000-0000-0000-0000-0000000000e3', to_char(CURRENT_DATE - 25, 'Mon YYYY'),
 420.00, 420.00, 420.00, 0, CURRENT_DATE - 10, 'paid', 'Monthly Theory & Harmony Masterclass', CURRENT_DATE - 25),
('00000000-0000-0000-0000-000000000307', '00000000-0000-0000-0000-000000000001', 'INV-SEED-0007', '00000000-0000-0000-0000-0000000000e5', to_char(CURRENT_DATE - 55, 'Mon YYYY'),
 350.00, 350.00, 0, 350.00, CURRENT_DATE - 40, 'pending', 'Junior Strings Monthly Tuition', CURRENT_DATE - 55),
('00000000-0000-0000-0000-000000000308', '00000000-0000-0000-0000-000000000001', 'INV-SEED-0008', '00000000-0000-0000-0000-0000000000e4', to_char(CURRENT_DATE - 9, 'Mon YYYY'),
 1450.00, 1450.00, 600.00, 850.00, CURRENT_DATE - 2, 'partially_paid', 'Autumn Term Conservatory Tuition — Senior Keyboard', CURRENT_DATE - 9),
('00000000-0000-0000-0000-000000000309', '00000000-0000-0000-0000-000000000001', 'INV-SEED-0009', '00000000-0000-0000-0000-0000000000e3', to_char(CURRENT_DATE - 120, 'Mon YYYY'),
 420.00, 420.00, 420.00, 0, CURRENT_DATE - 105, 'paid', 'Monthly Theory & Harmony Masterclass', CURRENT_DATE - 120)
ON CONFLICT DO NOTHING;

INSERT INTO billing.payments (payment_id, tenant_id, invoice_id, student_id, payment_reference, amount, payment_method, status,
                              receipt_number, recorded_by_actor_id, created_at) VALUES
('00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-0000000000e1',
 'BANKWIRE-3104', 185.00, 'BankWire', 'reconciled', 'RCP-SEED-3104', '00000000-0000-0000-0000-0000000000a5', CURRENT_DATE - 140),
('00000000-0000-0000-0000-000000000402', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-0000000000e1',
 'CARD-AUTOPAY-6211', 220.00, 'Card', 'posted', 'RCP-SEED-6211', '00000000-0000-0000-0000-0000000000a5', CURRENT_DATE - 70),
('00000000-0000-0000-0000-000000000403', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000303', '00000000-0000-0000-0000-0000000000e1',
 'CARD-AUTOPAY-8819', 1450.00, 'Card', 'posted', 'RCP-SEED-8819', '00000000-0000-0000-0000-0000000000a5', CURRENT_DATE - 18),
('00000000-0000-0000-0000-000000000404', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-0000000000e2',
 'CARD-5120', 140.00, 'Card', 'posted', 'RCP-SEED-5120', '00000000-0000-0000-0000-0000000000a5', CURRENT_DATE - 85),
('00000000-0000-0000-0000-000000000405', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000306', '00000000-0000-0000-0000-0000000000e3',
 'UPI-RAZORPAY-7719', 420.00, 'UPI', 'posted', 'RCP-SEED-4412', '00000000-0000-0000-0000-0000000000a5', CURRENT_DATE - 12),
('00000000-0000-0000-0000-000000000406', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000308', '00000000-0000-0000-0000-0000000000e4',
 'CASH-0042', 600.00, 'Cash', 'posted', 'RCP-SEED-0042', '00000000-0000-0000-0000-0000000000a5', CURRENT_DATE - 1),
('00000000-0000-0000-0000-000000000407', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000309', '00000000-0000-0000-0000-0000000000e3',
 'CHEQUE-2231', 420.00, 'Cheque', 'reconciled', 'RCP-SEED-2231', '00000000-0000-0000-0000-0000000000a5', CURRENT_DATE - 110)
ON CONFLICT DO NOTHING;

-- Notices, achievements and events
INSERT INTO engagement.notices (notice_id, tenant_id, title, content, notice_type, status, priority, target_audience, branch_id,
                                channels, author_actor_id, is_pinned, published_at, expires_at) VALUES
('00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000001', 'Michaelmas Term Recital Registration Active',
 'Audition registration for the 94th Winter Gala Soloist Showcase is now open. Faculty nominations close in three weeks.',
 'announcement', 'published', 'urgent', 'all', NULL, ARRAY['in-app', 'email'], '00000000-0000-0000-0000-0000000000a1', TRUE, now() - INTERVAL '6 days', now() + INTERVAL '21 days'),
('00000000-0000-0000-0000-000000000502', '00000000-0000-0000-0000-000000000001', 'Conservatory Studio Steinway Tuning Schedule',
 'Studios 4A through 4D will undergo quarterly precision acoustic voicing this Saturday from 06:00 AM to 09:00 AM.',
 'notice', 'published', 'normal', 'students', '00000000-0000-0000-0000-0000000000b1', ARRAY['in-app'], '00000000-0000-0000-0000-0000000000a1', FALSE, now() - INTERVAL '2 days', now() + INTERVAL '5 days'),
('00000000-0000-0000-0000-000000000503', '00000000-0000-0000-0000-000000000001', 'Term II Fee Reminder',
 'Term II studio fees are due within the next two weeks. Please settle outstanding balances through the guardian portal.',
 'alert', 'scheduled', 'high', 'guardians', NULL, ARRAY['email', 'sms'], '00000000-0000-0000-0000-0000000000a5', FALSE, now() + INTERVAL '2 days', now() + INTERVAL '16 days'),
('00000000-0000-0000-0000-000000000504', '00000000-0000-0000-0000-000000000001', 'Parent–Faculty Consultation Evening',
 'Annual consultation evening with department chairs. Booking slots will open through the guardian portal.',
 'event', 'draft', 'normal', 'guardians', NULL, ARRAY['in-app', 'email'], '00000000-0000-0000-0000-0000000000a1', FALSE, now(), NULL)
ON CONFLICT DO NOTHING;

INSERT INTO engagement.achievements (achievement_id, tenant_id, student_id, title, category, level, visibility, award_date, issuer, grade, remarks, photo_file_key) VALUES
('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1', 'Chopin Prelude Distinction 2026', 'Distinction', 'Institute', 'public',
 CURRENT_DATE - 40, 'Apex Conservatory Faculty', 'Grade VII', 'Adjudicated with honors for polyphonic balance and lyrical phrasing.', 'achievements/leo-chopin.jpg'),
('00000000-0000-0000-0000-000000000602', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1', 'Harmony & Counterpoint Cert. II', 'Certification', 'State', 'guardian',
 CURRENT_DATE - 90, 'Apex Theory Guild', 'Honors', 'Score: 98/100.', NULL),
('00000000-0000-0000-0000-000000000603', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e2', 'Suzuki String Excellence Ribbon', 'Distinction', 'City', 'public',
 CURRENT_DATE - 35, 'Apex Strings Academy Jury', 'Grade IV', 'Recognized for intonation precision and orchestral section leadership.', NULL),
('00000000-0000-0000-0000-000000000604', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e3', 'Regional Theory Olympiad — Finalist', 'Competition', 'National', 'batch',
 CURRENT_DATE - 15, 'National Music Theory Society', NULL, 'Advanced to national finals in harmonic analysis.', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO engagement.events (event_id, tenant_id, title, event_type, starts_at, venue, description) VALUES
('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000001', 'The 94th Annual Winter Gala & Soloist Showcase', 'event',
 date_trunc('day', now()) + INTERVAL '24 days 19 hours', 'Bradley Memorial Symphony Auditorium',
 'Selected by jury ballot to perform Chopin’s Ballade No. 1 in G Minor, Op. 23. Reserved patron seating is allocated for family members.'),
('00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000001', 'Autumn String Festival & Junior Symphony', 'event',
 date_trunc('day', now()) + INTERVAL '12 days 15 hours 30 minutes', 'St. Cecilia Chamber Hall',
 'Performing Vivaldi Concerto in A Minor with the Junior String Ensemble. Patron admission is complimentary for family members.'),
('00000000-0000-0000-0000-000000000703', '00000000-0000-0000-0000-000000000001', 'Winter Juried Evaluation — Keyboard', 'test',
 date_trunc('day', now()) + INTERVAL '8 days 9 hours', 'Studio 4B', NULL),
('00000000-0000-0000-0000-000000000704', '00000000-0000-0000-0000-000000000001', 'Term II Fee Due Date', 'fee',
 date_trunc('day', now()) + INTERVAL '13 days', NULL, NULL)
ON CONFLICT DO NOTHING;

INSERT INTO engagement.event_participants (event_id, student_id, tenant_id, role_label, program, seating, guaranteed_seats, seats_claimed_at) VALUES
('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', 'Leo Thompson', 'F. Chopin • Op. 23', 'Grand Auditorium • Tier 1 Box C', 4, NULL),
('00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-000000000001', 'Maya Thompson (Violin II Section)', 'A. Vivaldi • RV 356', 'Chamber Hall • Row C, Seats 8-10', 3, now() - INTERVAL '3 days')
ON CONFLICT DO NOTHING;

-- Practice logs for the last two weeks
INSERT INTO engagement.practice_logs (log_id, tenant_id, student_id, log_date, hours, piece, recorded_by_actor_id)
SELECT md5(s.student_id::text || d::date::text)::uuid, '00000000-0000-0000-0000-000000000001', s.student_id, d::date,
       CASE WHEN s.student_id = '00000000-0000-0000-0000-0000000000e1' THEN 2.5 + (EXTRACT(DOW FROM d)::int % 3) * 0.5
            ELSE 1.5 + (EXTRACT(DOW FROM d)::int % 2) * 0.5 END,
       CASE WHEN s.student_id = '00000000-0000-0000-0000-0000000000e1' THEN 'Chopin Ballade No. 1 in G Minor, Op. 23'
            ELSE 'Vivaldi Concerto in A Minor, RV 356' END,
       '00000000-0000-0000-0000-0000000000a6'
FROM academics.students s
CROSS JOIN generate_series(CURRENT_DATE - 13, CURRENT_DATE, INTERVAL '1 day') d
WHERE s.student_id IN ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2')
ON CONFLICT DO NOTHING;

-- Initial audit trail
INSERT INTO audit.compliance_logs (log_id, tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details, created_at) VALUES
('00000000-0000-0000-0000-000000000b01', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'tenant.created', 'tenant',
 '00000000-0000-0000-0000-000000000001', 'seed-tenant', '{"name": "Apex Music & Arts Conservatory", "plan": "Enterprise"}', now() - INTERVAL '400 days'),
('00000000-0000-0000-0000-000000000b02', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'student.created', 'student',
 '00000000-0000-0000-0000-0000000000e4', 'seed-student', '{"name": "Arjun Mehta", "enrollmentNo": "APX-2024-012"}', now() - INTERVAL '10 days'),
('00000000-0000-0000-0000-000000000b03', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a5', 'billing.payment_posted', 'payment',
 '00000000-0000-0000-0000-000000000406', 'seed-payment', '{"receipt": "RCP-SEED-0042", "amount": 600, "method": "Cash"}', now() - INTERVAL '1 day')
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- Sign-in for local development (dev seed only). Password for every demo account: ClassSphere@2026
-- Only replaces the unusable placeholder hash, so passwords changed later are kept.
-- ----------------------------------------------------------------------------
UPDATE tenant.organizations SET academy_type = 'Music'
WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND academy_type = 'Tuition';

INSERT INTO identity_app.users (user_id, email, password_hash, full_name, is_platform_admin) VALUES
('00000000-0000-0000-0000-0000000000a7', 'platform@classsphere.dev', '!', 'Platform Operator', TRUE),
('00000000-0000-0000-0000-0000000000a8', 'west.manager@apex-conservatory.org', '!', 'Nisha Rao', FALSE)
ON CONFLICT DO NOTHING;

INSERT INTO tenant.memberships (membership_id, tenant_id, user_id, branch_id, role, title) VALUES
('00000000-0000-0000-0000-000000000807', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a8',
 '00000000-0000-0000-0000-0000000000b2', 'BranchManager', 'West Wing Branch Manager')
ON CONFLICT DO NOTHING;

UPDATE identity_app.users
SET password_hash = 'scrypt$LTUeMxlorjJ7rNBvs_4O8A$TNouCER8ilRvmY2F5W0uifY8QGw1ifqus-Yf_k522wA1YjlQOGFjhl2mK6GBExlsNCZkY9CfqaYOVul9C-ZxUg'
WHERE password_hash = '!' AND user_id IN (
    '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3',
    '00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000a6',
    '00000000-0000-0000-0000-0000000000a7', '00000000-0000-0000-0000-0000000000a8');

-- Home branch for students seeded before branch assignment existed
UPDATE academics.students s
SET branch_id = COALESCE(
    (SELECT b.branch_id FROM academics.enrollments e JOIN academics.batches b ON b.batch_id = e.batch_id
     WHERE e.student_id = s.student_id ORDER BY e.enrolled_at LIMIT 1),
    (SELECT br.branch_id FROM tenant.branches br WHERE br.tenant_id = s.tenant_id ORDER BY br.is_primary DESC, br.created_at LIMIT 1))
WHERE s.branch_id IS NULL;

-- ----------------------------------------------------------------------------
-- Course subjects, tests and results
-- ----------------------------------------------------------------------------
INSERT INTO academics.course_subjects (subject_id, tenant_id, course_id, name, sort_order) VALUES
('00000000-0000-0000-0000-000000000c11', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', 'Repertoire Performance', 1),
('00000000-0000-0000-0000-000000000c12', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', 'Technique & Scales', 2),
('00000000-0000-0000-0000-000000000c13', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', 'Sight Reading', 3),
('00000000-0000-0000-0000-000000000c21', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c2', 'Intonation', 1),
('00000000-0000-0000-0000-000000000c22', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c2', 'Ensemble Playing', 2),
('00000000-0000-0000-0000-000000000c31', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c3', 'Harmony', 1),
('00000000-0000-0000-0000-000000000c32', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c3', 'Score Analysis', 2)
ON CONFLICT DO NOTHING;

INSERT INTO academics.tests (test_id, tenant_id, batch_id, title, test_type, test_date, status, published_at, created_by_actor_id) VALUES
('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d1',
 'October Keyboard Assessment', 'Mid Term', CURRENT_DATE - 6, 'published', now() - INTERVAL '3 days', '00000000-0000-0000-0000-0000000000a2'),
('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d2',
 'Strings Progress Test', 'Unit Test', CURRENT_DATE - 4, 'published', now() - INTERVAL '2 days', '00000000-0000-0000-0000-0000000000a3'),
('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d3',
 'Harmony & Analysis Quiz', 'Unit Test', CURRENT_DATE + 7, 'scheduled', NULL, '00000000-0000-0000-0000-0000000000a4')
ON CONFLICT DO NOTHING;

INSERT INTO academics.test_subjects (test_id, subject_id, max_marks) VALUES
('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-000000000c11', 50),
('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-000000000c12', 30),
('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-000000000c13', 20),
('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-000000000c21', 50),
('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-000000000c22', 50),
('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-000000000c31', 25),
('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-000000000c32', 25)
ON CONFLICT DO NOTHING;

INSERT INTO academics.test_results (test_id, student_id, subject_id, tenant_id, marks_obtained, remarks, recorded_by_actor_id) VALUES
('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000c11', '00000000-0000-0000-0000-000000000001', 47, 'Expressive Chopin phrasing', '00000000-0000-0000-0000-0000000000a2'),
('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000c12', '00000000-0000-0000-0000-000000000001', 27, NULL, '00000000-0000-0000-0000-0000000000a2'),
('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000c13', '00000000-0000-0000-0000-000000000001', 17, NULL, '00000000-0000-0000-0000-0000000000a2'),
('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-000000000c11', '00000000-0000-0000-0000-000000000001', 33, 'Work on pedal clarity', '00000000-0000-0000-0000-0000000000a2'),
('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-000000000c12', '00000000-0000-0000-0000-000000000001', 21, NULL, '00000000-0000-0000-0000-0000000000a2'),
('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-000000000c13', '00000000-0000-0000-0000-000000000001', 12, NULL, '00000000-0000-0000-0000-0000000000a2'),
('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-000000000c21', '00000000-0000-0000-0000-000000000001', 44, 'Excellent intonation', '00000000-0000-0000-0000-0000000000a3'),
('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-000000000c22', '00000000-0000-0000-0000-000000000001', 46, NULL, '00000000-0000-0000-0000-0000000000a3'),
('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-000000000c21', '00000000-0000-0000-0000-000000000001', 29, NULL, '00000000-0000-0000-0000-0000000000a3'),
('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-000000000c22', '00000000-0000-0000-0000-000000000001', 18, 'Needs more sectional practice', '00000000-0000-0000-0000-0000000000a3')
ON CONFLICT DO NOTHING;
