const { JournalEntry, JournalEntryLine, ChartOfAccount } = require('../../models');
const { createDraftEntry, updateDraftEntry, postEntry, voidEntry, reverseEntry } = require('../../services/accounting/journalEntry.service');
const logger = require('../../config/logger');
const { entryThirdParties, resolveThirdParties, searchThirdParties } = require('../../services/accounting/thirdParty.service');
const { parsePagination, buildPagination } = require('../../utils/pagination');

// GET /api/accounting/journal-entries?status=&source_type=&from=&to=&branch_id=&third_party_id=&q=&page=&limit=
exports.list = async (req, res) => {
  try {
    const { Op } = require('sequelize');
    const { status, source_type, from, to, branch_id, third_party_id, q } = req.query;
    const where = { tenant_id: req.tenant_id };
    if (status) where.status = status;
    if (source_type) where.source_type = source_type;
    // branch_id ausente = todas las sedes. branch_id=null (string) permite
    // filtrar explícitamente los asientos sin sede asignada (ajustes globales).
    if (branch_id) where.branch_id = branch_id === 'null' ? null : branch_id;
    if (third_party_id) {
      const lines = await JournalEntryLine.findAll({
        where: { third_party_id },
        attributes: ['entry_id'],
        group: ['entry_id'],
        raw: true,
      });
      where.id = { [Op.in]: lines.map(l => l.entry_id) };
    }
    if (q && String(q).trim()) {
      const term = `%${String(q).trim()}%`;
      const num = parseInt(String(q).replace(/\D/g, ''), 10);
      where[Op.or] = [
        { description: { [Op.iLike]: term } },
        ...(Number.isFinite(num) ? [{ entry_number: num }] : []),
      ];
    }
    if (from || to) {
      where.entry_date = {};
      if (from) where.entry_date[Op.gte] = from;
      if (to) where.entry_date[Op.lte] = to;
    }

    const pg = parsePagination(req.query);
    const { rows: entries, count } = await JournalEntry.findAndCountAll({
      where,
      order: [['entry_date', 'DESC'], ['entry_number', 'DESC']],
      limit: pg.limit,
      offset: pg.offset,
    });

    // Tercero principal de cada asiento (cliente / proveedor / empleado)
    const tpMap = await entryThirdParties(entries.map(e => e.id));
    const data = entries.map(e => ({ ...e.toJSON(), third_party: tpMap.get(e.id) || null }));

    res.json({ success: true, data, pagination: buildPagination(pg, count) });
  } catch (error) {
    logger.error('Error en journalEntries.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al listar asientos', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
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
    const json = entry.toJSON();
    const tpMap = await resolveThirdParties((json.lines || []).map(l => l.third_party_id));
    json.lines = (json.lines || [])
      .sort((a, b) => (a.line_order ?? 0) - (b.line_order ?? 0))
      .map(l => ({ ...l, third_party: l.third_party_id ? (tpMap.get(l.third_party_id) || null) : null }));
    const entryTp = json.lines.find(l => l.third_party)?.third_party || null;
    json.third_party = entryTp;
    res.json({ success: true, data: json });
  } catch (error) {
    logger.error('Error en journalEntries.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al obtener asiento', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
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
    logger.error('Error en journalEntries.controller.js:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

// PUT /api/accounting/journal-entries/:id — edita un asiento manual en borrador
exports.update = async (req, res) => {
  const { sequelize } = require('../../config/database');
  const t = await sequelize.transaction();
  try {
    const { entry_date, description, lines, branch_id } = req.body;
    if (!entry_date || !Array.isArray(lines)) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'entry_date y lines son obligatorios' });
    }

    const entry = await updateDraftEntry(
      req.params.id,
      req.tenant_id,
      { entryDate: entry_date, description, branchId: branch_id, lines },
      t
    );

    await t.commit();
    res.json({ success: true, data: entry });
  } catch (error) {
    await t.rollback();
    logger.error('Error en journalEntries.controller.js:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

// PATCH /api/accounting/journal-entries/:id/post
exports.post = async (req, res) => {
  try {
    const entry = await postEntry(req.params.id, req.tenant_id, req.user?.id);
    res.json({ success: true, data: entry });
  } catch (error) {
    logger.error('Error en journalEntries.controller.js:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

// PATCH /api/accounting/journal-entries/:id/void
exports.void = async (req, res) => {
  try {
    const entry = await voidEntry(req.params.id, req.tenant_id, req.user?.id, req.body?.reason);
    res.json({ success: true, data: entry });
  } catch (error) {
    logger.error('Error en journalEntries.controller.js:', error);
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
    logger.error('Error en journalEntries.controller.js:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

// GET /api/accounting/third-parties?q=&types=customer,supplier,employee
// Buscador unificado de terceros para asientos manuales y filtros.
exports.searchThirdParties = async (req, res) => {
  try {
    const types = req.query.types ? String(req.query.types).split(',').filter(Boolean) : undefined;
    const data = await searchThirdParties(req.tenant_id, req.query.q, { limit: req.query.limit, types });
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error en journalEntries.controller.js (searchThirdParties):', error);
    res.status(500).json({ success: false, message: 'Error al buscar terceros' });
  }
};
