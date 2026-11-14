// backend/src/data/payroll-funds-colombia.js
//
// Entidades de seguridad social y parafiscales más usadas en Colombia. Se
// cargan como proveedores marcados por tipo (Supplier.payroll_fund_types) al
// crear un tenant y, a pedido, desde Configuración de Nómina -- ver
// services/payroll/payrollFundsSeed.service.js.
//
// tax_id = NIT sin dígito de verificación (el DV se calcula donde se necesita,
// ver dianKitAdapter.computeNitCheckDigit). Antes de reportar en PILA o
// exógena conviene validar el NIT contra el RUT de cada entidad: fusiones,
// liquidaciones y cambios de razón social son frecuentes en el sector.
//
// pila_code: código de la administradora en la PILA. Son nacionales (iguales
// para todos los tenants). Fuentes:
//   - Cajas de compensación: Ministerio de Salud, "Administradoras de
//     afiliaciones a compensación familiar" (28-feb-2019).
//   - ARL y fondos de pensión: tabla de administradoras de la PILA (componente
//     R y P). Positiva = 14-23 (antes La Previsora Vida), AXA Colpatria = 14-4
//     (antes Seguros de Vida Colpatria).
//   - EPS: listado de códigos EAPB del Ministerio de Salud; en las EPS de ambos
//     regímenes se usa el código del régimen contributivo (Coosalud EPS042,
//     Mutual Ser EPS048, Savia Salud EPS040).
// pila_codes: código por tipo cuando una entidad cumple dos papeles (Compensar
// es EPS008 como EPS y CCF24 como caja). La planilla resuelve el código por
// tipo con services/payroll/pila/pilaCodes.js, así que aunque el proveedor del
// tenant no tenga código, se toma el del catálogo por su NIT.
// inactive: entidad que ya no recauda (ARL Mapfre cerró el ramo; el
// Ministerio ordenó bloquear sus aportes desde el 1-ene-2025): no se crea en
// tenants nuevos, pero conserva el código para las planillas anteriores.
//
// Tipos: eps | afp (pensión) | cesantias | arl | ccf (caja de compensación)
//        | sena | icbf

const PAYROLL_FUND_TYPES = ['eps', 'afp', 'cesantias', 'arl', 'ccf', 'sena', 'icbf'];

const PAYROLL_FUNDS_COLOMBIA = [
  // ── EPS ──
  { name: 'Nueva EPS', business_name: 'NUEVA EMPRESA PROMOTORA DE SALUD S.A.', tax_id: '900156264', pila_code: 'EPS037', types: ['eps'] },
  { name: 'EPS Sura', business_name: 'EPS Y MEDICINA PREPAGADA SURAMERICANA S.A.', tax_id: '800088702', pila_code: 'EPS010', types: ['eps'] },
  { name: 'EPS Sanitas', business_name: 'ENTIDAD PROMOTORA DE SALUD SANITAS S.A.S.', tax_id: '800251440', pila_code: 'EPS005', types: ['eps'] },
  { name: 'Salud Total EPS', business_name: 'SALUD TOTAL ENTIDAD PROMOTORA DE SALUD S.A.', tax_id: '800130907', pila_code: 'EPS002', types: ['eps'] },
  { name: 'Famisanar EPS', business_name: 'EPS FAMISANAR S.A.S.', tax_id: '830003564', pila_code: 'EPS017', types: ['eps'] },
  { name: 'Coosalud EPS', business_name: 'COOSALUD ENTIDAD PROMOTORA DE SALUD S.A.', tax_id: '900226715', pila_code: 'EPS042', types: ['eps'] },
  { name: 'Mutual Ser EPS', business_name: 'MUTUAL SER EPS', tax_id: '806008394', pila_code: 'EPS048', types: ['eps'] },
  { name: 'Aliansalud EPS', business_name: 'ALIANSALUD ENTIDAD PROMOTORA DE SALUD S.A.', tax_id: '830113831', pila_code: 'EPS001', types: ['eps'] },
  { name: 'SOS EPS', business_name: 'SERVICIO OCCIDENTAL DE SALUD S.A. - S.O.S.', tax_id: '805001157', pila_code: 'EPS018', types: ['eps'] },
  { name: 'Savia Salud EPS', business_name: 'ALIANZA MEDELLÍN ANTIOQUIA EPS S.A.S.', tax_id: '900604350', pila_code: 'EPS040', types: ['eps'] },
  // Compensar es EPS y caja de compensación con el mismo NIT.
  { name: 'Compensar', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR COMPENSAR', tax_id: '860066942', pila_code: 'EPS008', pila_codes: { eps: 'EPS008', ccf: 'CCF24' }, types: ['eps', 'ccf'] },

  // ── Pensión y cesantías ──
  { name: 'Colpensiones', business_name: 'ADMINISTRADORA COLOMBIANA DE PENSIONES - COLPENSIONES', tax_id: '900336004', pila_code: '25-14', types: ['afp'] },
  { name: 'Porvenir', business_name: 'SOCIEDAD ADMINISTRADORA DE FONDOS DE PENSIONES Y CESANTÍAS PORVENIR S.A.', tax_id: '800224808', pila_code: '230301', types: ['afp', 'cesantias'] },
  { name: 'Protección', business_name: 'ADMINISTRADORA DE FONDOS DE PENSIONES Y CESANTÍAS PROTECCIÓN S.A.', tax_id: '800138188', pila_code: '230201', types: ['afp', 'cesantias'] },
  { name: 'Colfondos', business_name: 'COLFONDOS S.A. PENSIONES Y CESANTÍAS', tax_id: '800149496', pila_code: '231001', types: ['afp', 'cesantias'] },
  { name: 'Skandia', business_name: 'SKANDIA ADMINISTRADORA DE FONDOS DE PENSIONES Y CESANTÍAS S.A.', tax_id: '800148514', pila_code: '230901', types: ['afp', 'cesantias'] },
  { name: 'Fondo Nacional del Ahorro', business_name: 'FONDO NACIONAL DEL AHORRO', tax_id: '899999284', types: ['cesantias'] },

  // ── ARL ──
  { name: 'Positiva ARL', business_name: 'POSITIVA COMPAÑÍA DE SEGUROS S.A.', tax_id: '860011153', pila_code: '14-23', types: ['arl'] },
  { name: 'ARL Sura', business_name: 'SEGUROS DE VIDA SURAMERICANA S.A.', tax_id: '890903790', pila_code: '14-28', types: ['arl'] },
  { name: 'ARL Colmena', business_name: 'COLMENA SEGUROS RIESGOS LABORALES S.A.', tax_id: '800226175', pila_code: '14-25', types: ['arl'] },
  { name: 'ARL Bolívar', business_name: 'COMPAÑÍA DE SEGUROS BOLÍVAR S.A.', tax_id: '860002503', pila_code: '14-7', types: ['arl'] },
  { name: 'ARL AXA Colpatria', business_name: 'AXA COLPATRIA SEGUROS DE VIDA S.A.', tax_id: '860002183', pila_code: '14-4', types: ['arl'] },
  { name: 'ARL Seguros de Vida Alfa', business_name: 'SEGUROS DE VIDA ALFA S.A.', tax_id: '860503617', pila_code: '14-17', types: ['arl'] },
  { name: 'ARL La Equidad', business_name: 'LA EQUIDAD SEGUROS DE VIDA O.C.', tax_id: '830008686', pila_code: '14-29', types: ['arl'] },
  { name: 'ARL Mapfre', business_name: 'MAPFRE COLOMBIA VIDA SEGUROS S.A.', tax_id: '830054904', pila_code: '14-30', types: ['arl'], inactive: true },

  // ── Cajas de compensación familiar ──
  { name: 'Cafam', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR CAFAM', tax_id: '860013570', pila_code: 'CCF21', types: ['ccf'] },
  { name: 'Colsubsidio', business_name: 'CAJA COLOMBIANA DE SUBSIDIO FAMILIAR COLSUBSIDIO', tax_id: '860007336', pila_code: 'CCF22', types: ['ccf'] },
  { name: 'Comfacundi', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DE CUNDINAMARCA - COMFACUNDI', tax_id: '860045904', pila_code: 'CCF26', types: ['ccf'] },
  { name: 'Comfama', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DE ANTIOQUIA - COMFAMA', tax_id: '890900841', pila_code: 'CCF04', types: ['ccf'] },
  { name: 'Comfenalco Antioquia', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR COMFENALCO ANTIOQUIA', tax_id: '890900842', pila_code: 'CCF03', types: ['ccf'] },
  { name: 'Comfandi', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DEL VALLE DEL CAUCA - COMFANDI', tax_id: '890303208', pila_code: 'CCF57', types: ['ccf'] },
  { name: 'Comfenalco Valle', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR COMFENALCO VALLE DE LA GENTE', tax_id: '890303093', pila_code: 'CCF56', types: ['ccf'] },
  { name: 'Comfamiliar Atlántico', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR COMFAMILIAR ATLÁNTICO', tax_id: '890101994', pila_code: 'CCF07', types: ['ccf'] },
  { name: 'Combarranquilla', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DE BARRANQUILLA - COMBARRANQUILLA', tax_id: '890102002', pila_code: 'CCF06', types: ['ccf'] },
  { name: 'Cajacopi Atlántico', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR CAJACOPI ATLÁNTICO', tax_id: '890102044', pila_code: 'CCF05', types: ['ccf'] },
  { name: 'Comfenalco Cartagena', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DE FENALCO - COMFENALCO CARTAGENA', tax_id: '890480023', pila_code: 'CCF08', types: ['ccf'] },
  { name: 'Cajasan', business_name: 'CAJA SANTANDEREANA DE SUBSIDIO FAMILIAR - CAJASAN', tax_id: '890200106', pila_code: 'CCF39', types: ['ccf'] },
  { name: 'Comfenalco Santander', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR COMFENALCO SANTANDER', tax_id: '890201578', pila_code: 'CCF40', types: ['ccf'] },
  { name: 'Comfaboy', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DE BOYACÁ - COMFABOY', tax_id: '891800213', pila_code: 'CCF10', types: ['ccf'] },
  { name: 'Comfamiliar Risaralda', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DE RISARALDA - COMFAMILIAR RISARALDA', tax_id: '891480000', pila_code: 'CCF44', types: ['ccf'] },
  { name: 'Confa', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DE CALDAS - CONFA', tax_id: '890806490', pila_code: 'CCF11', types: ['ccf'] },
  { name: 'Comfenalco Tolima', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR COMFENALCO TOLIMA', tax_id: '890700148', pila_code: 'CCF50', types: ['ccf'] },
  { name: 'Comfamiliar Huila', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DEL HUILA - COMFAMILIAR', tax_id: '891180008', pila_code: 'CCF32', types: ['ccf'] },
  { name: 'Comfacauca', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DEL CAUCA - COMFACAUCA', tax_id: '891500182', pila_code: 'CCF14', types: ['ccf'] },
  { name: 'Comfamiliar Nariño', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DE NARIÑO', tax_id: '891280008', pila_code: 'CCF35', types: ['ccf'] },
  { name: 'Comfaoriente', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DEL ORIENTE COLOMBIANO - COMFAORIENTE', tax_id: '890500675', pila_code: 'CCF36', types: ['ccf'] },
  { name: 'Comfacesar', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DEL CESAR - COMFACESAR', tax_id: '892399989', pila_code: 'CCF15', types: ['ccf'] },
  { name: 'Comfacor', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DE CÓRDOBA - COMFACOR', tax_id: '891080005', pila_code: 'CCF16', types: ['ccf'] },
  { name: 'Comfasucre', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DE SUCRE - COMFASUCRE', tax_id: '892200015', pila_code: 'CCF41', types: ['ccf'] },
  { name: 'Comfaguajira', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DE LA GUAJIRA - COMFAGUAJIRA', tax_id: '892115006', pila_code: 'CCF30', types: ['ccf'] },
  { name: 'Cofrem', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR REGIONAL DEL META - COFREM', tax_id: '892000146', pila_code: 'CCF34', types: ['ccf'] },
  { name: 'Comfacasanare', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DE CASANARE - COMFACASANARE', tax_id: '844003392', pila_code: 'CCF69', types: ['ccf'] },
  { name: 'Comfaca', business_name: 'CAJA DE COMPENSACIÓN FAMILIAR DEL CAQUETÁ - COMFACA', tax_id: '891190047', pila_code: 'CCF13', types: ['ccf'] },

  // ── Parafiscales ──
  { name: 'SENA', business_name: 'SERVICIO NACIONAL DE APRENDIZAJE - SENA', tax_id: '899999034', types: ['sena'] },
  { name: 'ICBF', business_name: 'INSTITUTO COLOMBIANO DE BIENESTAR FAMILIAR - ICBF', tax_id: '899999239', types: ['icbf'] },
];

module.exports = { PAYROLL_FUND_TYPES, PAYROLL_FUNDS_COLOMBIA };
