'use strict';

// Cruce automático de comisiones liquidadas → nómina (categoría DIAN
// "Comisiones"), calcado del mismo patrón ya usado por CrmReward
// (crmRewardService.js#chargeRewardToPayroll) -- ver
// 00 - Documentación/plan-comisiones-tecnicos-por-sistema.md y la
// investigación de cruce comisiones-nómina.
//
// `employee_id`: empleado de nómina vinculado (por email/documento, ver
//   utils/crmRewardMatching.js) -- nullable, se resuelve en el momento de
//   liquidar, no antes.
// `payroll_novedad_id`: idempotencia -- si ya tiene valor, no se vuelve a
//   generar la novedad aunque se reintente el proceso.
// `payroll_status`: espejo de CrmReward.status para esta misma integración.

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('commission_settlements', 'employee_id', {
      type: Sequelize.UUID, allowNull: true,
      references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('commission_settlements', 'payroll_novedad_id', {
      type: Sequelize.UUID, allowNull: true,
      references: { model: 'payroll_novedades', key: 'id' }, onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('commission_settlements', 'payroll_status', {
      type: Sequelize.STRING(30), allowNull: false, defaultValue: 'not_applicable',
      comment: 'not_applicable | sin_empleado_vinculado | pendiente_periodo | cargada_nomina',
    });
    await queryInterface.addColumn('commission_settlements', 'payroll_error', {
      type: Sequelize.TEXT, allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('commission_settlements', 'payroll_error');
    await queryInterface.removeColumn('commission_settlements', 'payroll_status');
    await queryInterface.removeColumn('commission_settlements', 'payroll_novedad_id');
    await queryInterface.removeColumn('commission_settlements', 'employee_id');
  },
};
