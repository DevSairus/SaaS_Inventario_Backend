// backend/src/constants/inspectionTemplates.js
//
// Peritajes vehiculares (migración 2026112701). Aquí viven:
//   - Las plantillas de Pitbox (carro, moto, pesado). Cada empresa puede
//     copiarlas a inspection_templates y ajustarlas; si no tiene una propia
//     para el tipo de vehículo, se usa la de Pitbox.
//   - Las zonas de carrocería del diagrama y los tipos de daño.
//   - El cálculo del puntaje y del concepto sugerido.
//
// Una plantilla es { name, sections: [{ key, label, weight, items: [{ key,
// label, kind, unit?, critical? }] }] }.
//   kind 'rating'  → Bueno / Regular / Malo / No aplica.
//   kind 'measure' → además de la calificación, un valor numérico (unit).
//   critical: un "Malo" en este punto deja el concepto en "No recomendado"
//   sin importar el puntaje (p. ej. daño estructural, improntas alteradas).
//
// La plantilla se CONGELA en el peritaje al crearlo (template_snapshot), así
// que editar una plantilla nunca cambia peritajes ya hechos.

const r = (key, label, extra = {}) => ({ key, label, kind: 'rating', ...extra });
const m = (key, label, unit, extra = {}) => ({ key, label, kind: 'measure', unit, ...extra });

const AUTO = {
  base_key: 'auto',
  name: 'Peritaje automóvil / camioneta',
  vehicle_types: ['automovil', 'camioneta', 'otro'],
  sections: [
    { key: 'estructura', label: 'Estructura y chasis', weight: 20, items: [
      r('largueros_delanteros', 'Largueros delanteros', { critical: true }),
      r('largueros_traseros', 'Largueros traseros', { critical: true }),
      r('torres_suspension', 'Torres de suspensión', { critical: true }),
      r('piso_bajos', 'Piso y bajos', { critical: true }),
      r('parales_columnas', 'Parales / columnas (A, B, C)', { critical: true }),
      r('puntos_soldadura', 'Puntos de soldadura de fábrica'),
      r('corrosion_estructural', 'Corrosión estructural', { critical: true }),
      r('evidencia_inundacion', 'Sin evidencia de inundación', { critical: true }),
    ] },
    { key: 'carroceria', label: 'Carrocería y pintura', weight: 15, items: [
      r('alineacion_paneles', 'Alineación y luces entre paneles'),
      r('pintura_general', 'Estado general de la pintura'),
      r('vidrios', 'Vidrios y panorámicos (marcas de fábrica)'),
      r('farolas_stops', 'Farolas y stops'),
      r('espejos', 'Espejos'),
      r('bomperes', 'Bómperes'),
      r('chapas_puertas', 'Chapas, bisagras y cierre de puertas'),
    ] },
    { key: 'motor', label: 'Motor', weight: 20, items: [
      r('arranque', 'Arranque en frío'),
      r('ruidos_motor', 'Ruidos anormales'),
      r('fugas_aceite', 'Fugas de aceite'),
      r('fugas_refrigerante', 'Fugas de refrigerante'),
      r('humo_escape', 'Humo en el escape'),
      r('correas', 'Correas y tensores'),
      r('soportes_motor', 'Soportes de motor'),
      m('compresion', 'Compresión (promedio)', 'psi'),
      r('testigos_tablero', 'Testigos del tablero / códigos de falla'),
    ] },
    { key: 'transmision', label: 'Transmisión y embrague', weight: 10, items: [
      r('cambios', 'Paso de cambios'),
      r('embrague', 'Embrague / convertidor'),
      r('fugas_caja', 'Fugas en caja y diferencial'),
      r('juntas_homocineticas', 'Juntas homocinéticas / cardán'),
    ] },
    { key: 'suspension_direccion', label: 'Suspensión y dirección', weight: 10, items: [
      r('amortiguadores', 'Amortiguadores'),
      r('bujes_rotulas', 'Bujes y rótulas'),
      r('terminales', 'Terminales y axiales'),
      r('caja_direccion', 'Caja de dirección / bomba'),
      r('alineacion', 'Alineación (tiro del vehículo)'),
    ] },
    { key: 'frenos_llantas', label: 'Frenos y llantas', weight: 10, items: [
      m('pastillas_del', 'Pastillas delanteras', '%'),
      m('frenos_tras', 'Frenos traseros', '%'),
      r('discos', 'Discos / campanas'),
      r('freno_mano', 'Freno de mano'),
      m('llanta_di', 'Llanta delantera izquierda', 'mm'),
      m('llanta_dd', 'Llanta delantera derecha', 'mm'),
      m('llanta_ti', 'Llanta trasera izquierda', 'mm'),
      m('llanta_td', 'Llanta trasera derecha', 'mm'),
      r('llanta_repuesto', 'Llanta de repuesto y herramienta'),
    ] },
    { key: 'electrico', label: 'Sistema eléctrico', weight: 7, items: [
      m('bateria', 'Batería', 'V'),
      r('alternador', 'Carga del alternador'),
      r('luces', 'Luces exteriores'),
      r('aire_acondicionado', 'Aire acondicionado'),
      r('vidrios_electricos', 'Vidrios eléctricos y seguros'),
      r('radio_tablero', 'Radio, tablero e instrumentos'),
      r('airbags', 'Testigo de airbags'),
    ] },
    { key: 'interior', label: 'Interior', weight: 8, items: [
      r('tapiceria', 'Tapicería y sillas'),
      r('cinturones', 'Cinturones de seguridad'),
      r('techo_interior', 'Techo interior'),
      r('alfombras', 'Alfombras (humedad / olor)'),
      r('desgaste_coherente', 'Desgaste coherente con el kilometraje'),
    ] },
  ],
};

const MOTO = {
  base_key: 'moto',
  name: 'Peritaje motocicleta',
  vehicle_types: ['motocicleta', 'motocarro', 'cuatrimoto', 'utv'],
  sections: [
    { key: 'chasis', label: 'Chasis y estructura', weight: 25, items: [
      r('chasis_golpes', 'Chasis sin golpes ni enderezadas', { critical: true }),
      r('soldaduras', 'Soldaduras de fábrica', { critical: true }),
      r('tijera', 'Tijera / basculante', { critical: true }),
      r('direccion_cunas', 'Dirección y cunas'),
      r('corrosion', 'Corrosión'),
    ] },
    { key: 'motor', label: 'Motor', weight: 25, items: [
      r('arranque', 'Arranque eléctrico / pedal'),
      r('ruidos_motor', 'Ruidos anormales'),
      r('fugas', 'Fugas de aceite'),
      r('humo_escape', 'Humo en el escape'),
      r('embrague', 'Embrague'),
      r('cambios', 'Paso de cambios'),
      m('compresion', 'Compresión', 'psi'),
    ] },
    { key: 'transmision', label: 'Transmisión', weight: 10, items: [
      r('cadena', 'Cadena / correa'),
      r('pinon_corona', 'Piñón y corona'),
    ] },
    { key: 'suspension_frenos', label: 'Suspensión y frenos', weight: 20, items: [
      r('barras', 'Barras delanteras (fugas / rayones)'),
      r('amortiguador_tras', 'Amortiguador trasero'),
      m('freno_del', 'Freno delantero', '%'),
      m('freno_tras', 'Freno trasero', '%'),
      m('llanta_del', 'Llanta delantera', 'mm'),
      m('llanta_tras', 'Llanta trasera', 'mm'),
      r('rines', 'Rines (golpes / radios)'),
    ] },
    { key: 'electrico', label: 'Sistema eléctrico', weight: 10, items: [
      m('bateria', 'Batería', 'V'),
      r('luces', 'Luces, direccionales y stop'),
      r('pito', 'Pito'),
      r('tablero', 'Tablero e instrumentos'),
    ] },
    { key: 'carenaje', label: 'Carenaje y accesorios', weight: 10, items: [
      r('tanque', 'Tanque (golpes / óxido interno)'),
      r('carenaje', 'Carenaje y tapas laterales'),
      r('espejos', 'Espejos'),
      r('sillin', 'Sillín'),
      r('desgaste_coherente', 'Desgaste coherente con el kilometraje'),
    ] },
  ],
};

const PESADO = {
  base_key: 'pesado',
  name: 'Peritaje vehículo pesado',
  vehicle_types: ['camion'],
  sections: [
    { key: 'chasis', label: 'Chasis y estructura', weight: 25, items: [
      r('largueros', 'Largueros del chasis', { critical: true }),
      r('travesanos', 'Travesaños', { critical: true }),
      r('quinta_rueda', 'Quinta rueda / enganche'),
      r('cabina', 'Cabina y soportes'),
      r('corrosion_estructural', 'Corrosión estructural', { critical: true }),
    ] },
    { key: 'motor', label: 'Motor', weight: 25, items: [
      r('arranque', 'Arranque'),
      r('ruidos_motor', 'Ruidos anormales'),
      r('fugas', 'Fugas de aceite / refrigerante'),
      r('humo_escape', 'Humo en el escape'),
      r('turbo', 'Turbo'),
      m('presion_aceite', 'Presión de aceite', 'psi'),
    ] },
    { key: 'transmision', label: 'Transmisión', weight: 15, items: [
      r('caja', 'Caja de cambios'),
      r('embrague', 'Embrague'),
      r('cardan', 'Cardán y crucetas'),
      r('diferenciales', 'Diferenciales'),
    ] },
    { key: 'frenos_suspension', label: 'Frenos y suspensión', weight: 20, items: [
      r('sistema_aire', 'Sistema de aire (fugas / compresor)'),
      r('frenos', 'Bandas / pastillas'),
      r('muelles', 'Muelles y ballestas'),
      r('amortiguadores', 'Amortiguadores'),
      r('direccion', 'Dirección'),
      r('llantas', 'Llantas (profundidad y desgaste)'),
    ] },
    { key: 'electrico', label: 'Sistema eléctrico', weight: 7, items: [
      r('baterias', 'Baterías'),
      r('luces', 'Luces y señalización'),
      r('tablero', 'Tablero e instrumentos'),
    ] },
    { key: 'carroceria', label: 'Carrocería e interior', weight: 8, items: [
      r('carroceria', 'Carrocería / furgón / platón'),
      r('vidrios', 'Vidrios y espejos'),
      r('cabina_interior', 'Interior de cabina'),
    ] },
  ],
};

const BUILTIN_TEMPLATES = [AUTO, MOTO, PESADO];

/** Plantilla de Pitbox que corresponde a un tipo de vehículo (por defecto, la de carro). */
function builtinForVehicleType(vehicleType) {
  return BUILTIN_TEMPLATES.find((t) => t.vehicle_types.includes(vehicleType)) || AUTO;
}

// ── Diagrama de carrocería ────────────────────────────────────────────
// Zonas que el frontend dibuja (VehicleBodyDiagram.jsx). Los ids deben
// coincidir con los del SVG.
const BODY_ZONES = {
  car: [
    ['bomper_del', 'Bómper delantero'], ['capo', 'Capó'], ['guardabarro_di', 'Guardabarro del. izq.'],
    ['guardabarro_dd', 'Guardabarro del. der.'], ['puerta_di', 'Puerta del. izq.'], ['puerta_dd', 'Puerta del. der.'],
    ['puerta_ti', 'Puerta tras. izq.'], ['puerta_td', 'Puerta tras. der.'], ['techo', 'Techo'],
    ['panoramico', 'Panorámico'], ['vidrio_trasero', 'Vidrio trasero'], ['costado_ti', 'Costado tras. izq.'],
    ['costado_td', 'Costado tras. der.'], ['baul', 'Baúl / compuerta'], ['bomper_tras', 'Bómper trasero'],
    ['estribo_i', 'Estribo izq.'], ['estribo_d', 'Estribo der.'],
  ],
  moto: [
    ['guardabarro_del', 'Guardabarro delantero'], ['farola', 'Farola / carenaje frontal'], ['tanque', 'Tanque'],
    ['carenaje_i', 'Carenaje izq.'], ['carenaje_d', 'Carenaje der.'], ['tapa_lateral_i', 'Tapa lateral izq.'],
    ['tapa_lateral_d', 'Tapa lateral der.'], ['sillin', 'Sillín'], ['colin', 'Colín'],
    ['guardabarro_tras', 'Guardabarro trasero'], ['chasis', 'Chasis'], ['tijera', 'Tijera / basculante'],
    ['exosto', 'Exhosto'], ['rin_del', 'Rin delantero'], ['rin_tras', 'Rin trasero'],
  ],
  heavy: [
    ['bomper_del', 'Bómper delantero'], ['cabina_frente', 'Frente de cabina'], ['puerta_i', 'Puerta izq.'],
    ['puerta_d', 'Puerta der.'], ['techo_cabina', 'Techo de cabina'], ['panoramico', 'Panorámico'],
    ['chasis_i', 'Chasis izq.'], ['chasis_d', 'Chasis der.'], ['carroceria_i', 'Carrocería izq.'],
    ['carroceria_d', 'Carrocería der.'], ['carroceria_tras', 'Carrocería trasera'], ['bomper_tras', 'Bómper trasero'],
  ],
};

function bodyKindFor(vehicleType) {
  if (['motocicleta', 'motocarro', 'cuatrimoto', 'utv'].includes(vehicleType)) return 'moto';
  if (vehicleType === 'camion') return 'heavy';
  return 'car';
}

const DAMAGE_TYPES = ['golpe', 'rayon', 'repintura', 'masilla', 'cambio_pieza', 'corrosion', 'vidrio', 'otro'];
const DAMAGE_SEVERITIES = ['leve', 'moderado', 'grave'];

// Espesor de pintura (micras). Pintura original de fábrica ronda 80–180 µm;
// por encima de REPAINT_MICRONS se presume repintura, por encima de
// FILLER_MICRONS hay masilla. Solo son sugerencias para el perito.
const REPAINT_MICRONS = 200;
const FILLER_MICRONS = 400;

// ── Puntaje ───────────────────────────────────────────────────────────
const RATINGS = ['bueno', 'regular', 'malo', 'na'];
const RATING_POINTS = { bueno: 100, regular: 60, malo: 0 };
const CONCEPTS = ['aprobado', 'aprobado_observaciones', 'no_recomendado'];
const APPROVED_MIN = 80;
const OBSERVATIONS_MIN = 60;

/**
 * Puntaje (0–100) por sección y total ponderado, y concepto sugerido.
 * Puntos sin calificar o "No aplica" no cuentan. Una sección sin ningún
 * punto calificado no pesa en el total.
 *
 * @param {Array<{section_key, rating, critical}>} items
 * @param {Array<{key, label, weight}>} sections (de la plantilla congelada)
 * @param {{ identityMismatch?: boolean, structuralBodyDamage?: boolean }} flags
 */
function computeScore(items, sections, flags = {}) {
  const bySection = {};
  for (const s of sections || []) bySection[s.key] = { key: s.key, label: s.label, weight: Number(s.weight) || 0, sum: 0, count: 0, bad: 0, regular: 0 };
  let criticalFail = false;
  let rated = 0;
  for (const it of items || []) {
    const sec = bySection[it.section_key];
    if (!sec || !(it.rating in RATING_POINTS)) continue;
    sec.sum += RATING_POINTS[it.rating];
    sec.count += 1;
    rated += 1;
    if (it.rating === 'malo') { sec.bad += 1; if (it.critical) criticalFail = true; }
    if (it.rating === 'regular') sec.regular += 1;
  }
  let weighted = 0;
  let weights = 0;
  const sectionScores = Object.values(bySection).map((s) => {
    const score = s.count ? Math.round((s.sum / s.count) * 10) / 10 : null;
    if (score !== null && s.weight > 0) { weighted += score * s.weight; weights += s.weight; }
    return { key: s.key, label: s.label, weight: s.weight, score, rated: s.count, bad: s.bad, regular: s.regular };
  });
  const score = weights ? Math.round((weighted / weights) * 10) / 10 : null;

  const reasons = [];
  if (criticalFail) reasons.push('Hay un punto crítico calificado como malo');
  if (flags.identityMismatch) reasons.push('Las improntas o la identificación no coinciden');
  if (flags.structuralBodyDamage) reasons.push('Daño grave en la carrocería');

  let concept = null;
  if (score !== null) {
    if (criticalFail || flags.identityMismatch) concept = 'no_recomendado';
    else if (score >= APPROVED_MIN && !flags.structuralBodyDamage) concept = 'aprobado';
    else if (score >= OBSERVATIONS_MIN) concept = 'aprobado_observaciones';
    else concept = 'no_recomendado';
  }
  return { score, concept, sections: sectionScores, critical_fail: criticalFail, reasons, rated };
}

/** Valida y normaliza una plantilla que llega del usuario. Lanza Error con mensaje legible. */
function normalizeTemplateSections(sections) {
  if (!Array.isArray(sections) || sections.length === 0) throw new Error('La plantilla debe tener al menos una sección');
  const keys = new Set();
  const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50);
  return sections.map((s, si) => {
    const label = String(s.label || '').trim().slice(0, 120);
    if (!label) throw new Error(`La sección ${si + 1} no tiene nombre`);
    let key = slug(s.key || label) || `seccion_${si + 1}`;
    while (keys.has(key)) key = `${key}_${si + 1}`;
    keys.add(key);
    const weight = Math.max(0, Math.min(100, Number(s.weight) || 0));
    const itemKeys = new Set();
    const items = (Array.isArray(s.items) ? s.items : []).map((it, ii) => {
      const itLabel = String(it.label || '').trim().slice(0, 150);
      if (!itLabel) throw new Error(`Hay un punto sin nombre en "${label}"`);
      let ik = slug(it.key || itLabel) || `punto_${ii + 1}`;
      while (itemKeys.has(ik)) ik = `${ik}_${ii + 1}`;
      itemKeys.add(ik);
      const kind = it.kind === 'measure' ? 'measure' : 'rating';
      return {
        key: ik, label: itLabel, kind,
        ...(kind === 'measure' ? { unit: String(it.unit || '').trim().slice(0, 10) } : {}),
        ...(it.critical ? { critical: true } : {}),
      };
    });
    if (items.length === 0) throw new Error(`La sección "${label}" no tiene puntos`);
    return { key, label, weight, items };
  });
}

module.exports = {
  BUILTIN_TEMPLATES, builtinForVehicleType,
  BODY_ZONES, bodyKindFor, DAMAGE_TYPES, DAMAGE_SEVERITIES, REPAINT_MICRONS, FILLER_MICRONS,
  RATINGS, RATING_POINTS, CONCEPTS, APPROVED_MIN, OBSERVATIONS_MIN,
  computeScore, normalizeTemplateSections,
};
