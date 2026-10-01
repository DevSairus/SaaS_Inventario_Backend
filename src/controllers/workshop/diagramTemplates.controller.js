// backend/src/controllers/workshop/diagramTemplates.controller.js
const logger = require('../../config/logger');
const { sequelize } = require('../../config/database');
const { DiagramTemplate, DiagramTemplateSetting } = require('../../models');
const { Op } = require('sequelize');

const VEHICLE_TYPES = ['automovil', 'camioneta', 'motocicleta', 'camion', 'otro'];

// Lista el catálogo disponible para el tenant: los diagramas de la
// biblioteca compartida (tenant_id = NULL) más los propios del taller,
// filtrable por vehicle_type y system para armar el flujo paso a paso
// (tipo de vehículo → sistema → configuración) descrito en la propuesta.
//
// Aplica los ajustes del taller (diagram_template_settings):
// - vehicle_type incluye también los diagramas que el taller marcó como
//   aplicables a esa categoría (extra_vehicle_types).
// - Los desactivados se omiten, salvo con ?all=1 (pantalla "Biblioteca de
//   diagramas" y calibración, que necesitan verlos todos).
const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { vehicle_type, system, all } = req.query;
    const includeDisabled = all === '1' || all === 'true';

    const where = {
      is_active: true,
      [Op.or]: [{ tenant_id: null }, { tenant_id }],
    };
    if (system) where.system = system;

    const [templates, settings] = await Promise.all([
      DiagramTemplate.findAll({
        where,
        attributes: ['id', 'tenant_id', 'vehicle_type', 'system', 'configuration', 'name', 'description'],
        order: [['vehicle_type', 'ASC'], ['system', 'ASC'], ['configuration', 'ASC']],
      }),
      DiagramTemplateSetting.findAll({ where: { tenant_id } }),
    ]);
    const settingsById = new Map(settings.map(s => [s.diagram_template_id, s]));

    const data = templates
      .map(t => {
        const setting = settingsById.get(t.id);
        return {
          ...t.toJSON(),
          is_enabled: setting ? setting.is_enabled : true,
          extra_vehicle_types: setting?.extra_vehicle_types || [],
        };
      })
      .filter(t => includeDisabled || t.is_enabled)
      .filter(t => !vehicle_type || t.vehicle_type === vehicle_type || t.extra_vehicle_types.includes(vehicle_type));

    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error listando plantillas de diagrama:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el catálogo de diagramas' });
  }
};

// Devuelve un diagrama completo (SVG + puntos) — es lo que consume el
// editor para pintar el dibujo base y los puntos clicables encima.
const getById = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const template = await DiagramTemplate.findOne({
      where: {
        id: req.params.id,
        is_active: true,
        [Op.or]: [{ tenant_id: null }, { tenant_id }],
      },
    });
    if (!template) return res.status(404).json({ success: false, message: 'Diagrama no encontrado' });
    res.json({ success: true, data: template });
  } catch (error) {
    logger.error('Error obteniendo plantilla de diagrama:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el diagrama' });
  }
};

// Actualiza las coordenadas (x/y) del catálogo de puntos de una plantilla —
// usado por el editor visual de calibración (admin) tras migrar de SVG a
// imágenes WEBP reales, donde las posiciones dibujadas a mano ya no calzan
// con la foto. Solo toca `points`; no crea ni borra marcas de ninguna OT
// (las marcas solo referencian point_number, nunca x/y).
// label_dx/label_dy son opcionales: desplazan el número respecto al punto
// real y el frontend dibuja la línea guía entre ambos — se usan cuando hay
// varias marcas muy próximas entre sí.
// Marca is_customized = true: a partir de este PATCH, el seed que corre en
// cada arranque del server (seedDiagramTemplates) deja esta fila en paz y
// ya no la vuelve a pisar con lo que haya en el catálogo estático.
const updatePoints = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { points } = req.body;

    if (!Array.isArray(points) || points.some(p => (
      typeof p.point_number !== 'number' ||
      typeof p.x !== 'number' ||
      typeof p.y !== 'number' ||
      typeof p.part_name !== 'string' ||
      (p.label_dx !== undefined && typeof p.label_dx !== 'number') ||
      (p.label_dy !== undefined && typeof p.label_dy !== 'number')
    ))) {
      return res.status(400).json({
        success: false,
        message: 'points debe ser un array de {point_number, x, y, part_name, label_dx?, label_dy?}',
      });
    }

    const template = await DiagramTemplate.findOne({
      where: {
        id: req.params.id,
        [Op.or]: [{ tenant_id: null }, { tenant_id }],
      },
    });
    if (!template) return res.status(404).json({ success: false, message: 'Diagrama no encontrado' });

    await template.update({ points, is_customized: true });
    res.json({ success: true, message: 'Puntos actualizados', data: template });
  } catch (error) {
    logger.error('Error actualizando puntos de plantilla de diagrama:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar los puntos' });
  }
};

// Setea la ruta de la imagen WEBP real de una plantilla (relativa a
// public/assets/diagrams/ en el frontend, ej. "suspension/macpherson.webp")
// — usado por el panel admin tras subir/organizar los assets del diagrama.
// No hay endpoint de subida de archivo acá a propósito: los WEBP viven como
// assets estáticos del frontend, este endpoint solo guarda la ruta relativa.
// Igual que updatePoints, marca is_customized = true para que el seed no
// vuelva a resetear la ruta al siguiente reinicio del server.
const updateImage = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { image_path } = req.body;

    if (image_path !== null && typeof image_path !== 'string') {
      return res.status(400).json({ success: false, message: 'image_path debe ser un string (o null para limpiarlo)' });
    }
    if (typeof image_path === 'string' && !image_path.trim()) {
      return res.status(400).json({ success: false, message: 'image_path no puede ser un string vacío' });
    }

    const template = await DiagramTemplate.findOne({
      where: {
        id: req.params.id,
        [Op.or]: [{ tenant_id: null }, { tenant_id }],
      },
    });
    if (!template) return res.status(404).json({ success: false, message: 'Diagrama no encontrado' });

    await template.update({ image_path, is_customized: true });
    res.json({ success: true, message: 'Imagen actualizada', data: template });
  } catch (error) {
    logger.error('Error actualizando imagen de plantilla de diagrama:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la imagen' });
  }
};

// Guarda los ajustes del taller sobre uno o varios diagramas (activar /
// desactivar y categorías adicionales). Recibe un lote para que la pantalla
// pueda activar/desactivar toda una categoría en un solo request.
// Body: { settings: [{ diagram_template_id, is_enabled, extra_vehicle_types }] }
const updateSettings = async (req, res) => {
  const tenant_id = req.user.tenant_id;
  const { settings } = req.body;

  if (!Array.isArray(settings) || !settings.length || settings.some(s => (
    typeof s.diagram_template_id !== 'string' ||
    (s.is_enabled !== undefined && typeof s.is_enabled !== 'boolean') ||
    (s.extra_vehicle_types !== undefined && !Array.isArray(s.extra_vehicle_types))
  ))) {
    return res.status(400).json({
      success: false,
      message: 'settings debe ser un array de {diagram_template_id, is_enabled?, extra_vehicle_types?}',
    });
  }

  const transaction = await sequelize.transaction();
  try {
    const templates = await DiagramTemplate.findAll({
      where: {
        id: settings.map(s => s.diagram_template_id),
        [Op.or]: [{ tenant_id: null }, { tenant_id }],
      },
      attributes: ['id', 'vehicle_type'],
      transaction,
    });
    const templatesById = new Map(templates.map(t => [t.id, t]));
    if (templatesById.size !== new Set(settings.map(s => s.diagram_template_id)).size) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Uno o más diagramas no existen' });
    }

    for (const s of settings) {
      const template = templatesById.get(s.diagram_template_id);
      const [row] = await DiagramTemplateSetting.findOrCreate({
        where: { tenant_id, diagram_template_id: s.diagram_template_id },
        defaults: { tenant_id, diagram_template_id: s.diagram_template_id },
        transaction,
      });

      const updates = {};
      if (s.is_enabled !== undefined) updates.is_enabled = s.is_enabled;
      if (s.extra_vehicle_types !== undefined) {
        // Solo categorías válidas, sin repetir y sin la propia del diagrama
        updates.extra_vehicle_types = [...new Set(s.extra_vehicle_types)]
          .filter(vt => VEHICLE_TYPES.includes(vt) && vt !== template.vehicle_type);
      }
      if (Object.keys(updates).length) await row.update(updates, { transaction });
    }

    await transaction.commit();
    res.json({ success: true, message: 'Ajustes de diagramas guardados' });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error guardando ajustes de diagramas:', error);
    res.status(500).json({ success: false, message: 'Error al guardar los ajustes de diagramas' });
  }
};

module.exports = { list, getById, updatePoints, updateImage, updateSettings };
