const axios = require("axios");
const AdmZip = require("adm-zip");
const forge = require("node-forge");
const { SignedXml } = require("xml-crypto");

const ENDPOINTS = {
  beta: "https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService",
  production: "https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService",
};

class SunatTransportError extends Error {
  constructor(message, { code = "SUNAT_TRANSPORT_ERROR", details = null } = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const xmlEscape = (value = "") => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&apos;");

function readPfx(pfxBase64, password = "") {
  try {
    const bytes = forge.util.decode64(String(pfxBase64 || "").replace(/^data:[^,]+,/, ""));
    const p12Asn1 = forge.asn1.fromDer(bytes);
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
    const keyBags = [
      ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
      ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
    ];
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    const keyBag = keyBags[0];
    const certBag = certBags.find((bag) =>
      bag.cert?.publicKey?.n?.toString(16) === keyBag?.key?.n?.toString(16)
      && bag.cert?.publicKey?.e?.toString(16) === keyBag?.key?.e?.toString(16),
    ) || certBags[0];
    if (!keyBag?.key || !certBag?.cert) throw new Error("El PFX no contiene clave privada y certificado.");
    const now = new Date();
    if (now < certBag.cert.validity.notBefore || now > certBag.cert.validity.notAfter) {
      throw new Error("El certificado del PFX está vencido o todavía no es válido.");
    }
    return {
      privateKey: forge.pki.privateKeyToPem(keyBag.key),
      publicCert: forge.pki.certificateToPem(certBag.cert),
    };
  } catch (error) {
    throw new SunatTransportError("No se pudo abrir el certificado PFX. Verifique el archivo y su contraseña.", {
      code: "INVALID_PFX",
      details: error.message,
    });
  }
}

function signUbl(xml, pfxBase64, pfxPassword) {
  const { privateKey, publicCert } = readPfx(pfxBase64, pfxPassword);
  const signature = new SignedXml({
    privateKey,
    publicCert,
    getKeyInfoContent: SignedXml.getKeyInfoContent,
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  });
  signature.addReference({
    xpath: "/*",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    isEmptyUri: true,
  });
  signature.computeSignature(xml, {
    prefix: "ds",
    location: { reference: "//*[local-name(.)='ExtensionContent']", action: "append" },
  });
  return signature.getSignedXml();
}

function soapEnvelope(username, password, fileName, zipBase64) {
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.sunat.gob.pe" xmlns:wsse="http://schemas.xmlsoap.org/ws/2002/12/secext"><soapenv:Header><wsse:Security><wsse:UsernameToken><wsse:Username>${xmlEscape(username)}</wsse:Username><wsse:Password>${xmlEscape(password)}</wsse:Password></wsse:UsernameToken></wsse:Security></soapenv:Header><soapenv:Body><ser:sendBill><fileName>${xmlEscape(fileName)}</fileName><contentFile>${zipBase64}</contentFile></ser:sendBill></soapenv:Body></soapenv:Envelope>`;
}

function matchXml(xml, localName) {
  const match = String(xml).match(new RegExp(`<(?:(?:\\w+):)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${localName}>`, "i"));
  return match?.[1]?.trim() || null;
}

function decodeEntities(value = "") {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

function parseCdrSoap(soapXml) {
  const faultCode = matchXml(soapXml, "faultcode");
  if (faultCode) {
    throw new SunatTransportError(decodeEntities(matchXml(soapXml, "faultstring") || "SUNAT rechazó la solicitud SOAP."), {
      code: faultCode,
    });
  }
  const encoded = matchXml(soapXml, "applicationResponse");
  if (!encoded) throw new SunatTransportError("SUNAT no devolvió un CDR.", { code: "CDR_MISSING" });
  const cdrZip = new AdmZip(Buffer.from(encoded, "base64"));
  const entry = cdrZip.getEntries().find((item) => !item.isDirectory && item.entryName.toLowerCase().endsWith(".xml"));
  if (!entry) throw new SunatTransportError("El CDR no contiene XML.", { code: "CDR_XML_MISSING" });
  const cdrXml = entry.getData().toString("utf8");
  const responseCode = decodeEntities(matchXml(cdrXml, "ResponseCode") || "");
  const description = decodeEntities(matchXml(cdrXml, "Description") || "");
  const notes = [...cdrXml.matchAll(/<(?:(?:\w+):)?Note(?:\s[^>]*)?>([\s\S]*?)<\/(?:(?:\w+):)?Note>/gi)]
    .map((match) => decodeEntities(match[1].trim()));
  return { responseCode, description, notes, cdrFileName: entry.entryName, cdrXml };
}

async function sendBill({ xml, ruc, documentType, documentId, environment, credentials, timeoutMs = 30000 }) {
  if (!ENDPOINTS[environment]) throw new SunatTransportError("Ambiente SUNAT no permitido.", { code: "INVALID_ENVIRONMENT" });
  const signedXml = signUbl(xml, credentials.pfxBase64, credentials.pfxPassword || "");
  const baseName = `${ruc}-${documentType}-${documentId}`;
  const zip = new AdmZip();
  zip.addFile(`${baseName}.xml`, Buffer.from(signedXml, "utf8"));
  const username = environment === "beta" ? `${ruc}MODDATOS` : `${ruc}${credentials.usuarioSol}`;
  const password = environment === "beta" ? "MODDATOS" : credentials.claveSol;
  const response = await axios.post(
    ENDPOINTS[environment],
    soapEnvelope(username, password, `${baseName}.zip`, zip.toBuffer().toString("base64")),
    {
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "sendBill" },
      timeout: timeoutMs,
      responseType: "text",
      transformResponse: [(value) => value],
      validateStatus: () => true,
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new SunatTransportError(`SUNAT respondió HTTP ${response.status}.`, { code: "SUNAT_HTTP_ERROR" });
  }
  return { ...parseCdrSoap(response.data), signedXml, endpoint: ENDPOINTS[environment] };
}

module.exports = { ENDPOINTS, SunatTransportError, parseCdrSoap, readPfx, sendBill, signUbl };
