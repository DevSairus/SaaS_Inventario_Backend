'use strict';

// Habeas Data (Ley 1581 de 2012) y autorización de ingreso de vehículo al
// taller -- ver services/legal/consent.service.js.
//
//   legal_document_versions: cada texto EXACTO que se le mostró a un cliente
//     (ya con los datos del tenant reemplazados). Se versiona solo: si el
//     texto renderizado cambia (el tenant edita su documento o sus datos de
//     contacto), la siguiente solicitud crea la versión N+1. Es la prueba de
//     "versión del documento aceptado".
//   customer_consents: una solicitud de autorización (kind 'habeas_data' o
//     'vehicle_intake') con su OTP y la evidencia de aceptación.
//   customers.habeas_data_status / marketing_opt_in: desnormalizado para
//     listados y para filtrar campañas sin JOIN.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public):
// migrateAllTenantSchemas corre esto con el search_path de cada tenant.

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS legal_document_versions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          kind VARCHAR(30) NOT NULL CHECK (kind IN ('habeas_data', 'vehicle_intake')),
          version INTEGER NOT NULL,
          source VARCHAR(20) NOT NULL DEFAULT 'standard' CHECK (source IN ('standard', 'custom')),
          content TEXT NOT NULL,
          content_hash CHAR(64) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          UNIQUE (tenant_id, kind, version),
          UNIQUE (tenant_id, kind, content_hash)
        );
      `, { transaction });

      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS customer_consents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          kind VARCHAR(30) NOT NULL CHECK (kind IN ('habeas_data', 'vehicle_intake')),
          customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE ON UPDATE CASCADE,
          work_order_id UUID REFERENCES work_orders(id) ON DELETE CASCADE ON UPDATE CASCADE,
          document_version_id UUID NOT NULL REFERENCES legal_document_versions(id) ON UPDATE CASCADE,

          status VARCHAR(20) NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'accepted', 'rejected', 'revoked', 'cancelled', 'expired')),
          token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
          expires_at TIMESTAMP WITH TIME ZONE,

          intake_snapshot JSONB,
          intake_hash CHAR(64),
          marketing_opt_in BOOLEAN,

          otp_secret TEXT,
          otp_counter INTEGER NOT NULL DEFAULT 0,
          otp_channel VARCHAR(20),
          otp_destination VARCHAR(255),
          otp_sent_at TIMESTAMP WITH TIME ZONE,
          otp_expires_at TIMESTAMP WITH TIME ZONE,
          otp_attempts INTEGER NOT NULL DEFAULT 0,

          accepted_at TIMESTAMP WITH TIME ZONE,
          accepted_via VARCHAR(20) CHECK (accepted_via IN ('public_link', 'counter', 'physical')),
          accepted_ip VARCHAR(45),
          accepted_user_agent TEXT,
          verified_channel VARCHAR(20),
          verified_destination VARCHAR(255),
          signer_name VARCHAR(200),
          signer_document VARCHAR(30),
          physical_notes TEXT,

          rejected_at TIMESTAMP WITH TIME ZONE,
          revoked_at TIMESTAMP WITH TIME ZONE,
          revoked_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          revoke_reason TEXT,

          events JSONB NOT NULL DEFAULT '[]'::jsonb,
          requested_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS customer_consents_customer_idx ON customer_consents (tenant_id, customer_id, kind, status)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS customer_consents_work_order_idx ON customer_consents (work_order_id)`,
        { transaction }
      );

      await queryInterface.sequelize.query(`
        ALTER TABLE customers
          ADD COLUMN IF NOT EXISTS habeas_data_status VARCHAR(20),
          ADD COLUMN IF NOT EXISTS habeas_data_at TIMESTAMP WITH TIME ZONE,
          ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN;
      `, { transaction });

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE customers
        DROP COLUMN IF EXISTS habeas_data_status,
        DROP COLUMN IF EXISTS habeas_data_at,
        DROP COLUMN IF EXISTS marketing_opt_in;
    `);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS customer_consents`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS legal_document_versions`);
  },
};
