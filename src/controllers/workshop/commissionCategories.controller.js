// backend/src/controllers/workshop/commissionCategories.controller.js
//
// Panel "Comisiones > Categorías" -- configuración (una vez por tenant) de
// las categorías de comisión de mano de obra, sus overrides por técnico, y
// el mapeo desde diagram_templates.system -- ver
// 00 - Documentación/plan-comisiones-tecnicos-por-sistema.md sección 4.1.

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const {
  CommissionCategory,
  TechnicianCommissionRate,
  DiagramSystemCommissionMap,
  DiagramTemplate,
  User,
} = require('../../models');
const logger = require('../../config/logger');

// ── CATEGORÍAS ────────────────────────────────────────────────────────────────

const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { include_inactive = 'false' } = req.query;
    const where = { tenant_id };
    if (include_inactive !== 'true') where.is_active = true;

    const categories = await CommissionCategory.findAll({
      where,
      include: [{
        model: TechnicianCommissionRate, as: 'technician_rates',
        include: [{ model: User, as: 'technician', attributes: ['id', 'first_name', 'last_name'] }],
      }],
      order: [['is_default', 'ASC'], ['name', 'ASC']],
    });
    res.json({ success: true, data: categories });
  } catch (error) {
    logger.error('Error listando categorías de comisión:', error);
    res.status(500).json({ success: false, message: 'Error al obtener categorías de comisión' });
  }
};

const create = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { name, code, default_percentage } = req.body;
    if (!name || !name.trim())
      return res.status(400).json({ success: false, message: 'El nombre es requerido' });

    const category = await CommissionCategory.create({
      tenant_id,
      name: name.trim(),
      code: code ? code.trim() : null,
      default_percentage: parseFloat(default_percentage) || 0,
    });
    res.status(201).json({ success: true, message: 'Categoría creada', data: category });
  } catch (error) {
    logger.error('Error creando categoría de comisión:', error);
    res.status(500).json({ success: false, message: 'Error al crear la categoría' });
  }
};

const update = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const category = await CommissionCategory.findOne({ where: { id: req.params.id, tenant_id } });
    if (!category) return res.status(404).json({ success: false, message: 'Categoría no encontrada' });

    const { name, code, default_percentage, is_active } = req.body;
    await category.update({
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(code !== undefined ? { code: code ? code.trim() : null } : {}),
      ...(default_percentage !== undefined ? { default_percentage: parseFloat(default_percentage) || 0 } : {}),
      // La categoría "Otros" (is_default) es el fallback obligatorio del
      // tenant -- no se puede desactivar, o quedarían ítems sin categoría
      // resoluble (ver sección 5, punto 4 del plan).
      ...(is_active !== undefined && !category.is_default ? { is_active: !!is_active } : {}),
    });
    res.json({ success: true, message: 'Categoría actualizada', data: category });
  } catch (error) {
    logger.error('Error actualizando categoría de comisión:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la categoría' });
  }
};

const remove = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const category = await CommissionCategory.findOne({ where: { id: req.params.id, tenant_id } });
    if (!category) return res.status(404).json({ success: false, message: 'Categoría no encontrada' });
    if (category.is_default)
      return res.status(400).json({ success: false, message: 'No se puede eliminar la categoría "Otros" (es el fallback del taller)' });

    await category.destroy();
    res.json({ success: true, message: 'Categoría eliminada' });
  } catch (error) {
    logger.error('Error eliminando categoría de comisión:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar la categoría' });
  }
};

// ── OVERRIDES POR TÉCNICO ───────────────────────────────────────────────────
// Reemplazo simple estilo "guardar tabla completa": el admin ve una fila por
// técnico con un input de %, y guarda todo de una vez.

const setTechnicianRates = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const category = await CommissionCategory.findOne({ where: { id: req.params.id, tenant_id }, transaction });
    if (!category) { await transaction.rollback(); return res.status(404).json({ success: false, message: 'Categoría no encontrada' }); }

    const { rates } = req.body; // [{ technician_id, percentage }] — percentage null/'' = quitar override
    if (!Array.isArray(rates)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'rates debe ser un arreglo' });
    }

    for (const r of rates) {
      if (!r.technician_id) continue;
      if (r.percentage === null || r.percentage === '' || r.percentage === undefined) {
        await TechnicianCommissionRate.destroy({
          where: { tenant_id, technician_id: r.technician_id, commission_category_id: category.id },
          transaction,
        });
        continue;
      }
      const [rate] = await TechnicianCommissionRate.findOrCreate({
        where: { tenant_id, technician_id: r.technician_id, commission_category_id: category.id },
        defaults: { percentage: parseFloat(r.percentage) },
        transaction,
      });
      if (parseFloat(rate.percentage) !== parseFloat(r.percentage)) {
        await rate.update({ percentage: parseFloat(r.percentage) }, { transaction });
      }
    }

    await transaction.commit();

    const full = await CommissionCategory.findByPk(category.id, {
      include: [{
        model: TechnicianCommissionRate, as: 'technician_rates',
        include: [{ model: User, as: 'technician', attributes: ['id', 'first_name', 'last_name'] }],
      }],
    });
    res.json({ success: true, message: 'Tarifas por técnico actualizadas', data: full });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error actualizando tarifas por técnico:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar tarifas por técnico' });
  }
};

// ── MAPEO DESDE DIAGRAMAS ────────────────────────────────────────────────────

// Sistemas distintos ya usados en la biblioteca de diagramas (global + del
// tenant), para poblar el selector del panel sin inventar una lista aparte.
const listDiagramSystems = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const rows = await DiagramTemplate.findAll({
      where: { [Op.or]: [{ tenant_id }, { tenant_id: null }] },
      attributes: [[sequelize.fn('DISTINCT', sequelize.col('system')), 'system']],
      order: [['system', 'ASC']],
      raw: true,
    });
    res.json({ success: true, data: rows.map(r => r.system) });
  } catch (error) {
    logger.error('Error listando sistemas de diagrama:', error);
    res.status(500).json({ success: false, message: 'Error al obtener sistemas de diagrama' });
  }
};

const listDiagramMappings = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const mappings = await DiagramSystemCommissionMap.findAll({
      where: { tenant_id },
      include: [{ model: CommissionCategory, as: 'category', attributes: ['id', 'name'] }],
      order: [['system', 'ASC']],
    });
    res.json({ success: true, data: mappings });
  } catch (error) {
    logger.error('Error listando mapeo de diagramas:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el mapeo de diagramas' });
  }
};

const setDiagramMappings = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const { mappings } = req.body; // [{ system, commission_category_id }]
    if (!Array.isArray(mappings)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'mappings debe ser un arreglo' });
    }

    for (const m of mappings) {
      if (!m.system) continue;
      if (!m.commission_category_id) {
        await DiagramSystemCommissionMap.destroy({ where: { tenant_id, system: m.system }, transaction });
        continue;
      }
      const category = await CommissionCategory.findOne({ where: { id: m.commission_category_id, tenant_id }, transaction });
      if (!category) continue; // categoría inválida/de otro tenant -- se ignora silenciosamente

      const [row] = await DiagramSystemCommissionMap.findOrCreate({
        where: { tenant_id, system: m.system },
        defaults: { commission_category_id: category.id },
        transaction,
      });
      if (row.commission_category_id !== category.id) {
        await row.update({ commission_category_id: category.id }, { transaction });
      }
    }

    await transaction.commit();
    const full = await DiagramSystemCommissionMap.findAll({
      where: { tenant_id },
      include: [{ model: CommissionCategory, as: 'category', attributes: ['id', 'name'] }],
      order: [['system', 'ASC']],
    });
    res.json({ success: true, message: 'Mapeo de diagramas actualizado', data: full });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error actualizando mapeo de diagramas:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar el mapeo de diagramas' });
  }
};

module.exports = {
  list, create, update, remove,
  setTechnicianRates,
  listDiagramSystems, listDiagramMappings, setDiagramMappings,
};
