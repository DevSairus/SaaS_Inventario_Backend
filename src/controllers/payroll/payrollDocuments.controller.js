// backend/src/controllers/payroll/payrollDocuments.controller.js
//
// Consulta de Documentos Soporte de Pago de Nómina Electrónica ya emitidos
// (o en curso) — análogo de solo-lectura al de SupportDocument, usado por
// PayrollDocumentsPage.jsx y por la "vista de liquidación" dentro de
// PayrollPeriodsPage.jsx. La EMISIÓN del documento principal sigue viviendo
// en payrollPeriodEmissionService.js (disparada desde
// payrollPeriods.controller.js#changePayrollPeriodStatus).
//
// La Nota de Ajuste (Reemplazar/Eliminar) SÍ se maneja desde aquí
// (createPayrollDocumentAdjustment) — mismo patrón que
// dian.controller.js#createSupportDocumentAdjustment: este controlador crea
// la fila PayrollDocumentAdjustment en su propia transacción y dispara el
// envío a la DIAN fire-and-forget vía payrollAdjustmentService.js.
const { PayrollDocument, PayrollDocumentAdjustment, Employee, PayrollPeriod, Tenant, sequelize } = require('../../models');
const logger = require('../../config/logger');
const { resumenLiquidacionParaImpresion } = require('../../services/payroll/payrollService');
const { sendPayrollAdjustmentToDian } = require('../../services/payroll/payrollAdjustmentService');
const { generatePayrollDocumentPDF } = require('../../services/dian/payrollPdfService');

const employeeInclude = { model: Employee, as: 'employee' };
const periodInclude = { model: PayrollPeriod, as: 'period' };

const getPayrollDocuments = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const tenant_id = req.user.tenant_id;
    const {
      payroll_period_id, employee_id, dian_status, search, page = 1, limit = 20,
    } = req.query;

    const where = { tenant_id };
    if (payroll_period_id) where.payroll_period_id = payroll_period_id;
    if (employee_id) where.employee_id = employee_id;
    if (dian_status) where.dian_status = dian_status;

    const include = [employeeInclude, periodInclude];
    if (search) {
      const { Op } = require('sequelize');
      where[Op.or] = [
        { payroll_document_number: { [Op.iLike]: `%${search}%` } },
        { cune: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const offset = (page - 1) * limit;
    const { count, rows } = await PayrollDocument.findAndCountAll({
      where,
      include,
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    res.json({
      success: true,
      data: rows,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(count / limit),
      },
    });
  } catch (error) {
    console.error('Error en getPayrollDocuments:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener documentos de nómina',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const getPayrollDocumentById = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const doc = await PayrollDocument.findOne({
      where: { id, tenant_id: req.user.tenant_id },
      include: [employeeInclude, periodInclude, { association: 'adjustments' }],
    });
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Documento de nómina no encontrado' });
    }

    const resumen = doc.snapshot_liquidation ? resumenLiquidacionParaImpresion(doc.snapshot_liquidation) : null;

    res.json({ success: true, data: { ...doc.toJSON(), resumen } });
  } catch (error) {
    console.error('Error en getPayrollDocumentById:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener el documento de nómina',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const findDocumentForDownload = async (req) => {
  const { id } = req.params;
  return PayrollDocument.findOne({
    where: { id, tenant_id: req.user.tenant_id },
    include: [employeeInclude, periodInclude],
  });
};

const downloadPayrollDocumentXml = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    const doc = await findDocumentForDownload(req);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Documento de nómina no encontrado' });
    }
    if (!doc.xml_content) {
      return res.status(400).json({ success: false, message: 'Este documento todavía no tiene XML generado (no ha sido emitido)' });
    }

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.payroll_document_number || doc.id}.xml"`);
    res.send(doc.xml_content);
  } catch (error) {
    console.error('Error en downloadPayrollDocumentXml:', error);
    res.status(500).json({
      success: false,
      message: 'Error al descargar el XML del documento de nómina',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const downloadPayrollDocumentPdf = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    const doc = await findDocumentForDownload(req);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Documento de nómina no encontrado' });
    }
    if (!doc.snapshot_liquidation) {
      return res.status(400).json({ success: false, message: 'Este documento todavía no tiene una liquidación generada' });
    }

    const tenant = await Tenant.findByPk(req.user.tenant_id);
    await generatePayrollDocumentPDF(res, doc, doc.employee, doc.period, tenant);
  } catch (error) {
    console.error('Error en downloadPayrollDocumentPdf:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Error al generar el PDF del documento de nómina',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message,
      });
    }
  }
};

/**
 * POST /api/payroll/documents/:id/adjustments
 * Crea una Nota de Ajuste (Reemplazar/Eliminar) sobre un PayrollDocument ya
 * aceptado por la DIAN. Responde de inmediato con la fila en 'pending' —
 * el envío real a la DIAN ocurre fire-and-forget, igual que
 * createSupportDocumentAdjustment; el estado final se consulta luego vía
 * GET /:id (incluye `adjustments`).
 */
const createPayrollDocumentAdjustment = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    if (!req.user) {
      await transaction.rollback();
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const { adjustment_type, reason } = req.body;

    if (!['replace', 'delete'].includes(adjustment_type)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: "adjustment_type debe ser 'replace' o 'delete'" });
    }
    if (!reason) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El motivo (reason) es obligatorio' });
    }

    const payrollDocument = await PayrollDocument.findOne({
      where: { id, tenant_id: req.user.tenant_id },
      include: [employeeInclude, periodInclude],
      transaction,
    });
    if (!payrollDocument) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Documento de nómina no encontrado' });
    }
    if (payrollDocument.dian_status !== 'accepted' || !payrollDocument.cune) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'El Documento Soporte de Pago de Nómina debe estar aceptado por la DIAN antes de generar una Nota de Ajuste.',
      });
    }

    const adjustment = await PayrollDocumentAdjustment.create({
      tenant_id: req.user.tenant_id,
      payroll_document_id: payrollDocument.id,
      adjustment_type,
      reason,
      dian_status: 'pending',
      created_by: req.user.id,
    }, { transaction });

    await transaction.commit();

    const tenant = await Tenant.findByPk(req.user.tenant_id);

    setImmediate(async () => {
      try {
        await sendPayrollAdjustmentToDian(adjustment, payrollDocument, tenant);
        logger.info(`[Nómina] Nota de Ajuste creada para PayrollDocument ${payrollDocument.id}`);
      } catch (err) {
        logger.error(`[Nómina] Error enviando Nota de Ajuste de ${payrollDocument.id}:`, err.message);
      }
    });

    res.status(201).json({
      success: true,
      message: 'Nota de Ajuste creada. Envío a DIAN en proceso.',
      data: adjustment,
    });
  } catch (error) {
    if (transaction && !transaction.finished) await transaction.rollback();
    console.error('Error en createPayrollDocumentAdjustment:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear la Nota de Ajuste',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

module.exports = {
  getPayrollDocuments,
  getPayrollDocumentById,
  downloadPayrollDocumentXml,
  downloadPayrollDocumentPdf,
  createPayrollDocumentAdjustment,
};
