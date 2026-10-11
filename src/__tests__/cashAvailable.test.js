// Salida de efectivo de la caja abierta: debe haber ese efectivo según el cuadre.
const mockExpected = jest.fn();
jest.mock('../controllers/finance/cashSessions.controller', () => ({
  calculateExpected: (...a) => mockExpected(...a),
  normalizeMethod: (m) => (/efectivo|cash/i.test(m) ? 'efectivo' : 'transferencia'),
}));
const { assertCashAvailable } = require('../services/finance/cashSession.service');

test('efectivo suficiente: pasa', async () => {
  mockExpected.mockResolvedValue({ expected: { efectivo: 50000 } });
  await expect(assertCashAvailable({ id: 'cs1' }, 50000, 'Efectivo')).resolves.toBeUndefined();
});

test('efectivo insuficiente: error 400 con lo disponible', async () => {
  mockExpected.mockResolvedValue({ expected: { efectivo: 20000 } });
  await expect(assertCashAvailable({ id: 'cs1' }, 50000, 'Efectivo')).rejects.toMatchObject({ status: 400 });
});

test('otros medios o sin caja (sin Tesorería): no valida', async () => {
  mockExpected.mockClear();
  await expect(assertCashAvailable({ id: 'cs1' }, 999999, 'Transferencia')).resolves.toBeUndefined();
  await expect(assertCashAvailable(null, 999999, 'Efectivo')).resolves.toBeUndefined();
  expect(mockExpected).not.toHaveBeenCalled();
});
