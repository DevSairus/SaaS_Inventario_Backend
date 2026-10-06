// backend/src/services/payroll/payrollFundsSeed.service.js
//
// Carga el catálogo de entidades de seguridad social y parafiscales
// (data/payroll-funds-colombia.js) como proveedores del tenant, marcados en
// payroll_fund_types. Idempotente: si ya existe un proveedor con el mismo NIT
// (con o sin dígito de verificación) solo se le agregan los tipos que le
// falten -- no se duplica ni se cambian sus otros datos.
const { PAYROLL_FUNDS_COLOMBIA } = require('../../data/payroll-funds-colombia');

const digits = (v) => String(v || '').replace(/\D/g, '');

async function ensurePayrollFundSuppliers(tenantId, transaction) {
  const { Supplier } = require('../../models');
  const existing = await Supplier.findAll({ where: { tenant_id: tenantId }, attributes: ['id', 'tax_id', 'payroll_fund_types'], transaction });

  let created = 0;
  let tagged = 0;
  for (const fund of PAYROLL_FUNDS_COLOMBIA) {
    // tax_id guardado sin DV ("900156264") o con DV pegado/separado ("9001562642", "900156264-2").
    const match = existing.find((s) => {
      const d = digits(s.tax_id);
      return d === fund.tax_id || (d.length === fund.tax_id.length + 1 && d.startsWith(fund.tax_id));
    });
    if (match) {
      const current = Array.isArray(match.payroll_fund_types) ? match.payroll_fund_types : [];
      const merged = [...new Set([...current, ...fund.types])];
      if (merged.length !== current.length) {
        await match.update({ payroll_fund_types: merged }, { transaction });
        tagged += 1;
      }
      continue;
    }
    const supplier = await Supplier.create({
      tenant_id: tenantId,
      name: fund.name,
      business_name: fund.business_name,
      tax_id: fund.tax_id,
      document_type: '31',
      person_type: 'juridica',
      country: 'Colombia',
      is_active: true,
      is_obligated_to_invoice: true,
      payroll_fund_types: fund.types,
      notes: 'Entidad de seguridad social / parafiscal cargada desde el catálogo de Pitbox. Verifique el NIT contra el RUT antes de reportar.',
    }, { transaction });
    existing.push(supplier);
    created += 1;
  }
  return { created, tagged };
}

module.exports = { ensurePayrollFundSuppliers };
