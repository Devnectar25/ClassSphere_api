-- ============================================================================
-- ClassSphere Reference Data: 003_reference_data.sql
-- Platform subscription plan catalogue required by tenant provisioning.
-- ============================================================================

INSERT INTO platform.plans (plan_tier, description, price_monthly, currency, max_seats, max_branches, features, is_popular, sort_order)
VALUES
    ('Starter', 'Engineered for boutique coaching studios and private arts instructors.', 999.00, 'INR', 100, 1,
     ARRAY['Up to 100 Active Students', '1 Primary Branch Location', 'Full Invoicing & Receipt Ledger',
           'Batch Scheduling & Attendance', 'Standard Email Support'], FALSE, 1),
    ('Professional', 'Designed for multi-class academies, music hubs, and athletic academies.', 2499.00, 'INR', 250, 3,
     ARRAY['Up to 250 Active Students', 'Up to 3 Campus Branches', 'Online Payments (Razorpay/UPI)',
           'Parent & Guardian Portal Access', 'Automated Invoicing Cycles', 'Priority Support SLA'], TRUE, 2),
    ('Enterprise', 'Comprehensive solution for multi-branch conservatories and studio franchises.', 4999.00, 'INR', 500, 25,
     ARRAY['Up to 500+ Active Students', 'Up to 25 Campus Branches', 'Custom Domain & Brand Whitelabel',
           'Dedicated Supabase Storage Bucket', 'Compliance Audit Export & APIs', 'Dedicated Account Manager'], FALSE, 3)
ON CONFLICT (plan_tier) DO UPDATE SET
    description = EXCLUDED.description,
    price_monthly = EXCLUDED.price_monthly,
    currency = EXCLUDED.currency,
    max_seats = EXCLUDED.max_seats,
    max_branches = EXCLUDED.max_branches,
    features = EXCLUDED.features,
    is_popular = EXCLUDED.is_popular,
    sort_order = EXCLUDED.sort_order;
