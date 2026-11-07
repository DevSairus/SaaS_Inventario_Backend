'use strict';

// Simulador solar público (módulo Proyectos). Ver services/solar/solarPublic.service.js.
//
//   solar_settings: activar el simulador, textos, rango de precio (± %),
//     tarifa por defecto (si el visitante da el valor de su factura en vez de
//     los kWh), política de datos y a quién avisar.
//   solar_leads: cada interesado que deja sus datos, con su autorización de
//     tratamiento de datos (Ley 1581), el estudio en borrador y la oportunidad
//     del CRM que se le crea.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`ALTER TABLE solar_settings ADD COLUMN IF NOT EXISTS public_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
      await q(`ALTER TABLE solar_settings ADD COLUMN IF NOT EXISTS public_title VARCHAR(150)`);
      await q(`ALTER TABLE solar_settings ADD COLUMN IF NOT EXISTS public_intro TEXT`);
      await q(`ALTER TABLE solar_settings ADD COLUMN IF NOT EXISTS public_price_range_pct DECIMAL(5, 2) NOT NULL DEFAULT 10`);
      await q(`ALTER TABLE solar_settings ADD COLUMN IF NOT EXISTS public_default_tariff DECIMAL(10, 2) NOT NULL DEFAULT 900`);
      await q(`ALTER TABLE solar_settings ADD COLUMN IF NOT EXISTS public_privacy_url VARCHAR(300)`);
      await q(`ALTER TABLE solar_settings ADD COLUMN IF NOT EXISTS public_notify_emails VARCHAR(500)`);
      await q(`ALTER TABLE solar_settings ADD COLUMN IF NOT EXISTS public_whatsapp VARCHAR(30)`);

      await q(`
        CREATE TABLE IF NOT EXISTS solar_leads (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          study_id UUID REFERENCES solar_studies(id) ON DELETE SET NULL ON UPDATE CASCADE,
          customer_id UUID REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE,
          opportunity_id UUID REFERENCES opportunities(id) ON DELETE SET NULL ON UPDATE CASCADE,
          name VARCHAR(150) NOT NULL,
          phone VARCHAR(30),
          email VARCHAR(150),
          city VARCHAR(120),
          segment VARCHAR(20),
          monthly_kwh DECIMAL(12, 2),
          kwp DECIMAL(10, 3),
          price_min DECIMAL(15, 2),
          price_max DECIMAL(15, 2),
          consent_text TEXT NOT NULL,
          consent_at TIMESTAMP WITH TIME ZONE NOT NULL,
          consent_ip VARCHAR(64),
          user_agent VARCHAR(300),
          referrer VARCHAR(500),
          status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'quoted', 'won', 'discarded')),
          notes TEXT,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS solar_leads_tenant_created_idx ON solar_leads (tenant_id, created_at DESC)`);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP TABLE IF EXISTS solar_leads`);
    for (const c of ['public_enabled', 'public_title', 'public_intro', 'public_price_range_pct', 'public_default_tariff', 'public_privacy_url', 'public_notify_emails', 'public_whatsapp']) {
      // eslint-disable-next-line no-await-in-loop
      await q(`ALTER TABLE solar_settings DROP COLUMN IF EXISTS ${c}`);
    }
  },
};
