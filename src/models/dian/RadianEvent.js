// backend/src/models/dian/RadianEvent.js
// Eventos RADIAN (030 Acuse, 031 Reclamo, 032 Recibo, 033 Aceptación
// expresa, 034 Aceptación tácita) — NO reutiliza DianEvent (bitácora de
// llamadas SOAP de factura/nómina): ver RADIAN-Analisis-y-Plan.md §3.1.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const RadianEvent = sequelize.define('RadianEvent', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
  },
  direction: {
    type: DataTypes.STRING(10),
    allowNull: false,
    validate: { isIn: [['emitted', 'received']] },
  },
  purchase_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'purchases', key: 'id' },
    onDelete: 'SET NULL',
  },
  sale_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'sales', key: 'id' },
    onDelete: 'SET NULL',
  },
  document_cufe: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  document_number: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  counterparty_nit: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  event_code: {
    type: DataTypes.STRING(5),
    allowNull: false,
    validate: { isIn: [[
      '030', '031', '032', '033', '034', // Fases 1-3
      '036', '037', '038', '039', '040', '041', '042', '043', '044', '045', '046', // Fase 4 (035 Aval no aplica, lo emite el avalista con su propio software)
    ]] },
  },
  details: {
    type: DataTypes.JSONB,
    allowNull: true,
    comment: 'Payload estructurado del evento (Fase 4: endosatario, motivo de limitación, mandatario, monto pagado...).',
  },
  cude: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  issued_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  issuer_user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
  issuer_snapshot: {
    type: DataTypes.JSONB,
    allowNull: true,
    comment: 'Copia de nombre/cédula de quien ejecutó el evento (solo 030/032)',
  },
  claim_reason_code: {
    type: DataTypes.STRING(10),
    allowNull: true,
  },
  request_xml: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  signed_xml: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  track_id: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  dian_status: {
    type: DataTypes.STRING(30),
    allowNull: false,
    defaultValue: 'pending',
    comment: 'pending | sending | accepted | rejected | error',
  },
  dian_response_raw: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  error_message: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  attempt: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  is_test: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'radian_events',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = RadianEvent;
