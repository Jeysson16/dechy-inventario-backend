const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../index");

const issuer = {
  ruc: "20100070970",
  businessName: "EMPRESA DE PRUEBA SAC",
  address: "Lima",
  ubigeo: "150101",
};

async function withServer(run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("POST /api/sunat/preview cumple el contrato del frontend", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sunat/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentType: "03",
        series: "B001",
        number: 15,
        issueDate: "2026-07-15",
        issuer,
        customer: { document: "12345678", name: "CLIENTE" },
        sale: { items: [{ productName: "Producto", quantitySoldUnits: 1, subtotal: 118 }] },
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.success, true);
    assert.equal(result.data.status, "DRAFT_UNSIGNED_NOT_SENT");
    assert.equal(result.data.sentToSunat, false);
    assert.equal(result.data.signed, false);
    assert.equal(result.data.cdr, null);
    assert.equal(result.data.documentId, "B001-15");
    assert.match(result.data.xml, /^<\?xml/);
  });
});

test("POST /api/sunat/preview devuelve validaciones estructuradas", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sunat/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const result = await response.json();
    assert.equal(response.status, 422);
    assert.equal(result.success, false);
    assert.equal(result.code, "SUNAT_VALIDATION_ERROR");
    assert.ok(Array.isArray(result.errors));
  });
});

test("POST /api/sunat/emitir permanece bloqueado", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sunat/emitir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const result = await response.json();
    assert.equal(response.status, 409);
    assert.equal(result.code, "SUNAT_SEND_DISABLED");
  });
});

test("POST /api/sunat/preview genera nota de crédito 07 motivo 01 referenciada", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sunat/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentType: "07",
        series: "FC01",
        number: 1,
        issueDate: "2026-07-15",
        issuer,
        customer: { document: "20100070970", name: "CLIENTE EMPRESA SAC" },
        reference: {
          documentType: "01",
          id: "F001-25",
          reasonCode: "01",
          reason: "Anulación de la operación",
        },
        sale: { items: [{ productName: "Producto devuelto", quantitySoldUnits: 1, subtotal: 118 }] },
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.data.documentType, "07");
    assert.equal(result.data.documentId, "FC01-1");
    assert.match(result.data.xml, /<cbc:ReferenceID>F001-25<\/cbc:ReferenceID>/);
    assert.match(result.data.xml, /<cbc:ResponseCode>01<\/cbc:ResponseCode>/);
    assert.equal(result.data.sentToSunat, false);
  });
});
