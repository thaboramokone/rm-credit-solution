// Handles document "uploads" sent as base64 JSON (rather than implementing
// a full multipart/form-data parser from scratch). The frontend reads the
// File via FileReader.readAsDataURL() and posts the resulting base64
// string; this saves it to disk under a random, non-guessable filename so
// a leaked/incremented ID can't be used to enumerate other applicants'
// documents.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_EXT = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png" };

// `dataUrl` looks like "data:application/pdf;base64,JVBERi0xLjQK..."
function saveUploadedFile(dataUrl, originalName) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) throw new Error("Invalid file data.");
  const mimeType = match[1];
  const base64 = match[2];
  const ext = ALLOWED_EXT[mimeType];
  if (!ext) throw new Error("Unsupported file type. Please upload a PDF, JPG or PNG.");

  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > MAX_BYTES) throw new Error("File is larger than 8MB.");
  if (buffer.length === 0) throw new Error("File is empty.");

  const storedName = `${crypto.randomBytes(16).toString("hex")}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buffer);

  return {
    storedName,
    originalName: (originalName || "document").slice(0, 200),
    size: buffer.length,
    mimeType,
  };
}

function uploadPath(storedName) {
  // Guard against path traversal — storedName should always be exactly
  // what saveUploadedFile generated, but never trust it blindly.
  const safe = path.basename(storedName);
  return path.join(UPLOAD_DIR, safe);
}

module.exports = { saveUploadedFile, uploadPath, UPLOAD_DIR, MAX_BYTES };
