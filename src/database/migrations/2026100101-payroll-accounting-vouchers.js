'use strict';

// Comprobantes contables de nómina electrónica (ver
// services/payroll/payrollAccountingService.js):
//   1. Comprobante de nómina -- devengados/deducciones por empleado, con su
//      cédula como tercero (antes: un solo asiento consolidado sin terceros).
//   2. Aportes del empleador y provisiones -- consolidado por fondo de
//      destino (EPS/AFP/ARL/Caja/SENA/ICBF, registrados como proveedores).
//      Antes no se calculaba nada a cargo del empleador.
//   3. Desembolso -- pago del neto (y de la seguridad social) desde el banco.
//      Antes no existía: 250505 se acreditaba y nunca se debitaba.
//
// Cómo contabilizar (mismo comprobante o separado, causación mensual o al
// cierre de cada prestación) queda a criterio del encargado en
// payroll_settings -- el sistema solo ofrece las opciones.
//
// También siembra las subcuentas de gasto de personal/aportes/retenciones
// de nómina que el PUC simplificado no traía, y sus account_mappings, para
// los tenants que ya tienen plan de cuentas (el seed contable no vuelve a
// correr) -- mismo patrón que 2026092102-backfill-payroll-account-mappings.js.

const NEW_ACCOUNTS = [
  { code: '133015', name: 'Anticipos a Trabajadores', type: 'activo', parent: '13' },
  { code: '237006', name: 'Aportes a ARL por Pagar', type: 'pasivo', parent: '23' },
  { code: '237010', name: 'Aportes Parafiscales por Pagar (Caja, SENA, ICBF)', type: 'pasivo', parent: '23' },
  { code: '237025', name: 'Embargos Judiciales', type: 'pasivo', parent: '23' },
  { code: '237030', name: 'Libranzas', type: 'pasivo', parent: '23' },
  { code: '237035', name: 'Sindicatos', type: 'pasivo', parent: '23' },
  { code: '237040', name: 'Cooperativas', type: 'pasivo', parent: '23' },
  { code: '237095', name: 'Otras Retenciones de Nómina', type: 'pasivo', parent: '23' },
  { code: '238030', name: 'Fondos de Cesantías y/o Pensiones', type: 'pasivo', parent: '23' },
  { code: '510515', name: 'Horas Extras y Recargos', type: 'gasto', parent: '51' },
  { code: '510527', name: 'Auxilio de Transporte', type: 'gasto', parent: '51' },
  { code: '510530', name: 'Cesantías', type: 'gasto', parent: '51' },
  { code: '510533', name: 'Intereses sobre Cesantías', type: 'gasto', parent: '51' },
  { code: '510536', name: 'Prima de Servicios', type: 'gasto', parent: '51' },
  { code: '510539', name: 'Vacaciones', type: 'gasto', parent: '51' },
  { code: '510545', name: 'Auxilios', type: 'gasto', parent: '51' },
  { code: '510548', name: 'Bonificaciones', type: 'gasto', parent: '51' },
  { code: '510551', name: 'Dotación y Suministro a Trabajadores', type: 'gasto', parent: '51' },
  { code: '510560', name: 'Indemnizaciones Laborales', type: 'gasto', parent: '51' },
  { code: '510568', name: 'Aportes a Administradoras de Riesgos Laborales', type: 'gasto', parent: '51' },
  { code: '510569', name: 'Aportes a Entidades Promotoras de Salud (EPS)', type: 'gasto', parent: '51' },
  { code: '510570', name: 'Aportes a Fondos de Pensiones', type: 'gasto', parent: '51' },
  { code: '510572', name: 'Aportes Cajas de Compensación Familiar', type: 'gasto', parent: '51' },
  { code: '510575', name: 'Aportes ICBF', type: 'gasto', parent: '51' },
  { code: '510578', name: 'Aportes SENA', type: 'gasto', parent: '51' },
  { code: '510595', name: 'Otros Gastos de Personal', type: 'gasto', parent: '51' },
];

// Debe coincidir con las claves payroll_* de DEFAULT_ACCOUNT_MAPPINGS
// (data/puc-colombia-standard.js).
const NEW_MAPPINGS = {
  'payroll_expense:basico': '510506',
  'payroll_expense:horas_extra': '510515',
  'payroll_expense:comisiones': '615595',
  'payroll_expense:transporte': '510527',
  'payroll_expense:cesantias': '510530',
  'payroll_expense:intereses_cesantias': '510533',
  'payroll_expense:prima': '510536',
  'payroll_expense:vacaciones': '510539',
  'payroll_expense:auxilios': '510545',
  'payroll_expense:bonificaciones': '510548',
  'payroll_expense:dotacion': '510551',
  'payroll_expense:indemnizaciones': '510560',
  'payroll_expense:incapacidades_licencias': '510506',
  'payroll_expense:otros': '510595',
  'payroll_employer:eps': '510569',
  'payroll_employer:pension': '510570',
  'payroll_employer:arl': '510568',
  'payroll_employer:ccf': '510572',
  'payroll_employer:icbf': '510575',
  'payroll_employer:sena': '510578',
  payroll_pension_payable: '238030',
  payroll_arl_payable: '237006',
  payroll_parafiscales_payable: '237010',
  payroll_retefuente_payable: '236505',
  payroll_garnishments_payable: '237025',
  payroll_libranzas_payable: '237030',
  payroll_union_dues_payable: '237035',
  payroll_cooperative_payable: '237040',
  payroll_voluntary_pension_payable: '238030',
  payroll_advances_receivable: '133015',
  payroll_other_deductions_payable: '237095',
  'payroll_provision:cesantias': '251005',
  'payroll_provision:intereses_cesantias': '251505',
  'payroll_provision:prima': '252005',
  'payroll_provision:vacaciones': '252505',
  payroll_payment_bank: '111005',
};

module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;

    // 1) Configuración contable de nómina (decisión del encargado)
    await q.query(`
      ALTER TABLE payroll_settings
        ADD COLUMN IF NOT EXISTS accounting_voucher_mode VARCHAR(10) NOT NULL DEFAULT 'single',
        ADD COLUMN IF NOT EXISTS cesantias_accrual_mode VARCHAR(10) NOT NULL DEFAULT 'monthly',
        ADD COLUMN IF NOT EXISTS prima_accrual_mode VARCHAR(12) NOT NULL DEFAULT 'monthly',
        ADD COLUMN IF NOT EXISTS vacaciones_accrual_mode VARCHAR(12) NOT NULL DEFAULT 'monthly',
        ADD COLUMN IF NOT EXISTS employer_exonerated_114_1 BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS arl_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS ccf_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS sena_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS icbf_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL
    `);

    // 2) Fondos de seguridad social del empleado (proveedores) + clase de riesgo ARL
    await q.query(`
      ALTER TABLE employees
        ADD COLUMN IF NOT EXISTS eps_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS pension_fund_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS severance_fund_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS arl_risk_class SMALLINT NOT NULL DEFAULT 1
    `);

    // 3) Desembolsos de nómina (neto a empleados / seguridad social a fondos)
    await q.query(`
      CREATE TABLE IF NOT EXISTS payroll_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        payroll_period_id UUID NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
        payment_type VARCHAR(20) NOT NULL,
        payment_date DATE NOT NULL,
        bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
        amount NUMERIC(15,2) NOT NULL DEFAULT 0,
        reference VARCHAR(100),
        journal_entry_id UUID,
        status VARCHAR(10) NOT NULL DEFAULT 'active',
        created_by UUID,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS payroll_payments_period_idx ON payroll_payments (tenant_id, payroll_period_id)`);
    await q.query(`ALTER TABLE payroll_documents ADD COLUMN IF NOT EXISTS payment_id UUID REFERENCES payroll_payments(id) ON DELETE SET NULL`);

    // 4) Subcuentas nuevas para los tenants que ya tienen plan de cuentas
    const [tenants] = await q.query(`SELECT DISTINCT tenant_id FROM chart_of_accounts`);
    for (const { tenant_id: tenantId } of tenants) {
      for (const acc of NEW_ACCOUNTS) {
        // eslint-disable-next-line no-await-in-loop
        await q.query(
          `INSERT INTO chart_of_accounts
             (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
           SELECT gen_random_uuid(), :tenantId, :code, :name, :type, p.id, 3, true, true, NOW(), NOW()
           FROM chart_of_accounts p
           WHERE p.tenant_id = :tenantId AND p.code = :parent
             AND NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.tenant_id = :tenantId AND c.code = :code)`,
          { replacements: { tenantId, ...acc } }
        );
      }
    }

    // 5) account_mappings nuevos, apuntando a las cuentas por código
    for (const [eventType, code] of Object.entries(NEW_MAPPINGS)) {
      // eslint-disable-next-line no-await-in-loop
      await q.query(
        `INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
         SELECT gen_random_uuid(), a.tenant_id, :eventType, a.id, NOW(), NOW()
         FROM chart_of_accounts a
         WHERE a.code = :code
           AND NOT EXISTS (
             SELECT 1 FROM account_mappings m
             WHERE m.tenant_id = a.tenant_id AND m.event_type = :eventType
           )`,
        { replacements: { eventType, code } }
      );
    }

    console.log('[Migration] Comprobantes contables de nómina: configuración, fondos del empleado, desembolsos y subcuentas');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`DELETE FROM account_mappings WHERE event_type IN (:keys)`, { replacements: { keys: Object.keys(NEW_MAPPINGS) } });
    await q.query(`ALTER TABLE payroll_documents DROP COLUMN IF EXISTS payment_id`);
    await q.query(`DROP TABLE IF EXISTS payroll_payments`);
    await q.query(`
      ALTER TABLE employees
        DROP COLUMN IF EXISTS eps_supplier_id,
        DROP COLUMN IF EXISTS pension_fund_supplier_id,
        DROP COLUMN IF EXISTS severance_fund_supplier_id,
        DROP COLUMN IF EXISTS arl_risk_class
    `);
    await q.query(`
      ALTER TABLE payroll_settings
        DROP COLUMN IF EXISTS accounting_voucher_mode,
        DROP COLUMN IF EXISTS cesantias_accrual_mode,
        DROP COLUMN IF EXISTS prima_accrual_mode,
        DROP COLUMN IF EXISTS vacaciones_accrual_mode,
        DROP COLUMN IF EXISTS employer_exonerated_114_1,
        DROP COLUMN IF EXISTS arl_supplier_id,
        DROP COLUMN IF EXISTS ccf_supplier_id,
        DROP COLUMN IF EXISTS sena_supplier_id,
        DROP COLUMN IF EXISTS icbf_supplier_id
    `);
    // Las subcuentas nuevas no se borran: pueden tener movimientos.
  },
};
