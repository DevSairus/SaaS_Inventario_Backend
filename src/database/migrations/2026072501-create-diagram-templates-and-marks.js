'use strict';

// Fase 3 de la propuesta de diagramas interactivos de intervención:
// - diagram_templates: biblioteca de diagramas base (SVG limpio + catálogo de
//   puntos numerados). tenant_id = NULL significa "biblioteca compartida
//   global" (los diagramas base que se siembran para todos los talleres).
// - work_order_diagnosis_marks: las marcas que un técnico hace sobre un
//   diagrama, para una OT concreta (la "hoja de inspección").
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable('diagram_templates', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenant_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
          comment: 'NULL = biblioteca compartida global; con valor = diagrama propio de un taller',
        },
        vehicle_type: {
          type: Sequelize.STRING(20), allowNull: false,
          comment: 'automovil | camioneta | motocicleta | camion | otro',
        },
        system: {
          type: Sequelize.STRING(50), allowNull: false,
          comment: 'suspension_delantera | suspension_trasera | frenos_delanteros | frenos_traseros | ...',
        },
        configuration: {
          type: Sequelize.STRING(50), allowNull: false,
          comment: 'macpherson | doble_horquilla | eje_rigido | multilink | independiente | disco_ventilado | ...',
        },
        name: { type: Sequelize.STRING(150), allowNull: false, comment: 'Ej. "Suspensión delantera MacPherson"' },
        description: { type: Sequelize.TEXT, allowNull: true },
        svg_content: {
          type: Sequelize.TEXT, allowNull: false,
          comment: 'SVG base limpio, sin marcas — el frontend pinta los puntos encima usando `points`',
        },
        view_box: { type: Sequelize.STRING(50), allowNull: false, defaultValue: '0 0 600 400' },
        points: {
          type: Sequelize.JSONB, allowNull: false, defaultValue: [],
          comment: 'Catálogo de partes numeradas: [{point_number, x, y, part_name}]',
        },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });
      await queryInterface.addIndex('diagram_templates', ['tenant_id'], { transaction });
      await queryInterface.addIndex('diagram_templates', ['vehicle_type', 'system', 'configuration'], { transaction });

      await queryInterface.createTable('work_order_diagnosis_marks', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenant_id: { type: Sequelize.UUID, allowNull: false },
        work_order_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'work_orders', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        diagram_template_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'diagram_templates', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
        },
        point_number: { type: Sequelize.INTEGER, allowNull: false, comment: 'Cuál de los puntos del diagrama se marcó' },
        severity: {
          type: Sequelize.STRING(20), allowNull: false, defaultValue: 'revisar',
          comment: 'revisar | cambiar_pronto | urgente',
        },
        side: {
          type: Sequelize.STRING(20), allowNull: true,
          comment: 'izquierdo | derecho | ambos | NULL',
        },
        observation: { type: Sequelize.TEXT, allowNull: true, comment: 'Texto libre del técnico' },
        suggested_product_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: 'products', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
          comment: 'Producto/servicio del catálogo sugerido para autogenerar el WorkOrderItem',
        },
        generated_item_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: 'work_order_items', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
          comment: 'WorkOrderItem generado a partir de esta marca (si el técnico lo confirmó)',
        },
        marked_by: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        marked_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });
      await queryInterface.addIndex('work_order_diagnosis_marks', ['tenant_id'], { transaction });
      await queryInterface.addIndex('work_order_diagnosis_marks', ['work_order_id'], { transaction });
      await queryInterface.addIndex('work_order_diagnosis_marks', ['diagram_template_id'], { transaction });

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('work_order_diagnosis_marks');
    await queryInterface.dropTable('diagram_templates');
  },
};
