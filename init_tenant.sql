-- Crear tenant demo
INSERT INTO tenants (
    id, company_name, slug, tax_id, email, phone, address,
    dian_config, plan, subscription_status, is_active
) VALUES (
    gen_random_uuid(),
    'Pitbox Demo',
    'pitbox-demo',
    '900072256',
    'admin@pitbox.com',
    '3001234567',
    'Calle 123 #45-67, Bogota',
    '{"nit":"900072256","dv":"0","company_name":"Pitbox Demo SAS","environment":"test"}',
    'premium',
    'active',
    true
);

-- Crear usuario admin para el tenant
INSERT INTO users (
    id, tenant_id, first_name, last_name, email, password_hash, role, is_active
) SELECT
    gen_random_uuid(),
    t.id,
    'Admin',
    'Pitbox',
    'admin@pitbox.com',
    '$2b$10$PD2PzXv8oMwU6ziYty.YLu.GbiGjMfHRpBsSmjSOjseDds5F9c1Ua',
    'admin',
    true
FROM tenants t WHERE t.slug = 'pitbox-demo';

-- Crear superadmin
INSERT INTO users (
    id, tenant_id, first_name, last_name, email, password_hash, role, is_active
) VALUES (
    gen_random_uuid(),
    NULL,
    'Sergio',
    'Aguirre',
    'agurre984@gmail.com',
    '$2b$10$PD2PzXv8oMwU6ziYty.YLu.GbiGjMfHRpBsSmjSOjseDds5F9c1Ua',
    'super_admin',
    true
) ON CONFLICT (email) DO NOTHING;
