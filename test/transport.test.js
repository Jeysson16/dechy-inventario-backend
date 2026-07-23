const test = require("node:test");
const assert = require("node:assert/strict");
const forge = require("node-forge");
const AdmZip = require("adm-zip");
const { buildSunatDraft } = require("../sunat");
const { parseCdrSoap, signUbl } = require("../sunatTransport");

function testPfx() {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() - 60000);
  certificate.validity.notAfter = new Date(Date.now() + 86400000);
  const attributes = [{ name: "commonName", value: "SUNAT BETA TEST" }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, certificate, "test-password", { algorithm: "3des" });
  return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}

test("firma el UBL dentro de ExtensionContent usando un PFX", () => {
  const draft = buildSunatDraft({
    documentType: "03", series: "B001", number: 1, issueDate: "2026-07-17",
    issuer: { ruc: "20100070970", businessName: "EMPRESA PRUEBA", address: "Lima", ubigeo: "150101" },
    customer: { document: "12345678", name: "CLIENTE" },
    sale: { items: [{ productName: "Producto", quantitySoldUnits: 1, subtotal: 118 }] },
  });
  const signed = signUbl(draft.xml, testPfx(), "test-password");
  assert.match(signed, /<ext:ExtensionContent><ds:Signature/);
  assert.match(signed, /<ds:X509Certificate>/);
  assert.match(signed, /<cac:PaymentTerms>/);
});

test("extrae código, descripción y observaciones del CDR", () => {
  const cdrXml = `<?xml version="1.0"?><ApplicationResponse xmlns:cbc="urn:test"><cbc:ResponseCode>0</cbc:ResponseCode><cbc:Description>Aceptado</cbc:Description><cbc:Note>Observación de prueba</cbc:Note></ApplicationResponse>`;
  const zip = new AdmZip();
  zip.addFile("R-20100070970-03-B001-1.xml", Buffer.from(cdrXml));
  const soap = `<Envelope><Body><applicationResponse>${zip.toBuffer().toString("base64")}</applicationResponse></Body></Envelope>`;
  const result = parseCdrSoap(soap);
  assert.equal(result.responseCode, "0");
  assert.equal(result.description, "Aceptado");
  assert.deepEqual(result.notes, ["Observación de prueba"]);
});
