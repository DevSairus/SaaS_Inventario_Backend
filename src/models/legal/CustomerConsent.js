// backend/src/models/legal/CustomerConsent.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Solicitud de autorización a un cliente:
//   - 'habeas_data': tratamiento de datos personales (Ley 1581 de 2012).
//   - 'vehicle_intake': acta de ingreso del vehículo al taller (inventario +
//     condiciones del servicio), atada a una OT.
// El cliente la acepta confirmando un OTP (otplib, HOTP) que le llega por
// email o WhatsApp, desde el enlace público /autorizacion/:token o en
// mostrador. Toda la evidencia queda en esta fila + events.
const CustomerConsent = sequelize.define('CustomerConsent', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  kind: {
    type: DataTypes.STRING(30),
    allowNull: false,
    validate: { isIn: [['habeas_data', 'vehicle_intake']] },
  },
  customer_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'customers', key: 'id' },
    onDelete: 'CASCADE',
  },
  work_order_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'work_orders', key: 'id' },
    onDelete: 'CASCADE',
  },
  document_version_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'legal_document_versions', key: 'id' },
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'pending',
    validate: { isIn: [['pending', 'accepted', 'rejected', 'revoked', 'cancelled', 'expired']] },
  },
  token: {
    type: DataTypes.UUID,
    allowNull: false,
    defaultValue: DataTypes.UUIDV4,
    unique: true,
  },
  expires_at: { type: DataTypes.DATE, allowNull: true },

  // Solo vehicle_intake: foto del inventario/km/problema al momento de pedir
  // la autorización (lo que el cliente ve y acepta) y su hash.
  intake_snapshot: { type: DataTypes.JSONB, allowNull: true },
  intake_hash: { type: DataTypes.STRING(64), allowNull: true },
  // Solo habeas_data: autorización separada y opcional para publicidad.
  marketing_opt_in: { type: DataTypes.BOOLEAN, allowNull: true },

  // OTP -- secreto cifrado (utils/metaTokenCrypto) y contador HOTP: cada
  // reenvío incrementa el contador, así el código anterior deja de servir.
  otp_secret: { type: DataTypes.TEXT, allowNull: true },
  otp_counter: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  otp_channel: { type: DataTypes.STRING(20), allowNull: true },
  otp_destination: { type: DataTypes.STRING(255), allowNull: true },
  otp_sent_at: { type: DataTypes.DATE, allowNull: true },
  otp_expires_at: { type: DataTypes.DATE, allowNull: true },
  otp_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

  accepted_at: { type: DataTypes.DATE, allowNull: true },
  accepted_via: {
    type: DataTypes.STRING(20),
    allowNull: true,
    validate: { isIn: [['public_link', 'counter', 'physical']] },
  },
  accepted_ip: { type: DataTypes.STRING(45), allowNull: true },
  accepted_user_agent: { type: DataTypes.TEXT, allowNull: true },
  verified_channel: { type: DataTypes.STRING(20), allowNull: true },
  verified_destination: { type: DataTypes.STRING(255), allowNull: true },
  signer_name: { type: DataTypes.STRING(200), allowNull: true },
  signer_document: { type: DataTypes.STRING(30), allowNull: true },
  physical_notes: { type: DataTypes.TEXT, allowNull: true },
  // Escaneo del formato firmado (accepted_via 'physical'), privado -- ver
  // migración 2026102702 y consents.controller.js#getPhysicalDocument.
  physical_document: { type: DataTypes.JSONB, allowNull: true },

  rejected_at: { type: DataTypes.DATE, allowNull: true },
  revoked_at: { type: DataTypes.DATE, allowNull: true },
  revoked_by: { type: DataTypes.UUID, allowNull: true },
  revoke_reason: { type: DataTypes.TEXT, allowNull: true },

  // Bitácora: [{ at, type, ...detalle }] -- enlace enviado, OTP enviado,
  // intento fallido, aceptación, revocación.
  events: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  requested_by: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName: 'customer_consents',
  timestamps: true,
  underscored: true,
});

module.exports = CustomerConsent;
