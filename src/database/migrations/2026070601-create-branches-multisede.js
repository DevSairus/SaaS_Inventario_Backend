'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // ============= 1. TABLA BRANCHES (Sedes) =============
      await queryInterface.createTable('branches', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true
        },
        tenant_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'tenants', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
        },
        code: {
          type: Sequelize.STRING(20),
          allowNull: false,
          comment: 'Código corto de la sede (ej: PPAL, MED-CTR, MED-SUR)'
        },
        name: {
          type: Sequelize.STRING(150),
          allowNull: false
        },
        address: {
          type: Sequelize.TEXT,
          allowNull: true
        },
        city: {
          type: Sequelize.STRING(100),
          allowNull: true
        },
        phone: {
          type: Sequelize.STRING(20),
          allowNull: true
        },
        email: {
          type: Sequelize.STRING(150),
          allowNull: true
        },
        manager_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL'
        },
        is_main: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
          comment: 'Sede principal del tenant (usada como fallback)'
        },
        is_active: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true
        },
        created_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.NOW
        },
        updated_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.NOW
        }
      }, { transaction });

      await queryInterface.addConstraint('branches', {
        fields: ['tenant_id', 'code'],
        type: 'unique',
        name: 'branches_tenant_code_unique',
        transaction
      });

      // ============= 2. TABLA USER_BRANCHES (Usuario <-> Sedes, N:M) =============
      await queryInterface.createTable('user_branches', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true
        },
        user_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
        },
        branch_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'branches', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
        },
        is_default: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
          comment: 'Sede que se selecciona automáticamente al iniciar sesión'
        },
        created_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.NOW
        },
        updated_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.NOW
        }
      }, { transaction });

      await queryInterface.addConstraint('user_branches', {
        fields: ['user_id', 'branch_id'],
        type: 'unique',
        name: 'user_branches_user_branch_unique',
        transaction
      });

      // ============= 3. WAREHOUSES: agregar branch_id (1 sede = 1 bodega) =============
      await queryInterface.addColumn('warehouses', 'branch_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'branches', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      }, { transaction });

      // ============= 4. DIAN_RESOLUTIONS: agregar branch_id =============
      await queryInterface.addColumn('dian_resolutions', 'branch_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'branches', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      }, { transaction });

      // ============= 5. SALES: agregar branch_id =============
      await queryInterface.addColumn('sales', 'branch_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'branches', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      }, { transaction });

      // ============= 6. PURCHASES: agregar branch_id =============
      await queryInterface.addColumn('purchases', 'branch_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'branches', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      }, { transaction });

      // ============= 7. BACKFILL: crear "Sede Principal" para cada tenant existente =============
      // Crea una branch por tenant, tomando datos de contacto del propio tenant.
      await queryInterface.sequelize.query(`
        INSERT INTO branches (id, tenant_id, code, name, address, city, phone, email, is_main, is_active, created_at, updated_at)
        SELECT
          gen_random_uuid(),
          t.id,
          'PPAL',
          'Sede Principal',
          t.address,
          NULL,
          t.phone,
          t.email,
          true,
          true,
          NOW(),
          NOW()
        FROM tenants t;
      `, { transaction });

      // Vincula cada warehouse existente marcado is_main a la Sede Principal de su tenant.
      // Si un tenant no tiene warehouse is_main, toma la primera bodega activa.
      await queryInterface.sequelize.query(`
        UPDATE warehouses w
        SET branch_id = b.id
        FROM branches b
        WHERE b.tenant_id = w.tenant_id
          AND b.code = 'PPAL'
          AND w.id = (
            SELECT w2.id FROM warehouses w2
            WHERE w2.tenant_id = w.tenant_id
            ORDER BY w2.is_main DESC, w2.created_at ASC
            LIMIT 1
          );
      `, { transaction });

      // Bodegas restantes sin sede (multi-bodega previo sin sede definida) quedan
      // vinculadas también a la Sede Principal por defecto, para no dejar huérfanas.
      await queryInterface.sequelize.query(`
        UPDATE warehouses w
        SET branch_id = b.id
        FROM branches b
        WHERE b.tenant_id = w.tenant_id
          AND b.code = 'PPAL'
          AND w.branch_id IS NULL;
      `, { transaction });

      // Vincula resoluciones DIAN existentes a la Sede Principal de su tenant.
      await queryInterface.sequelize.query(`
        UPDATE dian_resolutions dr
        SET branch_id = b.id
        FROM branches b
        WHERE b.tenant_id = dr.tenant_id
          AND b.code = 'PPAL';
      `, { transaction });

      // Backfill de sales.branch_id: a partir del warehouse_id de la venta si existe,
      // si no, a la Sede Principal del tenant.
      await queryInterface.sequelize.query(`
        UPDATE sales s
        SET branch_id = COALESCE(
          (SELECT w.branch_id FROM warehouses w WHERE w.id = s.warehouse_id),
          (SELECT b.id FROM branches b WHERE b.tenant_id = s.tenant_id AND b.code = 'PPAL')
        );
      `, { transaction });

      // Backfill de purchases.branch_id: mismo criterio.
      await queryInterface.sequelize.query(`
        UPDATE purchases p
        SET branch_id = COALESCE(
          (SELECT w.branch_id FROM warehouses w WHERE w.id = p.warehouse_id),
          (SELECT b.id FROM branches b WHERE b.tenant_id = p.tenant_id AND b.code = 'PPAL')
        );
      `, { transaction });

      // ============= 8. Unicidad 1 sede = 1 bodega =============
      await queryInterface.addConstraint('warehouses', {
        fields: ['branch_id'],
        type: 'unique',
        name: 'warehouses_branch_id_unique',
        transaction
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeConstraint('warehouses', 'warehouses_branch_id_unique', { transaction });
      await queryInterface.removeColumn('purchases', 'branch_id', { transaction });
      await queryInterface.removeColumn('sales', 'branch_id', { transaction });
      await queryInterface.removeColumn('dian_resolutions', 'branch_id', { transaction });
      await queryInterface.removeColumn('warehouses', 'branch_id', { transaction });
      await queryInterface.dropTable('user_branches', { transaction });
      await queryInterface.dropTable('branches', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
