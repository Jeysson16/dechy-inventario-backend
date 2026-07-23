const forge = require("node-forge");
const { buildSunatDraft } = require("../sunat");
const { sendBill } = require("../sunatTransport");

function temporaryPfx() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = String(Date.now());
  certificate.validity.notBefore = new Date(Date.now() - 60000);
  certificate.validity.notAfter = new Date(Date.now() + 86400000);
  const attributes = [{ name: "commonName", value: "DECHY SUNAT BETA SMOKE TEST" }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const password = "temporary-beta-test";
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, certificate, password, { algorithm: "3des" });
  return { pfxBase64: forge.util.encode64(forge.asn1.toDer(p12).getBytes()), pfxPassword: password };
}

async function main() {
  if (process.env.SUNAT_LIVE_BETA_TEST !== "true") {
    throw new Error("Prueba bloqueada. Ejecute con SUNAT_LIVE_BETA_TEST=true.");
  }
  const ruc = "20100070970";
  const number = String(Date.now()).slice(-8);
  const draft = buildSunatDraft({
    documentType: "01",
    series: "F001",
    number,
    issueDate: new Date().toISOString().slice(0, 10),
    issuer: { ruc, businessName: "EMPRESA DE PRUEBA SAC", address: "LIMA", ubigeo: "150101", establishmentCode: "0000" },
    customer: { document: ruc, name: "CLIENTE BETA SAC", address: "LIMA" },
    sale: { items: [{ sku: "TEST-001", productName: "PRODUCTO DE PRUEBA BETA", quantitySoldUnits: 1, subtotal: 118 }] },
  });
  const result = await sendBill({
    xml: draft.xml,
    ruc,
    documentType: draft.documentType,
    documentId: draft.documentId,
    environment: "beta",
    credentials: temporaryPfx(),
  });
  console.log(JSON.stringify({
    documentId: draft.documentId,
    responseCode: result.responseCode,
    description: result.description,
    notes: result.notes,
    cdrFileName: result.cdrFileName,
    endpoint: result.endpoint,
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ code: error.code || "BETA_SMOKE_FAILED", message: error.message, details: error.details || null }));
  process.exitCode = 1;
});
