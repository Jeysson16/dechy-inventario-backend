const axios = require("axios");

class DocumentLookupError extends Error {
  constructor(message, { code = "DOCUMENT_LOOKUP_ERROR", status = 400, details = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function normalizeNumber(value) {
  return String(value || "").trim().replace(/\D/g, "");
}

function getDocumentKind(number) {
  if (/^\d{11}$/.test(number)) return "ruc";
  if (/^\d{8}$/.test(number)) return "dni";
  throw new DocumentLookupError("Ingrese un DNI o RUC válido.", {
    code: "INVALID_DOCUMENT_NUMBER",
    status: 422,
  });
}

function getApiKey() {
  const value = String(
    process.env.DOCUMENT_LOOKUP_API_KEY ||
    process.env.SUNAT_API_KEY ||
    process.env.DECOLECTA_API_TOKEN ||
    "",
  ).trim();
  if (!value) {
    throw new DocumentLookupError(
      "Configure DOCUMENT_LOOKUP_API_KEY o SUNAT_API_KEY en el backend para consultar RUC/DNI.",
      { code: "LOOKUP_API_KEY_REQUIRED", status: 503 },
    );
  }
  return value;
}

function buildLookupRequest(number, apiKey) {
  const kind = getDocumentKind(number);
  const baseUrl = kind === "ruc"
    ? (process.env.DOCUMENT_LOOKUP_RUC_URL || "https://api.decolecta.com/v1/sunat/ruc")
    : (process.env.DOCUMENT_LOOKUP_DNI_URL || "https://api.decolecta.com/v1/reniec/dni");
  const query = new URLSearchParams({ numero: number, token: apiKey });
  return { kind, url: `${baseUrl}?${query.toString()}` };
}

function buildDniName(payload = {}) {
  return String(
    payload.nombre_completo ||
    payload.nombreCompleto ||
    payload.razon_social ||
    [
      payload.nombres,
      payload.apellido_paterno,
      payload.apellido_materno,
    ].filter(Boolean).join(" "),
  ).trim();
}

function normalizeLookupResult(kind, number, payload = {}) {
  const name = kind === "ruc"
    ? String(payload.razon_social || payload.nombre_o_razon_social || payload.nombre || "").trim()
    : buildDniName(payload);

  if (!name) {
    throw new DocumentLookupError("El proveedor no devolvió datos válidos para este documento.", {
      code: "LOOKUP_EMPTY_RESULT",
      status: 502,
    });
  }

  return {
    documentType: kind,
    number,
    name,
    address: String(payload.direccion || payload.domicilio_fiscal || "").trim(),
    status: String(payload.estado || "").trim(),
    condition: String(payload.condicion || "").trim(),
    raw: payload,
  };
}

function mapProviderError(error) {
  const status = Number(error?.response?.status || 0);
  const data = error?.response?.data || {};
  const message = String(data?.message || data?.error || "").trim().toLowerCase();

  if (status === 404 || message.includes("no valido") || message.includes("no válido") || message.includes("no encontrado")) {
    return new DocumentLookupError("No se encontraron datos para el documento indicado.", {
      code: "DOCUMENT_NOT_FOUND",
      status: 404,
    });
  }

  if (status === 401 || status === 403) {
    return new DocumentLookupError("La clave del proveedor de consulta documental no es válida.", {
      code: "LOOKUP_PROVIDER_AUTH_FAILED",
      status: 502,
    });
  }

  if (error instanceof DocumentLookupError) return error;

  return new DocumentLookupError("No se pudo consultar el documento en el proveedor externo.", {
    code: "LOOKUP_PROVIDER_UNAVAILABLE",
    status: 502,
  });
}

async function lookupPeruvianDocument(value, {
  httpGet = axios.get,
  apiKey = getApiKey(),
} = {}) {
  const number = normalizeNumber(value);
  const request = buildLookupRequest(number, apiKey);

  try {
    const response = await httpGet(request.url, {
      headers: { Accept: "application/json" },
      timeout: 15000,
    });
    return normalizeLookupResult(request.kind, number, response?.data || {});
  } catch (error) {
    throw mapProviderError(error);
  }
}

module.exports = {
  DocumentLookupError,
  buildLookupRequest,
  lookupPeruvianDocument,
  normalizeLookupResult,
};
