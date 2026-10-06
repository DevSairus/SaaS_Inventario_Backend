'use strict';

// Carga el catálogo de entidades de nómina (data/payroll-funds-colombia.js)
// en los tenants que ya existían cuando se agregó payroll_fund_types -- los
// nuevos lo reciben al crearse (superadmin.routes.js). Mismo criterio que
// services/payroll/payrollFundsSeed.service.js: si ya hay un proveedor con
// ese NIT (con o sin DV) solo se le agregan los tipos que le falten; si no,
// se crea. Corre una sola vez por schema, así que si después alguien borra
// una entidad no vuelve a aparecer.
//
// Dentro del schema de un tenant cortado (provisionTenantSchema.js pasa
// `{ tenantId }`) solo se siembra ese tenant; en `public` solo los tenants
// legados que todavía viven ahí (schema_name IS NULL) -- mismo criterio que
// 2026092005-seed-default-commission-category.js.

const { PAYROLL_FUNDS_COLOMBIA } = require('../../data/payroll-funds-colombia');

const NOTE = 'Entidad de seguridad social / parafiscal cargada desde el catálogo de Pitbox. Verifique el NIT contra el RUT antes de reportar.';
const digits = (v) => String(v || '').replace(/\D/g, '');

module.exports = {
  up: async (queryInterface, Sequelize, context = {}) => {
    const q = queryInterface.sequelize;
    const where = context.tenantId ? 'WHERE id = :tenantId' : 'WHERE schema_name IS NULL';
    const [tenants] = await q.query(`SELECT id FROM public.tenants ${where}`, { replacements: { tenantId: context.tenantId } });

    for (const tenant of tenants) {
      const [existing] = await q.query(
        `SELECT id, tax_id, payroll_fund_types FROM suppliers WHERE tenant_id = :tenantId`,
        { replacements: { tenantId: tenant.id } }
      );
      let created = 0;
      let tagged = 0;
      for (const fund of PAYROLL_FUNDS_COLOMBIA) {
        const match = existing.find((s) => {
          const d = digits(s.tax_id);
          return d === fund.tax_id || (d.length === fund.tax_id.length + 1 && d.startsWith(fund.tax_id));
        });
        if (match) {
          const current = Array.isArray(match.payroll_fund_types) ? match.payroll_fund_types : [];
          const merged = [...new Set([...current, ...fund.types])];
          if (merged.length !== current.length) {
            await q.query(
              `UPDATE suppliers SET payroll_fund_types = CAST(:types AS jsonb), updated_at = NOW() WHERE id = :id`,
              { replacements: { id: match.id, types: JSON.stringify(merged) } }
            );
            match.payroll_fund_types = merged;
            tagged += 1;
          }
          continue;
        }
        await q.query(
          `INSERT INTO suppliers
             (id, tenant_id, name, business_name, tax_id, document_type, person_type, country,
              is_active, is_obligated_to_invoice, payroll_fund_types, notes, created_at, updated_at)
           VALUES
             (gen_random_uuid(), :tenantId, :name, :businessName, :taxId, '31', 'juridica', 'Colombia',
              true, true, CAST(:types AS jsonb), :notes, NOW(), NOW())`,
          { replacements: { tenantId: tenant.id, name: fund.name, businessName: fund.business_name, taxId: fund.tax_id, types: JSON.stringify(fund.types), notes: NOTE } }
        );
        existing.push({ tax_id: fund.tax_id, payroll_fund_types: fund.types });
        created += 1;
      }
      console.log(`[Migration] entidades de nómina tenant ${tenant.id}: ${created} creadas, ${tagged} marcadas`);
    }
  },

  // No se borran: pueden estar ya asignadas a empleados o usadas en comprobantes.
  down: async () => {},
};
