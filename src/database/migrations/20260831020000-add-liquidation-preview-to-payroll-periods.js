'use strict';

// El paso "liquidado" (abierto -> liquidado) hasta ahora era solo un
// cambio de estado sin ningún cálculo detrás — el valor real de cada
// empleado solo se conocía al emitir (que ya firma y envía a la DIAN, sin
// forma de "deshacer"). Se agrega liquidation_preview (snapshot JSON de lo
// que calcularía payrollService.js#liquidarEmpleado para cada empleado
// activo de ese periodo/periodicidad, SIN tocar la DIAN) y
// liquidation_preview_at, para que "liquidado" sirva de verdad como el
// punto de revisión antes de emitir — ver
// payrollPeriodEmissionService.js#previewPayrollPeriod.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE payroll_periods
        ADD COLUMN IF NOT EXISTS liquidation_preview JSONB,
        ADD COLUMN IF NOT EXISTS liquidation_preview_at TIMESTAMP WITH TIME ZONE
    `);
    console.log('[Migration] payroll_periods: +liquidation_preview, +liquidation_preview_at');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE payroll_periods
        DROP COLUMN IF EXISTS liquidation_preview,
        DROP COLUMN IF EXISTS liquidation_preview_at
    `);
  },
};
