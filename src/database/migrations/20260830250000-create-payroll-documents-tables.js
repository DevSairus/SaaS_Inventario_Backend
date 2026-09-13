'use strict';

// ============================================================================
// MÓDULO DE NÓMINA ELECTRÓNICA — Fase 2: PayrollDocument
//
// Análogo directo a support_documents (2026082809) — un documento por
// EMPLEADO por PERIODO, no un documento por periodo completo (el Anexo
// Técnico de Nómina Electrónica exige un NominaIndividual independiente
// por cada trabajador). PayrollDocumentAdjustment es al PayrollDocument lo
// que SupportDocumentAdjustment es a SupportDocument — misma relación 1
// original : N ajustes, misma FK real (no texto libre).
//
// snapshot_liquidation guarda el objeto `liquidation` completo devuelto por
// payrollService.js#liquidarEmpleado() en el momento de la emisión — mismo
// principio que seller_snapshot en support_documents: si después cambia el
// salario del empleado o el catálogo de conceptos, este documento ya
// emitido sigue siendo reconstruible/auditable tal como se envió a la
// DIAN, sin depender de que los datos "vivos" no hayan cambiado.
// ============================================================================

const SQL_UP = `
CREATE TABLE IF NOT EXISTS payroll_documents (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE,
    branch_id             UUID REFERENCES "public"."branches"(id) ON DELETE SET NULL,

    employee_id           UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    payroll_period_id     UUID NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,

    payroll_document_number VARCHAR(50),
    -- Prefijo + consecutivo (NumNE) -- equivalente a support_document_number

    cune                  VARCHAR(255),
    -- Código Único de Documento Soporte de Pago de Nómina Electrónica -- equivalente a cuds/cufe

    devengados_total      DECIMAL(15,2) NOT NULL DEFAULT 0,
    deducciones_total     DECIMAL(15,2) NOT NULL DEFAULT 0,
    comprobante_total     DECIMAL(15,2) NOT NULL DEFAULT 0,

    snapshot_liquidation  JSONB,
    -- Salida completa de payrollService.js#liquidarEmpleado() al momento de emitir

    xml_content           TEXT,
    -- XML firmado enviado a DIAN (mismo criterio que request_xml en dian_events, pero aquí queda también en el documento para descarga directa sin ir a buscar el evento)

    pdf_path              TEXT,
    -- Ruta de la representación gráfica generada (Fase 3/pdfService.js) -- NULL hasta que se genere

    dian_status           VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (dian_status IN ('pending', 'sending', 'accepted', 'rejected')),
    dian_response         JSONB,
    dian_sent_at          TIMESTAMP,
    dian_accepted_at      TIMESTAMP,
    dian_error_message    TEXT,

    email_sent_at         TIMESTAMP,
    -- NULL hasta que payrollEmailService.js confirme el envío al empleado

    created_by            UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT tenant_employee_period_unique UNIQUE (tenant_id, employee_id, payroll_period_id)
    -- Un solo documento vigente por empleado+periodo -- correcciones van por PayrollDocumentAdjustment, no por duplicar la fila
);
CREATE INDEX IF NOT EXISTS idx_payroll_documents_tenant   ON payroll_documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payroll_documents_period   ON payroll_documents(tenant_id, payroll_period_id);
CREATE INDEX IF NOT EXISTS idx_payroll_documents_employee ON payroll_documents(tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_documents_status   ON payroll_documents(tenant_id, dian_status);

CREATE TABLE IF NOT EXISTS payroll_document_adjustments (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE,
    payroll_document_id   UUID NOT NULL REFERENCES payroll_documents(id) ON DELETE RESTRICT,

    adjustment_type       VARCHAR(10) NOT NULL CHECK (adjustment_type IN ('replace', 'delete')),
    -- Anexo Técnico §2: Reemplazar(1)/Eliminar(2) -- distinto de Documento Soporte (credit/debit)

    reason                TEXT,
    snapshot_liquidation  JSONB,
    -- Liquidación corregida (solo aplica a adjustment_type='replace'; NULL si 'delete')

    devengados_total      DECIMAL(15,2) DEFAULT 0,
    deducciones_total     DECIMAL(15,2) DEFAULT 0,
    comprobante_total     DECIMAL(15,2) DEFAULT 0,

    adjustment_number     VARCHAR(50),
    cune                  VARCHAR(255),
    xml_content           TEXT,

    dian_status           VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (dian_status IN ('pending', 'sending', 'accepted', 'rejected')),
    dian_response         JSONB,
    dian_sent_at          TIMESTAMP,
    dian_accepted_at      TIMESTAMP,
    dian_error_message    TEXT,

    created_by            UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payroll_doc_adjustments_tenant   ON payroll_document_adjustments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payroll_doc_adjustments_document ON payroll_document_adjustments(payroll_document_id);
`;

const SQL_DOWN = `
DROP TABLE IF EXISTS payroll_document_adjustments CASCADE;
DROP TABLE IF EXISTS payroll_documents CASCADE;
`;

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(SQL_UP);
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query(SQL_DOWN);
  },
};
