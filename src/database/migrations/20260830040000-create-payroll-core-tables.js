'use strict';

// ============================================================================
// MÓDULO DE NÓMINA ELECTRÓNICA — Fase 1: modelo de datos núcleo
//
// Ver Plan-Implementacion-Nomina-Electronica-Nexora.md §4.2. Esta migración
// solo cubre las 3 tablas de la Fase 1 (Employee, PayrollConcept,
// PayrollPeriod) — PayrollDocument/PayrollDocumentAdjustment (Fase 2, ligadas
// a la emisión DIAN) se crean en una migración posterior, igual que se hizo
// con support_documents en su momento (2026082809).
//
// Mismo patrón que 20260830000000-create-production-tables.js: SQL crudo,
// tablas de schema-por-tenant sin prefijo, referencias explícitas a
// "public"."tenants"/"public"."users"/"public"."branches" para las tablas
// compartidas entre schemas.
// ============================================================================

const SQL_UP = `
-- 1. EMPLEADOS
CREATE TABLE IF NOT EXISTS employees (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE,

    -- Identificación (códigos DIAN Anexo Técnico Nómina — TipoDocumento)
    document_type       VARCHAR(5) NOT NULL DEFAULT '13'
        CHECK (document_type IN ('11','12','13','21','22','31','41','42','47','48')),
    document_number     VARCHAR(30) NOT NULL,

    -- Nombres estructurados (requeridos así por el XML de nómina, no como
    -- un solo campo "name" -- ver Trabajador/NombreTrabajador del Anexo)
    first_name          VARCHAR(100) NOT NULL,
    other_names         VARCHAR(100),
    first_surname       VARCHAR(100) NOT NULL,
    second_surname      VARCHAR(100),

    email               VARCHAR(255),
    phone               VARCHAR(20),

    -- Datos laborales
    position            VARCHAR(150),
    cost_center         VARCHAR(100),
    branch_id           UUID REFERENCES "public"."branches"(id) ON DELETE SET NULL,
    contract_type       VARCHAR(5) NOT NULL DEFAULT '1'
        CHECK (contract_type IN ('1','2','3','4','5')),
    -- 1 Término indefinido, 2 Término fijo, 3 Obra o labor,
    -- 4 Aprendizaje, 5 Otro
    worker_type         VARCHAR(5) NOT NULL DEFAULT '01',
    -- Código DIAN TipoTrabajador (01 Empleado, 02 Pensionado, etc.)
    salary_type         VARCHAR(20) NOT NULL DEFAULT 'ordinario'
        CHECK (salary_type IN ('ordinario','integral')),
    base_salary         DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
    transport_allowance_eligible BOOLEAN NOT NULL DEFAULT TRUE,

    hire_date           DATE NOT NULL,
    termination_date    DATE,

    -- Pago
    payment_method      VARCHAR(20) NOT NULL DEFAULT 'transfer'
        CHECK (payment_method IN ('transfer','cash','check')),
    bank_name            VARCHAR(150),
    account_type         VARCHAR(20) CHECK (account_type IN ('savings','checking')),
    account_number        VARCHAR(50),

    -- Ubicación DIAN (mismo patrón que suppliers/customers -- ver
    -- 2026082816-add-dian-address-fields-to-suppliers.js)
    country              VARCHAR(100) DEFAULT 'Colombia',
    state                VARCHAR(100),
    city                 VARCHAR(100),
    city_code            VARCHAR(5),
    address              TEXT,

    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    notes                TEXT,

    created_by           UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
    created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT tenant_employee_document_unique UNIQUE (tenant_id, document_type, document_number)
);
CREATE INDEX IF NOT EXISTS idx_employees_tenant        ON employees(tenant_id);
CREATE INDEX IF NOT EXISTS idx_employees_tenant_active ON employees(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_employees_branch        ON employees(branch_id);

-- 2. CATÁLOGO DE CONCEPTOS DE NÓMINA (devengados/deducciones)
CREATE TABLE IF NOT EXISTS payroll_concepts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE,
    code                VARCHAR(30) NOT NULL,
    name                VARCHAR(150) NOT NULL,
    concept_type        VARCHAR(20) NOT NULL
        CHECK (concept_type IN ('devengado','deduccion')),
    -- Categoría del Anexo Técnico DIAN a la que mapea este concepto
    -- (ej: 'Basico','HEDs','HRNs','Comisiones','AuxilioTransporte','Bonificaciones',
    --  'Salud','Pension','FondoSolidaridadPension','RetencionFuente','Libranza','Otros')
    dian_category       VARCHAR(50) NOT NULL DEFAULT 'Otros',
    -- Código de novedad/tipo específico del Anexo Técnico cuando aplica
    dian_code           VARCHAR(10),
    calculation_type    VARCHAR(20) NOT NULL DEFAULT 'manual'
        CHECK (calculation_type IN ('fixed','percentage','formula','manual')),
    -- Valor por defecto: monto fijo o porcentaje según calculation_type
    default_value       DECIMAL(15,4) NOT NULL DEFAULT 0,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order          INTEGER DEFAULT 0,
    notes               TEXT,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tenant_payroll_concept_code_unique UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_payroll_concepts_tenant ON payroll_concepts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payroll_concepts_type   ON payroll_concepts(tenant_id, concept_type);

-- 3. PERIODOS DE LIQUIDACIÓN
CREATE TABLE IF NOT EXISTS payroll_periods (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE,
    branch_id           UUID REFERENCES "public"."branches"(id) ON DELETE SET NULL,
    period_type         VARCHAR(20) NOT NULL DEFAULT 'mensual'
        CHECK (period_type IN ('mensual','quincenal')),
    start_date          DATE NOT NULL,
    end_date            DATE NOT NULL CHECK (end_date >= start_date),
    payment_date        DATE,
    status              VARCHAR(20) NOT NULL DEFAULT 'abierto'
        CHECK (status IN ('abierto','liquidado','emitido','cerrado')),
    notes               TEXT,
    closed_at           TIMESTAMP,
    closed_by           UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
    created_by          UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tenant_payroll_period_dates_unique UNIQUE (tenant_id, start_date, end_date)
);
CREATE INDEX IF NOT EXISTS idx_payroll_periods_tenant ON payroll_periods(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payroll_periods_status ON payroll_periods(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_periods_dates  ON payroll_periods(tenant_id, start_date, end_date);
`;

const SQL_DOWN = `
DROP TABLE IF EXISTS payroll_periods CASCADE;
DROP TABLE IF EXISTS payroll_concepts CASCADE;
DROP TABLE IF EXISTS employees CASCADE;
`;

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(SQL_UP);
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query(SQL_DOWN);
  },
};
