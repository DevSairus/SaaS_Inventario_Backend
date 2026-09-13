// backend/src/controllers/payroll/payrollSettings.controller.js
//
// Un solo registro de configuración por tenant (los porcentajes de recargo
// de horas extra). GET es de lectura libre para cualquiera con acceso al
// módulo de nómina (el formulario de novedades los necesita para
// precargar el campo "Porcentaje"); PUT queda restringido a admin/
// super_admin porque cambia un valor que afecta a toda la liquidación —
// mismo criterio inline que usa branch.js para detectar admin de tenant.
const { PayrollSetting } = require('../../models');

const PERCENTAGE_FIELDS = [
  'heds_percentage', 'hens_percentage', 'hrns_percentage',
  'heddfs_percentage', 'hrddfs_percentage', 'hendfs_percentage', 'hrndfs_percentage',
];

const getPayrollSettings = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const [settings] = await PayrollSetting.findOrCreate({
      where: { tenant_id: req.user.tenant_id },
      defaults: { tenant_id: req.user.tenant_id },
    });

    res.json({ success: true, data: settings });
  } catch (error) {
    console.error('Error en getPayrollSettings:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener la configuración de nómina',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const updatePayrollSettings = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Solo un administrador puede modificar los porcentajes de recargo',
      });
    }

    const updates = {};
    for (const field of PERCENTAGE_FIELDS) {
      if (req.body[field] === undefined) continue;
      const value = Number(req.body[field]);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ success: false, message: `${field} debe ser un número mayor o igual a 0` });
      }
      updates[field] = value;
    }
    updates.updated_by = req.user.id;

    const [settings] = await PayrollSetting.findOrCreate({
      where: { tenant_id: req.user.tenant_id },
      defaults: { tenant_id: req.user.tenant_id },
    });
    await settings.update(updates);

    res.json({ success: true, message: 'Configuración actualizada', data: settings });
  } catch (error) {
    console.error('Error en updatePayrollSettings:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar la configuración de nómina',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

module.exports = { getPayrollSettings, updatePayrollSettings };
