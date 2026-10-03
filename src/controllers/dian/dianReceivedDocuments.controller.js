// backend/src/controllers/dian/dianReceivedDocuments.controller.js
//
// Registro de documentos electrónicos recibidos a partir del Excel de
// "Documentos" del portal DIAN (ver dianReceivedDocuments.service.js):
//  - subir el Excel (cada 8 días trae todo el periodo; no duplica por CUFE),
//  - listar/conciliar contra compras ya registradas,
//  - ver la factura reconstruida (encabezado + QR; líneas si hay XML),
//  - descargar el XML desde la DIAN (GetXmlByDocumentKey) y
//  - cargar como compra: una por una (modal del ZIP con dian_document_id) o
//    en lote con mapeo automático de productos.

'use strict';

const { Op } = require('sequelize');
const { DianReceivedDocument, Purchase, Supplier, Tenant } = require('../../models');
const { runWithTenantSchema } = require('../../config/tenantContext');
const { importDocuments, isInvoice, documentNumber, findExistingPurchases } = require('../../services/dian/dianReceivedDocuments.service');
const { parseInvoiceXML } = require('../../services/invoiceXmlParser');
const dianKit = require('../../services/dian/dianKitAdapter');

const QR_BASE = 'https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=';

// Mismo problema que invoiceImport.controller: el upload (multer) rompe el
// AsyncLocalStorage del schema del tenant — se re-fija con req.tenant.
const withTenantSchema = (handler) => (req, res) => (
  req.tenant?.schema_name ? runWithTenantSchema(req.tenant.schema_name, () => handler(req, res)) : handler(req, res)
);

// Tenant completo (dian_config con certificado, NIT): igual que
// dian.controller, no se confía en lo que tenga cargado req.tenant.
const loadTenant = (req) => Tenant.findByPk(req.tenant_id || req.user.tenant_id);

const fail = (res, error, fallback) => {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
  console.error(fallback, error);
  return res.status(500).json({ success: false, message: fallback, error: process.env.NODE_ENV === 'production' ? undefined : error.message });
};

function serialize(doc) {
  const d = doc.toJSON ? doc.toJSON() : doc;
  const { xml_content, ...rest } = d;
  const otherTaxesTotal = Object.values(d.other_taxes || {}).reduce((s, v) => s + Number(v || 0), 0);
  // El reporte no trae la base gravable: se estima como Total - impuestos
  // ("Total" es el valor de la factura, antes de retenciones). Con el XML se
  // muestra la base real.
  const estimatedSubtotal = Number(d.total || 0) - Number(d.iva || 0) - Number(d.inc || 0) - Number(d.ica || 0) - otherTaxesTotal;
  return {
    ...rest,
    has_xml: !!xml_content,
    document_number: documentNumber(d),
    is_invoice: isInvoice(d),
    estimated_subtotal: Math.round(estimatedSubtotal * 100) / 100,
    qr_url: `${QR_BASE}${encodeURIComponent(d.cufe)}`,
  };
}

// POST /dian-documents/upload  (multipart: file)
exports.upload = withTenantSchema(async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Adjunta el Excel descargado del portal DIAN' });
    const summary = await importDocuments(await loadTenant(req), req.file.buffer);
    res.json({ success: true, data: summary });
  } catch (error) {
    fail(res, error, 'Error procesando el Excel de la DIAN');
  }
});

// GET /dian-documents?status=&from=&to=&search=&type=invoice|all&page=&limit=
exports.list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { status, from, to, search, type = 'invoice' } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);

    const where = { tenant_id };
    if (status && status !== 'all') where.status = status;
    if (from || to) where.issue_date = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) };
    if (search) {
      const like = `%${search.trim()}%`;
      where[Op.or] = [
        { issuer_name: { [Op.iLike]: like } },
        { issuer_nit: { [Op.iLike]: like } },
        { folio: { [Op.iLike]: like } },
        { cufe: { [Op.iLike]: like } },
      ];
    }
    if (type === 'invoice') {
      where.document_type = { [Op.iLike]: '%factura%' };
      where[Op.and] = [{ document_type: { [Op.notILike]: '%nota%' } }];
    }

    const { count, rows } = await DianReceivedDocument.findAndCountAll({
      where,
      attributes: { exclude: ['xml_content'], include: [[DianReceivedDocument.sequelize.literal('(xml_content IS NOT NULL)'), 'has_xml_flag']] },
      include: [{ model: Purchase, as: 'purchase', attributes: ['id', 'purchase_number', 'status', 'total_amount'] }],
      order: [['issue_date', 'DESC'], ['issuer_name', 'ASC']],
      limit,
      offset: (page - 1) * limit,
    });

    const countsRows = await DianReceivedDocument.findAll({
      where: { tenant_id },
      attributes: ['status', [DianReceivedDocument.sequelize.fn('COUNT', '*'), 'n']],
      group: ['status'],
      raw: true,
    });
    const counts = { pending: 0, loaded: 0, discarded: 0 };
    for (const c of countsRows) counts[c.status] = Number(c.n);

    res.json({
      success: true,
      data: rows.map((r) => ({ ...serialize(r), has_xml: !!r.get('has_xml_flag') })),
      counts,
      pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
    });
  } catch (error) {
    fail(res, error, 'Error listando documentos DIAN');
  }
};

// GET /dian-documents/:id — incluye detalle de líneas si hay XML.
exports.getById = async (req, res) => {
  try {
    const doc = await DianReceivedDocument.findOne({
      where: { id: req.params.id, tenant_id: req.user.tenant_id },
      include: [
        { model: Purchase, as: 'purchase', attributes: ['id', 'purchase_number', 'status', 'total_amount'] },
        { model: Supplier, as: 'supplier', attributes: ['id', 'name', 'business_name', 'tax_id', 'address', 'city', 'email', 'phone'] },
      ],
    });
    if (!doc) return res.status(404).json({ success: false, message: 'Documento no encontrado' });

    let detail = null;
    let related_invoice = null;
    if (doc.xml_content && !isInvoice(doc)) {
      // Nota crédito/débito: se muestra la factura que afecta y, si está en
      // el registro, su estado (cargada como compra o no).
      const ref = billingReference(doc.xml_content);
      if (ref) {
        const original = ref.cufe
          ? await DianReceivedDocument.findOne({
            where: { tenant_id: req.user.tenant_id, cufe: ref.cufe },
            attributes: ['id', 'prefix', 'folio', 'status', 'purchase_id', 'total'],
            include: [{ model: Purchase, as: 'purchase', attributes: ['id', 'purchase_number'] }],
          })
          : null;
        related_invoice = { ...ref, registry: original ? serialize(original) : null };
      }
    } else if (doc.xml_content) {
      try {
        const parsed = await parseInvoiceXML(doc.xml_content);
        detail = { supplier: parsed.supplier, invoice: parsed.invoice, items: parsed.items, totals: parsed.totals };
        // Plazo en días según el vencimiento del XML.
        if (parsed.invoice?.due_date && parsed.invoice?.date) {
          detail.invoice.term_days = Math.round((new Date(parsed.invoice.due_date) - new Date(parsed.invoice.date)) / 86400000);
        }
      } catch (e) {
        detail = { error: `No se pudo leer el XML: ${e.message}` };
      }
    }
    const data = serialize(doc);
    let qr_data_url = null;
    try {
      qr_data_url = await require('qrcode').toDataURL(data.qr_url, { margin: 1, width: 180 });
    } catch (e) { /* sin QR, se muestra el enlace */ }
    res.json({ success: true, data: { ...data, qr_data_url, detail, related_invoice } });
  } catch (error) {
    fail(res, error, 'Error obteniendo el documento DIAN');
  }
};

// PATCH /dian-documents/:id  { status: 'discarded'|'pending', discard_reason }
exports.updateStatus = async (req, res) => {
  try {
    const { status, discard_reason } = req.body || {};
    if (!['discarded', 'pending'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Estado inválido (discarded | pending)' });
    }
    const ids = req.params.id === 'batch' ? (req.body.ids || []) : [req.params.id];
    const [n] = await DianReceivedDocument.update(
      { status, discard_reason: status === 'discarded' ? (discard_reason || null) : null },
      // Un documento ya cargado como compra no se descarta ni se reabre desde aquí.
      { where: { tenant_id: req.user.tenant_id, id: { [Op.in]: ids }, purchase_id: null } }
    );
    res.json({ success: true, data: { updated: n } });
  } catch (error) {
    fail(res, error, 'Error actualizando el documento DIAN');
  }
};

// Primer cbc:UUID del documento = su propio CUFE/CUDE (en UBL va en el
// encabezado, antes de cualquier BillingReference).
const ownUuid = (xml) => (String(xml).match(/<(?:\w+:)?UUID\b[^>]*>\s*([^<\s]+)\s*</) || [])[1] || null;

// Nota crédito/débito → factura que afecta (cac:BillingReference/
// cac:InvoiceDocumentReference: número y CUFE de la factura original).
function billingReference(xml) {
  const block = (String(xml).match(/<(?:\w+:)?InvoiceDocumentReference\b[\s\S]*?<\/(?:\w+:)?InvoiceDocumentReference>/) || [])[0];
  if (!block) return null;
  const number = (block.match(/<(?:\w+:)?ID\b[^>]*>\s*([^<]+?)\s*</) || [])[1] || null;
  const cufe = (block.match(/<(?:\w+:)?UUID\b[^>]*>\s*([^<\s]+)\s*</) || [])[1] || null;
  const issueDate = (block.match(/<(?:\w+:)?IssueDate\b[^>]*>\s*([^<]+?)\s*</) || [])[1] || null;
  return number || cufe ? { number, cufe, issue_date: issueDate } : null;
}

async function fetchXmlFor(tenant, doc) {
  try {
    const result = await dianKit.getXmlByDocumentKey(tenant, doc.cufe);
    if (!result?.found || !result.xml) {
      const msg = result?.message || 'La DIAN no devolvió el XML';
      await doc.update({ xml_fetch_error: `${result?.code ? result.code + ' · ' : ''}${msg}` });
      return { ok: false, message: msg };
    }
    // Validación: el XML debe corresponder al CUFE pedido. Se compara el
    // UUID directo del XML (sirve para facturas y notas por igual).
    const parsedCufe = ownUuid(result.xml);
    if (isInvoice(doc)) {
      try {
        await parseInvoiceXML(result.xml);
      } catch (e) {
        await doc.update({ xml_fetch_error: `XML recibido no legible: ${e.message}` });
        return { ok: false, message: 'La DIAN devolvió un XML que no se pudo leer' };
      }
    }
    if (parsedCufe && parsedCufe.toLowerCase() !== doc.cufe.toLowerCase()) {
      await doc.update({ xml_fetch_error: 'El XML devuelto no corresponde al CUFE consultado' });
      return { ok: false, message: 'El XML devuelto no corresponde al CUFE consultado' };
    }
    await doc.update({ xml_content: result.xml, xml_fetched_at: new Date(), xml_fetch_error: null });
    return { ok: true };
  } catch (error) {
    await doc.update({ xml_fetch_error: error.message });
    return { ok: false, message: error.message };
  }
}

// POST /dian-documents/:id/fetch-xml
exports.fetchXml = async (req, res) => {
  try {
    const doc = await DianReceivedDocument.findOne({ where: { id: req.params.id, tenant_id: req.user.tenant_id } });
    if (!doc) return res.status(404).json({ success: false, message: 'Documento no encontrado' });
    const result = await fetchXmlFor(await loadTenant(req), doc);
    if (!result.ok) return res.status(422).json({ success: false, message: result.message });
    res.json({ success: true, message: 'Detalle obtenido desde la DIAN' });
  } catch (error) {
    fail(res, error, 'Error consultando la DIAN');
  }
};

// POST /dian-documents/load-batch  { ids: [], profit_margin? }
// Carga automática: descarga el XML si falta y lo importa con el mapeo
// automático de productos (mapeo proveedor-código, SKU, nombre o crea el
// producto). Para revisar línea por línea se usa el modal del ZIP con
// dian_document_id. Secuencial a propósito: la DIAN y la numeración de
// compras no toleran bien la concurrencia.
exports.loadBatch = async (req, res) => {
  const { importInvoiceFromXml, linkReceivedDocument, InvoiceImportError } = require('../invoiceImport.controller');
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 100) : [];
    if (ids.length === 0) return res.status(400).json({ success: false, message: 'Selecciona al menos un documento' });
    const tenant_id = req.user.tenant_id;

    const docs = await DianReceivedDocument.findAll({ where: { tenant_id, id: { [Op.in]: ids } } });
    const tenant = await loadTenant(req);
    const results = [];
    for (const doc of docs) {
      const base = { id: doc.id, document_number: documentNumber(doc), issuer_name: doc.issuer_name };
      if (doc.status === 'loaded' || doc.purchase_id) { results.push({ ...base, ok: false, skipped: true, message: 'Ya estaba cargada' }); continue; }
      if (!isInvoice(doc)) { results.push({ ...base, ok: false, skipped: true, message: 'No es una factura (nota o evento)' }); continue; }

      // Re-chequeo de duplicado justo antes de cargar (pudo cargarse por ZIP entretanto).
      const existing = (await findExistingPurchases(tenant_id, [doc])).get(doc.cufe);
      if (existing) {
        await doc.update({ status: 'loaded', purchase_id: existing.id });
        results.push({ ...base, ok: true, linked: true, purchase_number: existing.purchase_number, message: 'Ya existía como compra: vinculada' });
        continue;
      }

      if (!doc.xml_content) {
        const fetched = await fetchXmlFor(tenant, doc);
        if (!fetched.ok) { results.push({ ...base, ok: false, message: `Sin XML: ${fetched.message}` }); continue; }
      }

      try {
        const { purchase, processedItems } = await importInvoiceFromXml(
          doc.xml_content,
          { tenant_id, user_id: req.user.id, branch_id: req.branch_id },
          { profit_margin: req.body.profit_margin, payment_form_hint: doc.payment_form }
        );
        await linkReceivedDocument(tenant_id, purchase, doc.id);
        results.push({
          ...base, ok: true, purchase_id: purchase.id, purchase_number: purchase.purchase_number,
          items: processedItems.length, new_products: processedItems.filter((i) => i.isNew).length,
        });
      } catch (e) {
        if (e instanceof InvoiceImportError && e.payload?.existingPurchase) {
          await doc.update({ status: 'loaded', purchase_id: e.payload.existingPurchase.id });
          results.push({ ...base, ok: true, linked: true, purchase_number: e.payload.existingPurchase.purchase_number, message: 'Ya existía como compra: vinculada' });
        } else {
          results.push({ ...base, ok: false, message: e.message });
        }
      }
    }

    res.json({
      success: true,
      data: {
        results,
        loaded: results.filter((r) => r.ok && !r.linked).length,
        linked: results.filter((r) => r.linked).length,
        failed: results.filter((r) => !r.ok && !r.skipped).length,
        skipped: results.filter((r) => r.skipped).length,
      },
    });
  } catch (error) {
    fail(res, error, 'Error en la carga masiva');
  }
};
