// backend/src/services/accounting/entryDetails.service.js
//
// Detalle completo (todas las líneas: cuenta, tercero, débito, crédito) de
// un conjunto de asientos. Lo usan las exportaciones a Excel de Libro Mayor,
// Libro Auxiliar, Libro de IVA y Retenciones para agregar una hoja "Detalle
// de Asientos": esos reportes solo listan el número del asiento, y quien
// recibe el archivo sin acceso a Pitbox no tiene cómo ver la contrapartida.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');

// Tope de seguridad: un Libro Mayor de Caja de un año puede referenciar
// decenas de miles de asientos; por encima de esto la hoja de detalle se
// omite (el reporte principal se genera igual) y se avisa en la hoja.
const MAX_ENTRIES = 5000;

/**
 * @param {string} tenantId
 * @param {Array<string>} entryIds
 * @returns {Promise<{ entries: Array, truncated: boolean, total: number }>}
 */
async function fetchEntryDetails(tenantId, entryIds) {
  const ids = [...new Set((entryIds || []).filter(Boolean))];
  if (ids.length === 0) return { entries: [], truncated: false, total: 0 };
  if (ids.length > MAX_ENTRIES) return { entries: [], truncated: true, total: ids.length };

  const schema = getCurrentSchema() || 'public';
  const rows = await sequelize.query(
    `SELECT e.id AS entry_id, e.entry_number, e.entry_date, e.description AS entry_description, e.source_type,
            l.line_order, a.code AS account_code, a.name AS account_name,
            l.debit, l.credit, l.description AS line_description,
            COALESCE(
              NULLIF(s.business_name, ''), s.name,
              NULLIF(c.business_name, ''), NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
              NULLIF(TRIM(CONCAT_WS(' ', emp.first_name, emp.first_surname)), '')
            ) AS third_party_name,
            COALESCE(s.tax_id, c.tax_id, emp.document_number) AS third_party_tax_id
     FROM "${schema}"."journal_entries" e
     JOIN "${schema}"."journal_entry_lines" l ON l.entry_id = e.id
     JOIN "${schema}"."chart_of_accounts" a ON a.id = l.account_id
     LEFT JOIN "${schema}"."suppliers" s ON s.id = l.third_party_id
     LEFT JOIN "${schema}"."customers" c ON c.id = l.third_party_id
     LEFT JOIN "${schema}"."employees" emp ON emp.id = l.third_party_id
     WHERE e.tenant_id = :tenantId
       AND e.id IN (:ids)
     ORDER BY e.entry_date ASC, e.entry_number ASC, l.line_order ASC`,
    { replacements: { tenantId, ids }, type: QueryTypes.SELECT }
  );

  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.entry_id)) {
      map.set(r.entry_id, {
        id: r.entry_id,
        entry_number: r.entry_number,
        entry_date: r.entry_date,
        description: r.entry_description,
        source_type: r.source_type,
        lines: [],
        total_debit: 0,
        total_credit: 0,
      });
    }
    const entry = map.get(r.entry_id);
    entry.lines.push({
      account_code: r.account_code,
      account_name: r.account_name,
      third_party_name: r.third_party_name || '',
      third_party_tax_id: r.third_party_tax_id || '',
      description: r.line_description || '',
      debit: Number(r.debit),
      credit: Number(r.credit),
    });
    entry.total_debit += Number(r.debit);
    entry.total_credit += Number(r.credit);
  }

  return { entries: [...map.values()], truncated: false, total: ids.length };
}

/**
 * Asientos generados a partir de documentos origen (ej. ventas de un
 * reporte de retenciones que lee directo de `sales`).
 */
async function fetchEntryIdsBySource(tenantId, sourceType, sourceIds) {
  const ids = [...new Set((sourceIds || []).filter(Boolean))];
  if (ids.length === 0) return [];
  const schema = getCurrentSchema() || 'public';
  const rows = await sequelize.query(
    `SELECT id, entry_number, source_id FROM "${schema}"."journal_entries"
     WHERE tenant_id = :tenantId AND source_type = :sourceType AND source_id IN (:ids)
       AND status = 'posted'
     ORDER BY entry_date ASC, entry_number ASC`,
    { replacements: { tenantId, sourceType, ids }, type: QueryTypes.SELECT }
  );
  return rows;
}

module.exports = { fetchEntryDetails, fetchEntryIdsBySource, MAX_ENTRIES };
