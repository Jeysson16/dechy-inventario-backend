const crypto = require("node:crypto");

class SunatValidationError extends Error {
  constructor(errors) {
    super("El borrador no cumple las validaciones previas SUNAT");
    this.errors = errors;
  }
}

const TYPE_MAP = {
  "01": { code: "01", root: "Invoice", seriesPrefix: "F" },
  factura: { code: "01", root: "Invoice", seriesPrefix: "F" },
  "03": { code: "03", root: "Invoice", seriesPrefix: "B" },
  boleta: { code: "03", root: "Invoice", seriesPrefix: "B" },
  "07": { code: "07", root: "CreditNote" },
  nota_credito: { code: "07", root: "CreditNote" },
  nc: { code: "07", root: "CreditNote" },
  "08": { code: "08", root: "DebitNote" },
  nota_debito: { code: "08", root: "DebitNote" },
  nd: { code: "08", root: "DebitNote" },
};

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const money = (value) => round2(value).toFixed(2);
const escapeXml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

function validRuc(value) {
  const ruc = String(value || "");
  if (!/^\d{11}$/.test(ruc)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((total, weight, index) => total + weight * Number(ruc[index]), 0);
  const difference = 11 - (sum % 11);
  const check = difference >= 10 ? difference - 10 : difference;
  return check === Number(ruc[10]);
}

function documentIdentity(document = "") {
  const value = String(document).trim();
  if (!value) return { type: "0", value: "" };
  if (/^\d{8}$/.test(value)) return { type: "1", value };
  if (validRuc(value)) return { type: "6", value };
  return { type: "-", value };
}

function normalizeInput(input = {}) {
  const requestedType = String(input.documentType || input.type || "").toLowerCase();
  const type = TYPE_MAP[requestedType];
  const sale = input.sale || {};
  const issuer = input.issuer || {};
  const customer = input.customer || {
    document: sale.documentRUC || sale.customerDNI || "",
    name: sale.customerName || "CLIENTE GENERAL",
    address: sale.customerAddress || "",
  };
  const reference = input.reference || null;
  const prefix = type?.seriesPrefix || (reference?.documentType === "03" ? "B" : "F");
  const series = String(input.series || `${prefix}001`).toUpperCase();
  const number = String(input.number || sale.fiscalNumber || "1").replace(/^0+/, "") || "1";
  const issueDate = String(input.issueDate || new Date().toISOString().slice(0, 10));
  const items = (sale.items || input.items || []).map((item, index) => ({
    id: String(index + 1),
    sku: item.sku || item.productId || `ITEM-${index + 1}`,
    description: item.productName || item.name || "Producto",
    quantity: Number(item.quantity || (item.saleMode === "cajas" ? item.quantitySoldBoxes : item.quantitySoldUnits) || 0),
    gross: round2(item.subtotal),
    exonerated: Boolean(item.isExonerated || item.taxAffectationCode === "20"),
    unitCode: item.unitCode || "NIU",
  }));
  return { type, requestedType, sale, issuer, customer, reference, series, number, issueDate, items };
}

function validateDraft(data) {
  const errors = [];
  if (!data.type) errors.push({ field: "documentType", message: "Tipo permitido: 01, 03, 07 u 08." });
  if (!validRuc(data.issuer.ruc)) errors.push({ field: "issuer.ruc", message: "RUC del emisor inválido." });
  if (!String(data.issuer.businessName || "").trim()) errors.push({ field: "issuer.businessName", message: "Razón social del emisor requerida." });
  if (!/^\d{6}$/.test(String(data.issuer.ubigeo || ""))) errors.push({ field: "issuer.ubigeo", message: "Ubigeo SUNAT de 6 dígitos requerido." });
  if (!/^[FB][A-Z0-9]{3}$/.test(data.series)) errors.push({ field: "series", message: "La serie debe tener 4 caracteres e iniciar con F o B." });
  if (!/^\d{1,8}$/.test(data.number)) errors.push({ field: "number", message: "Correlativo numérico de 1 a 8 dígitos requerido." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.issueDate)) errors.push({ field: "issueDate", message: "Fecha inválida; use YYYY-MM-DD." });
  if (!data.items.length) errors.push({ field: "sale.items", message: "Debe existir al menos un ítem." });
  data.items.forEach((item, index) => {
    if (!(item.quantity > 0)) errors.push({ field: `sale.items[${index}].quantity`, message: "Cantidad debe ser mayor que cero." });
    if (!(item.gross >= 0)) errors.push({ field: `sale.items[${index}].subtotal`, message: "Subtotal inválido." });
  });

  const customerId = documentIdentity(data.customer.document);
  const total = round2(data.items.reduce((sum, item) => sum + item.gross, 0));
  if (data.type?.code === "01" && customerId.type !== "6") {
    errors.push({ field: "customer.document", message: "La factura requiere RUC válido del adquirente." });
  }
  if (data.type?.code === "03" && total > 700 && !["1", "6"].includes(customerId.type)) {
    errors.push({ field: "customer.document", message: "Boletas mayores a S/ 700 requieren DNI o RUC." });
  }
  if (["07", "08"].includes(data.type?.code)) {
    if (!data.reference || !["01", "03"].includes(String(data.reference.documentType))) {
      errors.push({ field: "reference", message: "La nota requiere factura o boleta de referencia." });
    } else {
      const expectedPrefix = String(data.reference.documentType) === "03" ? "B" : "F";
      if (!data.series.startsWith(expectedPrefix)) errors.push({ field: "series", message: `La serie debe iniciar con ${expectedPrefix} según el comprobante afectado.` });
      if (!/^[FB][A-Z0-9]{3}-\d{1,8}$/.test(String(data.reference.id || ""))) errors.push({ field: "reference.id", message: "Número del comprobante de referencia inválido." });
      if (!String(data.reference.reason || "").trim()) errors.push({ field: "reference.reason", message: "Motivo de la nota requerido." });
    }
  }
  return { errors, customerId, total };
}

function calculate(items) {
  const lines = items.map((item) => {
    const net = item.exonerated ? item.gross : round2(item.gross / 1.18);
    const tax = item.exonerated ? 0 : round2(item.gross - net);
    return { ...item, net, tax, unitValue: round2(net / item.quantity), unitPrice: round2(item.gross / item.quantity) };
  });
  return {
    lines,
    taxable: round2(lines.filter((line) => !line.exonerated).reduce((sum, line) => sum + line.net, 0)),
    exonerated: round2(lines.filter((line) => line.exonerated).reduce((sum, line) => sum + line.net, 0)),
    igv: round2(lines.reduce((sum, line) => sum + line.tax, 0)),
    total: round2(lines.reduce((sum, line) => sum + line.gross, 0)),
  };
}

function supplierXml(issuer) {
  return `<cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="6">${escapeXml(issuer.ruc)}</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName><![CDATA[${String(issuer.businessName).replaceAll("]]>", "] ]>")}]]></cbc:RegistrationName><cac:RegistrationAddress><cbc:ID>${escapeXml(issuer.ubigeo)}</cbc:ID><cbc:AddressTypeCode>${escapeXml(issuer.establishmentCode || "0000")}</cbc:AddressTypeCode><cac:AddressLine><cbc:Line><![CDATA[${String(issuer.address || "").replaceAll("]]>", "] ]>")}]]></cbc:Line></cac:AddressLine><cac:Country><cbc:IdentificationCode>PE</cbc:IdentificationCode></cac:Country></cac:RegistrationAddress></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>`;
}

function customerXml(customer, identity) {
  return `<cac:AccountingCustomerParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="${identity.type}">${escapeXml(identity.value)}</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName><![CDATA[${String(customer.name || "CLIENTE GENERAL").replaceAll("]]>", "] ]>")}]]></cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>`;
}

function taxXml(totals) {
  const subtotals = [];
  if (totals.taxable) subtotals.push(`<cac:TaxSubtotal><cbc:TaxableAmount currencyID="PEN">${money(totals.taxable)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="PEN">${money(totals.igv)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cac:TaxScheme><cbc:ID>1000</cbc:ID><cbc:Name>IGV</cbc:Name><cbc:TaxTypeCode>VAT</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`);
  if (totals.exonerated) subtotals.push(`<cac:TaxSubtotal><cbc:TaxableAmount currencyID="PEN">${money(totals.exonerated)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="PEN">0.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>E</cbc:ID><cac:TaxScheme><cbc:ID>9997</cbc:ID><cbc:Name>EXO</cbc:Name><cbc:TaxTypeCode>VAT</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`);
  return `<cac:TaxTotal><cbc:TaxAmount currencyID="PEN">${money(totals.igv)}</cbc:TaxAmount>${subtotals.join("")}</cac:TaxTotal>`;
}

function lineXml(line, root) {
  const node = root === "Invoice" ? "InvoiceLine" : root === "CreditNote" ? "CreditNoteLine" : "DebitNoteLine";
  const qty = root === "Invoice" ? "InvoicedQuantity" : root === "CreditNote" ? "CreditedQuantity" : "DebitedQuantity";
  const affectation = line.exonerated ? "20" : "10";
  const scheme = line.exonerated ? ["9997", "EXO"] : ["1000", "IGV"];
  return `<cac:${node}><cbc:ID>${line.id}</cbc:ID><cbc:${qty} unitCode="${escapeXml(line.unitCode)}">${line.quantity}</cbc:${qty}><cbc:LineExtensionAmount currencyID="PEN">${money(line.net)}</cbc:LineExtensionAmount><cac:PricingReference><cac:AlternativeConditionPrice><cbc:PriceAmount currencyID="PEN">${money(line.unitPrice)}</cbc:PriceAmount><cbc:PriceTypeCode>01</cbc:PriceTypeCode></cac:AlternativeConditionPrice></cac:PricingReference><cac:TaxTotal><cbc:TaxAmount currencyID="PEN">${money(line.tax)}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="PEN">${money(line.net)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="PEN">${money(line.tax)}</cbc:TaxAmount><cac:TaxCategory><cbc:Percent>${line.exonerated ? "0.00" : "18.00"}</cbc:Percent><cbc:TaxExemptionReasonCode>${affectation}</cbc:TaxExemptionReasonCode><cac:TaxScheme><cbc:ID>${scheme[0]}</cbc:ID><cbc:Name>${scheme[1]}</cbc:Name><cbc:TaxTypeCode>VAT</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal><cac:Item><cbc:Description><![CDATA[${String(line.description).replaceAll("]]>", "] ]>")}]]></cbc:Description><cac:SellersItemIdentification><cbc:ID>${escapeXml(line.sku)}</cbc:ID></cac:SellersItemIdentification></cac:Item><cac:Price><cbc:PriceAmount currencyID="PEN">${money(line.unitValue)}</cbc:PriceAmount></cac:Price></cac:${node}>`;
}

function buildXml(data, identity, totals) {
  const { root } = data.type;
  const namespace = `urn:oasis:names:specification:ubl:schema:xsd:${root}-2`;
  const docCodeNode = root === "Invoice" ? `<cbc:InvoiceTypeCode listID="0101">${data.type.code}</cbc:InvoiceTypeCode>` : "";
  const reference = root === "Invoice" ? "" : `<cac:DiscrepancyResponse><cbc:ReferenceID>${escapeXml(data.reference.id)}</cbc:ReferenceID><cbc:ResponseCode>${escapeXml(data.reference.reasonCode || (root === "CreditNote" ? "01" : "01"))}</cbc:ResponseCode><cbc:Description><![CDATA[${String(data.reference.reason).replaceAll("]]>", "] ]>")}]]></cbc:Description></cac:DiscrepancyResponse><cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${escapeXml(data.reference.id)}</cbc:ID><cbc:DocumentTypeCode>${escapeXml(data.reference.documentType)}</cbc:DocumentTypeCode></cac:InvoiceDocumentReference></cac:BillingReference>`;
  const signature = `<cac:Signature><cbc:ID>SIGN-${escapeXml(data.series)}-${escapeXml(data.number)}</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${escapeXml(data.issuer.ruc)}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name><![CDATA[${String(data.issuer.businessName).replaceAll("]]>", "] ]>")}]]></cbc:Name></cac:PartyName></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#SIGN-${escapeXml(data.series)}-${escapeXml(data.number)}</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature>`;
  const paymentTerms = root === "Invoice" ? `<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Contado</cbc:PaymentMeansID></cac:PaymentTerms>` : "";
  const legalNode = root === "Invoice" ? "LegalMonetaryTotal" : root === "CreditNote" ? "LegalMonetaryTotal" : "RequestedMonetaryTotal";
  const totalNode = root === "CreditNote" ? "PayableAmount" : "PayableAmount";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="${namespace}" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID><cbc:ID>${data.series}-${data.number}</cbc:ID><cbc:IssueDate>${data.issueDate}</cbc:IssueDate>${docCodeNode}<cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode>${reference}${signature}${supplierXml(data.issuer)}${customerXml(data.customer, identity)}${paymentTerms}${taxXml(totals)}<cac:${legalNode}><cbc:LineExtensionAmount currencyID="PEN">${money(totals.taxable + totals.exonerated)}</cbc:LineExtensionAmount><cbc:TaxInclusiveAmount currencyID="PEN">${money(totals.total)}</cbc:TaxInclusiveAmount><cbc:${totalNode} currencyID="PEN">${money(totals.total)}</cbc:${totalNode}></cac:${legalNode}>${totals.lines.map((line) => lineXml(line, root)).join("")}</${root}>`;
}

function buildSunatDraft(input) {
  const data = normalizeInput(input);
  const { errors, customerId } = validateDraft(data);
  if (errors.length) throw new SunatValidationError(errors);
  const totals = calculate(data.items);
  const xml = buildXml(data, customerId, totals);
  const digest = crypto.createHash("sha256").update(xml).digest("base64");
  const qr = [data.issuer.ruc, data.type.code, data.series, data.number, money(totals.igv), money(totals.total), data.issueDate, customerId.type, customerId.value, ""].join("|");
  return {
    status: "DRAFT_UNSIGNED_NOT_SENT",
    sentToSunat: false,
    signed: false,
    cdr: null,
    documentType: data.type.code,
    documentId: `${data.series}-${data.number}`,
    totals,
    qr,
    localDigest: digest,
    xml,
    warnings: ["XML de previsualización sin firma digital.", "No se realizó conexión con SUNAT en esta operación."],
  };
}

module.exports = { buildSunatDraft, validRuc, SunatValidationError };
