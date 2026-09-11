// Password hashing (scrypt, built into Node's crypto — no bcrypt dependency
// needed) and opaque session tokens (random, server-side, revocable — not
// JWTs, so there's no risk of a forged/self-signed token being accepted).

const crypto = require("crypto");
const { withTable } = require("./db");

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hashHex] = stored.split(":");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const storedBuf = Buffer.from(hashHex, "hex");
  if (storedBuf.length !== hash.length) return false;
  return crypto.timingSafeEqual(hash, storedBuf);
}

function genToken() {
  return crypto.randomBytes(32).toString("hex");
}

function genOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

async function createSession(email, role) {
  const token = genToken();
  await withTable("sessions", (sessions) => {
    sessions[token] = { email, role, expiresAt: Date.now() + SESSION_TTL_MS };
  });
  return token;
}

async function getSession(token) {
  if (!token) return null;
  const sessions = await withTable("sessions", (s) => s);
  const session = sessions[token];
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    await withTable("sessions", (s) => {
      delete s[token];
    });
    return null;
  }
  return session;
}

async function destroySession(token) {
  await withTable("sessions", (s) => {
    delete s[token];
  });
}

module.exports = {
  hashPassword,
  verifyPassword,
  genToken,
  genOtp,
  createSession,
  getSession,
  destroySession,
};
