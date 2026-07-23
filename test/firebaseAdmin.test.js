const test = require("node:test");
const assert = require("node:assert/strict");

const { isTokenVerificationError } = require("../firebaseAdmin");

test("clasifica un token vencido como error de sesión", () => {
  assert.equal(isTokenVerificationError({ code: "auth/id-token-expired" }), true);
});

test("no oculta un fallo de configuración Firebase como token inválido", () => {
  assert.equal(isTokenVerificationError({ code: "app/invalid-credential" }), false);
});
