const { PayrollConcept } = require('../../models');
const { Op } = require('sequelize');
const { DIAN_CATEGORY_MAP } = require('../../services/payroll/payrollService');

// auto_apply solo tiene sentido para categorías DIAN de "valor simple"
// (kind 'single'/'simpleList' en DIAN_CATEGORY_MAP -- Dotación, Comisiones,
// Retención en la fuente, etc.) porque su payload es un número plano. Las
// categorías de arreglo/objeto (horas extra, incapacidades, vacaciones...)
// necesitan campos que un cálculo automático no puede inventar solo
// (fechas, horas, subtipo) — esas se quedan como novedad manual, ver
// PayrollNovedadModal.jsx / NOVEDAD_FIELD_SCHEMAS en el frontend.
function validateAutoApply({ auto_apply, calculation_type, dian_category }) {
  if (!auto_apply) return null;
  if (!['fixed', 'percentage'].includes(calculation_type)) {
    return 'Un concepto automático debe ser de tipo "fijo" o "porcentaje" (no "manual" ni "fórmula")';
  }
  const mapping = DIAN_CATEGORY_MAP[dian_category];
  if (!mapping || !['single', 'simpleList'].includes(mapping.kind)) {
    return `La categoría DIAN "${dian_category}" no admite valor simple, así que no puede ser un concepto automático — desactive "auto_apply" y capture esto como novedad manual`;
  }
  return null;
}

const getPayrollConcepts = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const tenant_id = req.user.tenant_id;
    const { search = '', concept_type, is_active, sort_by = 'sort_order', sort_order = 'ASC' } = req.query;

    const where = { tenant_id };
    if (search) {
      where[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { code: { [Op.iLike]: `%${search}%` } },
      ];
    }
    if (concept_type) where.concept_type = concept_type;
    if (is_active !== undefined && is_active !== '') where.is_active = is_active === 'true';

    const concepts = await PayrollConcept.findAll({
      where,
      order: [[sort_by, sort_order.toUpperCase()], ['name', 'ASC']],
    });

    res.json({ success: true, data: concepts });
  } catch (error) {
    console.error('Error en getPayrollConcepts:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener conceptos de nómina',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const getPayrollConceptById = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const concept = await PayrollConcept.findOne({ where: { id, tenant_id: req.user.tenant_id } });
    if (!concept) {
      return res.status(404).json({ success: false, message: 'Concepto no encontrado' });
    }

    res.json({ success: true, data: concept });
  } catch (error) {
    console.error('Error en getPayrollConceptById:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener concepto',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const createPayrollConcept = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const tenant_id = req.user.tenant_id;
    const {
      code,
      name,
      concept_type,
      dian_category = 'Otros',
      dian_code,
      calculation_type = 'manual',
      default_value = 0,
      auto_apply = false,
      is_active = true,
      sort_order = 0,
      notes,
    } = req.body;

    if (!code || !name || !concept_type) {
      return res.status(400).json({
        success: false,
        message: 'Código, nombre y tipo (devengado/deducción) son requeridos',
      });
    }

    const autoApplyError = validateAutoApply({ auto_apply, calculation_type, dian_category });
    if (autoApplyError) {
      return res.status(400).json({ success: false, message: autoApplyError });
    }

    const existing = await PayrollConcept.findOne({ where: { tenant_id, code } });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Ya existe un concepto con ese código' });
    }

    const concept = await PayrollConcept.create({
      tenant_id,
      code,
      name,
      concept_type,
      dian_category,
      dian_code: dian_code || null,
      calculation_type,
      default_value,
      auto_apply,
      is_active,
      sort_order,
      notes: notes || null,
    });

    res.status(201).json({ success: true, message: 'Concepto creado exitosamente', data: concept });
  } catch (error) {
    console.error('Error en createPayrollConcept:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear concepto',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const updatePayrollConcept = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const updateData = { ...req.body };

    const concept = await PayrollConcept.findOne({ where: { id, tenant_id } });
    if (!concept) {
      return res.status(404).json({ success: false, message: 'Concepto no encontrado' });
    }

    if (updateData.code && updateData.code !== concept.code) {
      const duplicate = await PayrollConcept.findOne({
        where: { tenant_id, code: updateData.code, id: { [Op.ne]: id } },
      });
      if (duplicate) {
        return res.status(400).json({ success: false, message: 'Ya existe un concepto con ese código' });
      }
    }

    ['tenant_id', 'code', 'name', 'concept_type'].forEach((field) => {
      if (updateData[field] === '' || updateData[field] === undefined || updateData[field] === null) {
        delete updateData[field];
      }
    });
    ['dian_code', 'notes'].forEach((field) => {
      if (updateData[field] === '') updateData[field] = null;
    });
    Object.keys(updateData).forEach((key) => {
      if (updateData[key] === undefined) delete updateData[key];
    });

    // Se valida el estado RESULTANTE (lo ya guardado + lo que llega en este
    // PATCH), porque un update puede mandar solo `auto_apply: true` sin
    // repetir dian_category/calculation_type.
    const autoApplyError = validateAutoApply({
      auto_apply: updateData.auto_apply ?? concept.auto_apply,
      calculation_type: updateData.calculation_type ?? concept.calculation_type,
      dian_category: updateData.dian_category ?? concept.dian_category,
    });
    if (autoApplyError) {
      return res.status(400).json({ success: false, message: autoApplyError });
    }

    await concept.update(updateData);
    res.json({ success: true, message: 'Concepto actualizado exitosamente', data: concept });
  } catch (error) {
    console.error('Error en updatePayrollConcept:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar concepto',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const deactivatePayrollConcept = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const concept = await PayrollConcept.findOne({ where: { id, tenant_id: req.user.tenant_id } });
    if (!concept) {
      return res.status(404).json({ success: false, message: 'Concepto no encontrado' });
    }

    await concept.update({ is_active: false });
    res.json({ success: true, message: 'Concepto desactivado exitosamente' });
  } catch (error) {
    console.error('Error en deactivatePayrollConcept:', error);
    res.status(500).json({
      success: false,
      message: 'Error al desactivar concepto',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const activatePayrollConcept = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const concept = await PayrollConcept.findOne({ where: { id, tenant_id: req.user.tenant_id } });
    if (!concept) {
      return res.status(404).json({ success: false, message: 'Concepto no encontrado' });
    }

    await concept.update({ is_active: true });
    res.json({ success: true, message: 'Concepto activado exitosamente' });
  } catch (error) {
    console.error('Error en activatePayrollConcept:', error);
    res.status(500).json({
      success: false,
      message: 'Error al activar concepto',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const deletePayrollConcept = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const concept = await PayrollConcept.findOne({ where: { id, tenant_id: req.user.tenant_id } });
    if (!concept) {
      return res.status(404).json({ success: false, message: 'Concepto no encontrado' });
    }

    // NOTA: cuando exista el detalle de liquidación (Fase 2), validar aquí
    // que el concepto no esté en uso en documentos ya emitidos antes de
    // permitir el borrado físico -- por ahora solo protege el catálogo.
    await concept.destroy();
    res.json({ success: true, message: 'Concepto eliminado exitosamente' });
  } catch (error) {
    console.error('Error en deletePayrollConcept:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar concepto',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

module.exports = {
  getPayrollConcepts,
  getPayrollConceptById,
  createPayrollConcept,
  updatePayrollConcept,
  deactivatePayrollConcept,
  activatePayrollConcept,
  deletePayrollConcept,
};
