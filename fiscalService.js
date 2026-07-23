const { FieldValue } = require("firebase-admin/firestore");
const { getFirebaseServices } = require("./firebaseAdmin");
const { decryptSecret, encryptSecret, encryptionReady } = require("./secretConfig");
const { buildSunatDraft, validRuc } = require("./sunat");
const { sendBill } = require("./sunatTransport");

class FiscalServiceError extends Error {
  constructor(message, { code = "FISCAL_SERVICE_ERROR", status = 400, details = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const PUBLIC_FIELDS = [
  "ruc", "razonSocial", "direccion", "ubigeo", "establishmentCode",
  "facturaSeries", "boletaSeries", "environment",
];

function cleanPublicConfig(input = {}) {
  const result = {};
  PUBLIC_FIELDS.forEach((key) => {
    if (input[key] !== undefined) result[key] = String(input[key]).trim();
  });
  result.environment = result.environment === "production" ? "production" : "beta";
  result.establishmentCode = result.establishmentCode || "0000";
  result.facturaSeries = (result.facturaSeries || "F001").toUpperCase();
  result.boletaSeries = (result.boletaSeries || "B001").toUpperCase();
  return result;
}

function validatePublicConfig(config) {
  const errors = [];
  if (!validRuc(config.ruc)) errors.push("RUC del emisor inválido.");
  if (!config.razonSocial) errors.push("Razón social requerida.");
  if (!config.direccion) errors.push("Dirección fiscal requerida.");
  if (!/^\d{6}$/.test(config.ubigeo || "")) errors.push("Ubigeo SUNAT de 6 dígitos requerido.");
  if (!/^F[A-Z0-9]{3}$/.test(config.facturaSeries || "")) errors.push("Serie de factura inválida.");
  if (!/^B[A-Z0-9]{3}$/.test(config.boletaSeries || "")) errors.push("Serie de boleta inválida.");
  if (errors.length) throw new FiscalServiceError(errors.join(" "), { code: "INVALID_SUNAT_CONFIG", details: errors });
}

function secretFlags(credentials = {}) {
  return {
    usuarioSolConfigured: Boolean(credentials.usuarioSol),
    claveSolConfigured: Boolean(credentials.claveSol),
    certificateConfigured: Boolean(credentials.pfxBase64),
    certificatePasswordConfigured: Boolean(credentials.pfxPassword),
  };
}

async function readConfiguration({ includeSecrets = false } = {}) {
  const { db } = getFirebaseServices();
  const [publicSnapshot, privateSnapshot] = await Promise.all([
    db.collection("settings").doc("sunat").get(),
    db.collection("privateSettings").doc("sunat").get(),
  ]);
  const publicConfig = publicSnapshot.exists ? cleanPublicConfig(publicSnapshot.data()) : null;
  let credentials = null;
  if (privateSnapshot.exists && encryptionReady()) credentials = decryptSecret(privateSnapshot.data().encrypted);
  return {
    publicConfig,
    credentials: includeSecrets ? credentials : undefined,
    secretStatus: secretFlags(credentials || {}),
    legacySecretsDetected: Boolean(
      publicSnapshot.data()?.usuarioSol || publicSnapshot.data()?.claveSol ||
      publicSnapshot.data()?.cdtBase64 || publicSnapshot.data()?.pfxBase64
    ),
  };
}

async function getConfigurationStatus() {
  const configuration = await readConfiguration();
  return {
    configured: Boolean(configuration.publicConfig?.ruc),
    publicConfig: configuration.publicConfig,
    ...configuration.secretStatus,
    legacySecretsDetected: configuration.legacySecretsDetected,
    encryptionReady: encryptionReady(),
    betaEnabled: process.env.SUNAT_BETA_ENABLED !== "false",
    productionEnabled: process.env.SUNAT_PRODUCTION_ENABLED === "true",
  };
}

async function saveConfiguration(payload, actor) {
  const { db } = getFirebaseServices();
  const publicConfig = cleanPublicConfig(payload);
  validatePublicConfig(publicConfig);
  if (!encryptionReady()) {
    throw new FiscalServiceError("Configure SUNAT_CONFIG_ENCRYPTION_KEY en el backend antes de guardar credenciales.", {
      code: "ENCRYPTION_KEY_REQUIRED", status: 503,
    });
  }

  const current = await readConfiguration({ includeSecrets: true });
  const legacy = (await db.collection("settings").doc("sunat").get()).data() || {};
  const supplied = payload.credentials || {};
  const credentials = {
    usuarioSol: String(supplied.usuarioSol || current.credentials?.usuarioSol || legacy.usuarioSol || "").trim(),
    claveSol: String(supplied.claveSol || current.credentials?.claveSol || legacy.claveSol || ""),
    pfxBase64: String(supplied.pfxBase64 || current.credentials?.pfxBase64 || legacy.cdtBase64 || legacy.pfxBase64 || "").replace(/^data:[^,]+,/, ""),
    pfxPassword: String(supplied.pfxPassword || current.credentials?.pfxPassword || ""),
  };
  if (!credentials.pfxBase64) {
    throw new FiscalServiceError("Debe cargar el certificado digital PFX para firmar los comprobantes.", {
      code: "PFX_REQUIRED",
    });
  }
  if (Buffer.byteLength(credentials.pfxBase64, "utf8") > 700000) {
    throw new FiscalServiceError("El certificado PFX supera el tamaño permitido.", { code: "PFX_TOO_LARGE" });
  }
  if (publicConfig.environment === "production" && (!credentials.usuarioSol || !credentials.claveSol)) {
    throw new FiscalServiceError("Usuario y Clave SOL son obligatorios para producción.", { code: "SOL_REQUIRED" });
  }

  const batch = db.batch();
  batch.set(db.collection("settings").doc("sunat"), {
    ...publicConfig,
    usuarioSol: FieldValue.delete(), claveSol: FieldValue.delete(), cdtBase64: FieldValue.delete(), pfxBase64: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid,
  }, { merge: true });
  batch.set(db.collection("privateSettings").doc("sunat"), {
    encrypted: encryptSecret(credentials),
    updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid,
  });
  await batch.commit();
  return getConfigurationStatus();
}

function issueDate(value) {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function saleDocumentType(sale) {
  if (sale.documentType === "factura") return "01";
  if (sale.documentType === "boleta") return "03";
  throw new FiscalServiceError("Las notas de venta internas no se envían a SUNAT.", { code: "NOT_A_FISCAL_SALE" });
}

function draftInput(sale, config, number) {
  const documentType = saleDocumentType(sale);
  return {
    documentType,
    series: documentType === "01" ? config.facturaSeries : config.boletaSeries,
    number,
    issueDate: issueDate(sale.date || sale.paymentDate || sale.createdAt),
    issuer: {
      ruc: config.ruc,
      businessName: config.razonSocial,
      address: config.direccion,
      ubigeo: config.ubigeo,
      establishmentCode: config.establishmentCode,
    },
    customer: {
      document: sale.documentRUC || sale.customerDNI || "",
      name: sale.customerName || "CLIENTE GENERAL",
      address: sale.customerAddress || "",
    },
    sale,
  };
}

async function loadSaleAndConfig(saleId) {
  const { db } = getFirebaseServices();
  const [saleSnapshot, configuration] = await Promise.all([
    db.collection("sales").doc(saleId).get(),
    readConfiguration({ includeSecrets: true }),
  ]);
  if (!saleSnapshot.exists) throw new FiscalServiceError("Venta no encontrada.", { code: "SALE_NOT_FOUND", status: 404 });
  if (!configuration.publicConfig) throw new FiscalServiceError("Configuración SUNAT incompleta.", { code: "SUNAT_NOT_CONFIGURED" });
  validatePublicConfig(configuration.publicConfig);
  return { db, sale: { id: saleSnapshot.id, ...saleSnapshot.data() }, ...configuration };
}

async function previewSale(saleId) {
  const { sale, publicConfig } = await loadSaleAndConfig(saleId);
  const existingNumber = String(sale.sunat?.documentId || "").split("-")[1] || "1";
  return buildSunatDraft(draftInput(sale, publicConfig, existingNumber));
}

async function reserveFiscalDocument(db, saleId, publicConfig, actor) {
  const saleRef = db.collection("sales").doc(saleId);
  return db.runTransaction(async (transaction) => {
    const saleSnapshot = await transaction.get(saleRef);
    if (!saleSnapshot.exists) throw new FiscalServiceError("Venta no encontrada.", { code: "SALE_NOT_FOUND", status: 404 });
    const sale = { id: saleSnapshot.id, ...saleSnapshot.data() };
    if (sale.status === "cancelled") throw new FiscalServiceError("Una venta anulada no puede emitirse.", { code: "SALE_CANCELLED" });
    const documentType = saleDocumentType(sale);
    const currentStatus = sale.sunat?.status;
    if (["processing", "pending_cdr"].includes(currentStatus)) throw new FiscalServiceError("La venta ya tiene un envío SUNAT en proceso.", { code: "SUNAT_SEND_IN_PROGRESS", status: 409 });
    if (["accepted", "accepted_with_observations"].includes(currentStatus)) {
      throw new FiscalServiceError("La venta ya fue aceptada por SUNAT.", { code: "ALREADY_ACCEPTED", status: 409 });
    }
    const series = documentType === "01" ? publicConfig.facturaSeries : publicConfig.boletaSeries;
    let number = String(sale.sunat?.documentId || "").split("-")[1] || null;
    if (!number) {
      const counterRef = db.collection("fiscalCounters").doc(`${publicConfig.ruc}_${series}`);
      const counterSnapshot = await transaction.get(counterRef);
      number = String((counterSnapshot.data()?.lastNumber || 0) + 1);
      transaction.set(counterRef, { ruc: publicConfig.ruc, series, lastNumber: Number(number), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    const documentId = `${series}-${number}`;
    transaction.set(saleRef, {
      sunat: {
        ...(sale.sunat || {}), documentType, documentId, status: "processing", sentToSunat: false,
        environment: "beta", lastAttemptAt: FieldValue.serverTimestamp(), lastAttemptBy: actor.uid,
      },
    }, { merge: true });
    return { sale, documentType, series, number, documentId };
  });
}

async function sendSaleToSunat(saleId, environment, actor) {
  if (environment === "production" && process.env.SUNAT_PRODUCTION_ENABLED !== "true") {
    throw new FiscalServiceError("El envío a producción está bloqueado en el backend.", { code: "PRODUCTION_SEND_DISABLED", status: 409 });
  }
  if (environment !== "production" && process.env.SUNAT_BETA_ENABLED === "false") {
    throw new FiscalServiceError("El envío a SUNAT beta está deshabilitado.", { code: "BETA_SEND_DISABLED", status: 409 });
  }
  const targetEnvironment = environment === "production" ? "production" : "beta";
  const { db, publicConfig, credentials } = await loadSaleAndConfig(saleId);
  if (!credentials?.pfxBase64) throw new FiscalServiceError("Certificado PFX no configurado en el backend.", { code: "PFX_REQUIRED" });
  const reservation = await reserveFiscalDocument(db, saleId, publicConfig, actor);
  const draft = buildSunatDraft(draftInput(reservation.sale, publicConfig, reservation.number));
  const saleRef = db.collection("sales").doc(saleId);
  try {
    const result = await sendBill({
      xml: draft.xml, ruc: publicConfig.ruc, documentType: reservation.documentType,
      documentId: reservation.documentId, environment: targetEnvironment, credentials,
    });
    const accepted = result.responseCode === "0";
    const status = accepted ? (result.notes.length ? "accepted_with_observations" : "accepted") : "rejected";
    const audit = {
      saleId, documentId: reservation.documentId, documentType: reservation.documentType,
      environment: targetEnvironment, endpoint: result.endpoint, unsignedXml: draft.xml,
      signedXml: result.signedXml, cdrXml: result.cdrXml, responseCode: result.responseCode,
      description: result.description, notes: result.notes, createdAt: FieldValue.serverTimestamp(), actorUid: actor.uid,
    };
    const batch = db.batch();
    batch.set(saleRef, { sunat: {
      ...(reservation.sale.sunat || {}), documentType: reservation.documentType,
      documentId: reservation.documentId, environment: targetEnvironment, status,
      sentToSunat: true, responseCode: result.responseCode, description: result.description,
      notes: result.notes, cdrFileName: result.cdrFileName, respondedAt: FieldValue.serverTimestamp(),
    } }, { merge: true });
    batch.set(db.collection("sunatOutbox").doc(`${saleId}_${reservation.documentId}`), audit);
    await batch.commit();
    return { ...audit, createdAt: undefined, cdrFileName: result.cdrFileName, accepted, status };
  } catch (error) {
    await saleRef.set({ sunat: {
      ...(reservation.sale.sunat || {}), documentType: reservation.documentType,
      documentId: reservation.documentId, environment: targetEnvironment, status: "send_error",
      sentToSunat: false, errorCode: error.code || "SUNAT_SEND_ERROR", errorMessage: error.message,
      failedAt: FieldValue.serverTimestamp(),
    } }, { merge: true });
    throw error;
  }
}

module.exports = {
  FiscalServiceError, getConfigurationStatus, previewSale, readConfiguration,
  saveConfiguration, sendSaleToSunat,
};
