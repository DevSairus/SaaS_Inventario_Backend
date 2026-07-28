'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Tabla de marcas de vehículo
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS vehicle_brands (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          name VARCHAR(100) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      // Tabla de líneas de vehículo (depende de marca)
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS vehicle_lines (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          brand_id UUID NOT NULL REFERENCES vehicle_brands(id) ON DELETE CASCADE ON UPDATE CASCADE,
          name VARCHAR(100) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      // Índices
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_vehicle_brands_tenant ON vehicle_brands (tenant_id);
      `, { transaction });
      await queryInterface.sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_brands_tenant_name ON vehicle_brands (tenant_id, name);
      `, { transaction });
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_vehicle_lines_tenant ON vehicle_lines (tenant_id);
      `, { transaction });
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_vehicle_lines_brand ON vehicle_lines (brand_id);
      `, { transaction });
      await queryInterface.sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_lines_brand_name ON vehicle_lines (brand_id, name);
      `, { transaction });

      // Agregar FKs a product_vehicle_applications (nullable para no romper datos existentes)
      await queryInterface.sequelize.query(`
        ALTER TABLE product_vehicle_applications
        ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES vehicle_brands(id) ON DELETE SET NULL;
      `, { transaction });
      await queryInterface.sequelize.query(`
        ALTER TABLE product_vehicle_applications
        ADD COLUMN IF NOT EXISTS line_id UUID REFERENCES vehicle_lines(id) ON DELETE SET NULL;
      `, { transaction });

      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_vehicle_app_brand_id ON product_vehicle_applications (brand_id);
      `, { transaction });
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_vehicle_app_line_id ON product_vehicle_applications (line_id);
      `, { transaction });

      // Migrar datos existentes: crear brands/lines desde product_vehicle_applications
      await queryInterface.sequelize.query(`
        INSERT INTO vehicle_brands (id, tenant_id, name, created_at, updated_at)
        SELECT gen_random_uuid(), tenant_id, brand, NOW(), NOW()
        FROM product_vehicle_applications
        WHERE brand IS NOT NULL AND brand != ''
        GROUP BY tenant_id, brand
        ON CONFLICT (tenant_id, name) DO NOTHING;
      `, { transaction });

      await queryInterface.sequelize.query(`
        INSERT INTO vehicle_lines (id, tenant_id, brand_id, name, created_at, updated_at)
        SELECT gen_random_uuid(), pva.tenant_id, vb.id, pva.line, NOW(), NOW()
        FROM product_vehicle_applications pva
        JOIN vehicle_brands vb ON vb.tenant_id = pva.tenant_id AND vb.name = pva.brand
        WHERE pva.line IS NOT NULL AND pva.line != ''
        GROUP BY pva.tenant_id, vb.id, pva.line
        ON CONFLICT (brand_id, name) DO NOTHING;
      `, { transaction });

      // Actualizar FKs en product_vehicle_applications
      await queryInterface.sequelize.query(`
        UPDATE product_vehicle_applications pva
        SET brand_id = vb.id
        FROM vehicle_brands vb
        WHERE vb.tenant_id = pva.tenant_id AND vb.name = pva.brand
        AND pva.brand_id IS NULL;
      `, { transaction });

      await queryInterface.sequelize.query(`
        UPDATE product_vehicle_applications pva
        SET line_id = vl.id
        FROM vehicle_lines vl
        JOIN vehicle_brands vb ON vb.id = vl.brand_id
        WHERE vb.tenant_id = pva.tenant_id AND vb.name = pva.brand AND vl.name = pva.line
        AND pva.line_id IS NULL;
      `, { transaction });

      // Migrar también desde vehicles (brand/model)
      await queryInterface.sequelize.query(`
        INSERT INTO vehicle_brands (id, tenant_id, name, created_at, updated_at)
        SELECT gen_random_uuid(), tenant_id, brand, NOW(), NOW()
        FROM vehicles
        WHERE brand IS NOT NULL AND brand != ''
        GROUP BY tenant_id, brand
        ON CONFLICT (tenant_id, name) DO NOTHING;
      `, { transaction });

      await queryInterface.sequelize.query(`
        INSERT INTO vehicle_lines (id, tenant_id, brand_id, name, created_at, updated_at)
        SELECT gen_random_uuid(), v.tenant_id, vb.id, v.model, NOW(), NOW()
        FROM vehicles v
        JOIN vehicle_brands vb ON vb.tenant_id = v.tenant_id AND vb.name = v.brand
        WHERE v.model IS NOT NULL AND v.model != ''
        GROUP BY v.tenant_id, vb.id, v.model
        ON CONFLICT (brand_id, name) DO NOTHING;
      `, { transaction });

      // Migrar desde sales (vehicle_brand/vehicle_model)
      await queryInterface.sequelize.query(`
        INSERT INTO vehicle_brands (id, tenant_id, name, created_at, updated_at)
        SELECT gen_random_uuid(), tenant_id, vehicle_brand, NOW(), NOW()
        FROM sales
        WHERE vehicle_brand IS NOT NULL AND vehicle_brand != ''
        GROUP BY tenant_id, vehicle_brand
        ON CONFLICT (tenant_id, name) DO NOTHING;
      `, { transaction });

      await queryInterface.sequelize.query(`
        INSERT INTO vehicle_lines (id, tenant_id, brand_id, name, created_at, updated_at)
        SELECT gen_random_uuid(), s.tenant_id, vb.id, s.vehicle_model, NOW(), NOW()
        FROM sales s
        JOIN vehicle_brands vb ON vb.tenant_id = s.tenant_id AND vb.name = s.vehicle_brand
        WHERE s.vehicle_model IS NOT NULL AND s.vehicle_model != ''
        GROUP BY s.tenant_id, vb.id, s.vehicle_model
        ON CONFLICT (brand_id, name) DO NOTHING;
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE product_vehicle_applications DROP COLUMN IF EXISTS brand_id;
      ALTER TABLE product_vehicle_applications DROP COLUMN IF EXISTS line_id;
    `);
    await queryInterface.dropTable('vehicle_lines');
    await queryInterface.dropTable('vehicle_brands');
  },
};
