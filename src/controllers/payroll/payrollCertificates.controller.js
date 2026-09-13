// backend/src/controllers/payroll/payrollCertificates.controller.js
//
// Certificado de Ingresos y Retenciones anual (mejora #6) — solo lectura,
// no crea ni modifica nada: agrega PayrollDocument ya emitidos y aceptados
// por la DIAN (ver payrollCertificateService.js). Análogo en espíritu a
// payrollDocuments.controller.js (mismo patrón de auth/tenant + PDF
// streaming vs buffer), pero expone datos agregados por AÑO en vez de por
// documento individual.
const { Employee, Tenant } = require('../../models');
const {
  getAnnualCertificateSummary,
  listEmployeesWithCertificates,
} = require('../../services/payroll/payrollCertificateService');
const { generateAnnualCertificatePDF } = require('../../services/payroll/payrollCertificatePdfService');

// El servicio recibe los modelos por parámetro (en vez de importarlos él
// mismo) para no acoplar payrollCertificateService.js a la ruta exacta de
// src/models — mismo motivo por el que payrollService.js tampoco importa
// modelos directamente. Aquí sí los tenemos disponibles vía '../../models'.
const sequelizeModels = require('../../models');

function parseYear(raw) {
  const year = parseInt(raw, 10);
  const currentYear = new Date().getFullYear();
  if (!raw || Number.isNaN(year) || year < 2000 || year > currentYear + 1) {
    return null;
  }
  return year;
}

/**
 * GET /api/payroll/certificates?year=2025
 * Lista los empleados que tienen al menos un PayrollDocument aceptado en el
 * año dado, con el total neto pagado — para la pantalla de "certificados
 * disponibles" (default: año calendario anterior, que es cuando normalmente
 * se piden estos certificados en marzo).
 */
const getAvailableCertificates = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const defaultYear = new Date().getFullYear() - 1;
    const year = parseYear(req.query.year) || defaultYear;

    const rows = await listEmployeesWithCertificates({
      tenant_id: req.user.tenant_id,
      year,
      models: sequelizeModels,
    });

    res.json({ success: true, data: rows, year });
  } catch (error) {
    console.error('Error en getAvailableCertificates:', error);
    res.status(500).json({
      success: false,
      message: 'Error al listar los certificados disponibles',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

/**
 * GET /api/payroll/certificates/:employee_id?year=2025
 * Resumen agregado (JSON) del año para un empleado — usado por el detalle
 * en el frontend antes de descargar el PDF.
 */
const getCertificateSummary = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const year = parseYear(req.query.year);
    if (!year) {
      return res.status(400).json({ success: false, message: 'Parámetro year inválido' });
    }

    const employee = await Employee.findOne({ where: { id: req.params.employee_id, tenant_id: req.user.tenant_id } });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Empleado no encontrado' });
    }

    const summary = await getAnnualCertificateSummary({
      tenant_id: req.user.tenant_id,
      employee_id: employee.id,
      year,
      models: sequelizeModels,
    });

    if (!summary) {
      return res.status(404).json({
        success: false,
        message: `${employee.first_name} ${employee.first_surname} no tiene Documentos Soporte de Pago de Nómina aceptados por la DIAN en ${year}.`,
      });
    }

    // No exponer el arreglo completo de `documents` (instancias Sequelize
    // con snapshot_liquidation crudo) en el JSON de resumen — es carga
    // innecesaria para la pantalla de "ver resumen antes de descargar".
    const { documents, ...summaryWithoutDocs } = summary;

    res.json({ success: true, data: { employee_id: employee.id, employee_name: employee.full_name, ...summaryWithoutDocs } });
  } catch (error) {
    console.error('Error en getCertificateSummary:', error);
    res.status(500).json({
      success: false,
      message: 'Error al calcular el certificado de ingresos y retenciones',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

/**
 * GET /api/payroll/certificates/:employee_id/pdf?year=2025
 * Descarga/streaming del PDF del certificado.
 */
const downloadCertificatePdf = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const year = parseYear(req.query.year);
    if (!year) {
      return res.status(400).json({ success: false, message: 'Parámetro year inválido' });
    }

    const employee = await Employee.findOne({ where: { id: req.params.employee_id, tenant_id: req.user.tenant_id } });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Empleado no encontrado' });
    }

    const summary = await getAnnualCertificateSummary({
      tenant_id: req.user.tenant_id,
      employee_id: employee.id,
      year,
      models: sequelizeModels,
    });

    if (!summary) {
      return res.status(404).json({
        success: false,
        message: `${employee.first_name} ${employee.first_surname} no tiene Documentos Soporte de Pago de Nómina aceptados por la DIAN en ${year}.`,
      });
    }

    const tenant = await Tenant.findByPk(req.user.tenant_id);
    await generateAnnualCertificatePDF(res, { employee, tenant, year, summary });
  } catch (error) {
    console.error('Error en downloadCertificatePdf:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Error al generar el PDF del certificado',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message,
      });
    }
  }
};

module.exports = {
  getAvailableCertificates,
  getCertificateSummary,
  downloadCertificatePdf,
};
