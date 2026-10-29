'use strict';

// Historial de recordatorios de vencimiento de SOAT y técnico-mecánica (ver
// services/vehicleReminderService.js). Una fila por intento y canal:
//   status 'sent'    salió (correo o WhatsApp)
//          'failed'  se intentó y falló (p. ej. WhatsApp sin plantilla)
//          'skipped' no se intentó (sin cliente, sin correo, sin celular,
//                    habeas data rechazado o revocado)
// Se muestra en la ficha del vehículo y evita repetir un aviso ya enviado:
// solo puede haber un 'sent' por vehículo, documento, fecha de vencimiento,
// días de anticipación y canal.
//
// Sin calificar con esquema (salvo tenants, que vive en public):
// migrateAllTenantSchemas corre esto con el search_path de cada tenant.
module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS vehicle_reminder_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE ON UPDATE CASCADE,
          customer_id UUID REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE,
          document_type VARCHAR(20) NOT NULL CHECK (document_type IN ('soat', 'tecnomecanica')),
          expiry_date DATE NOT NULL,
          days_before INTEGER NOT NULL,
          channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'whatsapp')),
          status VARCHAR(20) NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
          destination VARCHAR(255),
          detail TEXT,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS vehicle_reminder_logs_vehicle_idx ON vehicle_reminder_logs (vehicle_id, created_at DESC)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS vehicle_reminder_logs_sent_once_idx
           ON vehicle_reminder_logs (vehicle_id, document_type, expiry_date, days_before, channel)
           WHERE status = 'sent'`,
        { transaction }
      );
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS vehicle_reminder_logs');
  },
};
