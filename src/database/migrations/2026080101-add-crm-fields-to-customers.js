'use strict';

// CRM Fase 1 — extiende `customers` sin tocar nada de lo existente.
// is_assigned_account es la base del modelo mixto de aislamiento entre
// vendedores: por defecto (false) cualquier vendedor puede atender al
// cliente; solo cuando un manager/admin lo marca como cuenta asignada se
// activa el bloqueo transaccional (ver middleware/checkAccountOwnership.js).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const columns = await queryInterface.describeTable('customers');

    if (!columns.owner_user_id) {
      await queryInterface.addColumn('customers', 'owner_user_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Asesor/vendedor dueño de la cuenta (informativo salvo que is_assigned_account=true)',
      });
    }

    if (!columns.is_assigned_account) {
      await queryInterface.addColumn('customers', 'is_assigned_account', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Si es true, solo owner_user_id (o manager/admin) puede cotizar/vender/abrir OT para este cliente',
      });
    }

    if (!columns.lifecycle_stage) {
      await queryInterface.addColumn('customers', 'lifecycle_stage', {
        type: Sequelize.ENUM('prospecto', 'activo', 'inactivo', 'en_riesgo', 'perdido'),
        allowNull: true,
        comment: 'Calculado por job nocturno a partir de compras e interacciones',
      });
    }

    if (!columns.last_interaction_at) {
      await queryInterface.addColumn('customers', 'last_interaction_at', {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Desnormalizado desde customer_interactions para ordenar listados sin JOIN',
      });
    }

    if (!columns.next_vehicle_service_due) {
      await queryInterface.addColumn('customers', 'next_vehicle_service_due', {
        type: Sequelize.DATEONLY,
        allowNull: true,
        comment: 'Solo aplica con módulo Taller activo — desnormalizado desde vehicles/work_orders',
      });
    }

    await queryInterface.addIndex('customers', ['tenant_id', 'owner_user_id'], {
      name: 'customers_tenant_owner_idx',
    }).catch(() => {}); // guard: no falla si el índice ya existe

    await queryInterface.addIndex('customers', ['tenant_id', 'lifecycle_stage'], {
      name: 'customers_tenant_lifecycle_idx',
    }).catch(() => {});
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('customers', 'customers_tenant_owner_idx').catch(() => {});
    await queryInterface.removeIndex('customers', 'customers_tenant_lifecycle_idx').catch(() => {});
    await queryInterface.removeColumn('customers', 'owner_user_id');
    await queryInterface.removeColumn('customers', 'is_assigned_account');
    await queryInterface.removeColumn('customers', 'lifecycle_stage');
    await queryInterface.removeColumn('customers', 'last_interaction_at');
    await queryInterface.removeColumn('customers', 'next_vehicle_service_due');
  },
};