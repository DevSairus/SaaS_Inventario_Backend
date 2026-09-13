// Cifrado AES-256-GCM para tokens de Meta guardados en BD.
// Clave: META_TOKEN_ENCRYPTION_KEY (32 bytes en hex = 64 chars) o, en
// desarrollo, un derivado de JWT_SECRET. Sin clave usable se guarda en
// claro con prefijo "plain:" (solo para no romper entornos locales).
const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const PLAIN_PREFIX = 'plain:';

function getKey() {
  const hex = process.env.META_TOKEN_ENCRYPTION_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) {
    return Buffer.from(hex, 'hex');
  }
  const fallback = process.env.JWT_SECRET;
  if (!fallback) return null;
  return crypto.createHash('sha256').update(`meta-token:${fallback}`).digest();
}

function encryptToken(plain) {
  if (!plain) return null;
  if (typeof plain === 'string' && (plain.startsWith(PREFIX) || plain.startsWith(PLAIN_PREFIX))) {
    return plain;
  }
  const key = getKey();
  if (!key) return `${PLAIN_PREFIX}${plain}`;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptToken(stored) {
  if (!stored) return null;
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
  if (!stored.startsWith(PREFIX)) return stored; // legado sin cifrar

  const key = getKey();
  if (!key) throw new Error('META_TOKEN_ENCRYPTION_KEY/JWT_SECRET requerido para descifrar token Meta');

  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Token Meta cifrado con formato inválido');
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encryptToken, decryptToken };
