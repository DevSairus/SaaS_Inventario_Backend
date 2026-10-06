'use strict';

// Tratamiento en nómina de la comisión de mano de obra (liquidaciones de
// técnicos, ver services/workshop/commissionPayroll.service.js):
//   salarial     -> novedad DIAN "Comisiones" (integra IBC y prestaciones)
//   no_salarial  -> novedad DIAN "Bonificaciones" con bonificacionNS
//   no_reportar  -> no va a nómina; se registra como gasto operativo
//                   (comisiones_tecnicos), igual que cuando no hay empleado
//
// payroll_settings.commission_payroll_mode es el valor del tenant;
// employees.commission_payroll_mode es la excepción por empleado (NULL =
// usar el del tenant).

module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS commission_payroll_mode VARCHAR(15) NOT NULL DEFAULT 'salarial'`);
    await q.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS commission_payroll_mode VARCHAR(15)`);
    console.log('[Migration] commission_payroll_mode en payroll_settings y employees');
  },
  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE employees DROP COLUMN IF EXISTS commission_payroll_mode`);
    await q.query(`ALTER TABLE payroll_settings DROP COLUMN IF EXISTS commission_payroll_mode`);
  },
};
