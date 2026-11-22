const { ChartOfAccount, JournalEntryLine } = require('../../models');
const logger = require('../../config/logger');
const { sequelize } = require('../../config/database');
const { NIIF_RUBROS, resolveRubros, isRubroValidForType, RUBRO_BY_CODE } = require('../../data/niifRubros');

// niif_rubro del body: '' / null = quitar (vuelve a heredado/regla).
// Devuelve { value } o { error }.
function parseNiifRubro(raw, accountType) {
  if (raw === undefined) return { skip: true };
  if (raw === null || raw === '') return { value: null };
  if (!RUBRO_BY_CODE[raw]) return { error: `Rubro NIIF desconocido: ${raw}` };
  if (!isRubroValidForType(raw, accountType)) {
    return { error: `El rubro "${RUBRO_BY_CODE[raw].label}" no aplica a una cuenta de tipo ${accountType}` };
  }
  return { value: raw };
}

// GET /api/accounting/chart-of-accounts
exports.list = async (req, res) => {
  try {
    const accounts = await ChartOfAccount.findAll({
      where: { tenant_id: req.tenant_id },
      order: [['code', 'ASC']],
    });
    // Rubro NIIF efectivo de cada cuenta (propio, heredado o por regla PUC).
    const rubros = resolveRubros(accounts.map((a) => a.get({ plain: true })));
    const data = accounts.map((a) => {
      const r = rubros.get(a.id);
      return { ...a.get({ plain: true }), niif_rubro_effective: r.rubro, niif_rubro_source: r.source };
    });
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error en chartOfAccounts.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al listar plan de cuentas', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// POST /api/accounting/chart-of-accounts
exports.create = async (req, res) => {
  try {
    const { code, name, account_type, parent_id, accepts_entries } = req.body;
    if (!code || !name || !account_type) {
      return res.status(400).json({ success: false, message: 'code, name y account_type son obligatorios' });
    }
    const rubro = parseNiifRubro(req.body.niif_rubro, account_type);
    if (rubro.error) return res.status(400).json({ success: false, message: rubro.error });

    let level = 1;
    if (parent_id) {
      const parent = await ChartOfAccount.findOne({ where: { id: parent_id, tenant_id: req.tenant_id } });
      if (!parent) return res.status(404).json({ success: false, message: 'Cuenta padre no encontrada' });
      level = parent.level + 1;
    }

    const account = await ChartOfAccount.create({
      tenant_id: req.tenant_id,
      code,
      name,
      account_type,
      parent_id: parent_id || null,
      level,
      accepts_entries: accepts_entries !== undefined ? accepts_entries : true,
      niif_rubro: rubro.skip ? null : rubro.value,
    });

    res.status(201).json({ success: true, data: account });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'Ya existe una cuenta con ese código' });
    }
    logger.error('Error en chartOfAccounts.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al crear cuenta', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// PUT /api/accounting/chart-of-accounts/:id
exports.update = async (req, res) => {
  try {
    const account = await ChartOfAccount.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!account) return res.status(404).json({ success: false, message: 'Cuenta no encontrada' });

    const { name, is_active, accepts_entries, parent_id } = req.body;
    const updates = {
      name: name ?? account.name,
      is_active: is_active !== undefined ? is_active : account.is_active,
      accepts_entries: accepts_entries !== undefined ? accepts_entries : account.accepts_entries,
    };
    const rubro = parseNiifRubro(req.body.niif_rubro, account.account_type);
    if (rubro.error) return res.status(400).json({ success: false, message: rubro.error });
    if (!rubro.skip) updates.niif_rubro = rubro.value;

    // Cambiar la cuenta padre (p. ej. una 415595 creada colgando de 41 en vez
    // de 4155). El nivel de la cuenta y de toda su descendencia se recalcula.
    // El padre debe ser del mismo tipo, agrupador, y no puede ser la misma
    // cuenta ni una de sus subcuentas.
    let levelDelta = 0;
    if (parent_id !== undefined && (parent_id || null) !== (account.parent_id || null)) {
      let newLevel = 1;
      if (parent_id) {
        const parent = await ChartOfAccount.findOne({ where: { id: parent_id, tenant_id: req.tenant_id } });
        if (!parent) return res.status(404).json({ success: false, message: 'Cuenta padre no encontrada' });
        if (parent.account_type !== account.account_type) {
          return res.status(400).json({ success: false, message: `La cuenta padre debe ser de tipo ${account.account_type}` });
        }
        if (!String(account.code).startsWith(String(parent.code))) {
          return res.status(400).json({ success: false, message: `El código ${account.code} no empieza por el de la cuenta padre ${parent.code}` });
        }
        // Ciclos: el nuevo padre no puede estar debajo de esta cuenta.
        for (let cur = parent; cur; cur = cur.parent_id ? await ChartOfAccount.findByPk(cur.parent_id) : null) {
          if (cur.id === account.id) return res.status(400).json({ success: false, message: 'La cuenta padre no puede ser una de sus propias subcuentas' });
        }
        if (parent.accepts_entries) {
          if (await JournalEntryLine.count({ where: { account_id: parent.id } })) {
            return res.status(400).json({ success: false, message: `La cuenta ${parent.code} tiene movimientos: muévelos a una subcuenta (Migración de Cuentas) antes de usarla como agrupadora` });
          }
          await parent.update({ accepts_entries: false });
        }
        newLevel = parent.level + 1;
      }
      levelDelta = newLevel - account.level;
      updates.parent_id = parent_id || null;
      updates.level = newLevel;
    }

    await sequelize.transaction(async (transaction) => {
      await account.update(updates, { transaction });
      if (levelDelta) {
        // Descendientes: mismo desplazamiento de nivel.
        let frontier = [account.id];
        while (frontier.length) {
          const children = await ChartOfAccount.findAll({ where: { tenant_id: req.tenant_id, parent_id: frontier }, transaction });
          for (const c of children) await c.update({ level: c.level + levelDelta }, { transaction });
          frontier = children.map((c) => c.id);
        }
      }
    });

    res.json({ success: true, data: account });
  } catch (error) {
    logger.error('Error en chartOfAccounts.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar cuenta', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// DELETE /api/accounting/chart-of-accounts/:id
exports.remove = async (req, res) => {
  try {
    const account = await ChartOfAccount.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!account) return res.status(404).json({ success: false, message: 'Cuenta no encontrada' });

    const hasMovements = await JournalEntryLine.count({ where: { account_id: account.id } });
    if (hasMovements > 0) {
      return res.status(409).json({ success: false, message: 'No se puede eliminar: la cuenta ya tiene movimientos contables. Desactívala en su lugar.' });
    }

    const hasChildren = await ChartOfAccount.count({ where: { parent_id: account.id } });
    if (hasChildren > 0) {
      return res.status(409).json({ success: false, message: 'No se puede eliminar: tiene subcuentas asociadas' });
    }

    await account.destroy();
    res.json({ success: true, message: 'Cuenta eliminada' });
  } catch (error) {
    logger.error('Error en chartOfAccounts.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar cuenta', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// GET /api/accounting/chart-of-accounts/niif-rubros
// Catálogo de rubros NIIF para Pymes (para el selector del plan de cuentas).
exports.niifRubros = async (req, res) => {
  const types = ['activo', 'pasivo', 'patrimonio', 'ingreso', 'gasto', 'costo'];
  res.json({
    success: true,
    data: NIIF_RUBROS.map((r) => ({ ...r, account_types: types.filter((t) => isRubroValidForType(r.code, t)) })),
  });
};
