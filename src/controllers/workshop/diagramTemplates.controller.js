// backend/src/controllers/workshop/diagramTemplates.controller.js
const logger = require('../../config/logger');
const { DiagramTemplate } = require('../../models');
const { Op } = require('sequelize');

// Lista el catálogo disponible para el tenant: los diagramas de la
// biblioteca compartida (tenant_id = NULL) más los propios del taller,
// filtrable por vehicle_type y system para armar el flujo paso a paso
// (tipo de vehículo → sistema → configuración) descrito en la propuesta.
const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { vehicle_type, system } = req.query;

    const where = {
      is_active: true,
      [Op.or]: [{ tenant_id: null }, { tenant_id }],
    };
    if (vehicle_type) where.vehicle_type = vehicle_type;
    if (system) where.system = system;

    const templates = await DiagramTemplate.findAll({
      where,
      attributes: ['id', 'tenant_id', 'vehicle_type', 'system', 'configuration', 'name', 'description'],
      order: [['vehicle_type', 'ASC'], ['system', 'ASC'], ['configuration', 'ASC']],
    });

    res.json({ success: true, data: templates });
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

module.exports = { list, getById, updatePoints, updateImage };
