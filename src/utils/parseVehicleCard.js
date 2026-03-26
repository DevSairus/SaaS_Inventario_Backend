/**
 * parseVehicleCard.js
 * Parser para el código de barras PDF417 de la Tarjeta de Propiedad /
 * Licencia de Tránsito colombiana (sistema RUNT).
 *
 * El código contiene campos separados por '|'. El orden puede variar
 * según el municipio y año de expedición, pero el más común es:
 *
 * [0]  Placa
 * [1]  Tipo documento propietario (CC, NIT, CE, PA…)
 * [2]  Número documento propietario
 * [3]  Primer apellido / Razón social
 * [4]  Segundo apellido
 * [5]  Primer nombre
 * [6]  Segundo nombre
 * [7]  Marca
 * [8]  Línea (modelo comercial)
 * [9]  Año modelo
 * [10] Color
 * [11] Cilindraje (cc)
 * [12] Número de motor
 * [13] Número VIN / chasis
 * [14] Clase de vehículo
 * [15] Tipo de carrocería
 * [16] Combustible
 * [17] Número de serie tarjeta
 * [18] Fecha de expedición
 * [19..] Campos adicionales (varían)
 */

const PLATE_RE = /^[A-Z]{3}[0-9]{2}[A-Z0-9]{1}$|^[A-Z]{3}[0-9]{3}$/i;
const YEAR_RE  = /^(19[5-9]\d|20[0-4]\d)$/;

const FUEL_MAP = {
  GASOLINA:  'gasolina',
  DIESEL:    'diesel',
  DIÉSEL:    'diesel',
  ELECTRICO: 'electrico',
  ELÉCTRICO: 'electrico',
  GAS:       'gas',
  GNV:       'gas',
  GNC:       'gas',
  HÍBRIDO:   'hibrido',
  HIBRIDO:   'hibrido',
};

function clean(s = '') {
  return s.trim().replace(/\s+/g, ' ');
}

function toTitle(s = '') {
  return s
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, c => c.toUpperCase())
    .trim();
}

function detectSeparator(raw) {
  // Intentar '|', luego ';', luego '\t'
  for (const sep of ['|', ';', '\t']) {
    const parts = raw.split(sep);
    if (parts.length >= 7) return sep;
  }
  return null;
}

/**
 * Intenta ubicar la placa dentro del array (puede no estar en posición 0
 * en algunos formatos municipales).
 */
function findPlate(parts) {
  for (let i = 0; i < Math.min(parts.length, 5); i++) {
    const v = clean(parts[i]).toUpperCase();
    if (PLATE_RE.test(v)) return { plate: v, offset: i };
  }
  return null;
}

/**
 * Normaliza combustible al enum usado en Pitbox.
 */
function parseFuel(raw = '') {
  const key = raw.toUpperCase().trim();
  return FUEL_MAP[key] || 'gasolina';
}

/**
 * Resultado de parseo:
 * {
 *   plate, brand, model, year, color,
 *   engine_number, vin, fuel_type,
 *   owner_doc_type, owner_doc, owner_name,
 *   raw_fields,   // array completo de campos
 *   confidence,   // 'high' | 'medium' | 'low'
 * }
 */
export function parseVehicleCard(rawBarcode) {
  const raw = rawBarcode?.trim() || '';

  if (!raw) return null;

  const sep = detectSeparator(raw);
  if (!sep) {
    // No tiene separadores → no es una tarjeta de propiedad estándar
    return null;
  }

  const parts = raw.split(sep).map(p => clean(p));

  // Buscar placa (índice de inicio real puede variar)
  const plateResult = findPlate(parts);
  if (!plateResult) return null;

  const { plate, offset } = plateResult;
  const p = (i) => parts[offset + i] || '';

  // Con offset 0 en placa, el esquema estándar es:
  // p(0)=placa  p(1)=tipo_doc  p(2)=num_doc
  // p(3)=apellido1  p(4)=apellido2  p(5)=nombre1  p(6)=nombre2
  // p(7)=marca  p(8)=linea  p(9)=año  p(10)=color
  // p(11)=cilindraje  p(12)=num_motor  p(13)=vin
  // p(14)=clase  p(15)=carroceria  p(16)=combustible

  const docType  = p(1).toUpperCase();
  const docNum   = p(2);
  const ap1      = toTitle(p(3));
  const ap2      = toTitle(p(4));
  const nm1      = toTitle(p(5));
  const nm2      = toTitle(p(6));

  const brandRaw    = p(7);
  const modelRaw    = p(8);
  const yearRaw     = p(9);
  const colorRaw    = p(10);
  const engineNum   = p(12);
  const vinRaw      = p(13);
  const fuelRaw     = p(16);

  // Construir nombre propietario
  const ownerParts = [nm1, nm2, ap1, ap2].filter(Boolean);
  const ownerName  = ownerParts.length ? ownerParts.join(' ') : '';

  // Validar año
  const year = YEAR_RE.test(yearRaw) ? yearRaw : '';

  // Detectar confianza
  const score = [plate, brandRaw, modelRaw, year, colorRaw].filter(Boolean).length;
  const confidence = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';

  return {
    plate:          plate,
    brand:          toTitle(brandRaw),
    model:          toTitle(modelRaw),
    year:           year,
    color:          toTitle(colorRaw),
    engine_number:  engineNum,
    vin:            vinRaw,
    fuel_type:      parseFuel(fuelRaw),
    owner_doc_type: docType,
    owner_doc:      docNum,
    owner_name:     ownerName,
    raw_fields:     parts,
    confidence,
  };
}