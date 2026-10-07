// IBC (ibc.service.js), jornada (Ley 2101) y planilla PILA (pilaCalc +
// pilaLayout). Los casos de la PILA replican una planilla real aceptada por
// el operador (septiembre de 2026, empleador exonerado Art. 114-1).
const { calcularIBC } = require('../services/payroll/ibc.service');
const { weeklyHoursFor, monthlyHoursFor } = require('../services/payroll/jornada');
const { computeCotizante, diasComerciales } = require('../services/payroll/pila/pilaCalc');
const { buildDetail, buildHeader, R1_LENGTH, R2_LENGTH, parseRecord, R2 } = require('../services/payroll/pila/pilaLayout');
const { liquidarEmpleado } = require('../services/payroll/payrollService');

const SMLMV = 1750905;
const baseEmployee = {
  id: 'e1', document_type: '13', document_number: '1152710849', worker_type: '01', worker_subtype: '00',
  first_name: 'Gisela', other_names: '', first_surname: 'González', second_surname: 'Arias',
  base_salary: 2150000, salary_type: 'ordinario', hire_date: '2025-01-01', arl_risk_class: 1,
  work_city_code: '05001', pila_work_center: '2', arl_economic_activity: '1701001',
};
const mes = { start_date: '2026-09-01', end_date: '2026-09-30' };

describe('jornada (Ley 2101)', () => {
  test('reducción gradual y horas del mes', () => {
    expect(weeklyHoursFor('2025-07-14')).toBe(46);
    expect(weeklyHoursFor('2025-07-15')).toBe(44);
    expect(weeklyHoursFor('2026-09-30')).toBe(42);
    expect(monthlyHoursFor('2026-09-30')).toBe(210);
    expect(monthlyHoursFor('2026-09-30', 44)).toBe(220);
  });
});

describe('IBC', () => {
  test('incluye horas extra y comisiones (VST)', () => {
    const r = calcularIBC({
      employee: baseEmployee,
      devengados: { basico: { diasTrabajados: 30 }, heds: [{ cantidad: 2, pago: 25000 }], comisiones: [11648] },
      diasPeriodo: 30, smlmv: SMLMV,
    });
    expect(r.ibc).toBeCloseTo(2186648, 2);
    expect(r.vst).toBe(true);
  });

  test('incapacidad sin descontar del básico: esos días se toman una sola vez', () => {
    const r = calcularIBC({
      employee: baseEmployee,
      devengados: { basico: { diasTrabajados: 30 }, incapacidades: [{ cantidad: 5, pago: 240000, tipo: '1' }] },
      diasPeriodo: 30, smlmv: SMLMV,
    });
    // 25 días de salario + la incapacidad
    expect(r.ibc).toBeCloseTo((2150000 / 30) * 25 + 240000, 2);
    expect(r.diasCotizados).toBe(30);
  });

  test('pagos no salariales sobre el 40% suman al IBC (Ley 1393)', () => {
    const r = calcularIBC({
      employee: baseEmployee,
      devengados: { basico: { diasTrabajados: 30 }, bonificaciones: [{ bonificacionNS: 2000000 }] },
      diasPeriodo: 30, smlmv: SMLMV,
    });
    const total = 2150000 + 2000000;
    expect(r.exceso40).toBeCloseTo(2000000 - 0.4 * total, 2);
    expect(r.ibc).toBeCloseTo(2150000 + (2000000 - 0.4 * total), 2);
  });

  test('integral al 70% y mínimo de 1 SMLMV', () => {
    expect(calcularIBC({ employee: { ...baseEmployee, salary_type: 'integral', base_salary: 30000000 }, devengados: { basico: { diasTrabajados: 30 } }, diasPeriodo: 30, smlmv: SMLMV }).ibc)
      .toBeCloseTo(21000000, 2);
    expect(calcularIBC({ employee: { ...baseEmployee, base_salary: 1000000 }, devengados: { basico: { diasTrabajados: 30 } }, diasPeriodo: 30, smlmv: SMLMV }).ibc)
      .toBeCloseTo(SMLMV, 2);
  });

  test('liquidarEmpleado descuenta salud y pensión sobre el IBC con horas extra', () => {
    const liq = liquidarEmpleado({
      employee: baseEmployee, period: mes,
      novedades: [{ dian_category: 'HEDs', payload: { cantidad: 2, porcentaje: 25, pago: 36648 } }],
    });
    expect(liq.ibc.ibc).toBeCloseTo(2186648, 2);
    expect(liq.deducciones.salud.deduccion).toBeCloseTo(2186648 * 0.04, 2);
  });
});

describe('PILA', () => {
  test('días comerciales', () => {
    expect(diasComerciales('2026-09-01', '2026-09-30')).toBe(30);
    expect(diasComerciales('2026-02-01', '2026-02-28')).toBe(30);
    expect(diasComerciales('2026-09-15', '2026-09-30')).toBe(16);
  });

  test('reproduce exactamente la línea de una planilla real', () => {
    const real = '0200001CC1152710849      0100  05001GONZALEZ            ARIAS                         GISELA                                                    X      00230301      EPS037      CCF03 30303030002150000F0021866480021866480021866480021866480.160000003499000000000000000000000003499000000000000000000000000000000.04000000087500000000000               000000000               0000000000.00522000000000020000115000.040000000875000000000000000000000000000000000000000000000000000000000000000000                  S14-11 1                                                                                                                                                       000000000220          1701001';
    expect(real.length).toBe(R2_LENGTH);
    const { fields, warnings } = computeCotizante({
      employee: baseEmployee,
      liquidations: [{ ibc: { ibc: 2186648, vst: true } }],
      period: { year: 2026, month: 9 },
      settings: { employer_exonerated_114_1: true, weekly_hours: 44 },
      codes: { eps: 'EPS037', afp: '230301', ccf: 'CCF03', arl: '14-11' },
      smlmv: SMLMV,
    });
    expect(warnings).toEqual([]);
    const linea = buildDetail({ secuencia: 1, ...fields });
    const a = parseRecord(R2, linea);
    const b = parseRecord(R2, real);
    for (const [name] of R2) expect(`${name}=${a[name]}`).toBe(`${name}=${b[name]}`);
    expect(linea).toBe(real);
  });

  test('ingreso en el mes, sin exoneración y FSP', () => {
    const { fields } = computeCotizante({
      employee: { ...baseEmployee, base_salary: 8000000, hire_date: '2026-09-16' },
      liquidations: [{ ibc: { ibc: 4000000 } }],
      period: { year: 2026, month: 9 },
      settings: { employer_exonerated_114_1: false },
      codes: { eps: 'EPS037', afp: '230301', ccf: 'CCF03', arl: '14-11' },
      smlmv: SMLMV,
    });
    expect(fields.ing).toBe('X');
    expect(fields.fechaIng).toBe('2026-09-16');
    expect(fields.diasEps).toBe(15);
    expect(fields.tarifaEps).toBe(0.125);
    expect(fields.cotizacionEps).toBe(500000);
    expect(fields.aporteSena).toBe(80000);
    expect(fields.aporteIcbf).toBe(120000);
    expect(fields.exonerado).toBe('N');
    expect(fields.horasLaboradas).toBe(105); // 15 días x 42 h / 6
    // 4.000.000 >= 4 SMLMV? no (7.003.620): sin FSP
    expect(fields.fsp).toBe(0);
  });

  test('aprendiz en etapa lectiva: solo salud', () => {
    const { fields } = computeCotizante({
      employee: { ...baseEmployee, worker_type: '12', base_salary: 1313179 },
      liquidations: [{ ibc: { ibc: 1313179 } }],
      period: { year: 2026, month: 9 },
      settings: { employer_exonerated_114_1: true },
      codes: { eps: 'EPS037', ccf: 'CCF03', arl: '14-11' },
      smlmv: SMLMV,
    });
    expect([fields.diasAfp, fields.diasEps, fields.diasArl, fields.diasCcf]).toEqual([0, 30, 0, 0]);
    expect(fields.tarifaEps).toBe(0.125);
    expect(fields.cotizacionEps).toBe(164200);
    expect(fields.cotizacionArl).toBe(0);
  });

  test('encabezado de 359 posiciones', () => {
    const h = buildHeader({ modalidad: '0', secuencia: 1, razonSocial: 'Cda motos la 58', tipoDoc: 'NI', nit: '901935249', dv: 8, tipoPlanilla: 'E', formaPresentacion: 'U', codigoArl: '14-11', periodoPension: '2026-09', periodoSalud: '2026-10', numeroCotizantes: 5, valorNomina: 14363473, tipoAportante: '01', codigoOperador: '00' });
    expect(h.length).toBe(R1_LENGTH);
    expect(h.endsWith('2026-092026-10                    000050000143634730100')).toBe(true);
  });
});

describe('nómina: ausencias y deducciones por tipo de trabajador', () => {
  test('la incapacidad descuenta sus días del básico (no se paga doble)', () => {
    const liq = liquidarEmpleado({
      employee: baseEmployee, period: mes,
      novedades: [{ dian_category: 'Incapacidades', payload: [{ fechaInicio: '2026-09-10', fechaFin: '2026-09-14', cantidad: 5, tipo: '1', pago: 240000 }] }],
    });
    expect(liq.devengados.basico.diasTrabajados).toBe(25);
    expect(liq.devengados.basico.sueldoTrabajado).toBeCloseTo((2150000 / 30) * 25, 2);
    expect(liq.ibc.ibc).toBeCloseTo((2150000 / 30) * 25 + 240000, 2);
  });

  test('vacaciones disfrutadas y licencias descuentan; compensadas no', () => {
    const liq = liquidarEmpleado({
      employee: baseEmployee, period: mes,
      novedades: [
        { dian_category: 'Vacaciones', payload: { comunes: [{ cantidad: 6, pago: 430000 }], compensadas: [{ cantidad: 3, pago: 215000 }] } },
        { dian_category: 'Licencias', payload: { noRemunerada: [{ cantidad: 2 }] } },
      ],
    });
    expect(liq.devengados.basico.diasTrabajados).toBe(22);
  });

  test('aprendiz: sin descuentos de salud ni pensión', () => {
    const liq = liquidarEmpleado({ employee: { ...baseEmployee, worker_type: '19' }, period: mes });
    expect(liq.deducciones.salud).toEqual({ porcentaje: 0, deduccion: 0 });
    expect(liq.deducciones.fondoPension).toEqual({ porcentaje: 0, deduccion: 0 });
  });

  test('pensionado: salud sí, pensión y FSP no', () => {
    const liq = liquidarEmpleado({ employee: { ...baseEmployee, worker_subtype: '01', base_salary: 9000000 }, period: mes });
    expect(liq.deducciones.salud.porcentaje).toBe(4);
    expect(liq.deducciones.fondoPension.deduccion).toBe(0);
    expect(liq.deducciones.fondoSP).toBeUndefined();
  });
});

describe('PILA: lectura de una planilla existente', () => {
  const { parsePilaFile } = require('../services/payroll/pila/pilaImport.service');

  test('lee el TXT (con BOM y CRLF) generado con el layout estándar', async () => {
    const header = buildHeader({ modalidad: '0', secuencia: 1, razonSocial: 'Cda motos la 58', tipoDoc: 'NI', nit: '901935249', dv: 8, tipoPlanilla: 'E', formaPresentacion: 'U', codigoArl: '14-11', periodoPension: '2026-09', periodoSalud: '2026-10', numeroCotizantes: 1, valorNomina: 2186648, tipoAportante: '01', codigoOperador: '00' });
    const { fields } = computeCotizante({
      employee: baseEmployee, liquidations: [{ ibc: { ibc: 2186648, vst: true } }], period: { year: 2026, month: 9 },
      settings: { employer_exonerated_114_1: true, weekly_hours: 44 }, codes: { eps: 'EPS037', afp: '230301', ccf: 'CCF03', arl: '14-11' }, smlmv: SMLMV,
    });
    const file = Buffer.from(`\uFEFF${header}\r\n${buildDetail({ secuencia: 1, ...fields })}\r\n`, 'utf8');
    const parsed = await parsePilaFile(file, 'planilla.txt');
    expect(parsed.header.nit).toBe('901935249');
    expect(parsed.header.codigoArl).toBe('14-11');
    expect(parsed.details).toHaveLength(1);
    expect(parsed.details[0]).toMatchObject({ documento: '1152710849', eps: 'EPS037', afp: '230301', ccf: 'CCF03', claseRiesgo: '1', actividadArl: '1701001', departamento: '05', municipio: '001' });
  });

  test('rechaza un archivo que no es PILA', async () => {
    await expect(parsePilaFile(Buffer.from('hola\r\nmundo'), 'x.txt')).rejects.toThrow(/no parece una planilla PILA/);
  });
});

describe('PILA en Excel: plantilla aprendida de una muestra', () => {
  const ExcelJS = require('exceljs');
  const { learnTemplate, renderExcel, sanitizeTemplate } = require('../services/payroll/pila/pilaExcel.service');
  const DEFAULT_TEMPLATE = require('../data/pila-excel-default-template.json');

  const fieldsDe = () => computeCotizante({
    employee: baseEmployee, liquidations: [{ ibc: { ibc: 2186648, vst: true } }], period: { year: 2026, month: 9 },
    settings: { employer_exonerated_114_1: true, weekly_hours: 44 }, codes: { eps: 'EPS037', afp: '230301', ccf: 'CCF03', arl: '14-11' }, smlmv: SMLMV,
  }).fields;

  test('reconoce columnas en otro orden, con otros nombres y tarifas en porcentaje', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Detalle');
    ws.addRow(['Cédula', 'Tipo doc', 'Primer apellido', 'Primer nombre', 'Días salud', 'IBC salud', 'Tarifa salud', 'Valor salud', 'Columna rara']);
    ws.addRow(['123', 'CC', 'PEREZ', 'ANA', 30, 1750905, 4, 70100, 'x']);
    const { template, unmapped, hasHeaderSection } = await learnTemplate(Buffer.from(await wb.xlsx.writeBuffer()), 'muestra.xlsx');
    const cols = template.sections[0].columns;
    expect(hasHeaderSection).toBe(false);
    expect(cols.map((c) => c.field)).toEqual(['documento', 'tipoDoc', 'primerApellido', 'primerNombre', 'diasEps', 'ibcEps', 'tarifaEps', 'cotizacionEps', null]);
    expect(cols.find((c) => c.field === 'tarifaEps').scale).toBe(100);
    expect(unmapped).toEqual([{ kind: 'r2', col: 9, label: 'Columna rara' }]);

    const out = new ExcelJS.Workbook();
    await out.xlsx.load(await renderExcel(template, {}, [{ secuencia: 1, ...fieldsDe() }, { secuencia: 2, ...fieldsDe(), documento: '999' }]));
    const sheet = out.getWorksheet('Detalle');
    expect(sheet.getRow(1).getCell(1).value).toBe('Cédula');
    expect(sheet.getRow(2).values.slice(1, 9)).toEqual(['1152710849', 'CC', 'GONZALEZ', 'GISELA', 30, 2186648, 4, 87500]);
    expect(sheet.getRow(3).getCell(1).value).toBe('999');
    expect(sheet.getRow(2).getCell(9).value).toBeNull();
  });

  test('la plantilla estándar sale igual que el TXT, campo por campo', async () => {
    const fields = fieldsDe();
    const out = new ExcelJS.Workbook();
    await out.xlsx.load(await renderExcel(DEFAULT_TEMPLATE, { razonSocial: 'Cda motos la 58', nit: '901935249', dv: 8, tipoPlanilla: 'E', tipoDoc: 'NI' }, [{ secuencia: 1, ...fields }]));
    const ws = out.worksheets[0];
    expect(ws.getRow(2).getCell(4).value).toBe('Cda motos la 58');
    const det = ws.getRow(4).values.slice(1);
    expect(det.length).toBe(98);
    expect(det[3]).toBe('1152710849');
    expect(det[42]).toBe(2186648); // IBC EPS
    expect(det[45]).toBe(0.16); // tarifa AFP
    expect(det[46]).toBe(349900);
    expect(det[97]).toBe('1701001');
  });

  test('sanitiza una plantilla editada (campos duplicados o inexistentes)', () => {
    const t = sanitizeTemplate({ sections: [{ kind: 'r2', sheet: 'X', labelRow: 1, dataStartRow: 2, columns: [
      { col: 1, label: 'a', field: 'documento' }, { col: 2, label: 'b', field: 'documento' }, { col: 3, label: 'c', field: 'hackeado' },
    ] }] });
    expect(t.sections[0].columns.map((c) => c.field)).toEqual(['documento', null, null]);
    expect(() => sanitizeTemplate({ sections: [] })).toThrow();
  });
});

describe('PILA: una línea por novedad', () => {
  const calc = (devengados, extra = {}) => computeCotizante({
    employee: baseEmployee,
    liquidations: [{ devengados, ibc: { ibc: extra.ibc ?? 2150000 } }],
    period: { year: 2026, month: 9 },
    settings: { employer_exonerated_114_1: true, weekly_hours: 44 },
    codes: { eps: 'EPS037', afp: '230301', ccf: 'CCF03', arl: '14-11' },
    smlmv: SMLMV,
    unpaidDays: extra.unpaidDays || 0,
  });

  test('incapacidad, vacaciones y licencia no remunerada en líneas separadas', () => {
    const salarioDia = 2150000 / 30;
    const { lines, summary } = calc({
      incapacidades: [{ fechaInicio: '2026-09-03', fechaFin: '2026-09-07', cantidad: 5, tipo: '1', pago: 300000 }],
      vacaciones: { comunes: [{ fechaInicio: '2026-09-14', fechaFin: '2026-09-19', cantidad: 6, pago: 430000 }] },
      licencias: { noRemunerada: [{ fechaInicio: '2026-09-25', fechaFin: '2026-09-26', cantidad: 2 }] },
    }, { ibc: salarioDia * 17 + 300000 + 430000 });
    expect(lines).toHaveLength(4);
    const [normal, ige, vac, sln] = lines;

    expect([normal.diasEps, normal.diasArl, normal.diasCcf]).toEqual([17, 17, 17]);
    expect(normal.ibcEps).toBe(Math.ceil(salarioDia * 17));
    expect(normal.horasLaboradas).toBe(Math.round((17 * 44) / 6));

    expect(ige).toMatchObject({ ige: 'X', fechaIgeInicio: '2026-09-03', fechaIgeFin: '2026-09-07', diasEps: 5, diasAfp: 5, diasArl: 0, diasCcf: 0, cotizacionArl: 0, horasLaboradas: 0 });
    expect(ige.ibcEps).toBe(300000);

    expect(vac).toMatchObject({ vacLr: 'X', fechaVacInicio: '2026-09-14', diasEps: 6, diasArl: 0, diasCcf: 6 });
    expect(vac.aporteCcf).toBe(Math.ceil((430000 * 0.04) / 100) * 100);

    // SLN: pensión 12% (empleador), salud 0%, sin ARL ni caja; IBC = salario proporcional (mínimo 1 SMLMV proporcional)
    const ibcSln = Math.max(Math.ceil(salarioDia * 2), Math.ceil((SMLMV * 2) / 30));
    expect(sln).toMatchObject({ sln: 'X', diasAfp: 2, diasEps: 2, diasArl: 0, diasCcf: 0, tarifaAfp: 0.12, tarifaEps: 0, cotizacionEps: 0, ibcAfp: ibcSln });

    expect(summary.dias).toBe(30);
    expect(summary.lineas).toBe(4);
    expect(summary.novedades).toEqual(expect.arrayContaining(['ige', 'vacLr', 'sln']));
  });

  test('dos incapacidades separadas van en dos líneas, ING en la primera', () => {
    const { lines } = computeCotizante({
      employee: { ...baseEmployee, hire_date: '2026-09-01' },
      liquidations: [{ devengados: { incapacidades: [
        { fechaInicio: '2026-09-20', fechaFin: '2026-09-21', cantidad: 2, tipo: '1', pago: 100000 },
        { fechaInicio: '2026-09-05', fechaFin: '2026-09-07', cantidad: 3, tipo: '2', pago: 215000 },
      ] }, ibc: { ibc: 2150000 } }],
      period: { year: 2026, month: 9 }, settings: {}, codes: { eps: 'EPS037', afp: '230301', ccf: 'CCF03', arl: '14-11' }, smlmv: SMLMV,
    });
    expect(lines.map((l) => [l.diasEps, l.ige || '', l.irl])).toEqual([[25, '', 0], [3, '', 3], [2, 'X', 0]]);
    expect(lines[0]).toMatchObject({ ing: 'X', fechaIng: '2026-09-01' });
    expect(lines[1]).toMatchObject({ fechaIrlInicio: '2026-09-05', fechaIrlFin: '2026-09-07', diasArl: 0 });
    // El IBC de la incapacidad no baja del mínimo proporcional
    expect(lines[2].ibcEps).toBe(Math.max(100000, Math.ceil((SMLMV * 2) / 30)));
  });

  test('cada línea mide 693 posiciones', () => {
    const { lines } = calc({ incapacidades: [{ fechaInicio: '2026-09-03', fechaFin: '2026-09-07', cantidad: 5, tipo: '1', pago: 300000 }] });
    for (const [i, l] of lines.entries()) expect(buildDetail({ secuencia: i + 1, ...l }).length).toBe(R2_LENGTH);
  });
});
