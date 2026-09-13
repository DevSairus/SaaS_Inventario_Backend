// backend/src/models/payroll/Employee.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Employee = sequelize.define('Employee', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
    onDelete: 'CASCADE',
  },
  // ── Identificación (códigos DIAN TipoDocumento del Anexo Técnico Nómina) ──
  document_type: {
    type: DataTypes.STRING(5),
    allowNull: false,
    defaultValue: '13',
    validate: { isIn: [['11', '12', '13', '21', '22', '31', '41', '42', '47', '48']] },
    comment: '13 CC, 22 CE, 41 Pasaporte, 47 PEP, 48 PPT, 31 NIT, etc.',
  },
  document_number: {
    type: DataTypes.STRING(30),
    allowNull: false,
  },
  // ── Nombres estructurados (requerido por el XML de nómina) ──
  first_name: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  other_names: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  first_surname: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  second_surname: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: true,
    validate: { isEmail: { msg: 'Email inválido' } },
  },
  phone: {
    type: DataTypes.STRING(20),
    allowNull: true,
  },
  // ── Datos laborales ──
  position: {
    type: DataTypes.STRING(150),
    allowNull: true,
    comment: 'Cargo',
  },
  cost_center: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  branch_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'branches', key: 'id' },
    onDelete: 'SET NULL',
  },
  contract_type: {
    type: DataTypes.STRING(5),
    allowNull: false,
    defaultValue: '1',
    validate: { isIn: [['1', '2', '3', '4', '5']] },
    comment: '1 Indefinido, 2 Fijo, 3 Obra/labor, 4 Aprendizaje, 5 Otro',
  },
  worker_type: {
    type: DataTypes.STRING(5),
    allowNull: false,
    defaultValue: '01',
    comment: 'Código DIAN TipoTrabajador (01 Empleado, 02 Pensionado, ...)',
  },
  worker_subtype: {
    type: DataTypes.STRING(5),
    allowNull: false,
    defaultValue: '00',
    comment: 'Código DIAN SubTipoTrabajador (tabla 5.5.4 del Anexo) — sub-clasificación PILA',
  },
  high_risk_pension: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: 'AltoRiesgoPension del Anexo — actividades del Decreto 2090 de 2003',
  },
  employee_code: {
    type: DataTypes.STRING(30),
    allowNull: true,
    comment: 'Código interno del empleado (CodigoTrabajador del Anexo, opcional)',
  },
  salary_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'ordinario',
    validate: { isIn: [['ordinario', 'integral']] },
  },
  base_salary: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
  // Con qué periodicidad se le paga a este empleado (mismo dominio que
  // PayrollPeriod.period_type) — determina qué periodos lo incluyen
  // automáticamente. Ver payrollPeriodEmissionService.js#getEmployeesActiveInPeriod.
  payroll_periodicity: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'mensual',
    validate: { isIn: [['mensual', 'quincenal']] },
  },
  transport_allowance_eligible: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  hire_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  termination_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  // Fecha de fin pactada del contrato (solo aplica a contract_type '2'
  // Término fijo) — base para el listado de alertas de vencimiento (ver
  // getExpiringContracts en employees.controller.js). Null para el resto
  // de tipos de contrato o cuando aún no se conoce la fecha exacta.
  contract_end_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  // ── Pago ──
  payment_method: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'transfer',
    validate: { isIn: [['transfer', 'cash', 'check']] },
    comment: 'Método de pago (Metodo del Anexo, tabla 5.3.3.2)',
  },
  payment_form: {
    type: DataTypes.STRING(5),
    allowNull: false,
    defaultValue: '1',
    validate: { isIn: [['1', '2']] },
    comment: 'Forma de pago (Forma del Anexo, tabla 5.3.3.1): 1 Contado, 2 Crédito',
  },
  bank_name: {
    type: DataTypes.STRING(150),
    allowNull: true,
  },
  account_type: {
    type: DataTypes.STRING(20),
    allowNull: true,
    validate: { isIn: [[null, 'savings', 'checking']] },
  },
  account_number: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  // ── Ubicación DIAN (mismo patrón que Supplier/Customer) ──
  country: {
    type: DataTypes.STRING(100),
    allowNull: true,
    defaultValue: 'Colombia',
  },
  state: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Departamento',
  },
  city: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Municipio',
  },
  city_code: {
    type: DataTypes.STRING(5),
    allowNull: true,
    comment: 'Código DIVIPOLA del municipio (ver data/divipola-colombia.js)',
  },
  address: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Dirección de residencia del empleado',
  },
  // ── Lugar de trabajo (independiente de la residencia — obligatorio en
  // el Anexo, NIE050-053). Si queda null, payrollService.js usa la
  // dirección del Empleador como fallback (caso típico de PyME). ──
  work_country: {
    type: DataTypes.STRING(2),
    allowNull: false,
    defaultValue: 'CO',
  },
  work_state: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Departamento del lugar de trabajo',
  },
  work_city: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Municipio del lugar de trabajo',
  },
  work_city_code: {
    type: DataTypes.STRING(5),
    allowNull: true,
    comment: 'Código DIVIPOLA del municipio de trabajo (si es distinto al de residencia)',
  },
  work_address: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Dirección física del lugar de trabajo',
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
  },
}, {
  tableName: 'employees',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  getterMethods: {
    full_name() {
      return [this.first_name, this.other_names, this.first_surname, this.second_surname]
        .filter(Boolean)
        .join(' ');
    },
  },
});

module.exports = Employee;