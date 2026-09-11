const { encryptToken, decryptToken } = require('../utils/metaTokenCrypto');

const KEY = 'a'.repeat(64);

describe('metaTokenCrypto', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('cifra y descifra un token de Meta sin perder el valor', () => {
    process.env.META_TOKEN_ENCRYPTION_KEY = KEY;
    const token = 'EAAPQSsg7tHQBSfijZCV1ZBawedfYVWBqcNS8MZAae20';

    const stored = encryptToken(token);

    expect(stored).toMatch(/^enc:v1:/);
    expect(stored).not.toContain(token);
    expect(decryptToken(stored)).toBe(token);
  });

  it('produce criptogramas distintos para el mismo token (IV aleatorio)', () => {
    process.env.META_TOKEN_ENCRYPTION_KEY = KEY;

    const a = encryptToken('mismo-token');
    const b = encryptToken('mismo-token');

    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe(decryptToken(b));
  });

  it('no vuelve a cifrar un valor ya cifrado', () => {
    process.env.META_TOKEN_ENCRYPTION_KEY = KEY;
    const stored = encryptToken('token');

    expect(encryptToken(stored)).toBe(stored);
  });

  it('detecta manipulación del criptograma (AES-GCM autentica)', () => {
    process.env.META_TOKEN_ENCRYPTION_KEY = KEY;
    const stored = encryptToken('token-original');
    const [prefix, iv, tag, data] = [
      'enc:v1:',
      ...stored.slice('enc:v1:'.length).split(':'),
    ];
    const tampered = `${prefix}${iv}:${tag}:${Buffer.from('otra-cosa').toString('base64')}`;

    expect(() => decryptToken(tampered)).toThrow();
    expect(data).toBeDefined();
  });

  it('sin clave configurada guarda en claro marcado, y lo recupera', () => {
    delete process.env.META_TOKEN_ENCRYPTION_KEY;
    delete process.env.JWT_SECRET;

    const stored = encryptToken('token-dev');

    expect(stored).toBe('plain:token-dev');
    expect(decryptToken(stored)).toBe('token-dev');
  });

  it('devuelve null para valores vacíos', () => {
    expect(encryptToken(null)).toBeNull();
    expect(decryptToken(null)).toBeNull();
  });
});
