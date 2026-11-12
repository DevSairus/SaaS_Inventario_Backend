// Catálogo global de marcas/líneas y tipos de vehículo por empresa.
const catalog = require('../data/vehicleCatalog.json');
const {
  VEHICLE_TYPES, CATALOG_CLASS_BY_TYPE, CATALOG_CLASSES, tenantVehicleTypes, sanitizeVehicleTypes,
} = require('../constants/vehicleTypes');

describe('data/vehicleCatalog.json', () => {
  const lines = (cls) => catalog.brands.flatMap((b) => b.lines[cls] || []);

  test('trae todas las clases, con líneas en cada una', () => {
    for (const cls of CATALOG_CLASSES) expect(lines(cls).length).toBeGreaterThan(20);
  });

  test('marcas y líneas en mayúsculas, sin repetir dentro de la clase', () => {
    const names = catalog.brands.map((b) => b.brand);
    expect(new Set(names).size).toBe(names.length);
    for (const b of catalog.brands) {
      expect(b.brand).toBe(b.brand.toUpperCase());
      for (const [cls, list] of Object.entries(b.lines)) {
        expect(CATALOG_CLASSES).toContain(cls);
        expect(new Set(list).size).toBe(list.length);
        for (const l of list) expect(l).toBe(l.toUpperCase().trim());
      }
    }
  });

  test('separa livianos de pesados y motos de autos', () => {
    const chevrolet = catalog.brands.find((b) => b.brand === 'CHEVROLET');
    expect(chevrolet.lines.liviano).toContain('SPARK');
    expect(chevrolet.lines.pesado).toContain('NHR');
    expect(chevrolet.lines.liviano).not.toContain('NHR');
    const honda = catalog.brands.find((b) => b.brand === 'HONDA');
    expect(honda.lines.liviano).toContain('CIVIC');
    expect(honda.lines.moto).toContain('XR 150L');
    expect(honda.lines.cuatrimoto.length).toBeGreaterThan(0);
    const bajaj = catalog.brands.find((b) => b.brand === 'BAJAJ');
    expect(bajaj.lines.motocarro).toContain('RE 4S');
    expect(catalog.brands.find((b) => b.brand === 'MERCEDES-BENZ').lines.liviano.length).toBeGreaterThan(100);
    const canAm = catalog.brands.find((b) => b.brand === 'CAN-AM');
    expect(canAm.lines.moto).toContain('SPYDER RT');
    expect(canAm.lines.cuatrimoto).toContain('OUTLANDER 570');
    expect(canAm.lines.utv).toContain('MAVERICK X3');
  });
});

describe('constants/vehicleTypes', () => {
  test('cada tipo apunta a una clase del catálogo (o a ninguna)', () => {
    for (const t of VEHICLE_TYPES) {
      const cls = CATALOG_CLASS_BY_TYPE[t];
      expect(cls === null || CATALOG_CLASSES.includes(cls)).toBe(true);
    }
  });

  test('sin configurar, la empresa atiende todos los tipos', () => {
    expect(tenantVehicleTypes({})).toEqual(VEHICLE_TYPES);
    expect(tenantVehicleTypes({ vehicle_types: [] })).toEqual(VEHICLE_TYPES);
    expect(tenantVehicleTypes({ vehicle_types: ['motocicleta', 'nave'] })).toEqual(['motocicleta']);
  });

  test('sanitize deja solo tipos válidos, en orden y con "otro"', () => {
    expect(sanitizeVehicleTypes(['utv', 'motocicleta', 'utv', 'avion'])).toEqual(['motocicleta', 'utv', 'otro']);
    expect(sanitizeVehicleTypes([])).toEqual([]);
    expect(sanitizeVehicleTypes('x')).toBeUndefined();
  });
});
