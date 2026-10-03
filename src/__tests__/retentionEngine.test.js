// Motor de retenciones en compras: perfil del tenant, del proveedor y concepto por ítem.
const { computeRetentions, resolveFiscalProfile, resolveSupplierProfile } = require('../services/retentionEngine.service');

const UVT = 52374;
const profile = (fp = {}) => resolveFiscalProfile({ fiscal_profile: { uvt_value: UVT, is_agente_reteiva: true, ...fp } });
const supplier = (over = {}, rc = {}) => resolveSupplierProfile({ person_type: 'juridica', tax_regime: 'comun', ...over, retention_config: rc });
const items = (concept, subtotal, iva = 0) => [{ concept_id: concept, subtotal, tax_amount: iva }];
const line = (r, code) => r.lines.find((l) => l.code === code);

describe('retentionEngine', () => {
  it('compras generales PJ declarante: 2.5% sobre base >= 10 UVT', () => {
    const r = computeRetentions({ profile: profile(), supplierProfile: supplier(), items: items('compras', 1000000, 190000) });
    expect(line(r, '07')).toMatchObject({ rate: 2.5, amount: 25000 });
    expect(line(r, '05')).toMatchObject({ rate: 15, amount: 28500 });
  });

  it('compras bajo la base mínima (10 UVT) no generan ReteFuente', () => {
    const r = computeRetentions({ profile: profile(), supplierProfile: supplier(), items: items('compras', 10 * UVT - 1) });
    expect(line(r, '07')).toBeUndefined();
    expect(r.notes.join(' ')).toMatch(/menor a la mínima/);
  });

  it('persona natural NO declarante usa la tarifa de no declarantes (3.5%)', () => {
    const r = computeRetentions({ profile: profile(), supplierProfile: supplier({ person_type: 'natural' }, { is_declarante: false }), items: items('compras', 1000000) });
    expect(line(r, '07').rate).toBe(3.5);
  });

  it('honorarios: 11% PJ, 10% PN, sin base mínima', () => {
    const pj = computeRetentions({ profile: profile(), supplierProfile: supplier(), items: items('honorarios', 100000) });
    const pn = computeRetentions({ profile: profile(), supplierProfile: supplier({ person_type: 'natural' }), items: items('honorarios', 100000) });
    expect(line(pj, '07').rate).toBe(11);
    expect(line(pn, '07').rate).toBe(10);
  });

  it('tenant en Régimen Simple: sin ReteFuente', () => {
    const r = computeRetentions({ profile: profile({ regime: 'simple', is_agente_reteiva: false }), supplierProfile: supplier(), items: items('compras', 5000000, 950000) });
    expect(line(r, '07')).toBeUndefined();
    expect(r.notes.join(' ')).toMatch(/Régimen Simple/);
  });

  it('proveedor autorretenedor: ReteFuente $0 pero ReteIVA sigue', () => {
    const r = computeRetentions({ profile: profile(), supplierProfile: supplier({}, { is_autoretenedor: true }), items: items('compras', 1000000, 190000) });
    expect(line(r, '07')).toBeUndefined();
    expect(line(r, '05').amount).toBe(28500);
  });

  it('proveedor gran contribuyente: sin ReteIVA; ReteFuente sigue', () => {
    const r = computeRetentions({ profile: profile(), supplierProfile: supplier({}, { is_gran_contribuyente: true }), items: items('compras', 1000000, 190000) });
    expect(line(r, '05')).toBeUndefined();
    expect(line(r, '07').amount).toBe(25000);
  });

  it('proveedor del Régimen Simple: sin ReteFuente', () => {
    const r = computeRetentions({ profile: profile(), supplierProfile: supplier({ tax_regime: 'simple' }), items: items('servicios', 1000000) });
    expect(line(r, '07')).toBeUndefined();
  });

  it('tenant no agente de ReteIVA: sin ReteIVA', () => {
    const r = computeRetentions({ profile: profile({ is_agente_reteiva: false }), supplierProfile: supplier(), items: items('compras', 1000000, 190000) });
    expect(line(r, '05')).toBeUndefined();
  });

  it('compra mixta: base mínima por concepto, una línea por concepto', () => {
    const r = computeRetentions({
      profile: profile(),
      supplierProfile: supplier(),
      items: [
        { concept_id: 'compras', subtotal: 600000 },
        { concept_id: 'servicios', subtotal: 300000 },   // 4 UVT = 209.496 → aplica
        { concept_id: 'compras', subtotal: 100000 },
      ],
    });
    const rf = r.lines.filter((l) => l.code === '07');
    expect(rf).toHaveLength(2);
    expect(rf.find((l) => l.concept_id === 'compras')).toMatchObject({ base: 700000, amount: 17500 });
    expect(rf.find((l) => l.concept_id === 'servicios')).toMatchObject({ base: 300000, amount: 12000 });
  });

  it('líneas manuales no pueden saltarse exclusiones legales', () => {
    const r = computeRetentions({
      profile: profile(),
      supplierProfile: supplier({}, { is_autoretenedor: true }),
      items: items('compras', 1000000, 190000),
      requested: [{ code: '07', rate: 2.5, concept: 'Compras' }, { code: '05', rate: 15, concept: 'ReteIVA' }],
    });
    expect(line(r, '07')).toBeUndefined();
    expect(line(r, '05')).toBeDefined();
  });

  it('ReteICA del proveedor (‰ municipal)', () => {
    const r = computeRetentions({ profile: profile(), supplierProfile: supplier({}, { retentions: [{ code: '06', concept: 'ICA Medellín', rate: 7, is_default: true }] }), items: items('compras', 1000000) });
    expect(line(r, '06')).toMatchObject({ rate: 7, amount: 7000 });
  });
});
