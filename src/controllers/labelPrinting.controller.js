// backend/src/controllers/labelPrinting.controller.js
//
// Perfiles de impresión de etiquetas (códigos de barras) por tenant. Cada
// perfil describe una combinación impresora + papel: tamaño de etiqueta,
// columnas del rollo, separaciones, resolución (dpi), desplazamiento de
// calibración, rotación y qué se imprime. Se guardan en
// tenants.business_config.label_printing = { profiles: [...], default_profile_id }.
//
// Cada equipo elige en el navegador cuál perfil usa (cada estación puede tener
// una impresora distinta); el tenant define cuáles existen y cuál es el de
// por defecto.

'use strict';

const { Tenant } = require('../models');
const logger = require('../config/logger');

const BARCODE_FORMATS = ['CODE128', 'EAN13', 'CODE39'];
const DPI_VALUES = [203, 300, 600];
const MAX_PROFILES = 30;

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};
const bool = (value, fallback) => (value === undefined ? fallback : value === true);

/** Normaliza un perfil: rangos válidos y valores por defecto (nunca confía en el cliente). */
function sanitizeProfile(p = {}, index = 0) {
  const id = String(p.id || '').trim().slice(0, 60) || `perfil-${Date.now()}-${index}`;
  return {
    id,
    name: String(p.name || '').trim().slice(0, 80) || `Perfil ${index + 1}`,
    // 'roll': rollo térmico, una fila de etiquetas por página (el alto de la
    // página es la etiqueta + la separación vertical). 'sheet': hoja de
    // etiquetas adhesivas (Carta/A4) en cuadrícula, con márgenes.
    media: p.media === 'sheet' ? 'sheet' : 'roll',
    page_w_mm: clamp(p.page_w_mm, 50, 500, 216),
    page_h_mm: clamp(p.page_h_mm, 50, 500, 279),
    margin_top_mm: clamp(p.margin_top_mm, 0, 60, 10),
    margin_left_mm: clamp(p.margin_left_mm, 0, 60, 5),
    label_w_mm: clamp(p.label_w_mm, 10, 300, 50),
    label_h_mm: clamp(p.label_h_mm, 10, 300, 30),
    columns: Math.round(clamp(p.columns, 1, 6, 1)),
    col_gap_mm: clamp(p.col_gap_mm, 0, 30, 0),
    row_gap_mm: clamp(p.row_gap_mm, 0, 30, 0),
    dpi: DPI_VALUES.includes(Number(p.dpi)) ? Number(p.dpi) : 203,
    offset_x_mm: clamp(p.offset_x_mm, -50, 50, 0),
    offset_y_mm: clamp(p.offset_y_mm, -50, 50, 0),
    padding_mm: clamp(p.padding_mm, 0, 15, 1),
    rotate: bool(p.rotate, false),
    fill_row: bool(p.fill_row, true),
    quiet_zone: bool(p.quiet_zone, false),
    barcode_format: BARCODE_FORMATS.includes(p.barcode_format) ? p.barcode_format : 'CODE128',
    show_name: bool(p.show_name, true),
    show_sku: bool(p.show_sku, false),
    show_barcode_text: bool(p.show_barcode_text, true),
    show_price: bool(p.show_price, false),
    font_scale: clamp(p.font_scale, 0.6, 2, 1),
    // Impresora a color (stickers de vehículo: franja con el color del taller
    // y placa amarilla). false = térmica, solo negro sólido.
    color: bool(p.color, false),
  };
}

function readConfig(tenant) {
  const raw = tenant?.business_config?.label_printing || {};
  const profiles = Array.isArray(raw.profiles) ? raw.profiles.map(sanitizeProfile) : [];
  const valid = (id) => (profiles.some((p) => p.id === id) ? id : profiles[0]?.id || null);
  // default_profile_id: etiquetas de productos; default_vehicle_profile_id:
  // stickers QR de vehículos (suelen ir en otra impresora o papel).
  return { profiles, default_profile_id: valid(raw.default_profile_id), default_vehicle_profile_id: valid(raw.default_vehicle_profile_id) };
}

// GET /api/tenant/label-printing -- cualquier usuario del tenant (para imprimir).
const getLabelPrinting = async (req, res) => {
  try {
    const tenant = await Tenant.findByPk(req.tenant_id, { attributes: ['id', 'business_config'] });
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });
    res.json({ success: true, data: readConfig(tenant) });
  } catch (error) {
    logger.error('Error leyendo perfiles de impresión:', error);
    res.status(500).json({ success: false, message: 'Error leyendo los perfiles de impresión' });
  }
};

// PUT /api/tenant/label-printing { profiles, default_profile_id, default_vehicle_profile_id } -- solo gestión.
const updateLabelPrinting = async (req, res) => {
  try {
    const { profiles, default_profile_id, default_vehicle_profile_id } = req.body || {};
    if (!Array.isArray(profiles)) {
      return res.status(400).json({ success: false, message: 'profiles debe ser una lista' });
    }
    if (profiles.length > MAX_PROFILES) {
      return res.status(400).json({ success: false, message: `Máximo ${MAX_PROFILES} perfiles` });
    }
    const clean = profiles.map(sanitizeProfile);
    const ids = new Set();
    for (const p of clean) {
      if (ids.has(p.id)) return res.status(400).json({ success: false, message: `Perfil repetido: ${p.name}` });
      ids.add(p.id);
    }

    const tenant = await Tenant.findByPk(req.tenant_id);
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });
    const label_printing = {
      profiles: clean,
      default_profile_id: ids.has(default_profile_id) ? default_profile_id : clean[0]?.id || null,
      default_vehicle_profile_id: ids.has(default_vehicle_profile_id) ? default_vehicle_profile_id : clean[0]?.id || null,
    };
    await tenant.update({ business_config: { ...(tenant.business_config || {}), label_printing } });
    res.json({ success: true, message: 'Perfiles de impresión guardados', data: label_printing });
  } catch (error) {
    logger.error('Error guardando perfiles de impresión:', error);
    res.status(500).json({ success: false, message: 'Error guardando los perfiles de impresión' });
  }
};

module.exports = { getLabelPrinting, updateLabelPrinting, sanitizeProfile };
