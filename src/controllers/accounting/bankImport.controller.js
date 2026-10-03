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
const { Op } = require('sequelize');
const { BankAccount, BankImportTemplate, BankTransaction, sequelize } = require('../../models');
const {
  parseStatementFile,
  computeFileSignature,
  previewRows,
  buildTransactionsFromRows,
  suggestMapping,
} = require('../../services/accounting/bankStatementParser.service');
const { runAutoMatch } = require('../../services/accounting/bankReconciliation.service');
const logger = require('../../config/logger');

// Errores de formato del archivo (ej. .xls binario) → 400 con su mensaje.
function fileError(res, error, fallback) {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
  return res.status(500).json({ success: false, message: fallback, error: process.env.NODE_ENV === 'production' ? undefined : error.message });
}

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

    const { headers, rows, meta } = await parseStatementFile(req.file.buffer, req.file.originalname);
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
        preview_rows: previewRows(rows, 5),
        total_rows: rows.length,
        file_signature: fileSignature,
        existing_template: existingTemplate || null,
        // Mapeo sugerido por nombres de columna y muestras (primera vez).
        suggested: suggestMapping(headers, rows),
        // Fila de encabezados detectada, periodo del extracto (para fechas
        // sin año) y filas del archivo que no son movimientos.
        meta,
      },
    });
  } catch (error) {
    logger.error('Error en bankImport.controller.js (preview):', error);
    fileError(res, error, 'Error al leer el archivo del extracto');
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

    const { headers, rows, rowNumbers, meta } = await parseStatementFile(req.file.buffer, req.file.originalname);
    if (headers.length === 0) {
      return res.status(400).json({ success: false, message: 'No se pudo leer ninguna columna del archivo' });
    }
    const fileSignature = computeFileSignature(headers);

    let template = await BankImportTemplate.findOne({
      where: { bank_account_id: bankAccount.id, file_signature: fileSignature },
    });

    // "Cambiar mapeo" en el modal: si llega un mapeo nuevo para un formato que
    // ya tenía plantilla, se reemplaza (antes una plantilla mal configurada
    // quedaba para siempre sin forma de corregirla desde la UI).
    if (template && req.body.column_mapping) {
      try {
        const columnMapping = JSON.parse(req.body.column_mapping);
        const amountFormat = JSON.parse(req.body.amount_format || 'null') || template.amount_format;
        if (columnMapping?.fecha) {
          await template.update({
            column_mapping: columnMapping,
            amount_format: amountFormat,
            date_format: req.body.date_format || template.date_format,
          });
        }
      } catch (e) {
        return res.status(400).json({ success: false, message: 'column_mapping / amount_format inválidos (deben ser JSON)' });
      }
    }

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

    const { transactions, errors, skipped } = buildTransactionsFromRows(
      rows,
      template.column_mapping,
      template.amount_format,
      template.date_format,
      { period: meta?.period, rowNumbers }
    );

    // Deduplicación por OCURRENCIAS: un extracto puede traer movimientos
    // idénticos legítimos el mismo día (dos transferencias de 230.000 desde
    // Nequi el 24/06). Antes findOrCreate por (fecha, valor, referencia,
    // descripción) descartaba el segundo como "duplicado" y el saldo no
    // cuadraba. Ahora, por cada combinación, se crean solo las que faltan
    // respecto a las ya guardadas: re-importar el mismo extracto (o uno que
    // se solapa) no duplica, y los repetidos reales sí entran.
    const groups = new Map();
    for (const tx of transactions) {
      const key = [tx.transaction_date, tx.amount, tx.reference ?? '', tx.description ?? ''].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(tx);
    }

    let created = 0;
    let duplicated = 0;
    const t = await sequelize.transaction();
    try {
      for (const list of groups.values()) {
        const sample = list[0];
        // Mismo criterio que el índice único bank_transactions_dedupe_occ_idx
        // (COALESCE de referencia/descripción a '').
        const existingRows = await BankTransaction.findAll({
          where: {
            bank_account_id: bankAccount.id,
            transaction_date: sample.transaction_date,
            amount: sample.amount,
            [Op.and]: [
              sequelize.where(sequelize.fn('COALESCE', sequelize.col('reference'), ''), sample.reference ?? ''),
              sequelize.where(sequelize.fn('COALESCE', sequelize.col('description'), ''), sample.description ?? ''),
            ],
          },
          attributes: ['occurrence'],
          transaction: t,
        });
        const existing = existingRows.length;
        const toCreate = list.slice(Math.min(existing, list.length));
        duplicated += list.length - toCreate.length;
        if (toCreate.length) {
          // Las nuevas ocurrencias siguen a la mayor ya guardada (no al
          // conteo), por si alguna intermedia se borró.
          const maxOccurrence = existingRows.reduce((m, r) => Math.max(m, Number(r.occurrence) || 1), 0);
          await BankTransaction.bulkCreate(
            toCreate.map((tx, i) => ({
              ...tx,
              tenant_id: req.tenant_id,
              bank_account_id: bankAccount.id,
              occurrence: maxOccurrence + i + 1,
            })),
            { transaction: t }
          );
          created += toCreate.length;
        }
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
        skipped_rows: skipped + (meta?.ignored_rows || 0),
        period: meta?.period || null,
        auto_match: autoMatch,
        template_used: { id: template.id, is_new: !req.body.reused_template },
      },
      message: `${created} movimiento(s) importado(s)${duplicated ? `, ${duplicated} ya existían` : ''}${errors.length ? `, ${errors.length} fila(s) con error` : ''}.`,
    });
  } catch (error) {
    logger.error('Error en bankImport.controller.js (runImport):', error);
    fileError(res, error, 'Error al importar el extracto');
  }
});
