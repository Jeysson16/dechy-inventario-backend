const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function localDevelopmentKey() {
  if (process.env.NODE_ENV === "production") return "";
  const keyPath = process.env.SUNAT_CONFIG_KEY_FILE || path.join(__dirname, ".sunat-config.key");
  try {
    return fs.readFileSync(keyPath, "utf8").trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const generated = crypto.randomBytes(32).toString("base64");
    try {
      fs.writeFileSync(keyPath, generated, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return generated;
    } catch (writeError) {
      if (writeError.code === "EEXIST") return fs.readFileSync(keyPath, "utf8").trim();
      throw writeError;
    }
  }
}

function encryptionKey() {
  const raw = String(process.env.SUNAT_CONFIG_ENCRYPTION_KEY || localDevelopmentKey()).trim();
  if (!raw) throw new Error("SUNAT_CONFIG_ENCRYPTION_KEY no está configurada.");
  const key = /^[a-f\d]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("SUNAT_CONFIG_ENCRYPTION_KEY debe representar exactamente 32 bytes.");
  return key;
}

function encryptionReady() {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptSecret(value = {}) {
  if (value.version !== 1 || value.algorithm !== "aes-256-gcm") throw new Error("Formato de secreto SUNAT no compatible.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  const cleartext = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(cleartext.toString("utf8"));
}

module.exports = { decryptSecret, encryptSecret, encryptionReady };
