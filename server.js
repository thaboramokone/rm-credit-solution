const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// Minimal .env loader (no dotenv dependency). Platforms like Render/
// Railway let you set environment variables directly in their dashboard,
// in which case there's no .env file and this is a harmless no-op — this
// is here for local development and plain VPS deployments.
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
})();

const { withTable, readTable } = require("./lib/db");
const auth = require("./lib/auth");
const { sendMail } = require("./lib/mailer");
const { saveUploadedFile, uploadPath } = require("./lib/uploads");
const { rateLimit } = require("./lib/rateLimit");
const V = require("./lib/validators");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const MAX_BODY_BYTES = 12 * 1024 * 1024; // headroom above an 8MB base64 file

// ---------- tiny router ----------

const routes = []; // { method, pattern: RegExp, keys: string[], handler }

function addRoute(method, path, handler) {
  const keys = [];
  const pattern = new RegExp(
    "^" +
      path
        .split("/")
        .map((seg) => {
          if (seg.startsWith(":")) {
            keys.push(seg.slice(1));
            return "([^/]+)";
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/") +
      "$"
  );
  routes.push({ method, pattern, keys, handler });
}

function get(path, handler) { addRoute("GET", path, handler); }
function post(path, handler) { addRoute("POST", path, handler); }

// ---------- request helpers ----------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(Object.assign(new Error("Invalid JSON body."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function fail(res, status, message) {
  sendJson(res, status, { error: message });
}

async function requireSession(req, role) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const session = await auth.getSession(token);
  if (!session) {
    const err = new Error("Not signed in.");
    err.status = 401;
    throw err;
  }
  if (role && session.role !== role) {
    const err = new Error("Not authorized.");
    err.status = 403;
    throw err;
  }
  return session;
}

function safeUser(user) {
  if (!user) return null;
  const { passwordHash, otp, ...rest } = user;
  return rest;
}

function safeLoan(loan) {
  // Nothing sensitive beyond what admins/owners are already entitled to see
  // here, but keep this as the one place shaping the API's loan shape.
  return loan;
}

// ---------- customer auth routes ----------

post("/api/signup", async (req, res, params, body) => {
  rateLimit(req, "signup", 5, 60 * 60 * 1000);
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  if (!V.isValidEmail(email)) return fail(res, 400, "Enter a valid email address.");
  if (password.length < 6) return fail(res, 400, "Password must be at least 6 characters.");

  const result = await withTable("users", async (users) => {
    if (users[email]) return { conflict: true };
    const otp = auth.genOtp();
    users[email] = {
      email,
      passwordHash: auth.hashPassword(password),
      verified: false,
      otp: { code: otp, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 },
      profile: null,
      createdAt: new Date().toISOString(),
    };
    return { otp };
  });

  if (result.conflict) return fail(res, 409, "An account with this email already exists — sign in instead.");

  await sendMail({
    to: email,
    subject: "Your RM Credit Solutions verification code",
    text: `Your verification code is ${result.otp}. It expires in 10 minutes.\n\nIf you didn't request this, you can ignore this email.`,
  });

  sendJson(res, 200, { ok: true });
});

post("/api/resend-otp", async (req, res, params, body) => {
  rateLimit(req, "resend-otp", 5, 60 * 60 * 1000);
  const email = (body.email || "").trim().toLowerCase();
  const result = await withTable("users", async (users) => {
    const user = users[email];
    if (!user || user.verified) return { skip: true };
    const otp = auth.genOtp();
    user.otp = { code: otp, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 };
    return { otp };
  });
  if (!result.skip) {
    await sendMail({
      to: email,
      subject: "Your RM Credit Solutions verification code",
      text: `Your verification code is ${result.otp}. It expires in 10 minutes.`,
    });
  }
  // Always respond ok, whether or not the account exists — don't leak
  // which emails are registered.
  sendJson(res, 200, { ok: true });
});

post("/api/verify-otp", async (req, res, params, body) => {
  rateLimit(req, "verify-otp", 15, 60 * 60 * 1000);
  const email = (body.email || "").trim().toLowerCase();
  const code = (body.otp || "").trim();

  const result = await withTable("users", async (users) => {
    const user = users[email];
    if (!user) return { error: "Something went wrong — please sign up again." };
    if (!user.otp) return { error: "No verification is pending for this account." };
    if (Date.now() > user.otp.expiresAt) return { error: "That code has expired — request a new one." };
    if (user.otp.attempts >= OTP_MAX_ATTEMPTS) return { error: "Too many incorrect attempts — request a new code." };
    if (code !== user.otp.code) {
      user.otp.attempts += 1;
      return { error: "That code doesn't match. Check your email and try again." };
    }
    user.verified = true;
    user.otp = null;
    return { ok: true };
  });

  if (result.error) return fail(res, 400, result.error);

  const token = await auth.createSession(email, "customer");
  sendJson(res, 200, { token, email });
});

post("/api/login", async (req, res, params, body) => {
  rateLimit(req, "login", 10, 15 * 60 * 1000);
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  const users = await readTable("users");
  const user = users[email];
  if (!user || !auth.verifyPassword(password, user.passwordHash)) {
    return fail(res, 401, "Incorrect email or password.");
  }
  if (!user.verified) return fail(res, 403, "Please finish email verification before signing in.");

  const token = await auth.createSession(email, "customer");
  sendJson(res, 200, { token, email });
});

post("/api/logout", async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token) await auth.destroySession(token);
  sendJson(res, 200, { ok: true });
});

get("/api/me", async (req, res) => {
  const session = await requireSession(req, "customer");
  const users = await readTable("users");
  sendJson(res, 200, { user: safeUser(users[session.email]) });
});

// ---------- questionnaire ----------

post("/api/questionnaire", async (req, res, params, body) => {
  const session = await requireSession(req, "customer");
  const fullNames = (body.fullNames || "").trim();
  const surname = (body.surname || "").trim();
  const idNumber = (body.idNumber || "").trim();
  const employment = body.employment === "unemployed" ? "unemployed" : "employed";
  const income = Number(body.income || 0);
  const statement = body.statement || {};

  if (!fullNames || !surname) return fail(res, 400, "Enter your full names and surname exactly as shown on your ID.");
  if (!V.isValidSaId(idNumber)) return fail(res, 400, "Enter a valid 13-digit South African ID number.");
  if (employment === "employed" && (!income || income <= 0)) return fail(res, 400, "Enter your monthly income.");

  let statementFileName, statementSource, statementStoredName = null;
  if (statement.mode === "uploaded") {
    try {
      const saved = saveUploadedFile(statement.dataUrl, statement.fileName);
      statementFileName = saved.originalName;
      statementStoredName = saved.storedName;
      statementSource = "uploaded";
    } catch (e) {
      return fail(res, 400, e.message);
    }
  } else if (statement.mode === "confirmed-ready" && (statement.fileName || "").trim()) {
    statementFileName = statement.fileName.trim();
    statementSource = "confirmed-ready";
  } else {
    return fail(res, 400, "Attach your bank statement, or confirm you have it ready and note the file name.");
  }

  const updated = await withTable("users", async (users) => {
    const user = users[session.email];
    user.profile = {
      fullNames,
      surname,
      idNumber,
      employment,
      income: employment === "employed" ? income : 0,
      statementFileName,
      statementSource,
      statementStoredName,
      submittedAt: new Date().toISOString(),
    };
    return user;
  });

  sendJson(res, 200, { user: safeUser(updated) });
});

// ---------- loans (customer) ----------

post("/api/loans", async (req, res, params, body) => {
  const session = await requireSession(req, "customer");
  const amount = Number(body.amount);
  const days = Number(body.days);

  const amountErr = V.validateLoanAmount(amount);
  if (amountErr) return fail(res, 400, amountErr);
  const daysErr = V.validateLoanDays(days);
  if (daysErr) return fail(res, 400, daysErr);

  const users = await readTable("users");
  const user = users[session.email];
  if (!user || !user.profile) return fail(res, 400, "Complete your borrower details before requesting funds.");

  const terms = V.computeLoanTerms(amount, days);
  const loan = {
    id: `loan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    email: session.email,
    applicantName: `${user.profile.fullNames} ${user.profile.surname}`,
    idNumber: user.profile.idNumber,
    employment: user.profile.employment,
    income: user.profile.income,
    statementFileName: user.profile.statementFileName,
    statementSource: user.profile.statementSource,
    amount,
    days,
    ...terms,
    status: "pending",
    requestedAt: new Date().toISOString(),
    decidedAt: null,
    documents: null,
    fundsReleasedAt: null,
  };

  await withTable("loans", async (loans) => {
    loans[loan.id] = loan;
  });

  sendJson(res, 200, { loan });
});

get("/api/loans", async (req, res) => {
  const session = await requireSession(req, "customer");
  const loans = await readTable("loans");
  const mine = Object.values(loans)
    .filter((l) => l.email === session.email)
    .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
  sendJson(res, 200, { loans: mine.map(safeLoan) });
});

post("/api/loans/:id/documents", async (req, res, params, body) => {
  const session = await requireSession(req, "customer");
  const { id } = params;

  const result = await withTable("loans", async (loans) => {
    const loan = loans[id];
    if (!loan) return { status: 404, error: "Request not found." };
    if (loan.email !== session.email) return { status: 403, error: "Not authorized." };
    if (loan.status !== "approved_docs_pending") {
      return { status: 400, error: "This request isn't awaiting documents right now." };
    }

    const idCopyIn = body.idCopy || {};
    const bankStatementIn = body.bankStatement || {};

    for (const [label, doc] of [["Certified ID copy", idCopyIn], ["Bank statement", bankStatementIn]]) {
      const dateErr = V.documentDateError(doc.date, V.DOC_MAX_AGE_MONTHS);
      if (dateErr) return { status: 400, error: `${label}: ${dateErr}` };
      if (doc.mode !== "uploaded" && !(doc.mode === "confirmed-ready" && (doc.fileName || "").trim())) {
        return { status: 400, error: `${label}: attach a file, or confirm you have it ready and note the file name.` };
      }
    }

    function processDoc(doc) {
      if (doc.mode === "uploaded") {
        const saved = saveUploadedFile(doc.dataUrl, doc.fileName);
        return { fileName: saved.originalName, storedName: saved.storedName, source: "uploaded", date: doc.date };
      }
      return { fileName: doc.fileName.trim(), storedName: null, source: "confirmed-ready", date: doc.date };
    }

    let idCopy, bankStatement;
    try {
      idCopy = processDoc(idCopyIn);
      bankStatement = processDoc(bankStatementIn);
    } catch (e) {
      return { status: 400, error: e.message };
    }

    loan.documents = { idCopy, bankStatement, submittedAt: new Date().toISOString() };
    loan.status = "docs_submitted";
    return { loan };
  });

  if (result.error) return fail(res, result.status, result.error);
  sendJson(res, 200, { loan: result.loan });
});

// ---------- admin auth ----------

post("/api/admin/login", async (req, res, params, body) => {
  rateLimit(req, "admin-login", 5, 60 * 60 * 1000);
  const email = (body.email || "").trim().toLowerCase();
  if (!V.isAdminEmail(email)) {
    return fail(res, 403, `Admin sign-in requires an email ending in "${V.ADMIN_SUFFIX}".`);
  }
  const otp = auth.genOtp();
  await withTable("adminOtps", async (t) => {
    t[email] = { code: otp, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 };
  });
  await sendMail({
    to: email,
    subject: "Your RM Credit Solutions admin access code",
    text: `Your admin access code is ${otp}. It expires in 10 minutes.\n\nIf you didn't request this, secure your account — someone may be trying to access the admin dashboard.`,
  });
  sendJson(res, 200, { ok: true });
});

post("/api/admin/verify-otp", async (req, res, params, body) => {
  rateLimit(req, "admin-verify-otp", 15, 60 * 60 * 1000);
  const email = (body.email || "").trim().toLowerCase();
  const code = (body.otp || "").trim();

  const result = await withTable("adminOtps", async (t) => {
    const entry = t[email];
    if (!entry) return { error: "No admin sign-in is pending for this address." };
    if (Date.now() > entry.expiresAt) return { error: "That code has expired — request a new one." };
    if (entry.attempts >= OTP_MAX_ATTEMPTS) return { error: "Too many incorrect attempts — request a new code." };
    if (code !== entry.code) {
      entry.attempts += 1;
      return { error: "That code doesn't match." };
    }
    delete t[email];
    return { ok: true };
  });

  if (result.error) return fail(res, 400, result.error);

  const token = await auth.createSession(email, "admin");
  sendJson(res, 200, { token, email });
});

// ---------- admin loan management ----------

get("/api/admin/loans", async (req, res) => {
  await requireSession(req, "admin");
  const loans = await readTable("loans");
  const all = Object.values(loans).sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
  sendJson(res, 200, { loans: all.map(safeLoan) });
});

function adminTransition(fromStatuses, toStatus, extra) {
  return async (req, res, params) => {
    await requireSession(req, "admin");
    const { id } = params;
    const result = await withTable("loans", async (loans) => {
      const loan = loans[id];
      if (!loan) return { status: 404, error: "Request not found." };
      if (!fromStatuses.includes(loan.status)) {
        return { status: 400, error: `This request is currently "${loan.status}" and can't be transitioned from here.` };
      }
      loan.status = toStatus;
      if (extra) Object.assign(loan, extra(loan));
      return { loan };
    });
    if (result.error) return fail(res, result.status, result.error);
    sendJson(res, 200, { loan: result.loan });
  };
}

post("/api/admin/loans/:id/approve", adminTransition(["pending"], "approved_docs_pending", () => ({ decidedAt: new Date().toISOString() })));
post("/api/admin/loans/:id/reject", adminTransition(["pending"], "rejected", () => ({ decidedAt: new Date().toISOString() })));
post("/api/admin/loans/:id/release", adminTransition(["docs_submitted"], "funds_released", () => ({ fundsReleasedAt: new Date().toISOString() })));
post(
  "/api/admin/loans/:id/request-new-documents",
  adminTransition(["docs_submitted"], "approved_docs_pending", () => ({ documents: null }))
);

// Streams an uploaded document to an authenticated admin only — never
// exposed as a plain static file, since these are sensitive ID/financial
// documents.
get("/api/admin/documents/:storedName", async (req, res, params) => {
  await requireSession(req, "admin");
  const filePath = uploadPath(params.storedName);
  if (!fs.existsSync(filePath)) return fail(res, 404, "File not found.");
  const ext = path.extname(filePath).toLowerCase();
  const contentType = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".png": "image/png" }[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType, "Content-Disposition": "inline" });
  fs.createReadStream(filePath).pipe(res);
});

// ---------- static file serving (compiled frontend) ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  // Prevent path traversal outside PUBLIC_DIR.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(400);
    return res.end("Bad request.");
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback: any unknown path serves index.html so client-side
    // state (not URL routing, in this app, but harmless either way) works.
    filePath = path.join(PUBLIC_DIR, "index.html");
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end("Not found.");
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (!pathname.startsWith("/api/")) {
    return serveStatic(req, res, pathname);
  }

  for (const route of routes) {
    if (route.method !== req.method) continue;
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const params = {};
    route.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1]); });

    try {
      const body = req.method === "POST" ? await readJsonBody(req) : {};
      await route.handler(req, res, params, body);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error("Unhandled error:", e);
      fail(res, status, status === 500 ? "Something went wrong. Please try again." : e.message);
    }
    return;
  }

  fail(res, 404, "Not found.");
});

server.listen(PORT, () => {
  console.log(`RM Credit Solutions server listening on port ${PORT}`);
});

module.exports = { server };
