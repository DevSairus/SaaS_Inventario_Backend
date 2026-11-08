const { calculate, performanceRatio, budgetFromResults } = require('../services/solar/solarCalc');
const { parseEnergyBill } = require('../services/solar/energyBillParser');

const settings = {
  price_per_kwp: 1250000, labor_pct: 22, electrical_pct: 13, consulting_pct: 10, service_tax_pct: 19,
  performance_ratio: 0.8, default_hsp: 4.5, dc_ac_ratio: 1.2, panel_watts: 645, use_aiu: false,
  aiu_admin_pct: 10, aiu_unforeseen_pct: 5, aiu_profit_pct: 10,
};
const panel = { product_id: 'p', name: 'Panel 645 W', watts: 645, unit_price: 520000, tax_pct: 0, unit_cost: 400000 };
const inverter = { product_id: 'i', name: 'Inversor 5 kW', unit_price: 4200000, tax_pct: 0, quantity: 1 };

describe('cotizador solar: dimensionamiento', () => {
  test('eficiencia con factores del techo, orientación, inclinación y sombra', () => {
    expect(performanceRatio({ basePr: 0.8, roof: 'inclinado', orientation: 'norte', tilt: 10, shadingPct: 5 }).pr).toBe(0.76);
    expect(performanceRatio({ basePr: 0.8, roof: 'plano', orientation: 'sur', tilt: 40, shadingPct: 50 }).pr).toBe(0.4); // piso
  });

  test('500 kWh/mes con 4,5 HSP: paneles enteros y producción', () => {
    const r = calculate({ monthly_kwh: 500, tariff_kwh: 900, coverage_pct: 100, hsp: 4.5, roof: 'inclinado', orientation: 'norte', tilt: 10, shading_pct: 5, panel, inverter }, settings);
    // 500 / (4,5 × 30 × 0,76) = 4,873 kWp → 8 paneles de 645 W = 5,16 kWp
    expect(r.panels).toBe(8);
    expect(r.kwp).toBe(5.16);
    expect(r.production_month).toBe(529.42);
    expect(r.savings_month).toBe(476478);
    expect(r.suggested_inverter_kw).toBe(4.3);
  });

  test('precio: equipos del catálogo + servicios por kWp; IVA solo donde aplica', () => {
    const r = calculate({ monthly_kwh: 500, tariff_kwh: 900, hsp: 4.5, panel, inverter }, settings);
    const by = Object.fromEntries(r.lines.map((l) => [l.kind, l.subtotal]));
    expect(by.panel).toBe(8 * 520000);
    expect(by.inverter).toBe(4200000);
    expect(by.labor).toBe(Math.round(5.16 * 1250000 * 0.22 * 100) / 100);
    expect(r.taxes).toBe(Math.round((by.labor + by.electrical + by.consulting) * 0.19 * 100) / 100);
    expect(r.total).toBe(Math.round((r.direct + r.taxes) * 100) / 100);
  });

  test('con AIU: servicios sin IVA y el IVA va sobre la utilidad', () => {
    const r = calculate({ monthly_kwh: 500, tariff_kwh: 900, hsp: 4.5, panel, inverter }, { ...settings, use_aiu: true });
    expect(r.lines.every((l) => l.tax_pct === 0)).toBe(true);
    expect(r.aiu.total).toBe(Math.round(r.direct * 0.25 * 100) / 100);
    expect(r.taxes).toBe(Math.round(r.aiu.profit * 0.19 * 100) / 100);
  });

  test('presupuesto de costos: equipos al costo, servicios a su valor', () => {
    const r = calculate({ monthly_kwh: 500, tariff_kwh: 900, hsp: 4.5, panel, inverter }, settings);
    const b = budgetFromResults(r);
    const electrical = r.lines.find((l) => l.kind === 'electrical').subtotal;
    expect(b.materials).toBe(8 * 400000 + 4200000 + electrical);
    expect(b.labor).toBe(r.lines.find((l) => l.kind === 'labor').subtotal);
  });

  test('sin consumo no calcula', () => {
    expect(() => calculate({ monthly_kwh: 0 }, settings)).toThrow('consumo');
  });
});

describe('cotizador solar: factura de energía', () => {
  test('lee consumo, tarifa, total, ciudad, operador, periodo y estrato', () => {
    const text = `CELSIA S.A. E.S.P.\nSUSCRIPTOR: MARIA FERNANDA LOPEZ\nCC 1098765432\nIBAGUÉ - TOLIMA\nESTRATO 4\nPERIODO FACTURADO OCTUBRE 2026\nCONSUMO ACTIVA 486 KWH\nTARIFA KWH $ 912,35\nTOTAL A PAGAR $ 443.402`;
    const r = parseEnergyBill(text);
    expect(r.monthly_kwh).toBe(486);
    expect(r.tariff_kwh).toBe(912.35);
    expect(r.bill_total).toBe(443402);
    expect(r.city).toBe('Ibagué');
    expect(r.operator).toBe('CELSIA');
    expect(r.period).toBe('Octubre 2026');
    expect(r.stratum).toBe(4);
  });
  test('sin tarifa explícita la calcula con total y consumo', () => {
    const r = parseEnergyBill('Consumo 300 kWh\nTotal a pagar $ 270.000');
    expect(r.tariff_kwh).toBe(900);
  });
  test('factura leída por el OCR propio: historial → promedio, titular y dirección sin arrastrar líneas', () => {
    const text = [
      'CELSIA COLOMBIA S.A. E.S.P.', 'NIT 800.249.860-1 Factura de servicio de energia', '',
      'SUSCRIPTOR: MARIA FERNANDA LOPEZ', '', 'Direccion: CRA 5 # 60-12 BARRIO LA FLORESTA', '',
      'IBAGUE - TOLIMA ESTRATO 4 Uso: RESIDENCIAL', 'Periodo facturado: OCTUBRE 2026', '',
      'CONSUMO ACTIVA 486 KWH', '', 'Historico de consumo (kWh)',
      'MAY 2026 452 kWh', 'JUN 2026 470 kWh', 'JUL 2026 498 kWh', 'AGO 2026 510 kWh', 'SEP 2026 477 kWh', 'OCT 2026 486 kWh', '',
      'Tarifa kWh $ 912,35', 'Valor energia $ 443.402', 'TOTAL A PAGAR $ 461.902', 'Pague antes de: 25 NOVIEMBRE 2026',
    ].join('\n');
    const r = parseEnergyBill(text);
    expect(r.holder).toBe('MARIA FERNANDA LOPEZ');
    expect(r.address).toBe('CRA 5 # 60-12 BARRIO LA FLORESTA');
    expect(r.history_kwh).toHaveLength(6);
    expect(r.average_kwh).toBe(482);
    expect(r.monthly_kwh).toBe(482);
    expect(r.last_month_kwh).toBe(486);
    expect(r.tariff_kwh).toBe(912.35);
    expect(r.bill_total).toBe(461902);
  });
  test('sin sección de histórico, un año no pasa por consumo', () => {
    const r = parseEnergyBill('Periodo: OCTUBRE 2026\nConsumo 300 kWh\nPague antes de: 25 NOVIEMBRE 2026');
    expect(r.history_kwh).toBeUndefined();
    expect(r.monthly_kwh).toBe(300);
  });
  test('EPM multiservicio con columnas mezcladas: el consumo sale del renglón facturado', () => {
    const text = [
      'Dirección prestación servicio: CR 54 CL 36 -69 (INTERIOR 501 ) Municipio: Itagüí - Antioquia',
      'Lectura actual Lectura anterior constante consumo Meta periodo: 129,99 kWh',
      '14.611 - 14.466 X 1 = 0kWh 55,33 kWh Consumo en investigación',
      'Energía oct-26 145 960,340 $ 139.249,30',
      'Gas 8,592 m3 $ 33.553,35 Prec M3-Kwh 298,92',
      'Acueducto 9 m3 $ 70.890,48',
      'Energía 145 Kwh $ 129.350,19',
    ].join('\n');
    const r = parseEnergyBill(text);
    expect(r.monthly_kwh).toBe(145);
    expect(r.address).toBe('CR 54 CL 36 -69 (INTERIOR 501 )');
    expect(r.city).toBe('Itagüí');
    expect(r.tariff_kwh).toBe(892.07);
  });
});
