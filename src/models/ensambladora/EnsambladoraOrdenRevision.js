// backend/src/models/ensambladora/EnsambladoraOrdenRevision.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const EnsambladoraOrdenRevision = sequelize.define(
  'EnsambladoraOrdenRevision',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    vin: { type: DataTypes.STRING, allowNull: false },
    politica_id: { type: DataTypes.UUID, allowNull: false },
    fecha_realizada: { type: DataTypes.DATE, allowNull: false },
    kilometraje_registrado: DataTypes.INTEGER,
    // Detalle del formulario de mantenimiento en taller (ver
    // requerimientos-pitbox-formulario-mantenimiento.md, sección 2) -- todo
    // opcional salvo lo ya obligatorio arriba (vin/politica_id/fecha, en el
    // controller). `checklist`/`piezas` son JSONB libres, el Core no valida
    // contra un esquema fijo.
    checklist: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    observaciones: DataTypes.TEXT,
    tarifario_servicio_id: DataTypes.UUID,
    valor_mano_obra: DataTypes.DECIMAL(12, 2),
    piezas: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    // `resultado.orden_revision_id` que devuelve el Core al confirmar el
    // evento (mismo patrón que core_orden_garantia_id en
    // EnsambladoraOrdenGarantia).
    core_orden_revision_id: DataTypes.UUID,
    sync_estado: {
      type: DataTypes.ENUM('pendiente', 'enviado', 'confirmado', 'error'),
      allowNull: false,
      defaultValue: 'pendiente',
    },
    evento_sync_id: DataTypes.UUID,
    // Token público para que el cliente consulte el estado de su revisión
    // sin autenticarse -- mismo patrón que WorkOrder.share_token.
    share_token: { type: DataTypes.UUID, allowNull: true, unique: true },
  },
  {
    tableName: 'ensambladora_ordenes_revision',
    timestamps: true,
    underscored: true,
  }
);

module.exports = EnsambladoraOrdenRevision;
