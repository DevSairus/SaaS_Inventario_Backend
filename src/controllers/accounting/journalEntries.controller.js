const { JournalEntry, JournalEntryLine, ChartOfAccount } = require('../../models');
const { createDraftEntry, postEntry, voidEntry, reverseEntry } = require('../../services/accounting/journalEntry.service');

// GET /api/accounting/journal-entries?status=&source_type=&from=&to=&branch_id=
exports.list = async (req, res) => {
  try {
    const { status, source_type, from, to, branch_id } = req.query;
    const where = { tenant_id: req.tenant_id };
    if (status) where.status = status;
    if (source_type) where.source_type = source_type;
    // branch_id ausente = todas las sedes. branch_id=null (string) permite
    // filtrar explícitamente los asientos sin sede asignada (ajustes globales).
    if (branch_id) where.branch_id = branch_id === 'null' ? null : branch_id;
    if (from || to) {
      const { Op } = require('sequelize');
      where.entry_date = {};
      if (from) where.entry_date[Op.gte] = from;
      if (to) where.entry_date[Op.lte] = to;
    }

    const entries = await JournalEntry.findAll({
      where,
      order: [['entry_date', 'DESC'], ['entry_number', 'DESC']],
      limit: 200,
    });

    res.json({ success: true, data: entries });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al listar asientos', error: error.message });
  }
};

// GET /api/accounting/journal-entries/:id
exports.getById = async (req, res) => {
  try {
    const entry = await JournalEntry.findOne({
      where: { id: req.params.id, tenant_id: req.tenant_id },
      include: [{ model: JournalEntryLine, as: 'lines', include: [{ model: ChartOfAccount, as: 'account' }] }],
    });
    if (!entry) return res.status(404).json({ success: false, message: 'Asiento no encontrado' });
    res.json({ success: true, data: entry });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al obtener asiento', error: error.message });
  }
};

// POST /api/accounting/journal-entries — asiento manual
exports.create = async (req, res) => {
  const { sequelize } = require('../../config/database');
  const t = await sequelize.transaction();
  try {
    const { entry_date, description, lines, branch_id } = req.body;
    if (!entry_date || !Array.isArray(lines)) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'entry_date y lines son obligatorios' });
    }

    const entry = await createDraftEntry(
      req.tenant_id,
      {
        branchId: branch_id || req.branch_id || null,
        entryDate: entry_date,
        sourceType: 'manual',
        sourceId: null,
        description,
        lines,
        createdBy: req.user?.id,
      },
      t
    );

    await t.commit();
    res.status(201).json({ success: true, data: entry });
  } catch (error) {
    await t.rollback();
    res.status(400).json({ success: false, message: error.message });
  }
};

// PATCH /api/accounting/journal-entries/:id/post
exports.post = async (req, res) => {
  try {
    const entry = await postEntry(req.params.id, req.tenant_id, req.user?.id);
    res.json({ success: true, data: entry });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// PATCH /api/accounting/journal-entries/:id/void
exports.void = async (req, res) => {
  try {
    const entry = await voidEntry(req.params.id, req.tenant_id, req.user?.id, req.body?.reason);
    res.json({ success: true, data: entry });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// PATCH /api/accounting/journal-entries/:id/reverse
// Corrige un asiento ya posteado sin editarlo ni anularlo: si está en draft
// simplemente se anula (nadie lo revisó, no afectó reportes); si ya está
// posted se crea un asiento nuevo con débito/crédito invertidos y se enlazan
// entre sí. Útil para correcciones manuales de asientos manuales o
// automáticos que ya no reflejan la realidad del negocio.
exports.reverse = async (req, res) => {
  const { sequelize } = require('../../config/database');
  const t = await sequelize.transaction();
  try {
    const result = await reverseEntry(req.params.id, req.tenant_id, req.user?.id, req.body?.reason, t);
    await t.commit();
    res.json({ success: true, data: result });
  } catch (error) {
    await t.rollback();
    res.status(400).json({ success: false, message: error.message });
  }
};
