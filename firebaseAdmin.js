const { applicationDefault, cert, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

let services;

function isTokenVerificationError(error) {
  return [
    "auth/argument-error",
    "auth/id-token-expired",
    "auth/id-token-revoked",
    "auth/invalid-id-token",
  ].includes(error?.code);
}

function firebaseOptions() {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (rawServiceAccount) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(rawServiceAccount);
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON no contiene JSON válido.");
    }
    if (projectId && serviceAccount.project_id && projectId !== serviceAccount.project_id) {
      throw new Error("FIREBASE_PROJECT_ID no coincide con project_id de FIREBASE_SERVICE_ACCOUNT_JSON.");
    }
    return { credential: cert(serviceAccount), projectId: projectId || serviceAccount.project_id };
  }
  return { credential: applicationDefault(), ...(projectId ? { projectId } : {}) };
}

function getFirebaseServices() {
  if (services) return services;
  const app = getApps()[0] || initializeApp(firebaseOptions());
  services = { app, auth: getAuth(app), db: getFirestore(app) };
  return services;
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

async function authenticateFirebase(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, code: "AUTH_REQUIRED", message: "Inicie sesión para usar SUNAT." });
    }
    const { auth, db } = getFirebaseServices();
    const decoded = await auth.verifyIdToken(token);
    const employeeSnapshot = await db.collection("employees").doc(decoded.uid).get();
    if (!employeeSnapshot.exists) {
      return res.status(403).json({ success: false, code: "EMPLOYEE_PROFILE_REQUIRED", message: "El usuario no tiene perfil de empleado." });
    }
    req.firebaseUser = decoded;
    req.employeeProfile = employeeSnapshot.data();
    return next();
  } catch (error) {
    console.error("Firebase authentication failed:", error?.code || error?.message);
    if (!isTokenVerificationError(error)) {
      return res.status(503).json({
        success: false,
        code: "FIREBASE_ADMIN_UNAVAILABLE",
        message: "El backend no pudo validar Firebase. Revise FIREBASE_PROJECT_ID y FIREBASE_SERVICE_ACCOUNT_JSON en Vercel.",
      });
    }
    return res.status(401).json({ success: false, code: "INVALID_FIREBASE_TOKEN", message: "La sesión de Firebase no es válida." });
  }
}

function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    const role = req.employeeProfile?.role;
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({ success: false, code: "ROLE_FORBIDDEN", message: "No tiene permisos para esta operación." });
    }
    return next();
  };
}

module.exports = { authenticateFirebase, getFirebaseServices, isTokenVerificationError, requireRoles };
