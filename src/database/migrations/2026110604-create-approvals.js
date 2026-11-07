'use strict';

// Motor de aprobaciones (Fase 2 del módulo Proyectos), empezando por las
// órdenes de compra. Ver services/approvals/approvals.service.js.
//
//   approval_rules: reglas de la empresa. Una compra cuyo total cae en
//     [min_amount, max_amount] (y del proyecto, si la regla tiene uno)
//     necesita la aprobación de approver_role o approver_user_id. Varias
//     reglas que aplican = varios pasos, en orden de `sequence`.
//   approval_requests: una solicitud por documento y monto; `steps` guarda
//     cada paso con su decisión. Sin reglas que apliquen no se crea nada y
//     el documento sigue igual que antes.
//   approval_tokens: enlaces de un solo uso para aprobar desde el correo en
//     el celular, sin iniciar sesión (/aprobar/:token).
//   purchases.approval_status: null (no requiere) | pending | approved | rejected.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`
        CREATE TABLE IF NOT EXISTS approval_rules (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          document_type VARCHAR(30) NOT NULL DEFAULT 'purchase' CHECK (document_type IN ('purchase')),
          name VARCHAR(120) NOT NULL,
          min_amount DECIMAL(15, 2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
          max_amount DECIMAL(15, 2),
          project_id UUID REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
          approver_role VARCHAR(30),
          approver_user_id UUID REFERENCES "public"."users"(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL DEFAULT 1,
          is_active BOOLEAN NOT NULL DEFAULT true,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          CHECK (approver_role IS NOT NULL OR approver_user_id IS NOT NULL),
          CHECK (max_amount IS NULL OR max_amount >= min_amount)
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS approval_rules_lookup_idx ON approval_rules (tenant_id, document_type) WHERE is_active`);

      await q(`
        CREATE TABLE IF NOT EXISTS approval_requests (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          document_type VARCHAR(30) NOT NULL,
          document_id UUID NOT NULL,
          document_number VARCHAR(60),
          amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
          project_id UUID REFERENCES projects(id) ON DELETE SET NULL ON UPDATE CASCADE,
          status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
          current_step INTEGER NOT NULL DEFAULT 0,
          steps JSONB NOT NULL DEFAULT '[]'::jsonb,
          requested_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          decided_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          decided_at TIMESTAMP WITH TIME ZONE,
          comment TEXT,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS approval_requests_document_idx ON approval_requests (tenant_id, document_type, document_id)`);
      await q(`CREATE INDEX IF NOT EXISTS approval_requests_pending_idx ON approval_requests (tenant_id, status) WHERE status = 'pending'`);

      await q(`
        CREATE TABLE IF NOT EXISTS approval_tokens (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
          step INTEGER NOT NULL,
          user_id UUID NOT NULL REFERENCES "public"."users"(id) ON DELETE CASCADE,
          token UUID NOT NULL UNIQUE,
          expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
          used_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);

      await q(`ALTER TABLE IF EXISTS purchases ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20)`);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE IF EXISTS purchases DROP COLUMN IF EXISTS approval_status`);
    await q(`DROP TABLE IF EXISTS approval_tokens`);
    await q(`DROP TABLE IF EXISTS approval_requests`);
    await q(`DROP TABLE IF EXISTS approval_rules`);
  },
};
