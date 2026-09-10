// backend/src/config/redisClient.js
//
// Cliente Redis compartido para lo que necesita estado coordinado entre
// réplicas del backend (Railway puede correr varias instancias del mismo
// servicio en paralelo, sin sticky sessions garantizadas):
//   - rate limiting (rateLimiter.js) -- sin esto cada réplica lleva su
//     propio contador en memoria y el límite efectivo se multiplica por N.
//   - adapter de socket.io (server.js) -- sin esto un evento emitido desde
//     la réplica que procesó una acción no llega a un cliente conectado a
//     otra réplica.
//
// Si REDIS_URL no está configurado (dev local, o un Railway sin el add-on
// de Redis todavía) `redisClient` queda en null y cada consumidor cae de
// vuelta a su comportamiento en memoria de siempre -- funciona igual en una
// sola instancia, simplemente no está listo para múltiples réplicas.
const logger = require('./logger');

let redisClient = null;

if (process.env.REDIS_URL) {
  const { createClient } = require('redis');

  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => logger.error('[Redis] Error de conexión:', err.message));
  redisClient.on('connect', () => logger.info('[Redis] Conectado'));

  // No se espera esta promesa a propósito: conectar es async y este módulo
  // se importa de forma síncrona desde varios lugares (rateLimiter.js se
  // evalúa al arrancar, antes de que cualquier request pueda llegar). El
  // cliente de `redis` v4 encola comandos mientras conecta, así que las
  // primeras requests en el arranque simplemente esperan un poco más en vez
  // de fallar.
  redisClient.connect().catch((err) => {
    logger.error('[Redis] No se pudo conectar:', err.message);
  });
} else {
  logger.warn('[Redis] REDIS_URL no configurado -- rate limiting y socket.io usan almacenamiento en memoria (no válido con múltiples réplicas)');
}

module.exports = { redisClient };
