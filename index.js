const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { buildSunatDraft, SunatValidationError } = require("./sunat");
const { DocumentLookupError, lookupPeruvianDocument } = require("./documentLookupService");
const { authenticateFirebase, requireRoles } = require("./firebaseAdmin");
const {
  FiscalServiceError,
  getConfigurationStatus,
  previewSale,
  saveConfiguration,
  sendSaleToSunat,
} = require("./fiscalService");
const { SunatTransportError } = require("./sunatTransport");

const app = express();
const port = process.env.PORT || 3001;
const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
  "https://dechy-inventario.web.app,https://dechy-inventario.firebaseapp.com,http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: "5mb" }));

app.get("/", (_req, res) => {
  res.json({
    service: "dechy-inventario-backend",
    status: "ok",
    sunatMode: process.env.SUNAT_PRODUCTION_ENABLED === "true" ? "production-enabled" : "beta-only",
    message: "La previsualización es local. Los envíos autenticados están limitados al ambiente configurado.",
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "dechy-inventario-backend",
    sunatMode: process.env.SUNAT_PRODUCTION_ENABLED === "true" ? "production-enabled" : "beta-only",
    betaSunatEnabled: process.env.SUNAT_BETA_ENABLED !== "false",
    productionSunatEnabled: process.env.SUNAT_PRODUCTION_ENABLED === "true",
  });
});

function preview(req, res) {
  try {
    const draft = buildSunatDraft(req.body);
    res.json({ success: true, data: draft });
  } catch (error) {
    if (error instanceof SunatValidationError) {
      return res.status(422).json({
        success: false,
        code: "SUNAT_VALIDATION_ERROR",
        errors: error.errors,
      });
    }
    console.error("Error building SUNAT draft:", error);
    return res.status(500).json({ success: false, code: "INTERNAL_ERROR" });
  }
}

app.post("/api/sunat/preview", preview);

function fiscalError(error, res) {
  if (error instanceof DocumentLookupError) {
    return res.status(error.status || 422).json({
      success: false,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  if (error instanceof FiscalServiceError || error instanceof SunatTransportError) {
    return res.status(error.status || 422).json({
      success: false,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  console.error("Fiscal service error:", error?.code || error?.message);
  return res.status(503).json({
    success: false,
    code: "FISCAL_SERVICE_UNAVAILABLE",
    message: "El backend no pudo acceder de forma segura a Firebase o SUNAT.",
  });
}

app.get(
  "/api/documents/:number",
  authenticateFirebase,
  async (req, res) => {
    try {
      return res.json({ success: true, data: await lookupPeruvianDocument(req.params.number) });
    } catch (error) {
      return fiscalError(error, res);
    }
  },
);

app.get(
  "/api/sunat/config/status",
  authenticateFirebase,
  requireRoles("admin"),
  async (_req, res) => {
    try {
      return res.json({ success: true, data: await getConfigurationStatus() });
    } catch (error) {
      return fiscalError(error, res);
    }
  },
);

app.put(
  "/api/sunat/config",
  authenticateFirebase,
  requireRoles("admin"),
  async (req, res) => {
    try {
      const data = await saveConfiguration(req.body, req.firebaseUser);
      return res.json({ success: true, data });
    } catch (error) {
      return fiscalError(error, res);
    }
  },
);

app.get(
  "/api/sunat/sales/:saleId/preview",
  authenticateFirebase,
  requireRoles("admin", "manager"),
  async (req, res) => {
    try {
      return res.json({ success: true, data: await previewSale(req.params.saleId) });
    } catch (error) {
      return fiscalError(error, res);
    }
  },
);

app.post(
  "/api/sunat/sales/:saleId/send",
  authenticateFirebase,
  requireRoles("admin", "manager"),
  async (req, res) => {
    try {
      const data = await sendSaleToSunat(
        req.params.saleId,
        req.body?.environment || "beta",
        req.firebaseUser,
      );
      return res.json({ success: true, data });
    } catch (error) {
      return fiscalError(error, res);
    }
  },
);

// Compatibilidad temporal con el endpoint antiguo. Solo permite previsualizar.
app.post("/api/sunat/emitir", (req, res) => {
  if (req.body?.dryRun === true) return preview(req, res);
  return res.status(409).json({
    success: false,
    code: "SUNAT_SEND_DISABLED",
    message: "Envío bloqueado. Use dryRun=true o POST /api/sunat/preview.",
  });
});

if (require.main === module) {
  app.listen(port, () => console.log(`Backend server running on port ${port}`));
}

module.exports = app;
