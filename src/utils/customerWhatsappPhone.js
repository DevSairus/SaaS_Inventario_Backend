// backend/src/utils/customerWhatsappPhone.js
//
// Arma el número de WhatsApp de un cliente en formato E.164 sin "+"
// (ej. "573001234567"), como lo exige tanto la Cloud API de Meta como el
// enlace wa.me. `customers.mobile` guarda solo el número local; el
// indicativo vive por separado en `mobile_country_code` (default "57" =
// Colombia, capturado en el formulario de cliente). Si el cliente no tiene
// celular, se usa el teléfono fijo tal cual (no lleva indicativo propio).

/** @param {{ mobile?: string, mobile_country_code?: string, phone?: string }} customer */
function getCustomerWhatsappNumber(customer) {
  if (!customer) return '';
  const mobileDigits = String(customer.mobile || '').replace(/\D/g, '');
  if (mobileDigits) {
    const code = String(customer.mobile_country_code || '57').replace(/\D/g, '') || '57';
    return mobileDigits.startsWith(code) ? mobileDigits : `${code}${mobileDigits}`;
  }
  return String(customer.phone || '').replace(/\D/g, '');
}

module.exports = { getCustomerWhatsappNumber };
