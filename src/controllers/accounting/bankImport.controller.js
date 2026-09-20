// backend/src/controllers/accounting/bankImport.controller.js
//
// Importación de extractos bancarios — Fase 3 del plan de Contabilidad
// Pitbox. Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 3, flujo de
// importación (puntos 1-5).
//
// Endpoints:
//   POST /api/accounting/bank-accounts/:id/import/preview  → preview
//   POST /api/accounting/bank-accounts/:id/import          → runImport
//
// Nota (mismo hallazgo que invoiceImport.controller.js): el upload de
// archivo (multer) corre entre tenantMiddleware y este controller y rompe
// la propagación del AsyncLocalStorage que fija el schema del tenant -- se
// re-fija acá mismo con req.tenant.schema_name antes de tocar la BD.
const { runWithTenantSchema } = require('../../config/tenantContext');
const { BankAccount, BankImportTemplate, BankTransaction, sequelize } = require('../../models');
const {
  parseStatementFile,
  computeFileSignature,
  previewRows,
  buildTransactionsFromRows,
} = require('../../services/accounting/bankStatementParser.service');
const { runAutoMatch } = require('../../services/accounting/bankReconciliation.service');
const logger = require('../../config/logger');

function withTenantSchema(handler) {
  return (req, res) => {
    if (req.tenant?.schema_name) {
      return runWithTenantSchema(req.tenant.schema_name, () => handler(req, res));
    }
    return handler(req, res);
  };
}

// POST /bank-accounts/:id/import/preview
// Lee solo las primeras filas del archivo y las muestra en una tabla, junto
// con la firma calculada y si ya existe una plantilla guardada para esa
// firma en esta cuenta (para que el frontend decida si pedir el mapeo
// manual o aplicarlo directo).
exports.preview = withTenantSchema(async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No se ha cargado ningún archivo' });

    const bankAccount = await BankAccount.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!bankAccount) return res.status(404).json({ success: false, message: 'Cuenta bancaria no encontrada' });

    const { headers, rows } = await parseStatementFile(req.file.buffer, req.file.originalname);
    if (headers.length === 0) {
      return res.status(400).json({ success: false, message: 'No se pudo leer ninguna columna del archivo' });
    }

    const fileSignature = computeFileSignature(headers);
    const existingTemplate = await BankImportTemplate.findOne({
      where: { bank_account_id: bankAccount.id, file_signature: fileSignature },
    });

    res.json({
      success: true,
      data: {
        headers,
        preview_rows: previewRows(rows, 3),
        total_rows: rows.length,
        file_signature: fileSignature,
        existing_template: existingTemplate || null,
      },
    });
  } catch (error) {
    logger.error('Error en bankImport.controller.js (preview):', error);
    res.status(500).json({ success: false, message: 'Error al leer el archivo del extracto', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
});

// POST /bank-accounts/:id/import
// Body (multipart): file + column_mapping (JSON string, solo si es la
// primera vez para esta firma) + date_format + amount_format (JSON string).
// Si ya existe un BankImportTemplate para la firma detectada, se reutiliza
// sin que el frontend tenga que reenviar el mapeo.
exports.runImport = withTenantSchema(async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No se ha cargado ningún archivo' });

    const bankAccount = await BankAccount.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!bankAccount) return res.status(404).json({ success: false, message: 'Cuenta bancaria no encontrada' });

    const { headers, rows } = await parseStatementFile(req.file.buffer, req.file.originalname);
    if (headers.length === 0) {
      return res.status(400).json({ success: false, message: 'No se pudo leer ninguna columna del archivo' });
    }
    const fileSignature = computeFileSignature(headers);

    let template = await BankImportTemplate.findOne({
      where: { bank_account_id: bankAccount.id, file_signature: fileSignature },
    });

    if (!template) {
      // Primera vez que se ve este layout para esta cuenta: el mapeo debe
      // venir en el body.
      let columnMapping, amountFormat;
      try {
        columnMapping = JSON.parse(req.body.column_mapping || 'null');
        amountFormat = JSON.parse(req.body.amount_format || '{"decimal_separator":",","mode":"unico"}');
      } catch (e) {
        return res.status(400).json({ success: false, message: 'column_mapping / amount_format inválidos (deben ser JSON)' });
      }
      if (!columnMapping || !columnMapping.fecha) {
        return res.status(400).json({ success: false, message: 'Debes indicar el mapeo de columnas (al menos la columna de fecha) la primera vez que importas este banco' });
      }
      const dateFormat = req.body.date_format || 'DD/MM/YYYY';

      template = await BankImportTemplate.create({
        tenant_id: req.tenant_id,
        bank_account_id: bankAccount.id,
        file_signature: fileSignature,
        column_mapping: columnMapping,
        date_format: dateFormat,
        amount_format: amountFormat,
      });
    }

    const { transactions, errors } = buildTransactionsFromRows(
      rows,
      template.column_mapping,
      template.amount_format,
      template.date_format
    );

    let created = 0;
    let duplicated = 0;
    const t = await sequelize.transaction();
    try {
      for (const tx of transactions) {
        const [, wasCreated] = await BankTransaction.findOrCreate({
          where: {
            bank_account_id: bankAccount.id,
            transaction_date: tx.transaction_date,
            amount: tx.amount,
            reference: tx.reference,
            description: tx.description,
          },
          defaults: { ...tx, tenant_id: req.tenant_id, bank_account_id: bankAccount.id },
          transaction: t,
        });
        if (wasCreated) created++; else duplicated++;
      }
      await t.commit();
    } catch (error) {
      await t.rollback();
      throw error;
    }

    // Matching automático fire-and-forget dentro de la misma request (el
    // volumen típico de un extracto mensual no justifica un job aparte) --
    // si falla, el import ya quedó guardado igual, solo falta conciliar.
    let autoMatch = null;
    try {
      autoMatch = await runAutoMatch(req.tenant_id, bankAccount.id);
    } catch (error) {
      logger.warn(`[bank-import] No se pudo correr el matching automático (cuenta ${bankAccount.id}): ${error.message}`);
    }

    res.status(201).json({
      success: true,
      data: {
        total_rows: rows.length,
        created,
        duplicated,
        row_errors: errors,
        auto_match: autoMatch,
        template_used: { id: template.id, is_new: !req.body.reused_template },
      },
      message: `${created} movimiento(s) importado(s)${duplicated ? `, ${duplicated} ya existían` : ''}${errors.length ? `, ${errors.length} fila(s) con error` : ''}.`,
    });
  } catch (error) {
    logger.error('Error en bankImport.controller.js (runImport):', error);
    res.status(500).json({ success: false, message: 'Error al importar el extracto', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
});
