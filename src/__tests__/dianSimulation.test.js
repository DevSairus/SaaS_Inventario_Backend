// Modo simulación DIAN (demo): completa la configuración, nunca envía a la
// DIAN y responde "aceptado" marcado como simulado.
const sim = require('../services/dian/dianSimulation');

jest.setTimeout(60000); // la primera llamada genera un certificado RSA 2048

describe('dianSimulation', () => {
  const tenant = { id: 't1', tax_id: '900123456-7', company_name: 'Demo SAS', dian_config: { environment: 'simulation' } };

  test('isSimulation acepta el tenant o el dian_config', () => {
    expect(sim.isSimulation(tenant)).toBe(true);
    expect(sim.isSimulation(tenant.dian_config)).toBe(true);
    expect(sim.isSimulation({ dian_config: { environment: 'test' } })).toBe(false);
    expect(sim.isSimulation({ dian_config: null })).toBe(false);
  });

  test('simulationConfig completa lo que falta, con certificado autofirmado', () => {
    const cfg = sim.simulationConfig(tenant);
    expect(cfg.nit).toBe('900123456');
    expect(cfg.dv).toMatch(/^\d$/);
    expect(cfg.company_name).toBe('Demo SAS');
    expect(cfg.software_id).toBeTruthy();
    expect(cfg.technical_key).toBeTruthy();
    expect(cfg.certificate_p12_base64).toBeTruthy();
    expect(cfg.certificate_password).toBeTruthy();
    expect(cfg.environment).toBe('simulation');
  });

  test('respeta los datos y el certificado que la empresa sí tiene', () => {
    const cfg = sim.simulationConfig({ ...tenant, dian_config: { environment: 'simulation', nit: '800111222', software_id: 'X', certificate_p12_base64: 'abc', certificate_password: 'p' } });
    expect(cfg.nit).toBe('800111222');
    expect(cfg.software_id).toBe('X');
    expect(cfg.certificate_p12_base64).toBe('abc');
  });

  test('fuera de simulación no toca nada', () => {
    const t = { id: 't2', dian_config: { environment: 'production', nit: '1' } };
    expect(sim.simulationConfig(t)).toBe(t.dian_config);
    expect(sim.withSimulation(t)).toBe(t);
  });

  test('withSimulation conserva el resto del tenant', () => {
    const w = sim.withSimulation(tenant);
    expect(w.id).toBe('t1');
    expect(w.company_name).toBe('Demo SAS');
    expect(w.dian_config.software_id).toBeTruthy();
    expect(tenant.dian_config.software_id).toBeUndefined(); // el original no cambia
  });

  test('la respuesta simulada tiene la forma de una aceptada y queda marcada', () => {
    const r = sim.simulatedResponse('SIMF1', 'cufe123');
    expect(r.isValid).toBe(true);
    expect(r.statusCode).toBe('00');
    expect(r.simulated).toBe(true);
    expect(sim.isSimulatedDocument({ dian_response: r })).toBe(true);
    expect(sim.isSimulatedDocument({ dian_response: { isValid: true } })).toBe(false);
  });

  test('sendToDian no sale hacia la DIAN en simulación', async () => {
    const { sendToDian } = require('../services/dian/dianKitAdapter');
    const r = await sendToDian(tenant, { signedXml: '<x/>', invoiceNumber: 'SIMF9', cufe: 'abc' });
    expect(r.simulated).toBe(true);
    expect(r.isValid).toBe(true);
  });
});
