// backend/src/utils/customerWhatsappPhone.js
//
// Arma el número de WhatsApp de un cliente en formato E.164 sin "+"
// (ej. "573001234567"), como lo exige tanto la Cloud API de Meta como el
// enlace wa.me. `customers.mobile` guarda solo el número local; el
// indicativo vive por separado en `mobile_country_code` (default "57" =
// Colombia, capturado en el formulario de cliente).

/**
 * Único normalizador de números de WhatsApp del backend: deja solo dígitos y,
 * por compatibilidad, antepone "57" a los números colombianos de 10 dígitos
 * guardados sin indicativo. Sin esto Meta rechaza el envío y la bandeja abre
 * un chat duplicado por cada forma de escribir el mismo número.
 */
function normalizeWhatsAppPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  // Solo números colombianos (celular 3XX o fijo 60X): un número extranjero de
  // 10 dígitos con su indicativo (Belice 501, Guyana 592...) queda igual.
  return /^(3\d{9}|60\d{8})$/.test(digits) ? `57${digits}` : digits;
}

/** @param {{ mobile?: string, mobile_country_code?: string, phone?: string }} customer */
function getCustomerWhatsappNumber(customer) {
  if (!customer) return '';
  const mobileDigits = String(customer.mobile || '').replace(/\D/g, '');
  if (mobileDigits) {
    const code = String(customer.mobile_country_code || '57').replace(/\D/g, '') || '57';
    return mobileDigits.startsWith(code) ? mobileDigits : `${code}${mobileDigits}`;
  }
  return normalizeWhatsAppPhone(customer.phone);
}

module.exports = { getCustomerWhatsappNumber, normalizeWhatsAppPhone };
