const twilio = require('twilio');

/**
 * Crear cliente de Twilio basado en configuración del tenant
 */
const createSMSClient = (config) => {
  if (!config || !config.twilio_account_sid || !config.twilio_auth_token) {
    throw new Error('Configuración de SMS no disponible');
  }

  return twilio(config.twilio_account_sid, config.twilio_auth_token);
};

/**
 * Verificar configuración de SMS
 */
const verifySMSConfig = async (config) => {
  try {
    const client = createSMSClient(config);
    // Intentar obtener información de la cuenta
    await client.api.accounts(config.twilio_account_sid).fetch();
    return { success: true, message: 'Configuración válida' };
  } catch (error) {
    return { success: false, message: error.message };
  }
};

/**
 * Formatear número de teléfono colombiano
 */
const formatPhoneNumber = (phone) => {
  // Remover espacios y caracteres especiales
  const cleaned = phone.replace(/\D/g, '');

  // Si empieza con 57, ya tiene código de país
  if (cleaned.startsWith('57')) {
    return `+${cleaned}`;
  }

  // Si empieza con 3 (celular) agregar código de país
  if (cleaned.startsWith('3') && cleaned.length === 10) {
    return `+57${cleaned}`;
  }

  // Si tiene menos de 10 dígitos, agregar código de país y suponer que es celular
  if (cleaned.length < 10) {
    return `+573${cleaned}`;
  }

  return `+57${cleaned}`;
};

module.exports = {
  createSMSClient,
  verifySMSConfig,
  formatPhoneNumber,
};
