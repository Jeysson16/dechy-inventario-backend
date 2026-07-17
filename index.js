const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { buildSunatDraft, SunatValidationError } = require("./sunat");

const app = express();
const port = process.env.PORT || 3001;
const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
  "https://dechy-inventario.web.app,https://dechy-inventario.firebaseapp.com,http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({
    service: "dechy-inventario-backend",
    status: "ok",
    sunatMode: "dry-run",
    message: "La transmisión a SUNAT está deshabilitada. Use POST /api/sunat/preview.",
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "dechy-inventario-backend",
    sunatMode: "dry-run",
    outboundSunatEnabled: false,
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
