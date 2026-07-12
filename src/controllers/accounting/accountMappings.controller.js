const { AccountMapping, ChartOfAccount, AccountMappingAudit } = require('../../models');
const logger = require('../../config/logger');

// GET /api/accounting/account-mappings
exports.list = async (req, res) => {
  try {
    const mappings = await AccountMapping.findAll({
      where: { tenant_id: req.tenant_id },
      include: [{ model: ChartOfAccount, as: 'account' }],
      order: [['event_type', 'ASC']],
    });
    res.json({ success: true, data: mappings });
  } catch (error) {
    logger.error('Error en accountMappings.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al listar mapeos', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// PUT /api/accounting/account-mappings/:event_type — upsert
exports.upsert = async (req, res) => {
  try {
    const { event_type } = req.params;
    const { account_id } = req.body;
    if (!account_id) return res.status(400).json({ success: false, message: 'account_id es obligatorio' });

    const account = await ChartOfAccount.findOne({ where: { id: account_id, tenant_id: req.tenant_id } });
    if (!account) return res.status(404).json({ success: false, message: 'Cuenta no encontrada' });
    if (!account.accepts_entries) {
      return res.status(400).json({ success: false, message: 'Esa cuenta es una cuenta agrupadora (no recibe movimientos directos), elige una subcuenta' });
    }

    const [mapping, wasCreated] = await AccountMapping.findOrCreate({
      where: { tenant_id: req.tenant_id, event_type },
      defaults: { account_id },
    });

    // 4.2 del análisis contable: dejar rastro de quién cambió qué cuenta
    // mapeaba a qué evento. Se audita tanto la creación inicial (con
    // previous_account_id en null) como cada cambio posterior.
    if (wasCreated) {
      await AccountMappingAudit.create({
        tenant_id: req.tenant_id,
        event_type,
        previous_account_id: null,
        new_account_id: account_id,
        changed_by: req.user?.id || null,
      });
    } else if (mapping.account_id !== account_id) {
      const previousAccountId = mapping.account_id;
      await mapping.update({ account_id });
      await AccountMappingAudit.create({
        tenant_id: req.tenant_id,
        event_type,
        previous_account_id: previousAccountId,
        new_account_id: account_id,
        changed_by: req.user?.id || null,
      });
    }

    res.json({ success: true, data: mapping });
  } catch (error) {
    logger.error('Error en accountMappings.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar mapeo', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// POST /api/accounting/account-mappings — crear un tipo de evento personalizado
// (los tipos predefinidos vienen del catálogo fijo del frontend; este endpoint
// permite agregar tipos nuevos no contemplados, ej. una categoría de gasto o
// un evento propio del negocio que aún no tiene mapeo).
exports.create = async (req, res) => {
  try {
    const { event_type, label, category, account_id } = req.body;
    if (!event_type || !label || !account_id) {
      return res.status(400).json({ success: false, message: 'event_type, label y account_id son obligatorios' });
    }
    if (!/^[a-z0-9_:]+$/.test(event_type)) {
      return res.status(400).json({ success: false, message: 'event_type solo puede tener minúsculas, números, "_" y ":"' });
    }

    const existing = await AccountMapping.findOne({ where: { tenant_id: req.tenant_id, event_type } });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Ya existe un mapeo para ese tipo de evento' });
    }

    const account = await ChartOfAccount.findOne({ where: { id: account_id, tenant_id: req.tenant_id } });
    if (!account) return res.status(404).json({ success: false, message: 'Cuenta no encontrada' });
    if (!account.accepts_entries) {
      return res.status(400).json({ success: false, message: 'Esa cuenta es una cuenta agrupadora (no recibe movimientos directos), elige una subcuenta' });
    }

    const mapping = await AccountMapping.create({
      tenant_id: req.tenant_id,
      event_type,
      label,
      category: category || 'Personalizado',
      is_custom: true,
      account_id,
    });

    await AccountMappingAudit.create({
      tenant_id: req.tenant_id,
      event_type,
      previous_account_id: null,
      new_account_id: account_id,
      changed_by: req.user?.id || null,
    });

    res.status(201).json({ success: true, data: mapping });
  } catch (error) {
    logger.error('Error en accountMappings.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al crear el tipo de mapeo', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// DELETE /api/accounting/account-mappings/:event_type — solo tipos personalizados
exports.remove = async (req, res) => {
  try {
    const { event_type } = req.params;
    const mapping = await AccountMapping.findOne({ where: { tenant_id: req.tenant_id, event_type } });
    if (!mapping) return res.status(404).json({ success: false, message: 'Mapeo no encontrado' });
    if (!mapping.is_custom) {
      return res.status(400).json({ success: false, message: 'Los tipos predefinidos no se pueden eliminar, solo dejarlos sin asignar' });
    }

    await mapping.destroy();
    res.json({ success: true, message: 'Tipo de mapeo eliminado' });
  } catch (error) {
    logger.error('Error en accountMappings.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar el tipo de mapeo', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// GET /api/accounting/account-mappings/:event_type/audit
exports.auditHistory = async (req, res) => {
  try {
    const { event_type } = req.params;
    const { User } = require('../../models');
    const history = await AccountMappingAudit.findAll({
      where: { tenant_id: req.tenant_id, event_type },
      include: [
        { model: ChartOfAccount, as: 'previous_account', attributes: ['id', 'code', 'name'] },
        { model: ChartOfAccount, as: 'new_account', attributes: ['id', 'code', 'name'] },
        { model: User, as: 'changed_by_user', attributes: ['id', 'first_name', 'last_name', 'email'] },
      ],
      order: [['created_at', 'DESC']],
    });
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('Error en accountMappings.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al consultar historial de mapeo', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};
