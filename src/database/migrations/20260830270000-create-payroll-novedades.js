'use strict';

// ============================================================================
// MÓDULO DE NÓMINA ELECTRÓNICA — captura de novedades por empleado/periodo
//
// payrollService.js#liquidarEmpleado() ya sabía procesar un arreglo de
// "novedades" (horas extra, bonificaciones, licencias, libranzas, etc.)
// pero no existía ninguna tabla donde persistirlas -- sin esto, la
// liquidación real de un periodo solo podía calcular Básico + deducciones
// legales, sin nada capturado manualmente. Esta tabla es el punto de
// entrada de esos datos (Fase 3 los expondrá en PayrollPeriodsPage.jsx;
// aquí solo se persiste).
//
// `dian_category` usa las mismas claves que
// payrollService.js#DIAN_CATEGORY_MAP (HEDs, Bonificaciones, Libranza,
// etc.) -- ver esa constante como fuente de verdad de valores válidos.
// `unpaid_days` es la única excepción: no es una categoría DIAN, es un
// dato puramente interno para el prorrateo del Básico (licencia no
// remunerada, suspensión, ausencia injustificada) -- se resta del cálculo
// pero NUNCA se envía a la DIAN como tal (esos días sí generan, aparte,
// su propia novedad LicenciaNR/HuelgasLegales si corresponde presentarlos
// en el XML).
// ============================================================================

const SQL_UP = `
CREATE TABLE IF NOT EXISTS payroll_novedades (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE,
    employee_id         UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    payroll_period_id   UUID NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
    payroll_concept_id  UUID REFERENCES payroll_concepts(id) ON DELETE SET NULL,

    dian_category       VARCHAR(50),
    -- Clave de DIAN_CATEGORY_MAP en payrollService.js (HEDs, Bonificaciones,
    -- Libranza, ...) -- NULL si esta fila es puramente unpaid_days sin
    -- categoría DIAN asociada.

    payload             JSONB,
    -- Estructura exacta que espera el sub-builder de payrollXmlBuilder.js
    -- correspondiente a dian_category (ver DIAN_CATEGORY_MAP). NULL si esta
    -- fila es puramente unpaid_days.

    unpaid_days         DECIMAL(5,2) DEFAULT 0,
    -- Días NO remunerados que resta del Básico (licencia no remunerada,
    -- suspensión, ausencia injustificada). 0 si esta novedad no afecta el
    -- Básico (ej. una bonificación no resta días).

    notes               TEXT,
    created_by          UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT payroll_novedad_has_content
        CHECK (dian_category IS NOT NULL OR unpaid_days > 0)
);
CREATE INDEX IF NOT EXISTS idx_payroll_novedades_tenant   ON payroll_novedades(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payroll_novedades_period   ON payroll_novedades(tenant_id, payroll_period_id);
CREATE INDEX IF NOT EXISTS idx_payroll_novedades_employee ON payroll_novedades(tenant_id, employee_id, payroll_period_id);
`;

const SQL_DOWN = `
DROP TABLE IF EXISTS payroll_novedades CASCADE;
`;

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(SQL_UP);
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query(SQL_DOWN);
  },
};
