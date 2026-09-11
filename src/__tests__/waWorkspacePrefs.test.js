const { windowStatus, mergePrefs, DEFAULT_WA_WORKSPACE_PREFS } = require('../utils/waWorkspacePrefs');

const HOUR = 60 * 60 * 1000;

describe('windowStatus — ventana de servicio de 24h de Meta', () => {
  it('está abierta si el cliente escribió hace menos de 24h', () => {
    const result = windowStatus(new Date(Date.now() - 2 * HOUR));

    expect(result.open).toBe(true);
    expect(result.expires_at).not.toBeNull();
  });

  it('está cerrada si el último mensaje del cliente pasó las 24h', () => {
    const result = windowStatus(new Date(Date.now() - 25 * HOUR));

    expect(result.open).toBe(false);
    expect(result.label).toMatch(/plantilla/i);
  });

  it('está cerrada si el cliente nunca escribió', () => {
    expect(windowStatus(null).open).toBe(false);
  });

  it('se cierra justo al cruzar las 24h', () => {
    expect(windowStatus(new Date(Date.now() - 24 * HOUR + 1000)).open).toBe(true);
    expect(windowStatus(new Date(Date.now() - 24 * HOUR - 1000)).open).toBe(false);
  });
});

describe('mergePrefs', () => {
  it('completa con los valores por defecto lo que el asesor no configuró', () => {
    const prefs = mergePrefs({ show_ai_suggest: false });

    expect(prefs.show_ai_suggest).toBe(false);
    expect(prefs.show_pin).toBe(DEFAULT_WA_WORKSPACE_PREFS.show_pin);
  });

  it('devuelve los defaults cuando no hay preferencias guardadas', () => {
    expect(mergePrefs(null)).toEqual(DEFAULT_WA_WORKSPACE_PREFS);
  });
});
