'use strict';

// Registro de documentos electrónicos recibidos, alimentado con el Excel de
// "Documentos" que se descarga del portal DIAN (una fila por CUFE).
//
// El portal no filtra por "ya revisado": cada descarga trae todo el periodo,
// así que la misma factura llega en varias cargas sucesivas. La llave única
// (tenant_id, cufe) hace que una nueva carga solo actualice los datos de la
// DIAN (estado, etc.) sin tocar lo que el usuario ya decidió (status,
// purchase_id/expense_id) ni duplicar filas.
//
// status: pending (por revisar) | loaded (ya existe en Pitbox como compra o
// gasto) | discarded (el usuario decidió no cargarla).
//
// xml_content: XML descargado de la DIAN (GetXmlByDocumentKey) cuando está
// disponible — con él se puede cargar como compra con detalle por el mismo
// flujo del ZIP.

module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      CREATE TABLE IF NOT EXISTS dian_received_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
        cufe VARCHAR(200) NOT NULL,
        document_type VARCHAR(120),
        folio VARCHAR(60),
        prefix VARCHAR(20),
        currency VARCHAR(10),
        payment_form VARCHAR(60),
        payment_method VARCHAR(120),
        issue_date DATE,
        reception_date TIMESTAMP,
        issuer_nit VARCHAR(30),
        issuer_name VARCHAR(255),
        receiver_nit VARCHAR(30),
        receiver_name VARCHAR(255),
        iva DECIMAL(15,2) DEFAULT 0,
        ica DECIMAL(15,2) DEFAULT 0,
        inc DECIMAL(15,2) DEFAULT 0,
        other_taxes JSONB DEFAULT '{}',
        rete_iva DECIMAL(15,2) DEFAULT 0,
        rete_renta DECIMAL(15,2) DEFAULT 0,
        rete_ica DECIMAL(15,2) DEFAULT 0,
        total DECIMAL(15,2) DEFAULT 0,
        dian_status VARCHAR(80),
        dian_group VARCHAR(40),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        purchase_id UUID REFERENCES purchases(id) ON DELETE SET NULL,
        expense_id UUID REFERENCES expenses(id) ON DELETE SET NULL,
        supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
        xml_content TEXT,
        xml_fetched_at TIMESTAMP,
        xml_fetch_error TEXT,
        discard_reason VARCHAR(255),
        first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
        times_seen INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT dian_received_documents_tenant_cufe_unique UNIQUE (tenant_id, cufe)
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_dian_received_docs_tenant_status ON dian_received_documents (tenant_id, status)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_dian_received_docs_tenant_issue_date ON dian_received_documents (tenant_id, issue_date)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_dian_received_docs_issuer ON dian_received_documents (tenant_id, issuer_nit)`);
    console.log('[Migration] dian_received_documents creada');
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS dian_received_documents`);
  },
};
