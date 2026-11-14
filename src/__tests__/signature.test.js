const { validateSignature, signatureBuffer, SIGNATURE_MAX } = require('../utils/signature');

// PNG mínimo válido (1x1) en base64.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const ok = `data:image/png;base64,${PNG_1X1}`;

describe('validateSignature', () => {
  test.each([undefined, null, ''])('vacía (%p) → null cuando es opcional', (v) => {
    expect(validateSignature(v)).toBeNull();
  });

  test('vacía y obligatoria → 400', () => {
    expect.assertions(2);
    try { validateSignature('', { required: true, label: 'La firma del transportador' }); } catch (e) {
      expect(e.statusCode).toBe(400);
      expect(e.message).toBe('La firma del transportador es obligatoria');
    }
  });

  test('PNG válido pasa tal cual', () => {
    expect(validateSignature(ok)).toBe(ok);
  });

  test.each([
    ['no es string', 123],
    ['otro formato', `data:image/jpeg;base64,${PNG_1X1}`],
    ['sin prefijo', PNG_1X1],
    ['caracteres inválidos', 'data:image/png;base64,<script>alert(1)</script>'],
    ['base64 que no es PNG', 'data:image/png;base64,AAAAAAAAAAAAAAAA'],
  ])('rechaza: %s', (_n, v) => {
    expect(() => validateSignature(v)).toThrow('Firma inválida');
  });

  test('rechaza una firma que pasa el tope', () => {
    const big = `data:image/png;base64,${PNG_1X1.slice(0, 11)}${'A'.repeat(SIGNATURE_MAX)}`;
    expect(() => validateSignature(big)).toThrow('La firma es demasiado grande');
  });
});

describe('signatureBuffer', () => {
  test('devuelve el buffer PNG', () => {
    const buf = signatureBuffer(ok);
    expect(buf.subarray(1, 4).toString()).toBe('PNG');
  });
  test('null si no hay firma o no es data URL', () => {
    expect(signatureBuffer(null)).toBeNull();
    expect(signatureBuffer('hola')).toBeNull();
  });
});
