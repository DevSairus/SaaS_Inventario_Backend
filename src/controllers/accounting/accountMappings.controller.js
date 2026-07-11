const { AccountMapping, ChartOfAccount } = require('../../models');

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
    res.status(500).json({ success: false, message: 'Error al listar mapeos', error: error.message });
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

    const [mapping] = await AccountMapping.findOrCreate({
      where: { tenant_id: req.tenant_id, event_type },
      defaults: { account_id },
    });
    if (mapping.account_id !== account_id) {
      await mapping.update({ account_id });
    }

    res.json({ success: true, data: mapping });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al actualizar mapeo', error: error.message });
  }
};
