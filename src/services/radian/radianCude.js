// backend/src/services/radian/radianCude.js
/**
 * CUDE de un evento RADIAN (ApplicationResponse) — NO es la misma fórmula
 * que el CUDE de Nota Crédito/Débito de dianXmlBuilder.js#buildCude (esa es
 * la fórmula de un documento tipo factura). Esta es la del Anexo Técnico
 * RADIAN v1.0, §11.1.1 (pág. 347), confirmada contra el PDF oficial — ver
 * 00 - Documentación/RADIAN-Analisis-y-Plan.md §7.2:
 *
 *   CUDE = SHA-384(Num_DE + Fec_Emi + Hor_Emi + NitFE + DocAdq +
 *                   ResponseCode + ID + DocumentTypeCode + Software-PIN)
 *
 * El propio Anexo no detalla el XPath exacto de cada campo con el mismo
 * nivel de precisión que sí tiene el CUFE de factura (Anexo FE) — el mapeo
 * de abajo es MEJOR ESFUERZO a partir del nombre de cada campo:
 *   Num_DE          → cbc:ID del propio ApplicationResponse (el evento)
 *   Fec_Emi/Hor_Emi → cbc:IssueDate/cbc:IssueTime del propio evento
 *   NitFE           → NIT de quien emitió la factura referenciada (el
 *                      "Facturador Electrónico", es decir el proveedor)
 *   DocAdq          → NIT/documento del adquirente que emite el evento
 *   ResponseCode    → cbc:ResponseCode dentro de DocumentResponse/Response
 *   ID              → cbc:ID de DocumentReference (número de la factura
 *                      referenciada, NO el CUFE)
 *   DocumentTypeCode→ cbc:DocumentTypeCode de DocumentReference ('01' factura)
 *   Software-PIN    → PIN del software (secreto), no la clave técnica
 *
 * Sin verificar contra un envío aceptado por la DIAN — validar en el primer
 * evento enviado al set de habilitación (mismo criterio que el resto de
 * cálculos "confirmados por fórmula, no por envío real" en este proyecto).
 */
'use strict';

const crypto = require('crypto');

function buildRadianCude({
  applicationResponseId,
  issueDate, issueTime,
  nitEmisorFactura,
  nitAdquiriente,
  responseCode,
  referencedDocumentId,
  documentTypeCode = '01',
  softwarePin,
}) {
  const plain = [
    applicationResponseId,
    issueDate,
    issueTime,
    nitEmisorFactura,
    nitAdquiriente,
    responseCode,
    referencedDocumentId,
    documentTypeCode,
    softwarePin,
  ].join('');

  return crypto.createHash('sha384').update(plain).digest('hex');
}

module.exports = { buildRadianCude };
