const { resolveRubros, isRubroValidForType, ruleRubro, NIIF_RUBROS, niifGroupOf } = require('../data/niifRubros');

const acc = (id, code, account_type, parent_id = null, niif_rubro = null) => ({ id, code, account_type, parent_id, niif_rubro });

describe('niifRubros', () => {
  test('regla por prefijo PUC: gana el prefijo más largo', () => {
    expect(ruleRubro('110505', 'activo')).toBe('efectivo');
    expect(ruleRubro('135515', 'activo')).toBe('activos_impuestos_corrientes');
    expect(ruleRubro('130505', 'activo')).toBe('deudores_comerciales');
    expect(ruleRubro('139905', 'activo')).toBe('deudores_comerciales'); // deterioro resta dentro del rubro
    expect(ruleRubro('159205', 'activo')).toBe('ppe');
    expect(ruleRubro('171076', 'activo')).toBe('activo_impuesto_diferido');
    expect(ruleRubro('236505', 'pasivo')).toBe('pasivos_impuestos_corrientes');
    expect(ruleRubro('233505', 'pasivo')).toBe('proveedores_cxp');
    expect(ruleRubro('237005', 'pasivo')).toBe('beneficios_empleados_corrientes');
    expect(ruleRubro('272505', 'pasivo')).toBe('pasivo_impuesto_diferido');
    expect(ruleRubro('280505', 'pasivo')).toBe('otros_pasivos_corrientes');
    expect(ruleRubro('370505', 'patrimonio')).toBe('ganancias_acumuladas');
    expect(ruleRubro('373005', 'patrimonio')).toBe('adopcion_niif');
    expect(ruleRubro('383005', 'patrimonio')).toBe('ori_acumulado');
    expect(ruleRubro('380505', 'patrimonio')).toBe('otras_partidas_patrimonio');
    expect(ruleRubro('421005', 'ingreso')).toBe('ingresos_financieros');
    expect(ruleRubro('429505', 'ingreso')).toBe('otros_ingresos');
    expect(ruleRubro('530505', 'gasto')).toBe('costos_financieros');
    expect(ruleRubro('531015', 'gasto')).toBe('otros_gastos');
    expect(ruleRubro('540505', 'gasto')).toBe('impuesto_ganancias');
    expect(ruleRubro('613501', 'costo')).toBe('costo_ventas');
  });

  test('la regla no aplica si el tipo de cuenta no coincide', () => {
    // Un código 13 creado como pasivo no puede quedar en un rubro de activo.
    expect(ruleRubro('130599', 'pasivo')).toBeNull();
  });

  test('rubro propio > heredado del padre > regla > sin clasificar', () => {
    const accounts = [
      acc('c2', '2', 'pasivo'),
      acc('g21', '21', 'pasivo', 'c2'),
      acc('a210505', '210505', 'pasivo', 'g21'),
      acc('g2120', '2120', 'pasivo', 'g21', 'obligaciones_financieras_no_corrientes'),
      acc('a212005', '212005', 'pasivo', 'g2120'),
      acc('a212010', '212010', 'pasivo', 'g2120', 'obligaciones_financieras_corrientes'),
      acc('x', '99', 'pasivo', 'c2'),
    ];
    const r = resolveRubros(accounts);
    expect(r.get('a210505')).toEqual({ rubro: 'obligaciones_financieras_corrientes', source: 'regla' });
    expect(r.get('g2120')).toEqual({ rubro: 'obligaciones_financieras_no_corrientes', source: 'cuenta' });
    expect(r.get('a212005')).toEqual({ rubro: 'obligaciones_financieras_no_corrientes', source: 'heredado' });
    expect(r.get('a212010')).toEqual({ rubro: 'obligaciones_financieras_corrientes', source: 'cuenta' });
    expect(r.get('x').source).toBe('sin_clasificar');
    expect(r.get('c2').source).toBe('clase');
  });

  test('un rubro guardado inválido para el tipo se ignora', () => {
    const r = resolveRubros([acc('a', '143501', 'activo', null, 'proveedores_cxp')]);
    expect(r.get('a')).toEqual({ rubro: 'inventarios', source: 'regla' });
  });

  test('validez de rubros por tipo de cuenta', () => {
    expect(isRubroValidForType('ingresos_financieros', 'ingreso')).toBe(true);
    expect(isRubroValidForType('ingresos_financieros', 'gasto')).toBe(false);
    expect(isRubroValidForType('costos_financieros', 'gasto')).toBe(true);
    expect(isRubroValidForType('costo_ventas', 'gasto')).toBe(true);
    expect(isRubroValidForType('ppe', 'pasivo')).toBe(false);
    expect(isRubroValidForType('no_existe', 'activo')).toBe(false);
    // Todo account_type tiene al menos un rubro.
    for (const t of ['activo', 'pasivo', 'patrimonio', 'ingreso', 'gasto', 'costo']) {
      expect(NIIF_RUBROS.some((x) => isRubroValidForType(x.code, t))).toBe(true);
    }
  });

  test('grupo NIIF por defecto 2', () => {
    expect(niifGroupOf({})).toBe('2');
    expect(niifGroupOf({ business_config: { niif_group: '3' } })).toBe('3');
    expect(niifGroupOf({ business_config: { niif_group: '1' } })).toBe('2');
  });
});
