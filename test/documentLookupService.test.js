const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DocumentLookupError,
  buildLookupRequest,
  lookupPeruvianDocument,
  normalizeLookupResult,
} = require("../documentLookupService");

test("arma la URL de consulta RUC con el token del backend", () => {
  const request = buildLookupRequest("20100070970", "secret-token");
  assert.equal(request.kind, "ruc");
  assert.match(request.url, /^https:\/\/api\.decolecta\.com\/v1\/sunat\/ruc\?/);
  assert.match(request.url, /numero=20100070970/);
  assert.match(request.url, /token=secret-token/);
});

test("arma la URL de consulta DNI con el token del backend", () => {
  const request = buildLookupRequest("12345678", "secret-token");
  assert.equal(request.kind, "dni");
  assert.match(request.url, /^https:\/\/api\.decolecta\.com\/v1\/reniec\/dni\?/);
  assert.match(request.url, /numero=12345678/);
});

test("normaliza respuesta RUC para el frontend", () => {
  const result = normalizeLookupResult("ruc", "20100070970", {
    razon_social: "EMPRESA DEMO SAC",
    direccion: "AV PERU 123",
    estado: "ACTIVO",
    condicion: "HABIDO",
  });
  assert.equal(result.documentType, "ruc");
  assert.equal(result.name, "EMPRESA DEMO SAC");
  assert.equal(result.address, "AV PERU 123");
});

test("normaliza respuesta DNI para el frontend", () => {
  const result = normalizeLookupResult("dni", "12345678", {
    nombres: "JUAN",
    apellido_paterno: "PEREZ",
    apellido_materno: "LOPEZ",
  });
  assert.equal(result.documentType, "dni");
  assert.equal(result.name, "JUAN PEREZ LOPEZ");
  assert.equal(result.address, "");
});

test("rechaza documentos con longitud inválida", async () => {
  await assert.rejects(
    lookupPeruvianDocument("123", {
      apiKey: "secret-token",
      httpGet: async () => ({ data: {} }),
    }),
    (error) => error instanceof DocumentLookupError && error.code === "INVALID_DOCUMENT_NUMBER",
  );
});

test("mapea 404 del proveedor a documento no encontrado", async () => {
  await assert.rejects(
    lookupPeruvianDocument("12345678", {
      apiKey: "secret-token",
      httpGet: async () => {
        const error = new Error("not found");
        error.response = { status: 404, data: { message: "dni no encontrado" } };
        throw error;
      },
    }),
    (error) => error instanceof DocumentLookupError && error.code === "DOCUMENT_NOT_FOUND",
  );
});
