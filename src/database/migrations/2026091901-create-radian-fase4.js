'use strict';

// RADIAN Fase 4 (ver 00 - Documentación/RADIAN-Analisis-y-Plan.md §4, §6):
// inscripción (036), endosos (037-039), cancelación de endoso (040),
// limitación de circulación (041-042), mandato (043-044), pago (045) e
// informe para el pago (046) — todos sobre una Sale ya inscrita como
// título valor.
//
// A diferencia de purchases/sales.radian_status (una máquina de estados
// lineal), acá el "estado de circulación" tiene varios atributos
// independientes que pueden coexistir (inscrita + con tenedor distinto +
// con mandato activo) -- se modela como un único JSONB en vez de multiplicar
// columnas para una feature que el propio plan marca condicionada a demanda
// real de factoring (§6, Fase 4 "10+ días | Condicionada a demanda").
// Forma: { inscribed_at, holder_nit, holder_name, circulation_restricted,
//          mandate_nit, mandate_name }
//
// `details` en radian_events guarda el payload estructurado de cada evento
// (a quién se endosó, motivo de limitación, datos del mandatario, monto
// pagado...) -- el texto legible equivalente va en el cbc:Note del XML (ver
// radianXmlBuilder.js), esto es para reportes/auditoría interna.
module.exports = {
  up: async (queryInterface) => {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE sales
        ADD COLUMN IF NOT EXISTS radian_circulation JSONB NOT NULL DEFAULT '{}'::jsonb
    `);
    await q.query(`
      ALTER TABLE radian_events
        ADD COLUMN IF NOT EXISTS details JSONB
    `);
    console.log('[Migration] RADIAN Fase 4: sales.radian_circulation + radian_events.details agregadas');
  },

  down: async (queryInterface) => {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE sales DROP COLUMN IF EXISTS radian_circulation`);
    await q.query(`ALTER TABLE radian_events DROP COLUMN IF EXISTS details`);
  },
};
