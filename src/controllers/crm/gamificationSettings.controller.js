// backend/src/controllers/crm/gamificationSettings.controller.js
//
// CRM — Gamificación, Fase 1. Ver gamificacion-crm-diseno.md §3.5 y §7.
const logger = require('../../config/logger');
const { CrmGamificationSettings } = require('../../models');

const get = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const [settings] = await CrmGamificationSettings.findOrCreate({
      where: { tenant_id },
      defaults: { tenant_id, board_visibility: 'own_only', enabled: true },
    });
    res.json({ success: true, data: settings });
  } catch (error) {
    logger.error('Error obteniendo configuración de gamificación:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la configuración' });
  }
};

const update = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { board_visibility, enabled } = req.body;

    if (board_visibility && !['own_only', 'team', 'all'].includes(board_visibility)) {
      return res.status(400).json({ success: false, message: 'board_visibility inválido' });
    }

    const [settings] = await CrmGamificationSettings.findOrCreate({
      where: { tenant_id },
      defaults: { tenant_id, board_visibility: 'own_only', enabled: true },
    });

    const updateData = {};
    if (board_visibility !== undefined) updateData.board_visibility = board_visibility;
    if (enabled !== undefined) updateData.enabled = enabled;

    await settings.update(updateData);
    res.json({ success: true, message: 'Configuración actualizada', data: settings });
  } catch (error) {
    logger.error('Error actualizando configuración de gamificación:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la configuración' });
  }
};

module.exports = { get, update };
