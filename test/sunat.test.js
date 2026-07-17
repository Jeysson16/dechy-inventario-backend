const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSunatDraft, validRuc, SunatValidationError } = require("../sunat");

const issuer = {
  ruc: "20100070970",
  businessName: "EMPRESA DE PRUEBA SAC",
  address: "Lima",
  ubigeo: "150101",
};

const baseSale = {
  customerName: "CLIENTE PRUEBA",
  customerDNI: "12345678",
  items: [{ sku: "P001", productName: "Producto gravado", quantitySoldUnits: 2, subtotal: 118 }],
};

test("valida dígito verificador del RUC", () => {
  assert.equal(validRuc("20100070970"), true);
  assert.equal(validRuc("20555666777"), false);
});

test("genera boleta UBL 2.1 sin enviar", () => {
  const draft = buildSunatDraft({ issuer, sale: baseSale, documentType: "03", series: "B001", number: 1 });
  assert.equal(draft.sentToSunat, false);
  assert.equal(draft.status, "DRAFT_UNSIGNED_NOT_SENT");
  assert.equal(draft.totals.igv, 18);
  assert.match(draft.xml, /<cbc:InvoiceTypeCode listID="0101">03<\/cbc:InvoiceTypeCode>/);
  assert.equal(draft.qr.split("|").length, 10);
});

test("rechaza factura sin RUC de adquirente", () => {
  assert.throws(
    () => buildSunatDraft({ issuer, sale: baseSale, documentType: "01", series: "F001", number: 1 }),
    (error) => error instanceof SunatValidationError && error.errors.some((item) => item.field === "customer.document"),
  );
});

test("rechaza boleta mayor de S/ 700 sin identificación", () => {
  const sale = { ...baseSale, customerDNI: "", items: [{ ...baseSale.items[0], subtotal: 701 }] };
  assert.throws(() => buildSunatDraft({ issuer, sale, documentType: "03", series: "B001", number: 2 }), SunatValidationError);
});

test("separa operaciones gravadas y exoneradas", () => {
  const sale = { ...baseSale, items: [...baseSale.items, { sku: "E1", productName: "Exonerado", quantitySoldUnits: 1, subtotal: 50, isExonerated: true }] };
  const draft = buildSunatDraft({ issuer, sale, documentType: "03", series: "B001", number: 3 });
  assert.equal(draft.totals.taxable, 100);
  assert.equal(draft.totals.exonerated, 50);
  assert.equal(draft.totals.total, 168);
});

test("nota de crédito exige comprobante de referencia", () => {
  assert.throws(() => buildSunatDraft({ issuer, sale: baseSale, documentType: "07", series: "F001", number: 4 }), SunatValidationError);
  const draft = buildSunatDraft({
    issuer,
    sale: { ...baseSale, customerDNI: "20100070970" },
    documentType: "07",
    series: "F001",
    number: 4,
    reference: { documentType: "01", id: "F001-1", reasonCode: "01", reason: "Anulación de la operación" },
  });
  assert.match(draft.xml, /<CreditNote/);
});
