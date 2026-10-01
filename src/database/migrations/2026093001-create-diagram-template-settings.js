'use strict';

// Ajustes por taller sobre la biblioteca de diagramas (diagram_templates):
// - is_enabled: el admin del taller apaga los diagramas que no usa, para que
//   no aparezcan en el selector de la OT / cotización.
// - extra_vehicle_types: categorías ADICIONALES en las que el diagrama
//   aplica, además de su vehicle_type de origen (ej. una suspensión de
//   automóvil que también se ve en camionetas).
//
// Va en una tabla aparte, y no como columnas de diagram_templates, porque
// los tenants en modo legado (schema_name NULL) comparten las filas de
// public.diagram_templates: un ajuste guardado en la fila le cambiaría el
// catálogo a todos. Sin fila de ajustes = diagrama activo, sin categorías
// extra (comportamiento de siempre).

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable('diagram_template_settings', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenant_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        diagram_template_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'diagram_templates', key: 'id' },
          onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        is_enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        extra_vehicle_types: {
          type: Sequelize.JSONB, allowNull: false, defaultValue: [],
          comment: 'Categorías adicionales donde aplica: ["camioneta", ...]',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });

      await queryInterface.addIndex(
        'diagram_template_settings',
        ['tenant_id', 'diagram_template_id'],
        { unique: true, name: 'diagram_template_settings_tenant_template_unique', transaction }
      );
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('diagram_template_settings');
  },
};
