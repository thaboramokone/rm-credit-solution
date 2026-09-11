// Minimal, dependency-free JSON-file datastore.
//
// This is intentionally simple: each "table" is a JSON file on disk, all
// reads/writes for a given file are serialized through a promise queue so
// concurrent requests can't corrupt it, and writes go to a temp file first
// then get renamed into place (atomic on POSIX) so a crash mid-write can't
// leave a half-written file behind.
//
// This is fine for an MVP / small-scale deployment. Before this handles
// real transaction volume, swap it for a real database (Postgres, etc.) —
// the get/set/update functions below are a small enough surface that the
// rest of the app doesn't need to change much to move to a real DB later.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const queues = new Map(); // filePath -> Promise chain

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function readRaw(name) {
  const fp = filePath(name);
  if (!fs.existsSync(fp)) return {};
  const text = fs.readFileSync(fp, "utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    // Don't silently lose data on a corrupt file — fail loudly.
    throw new Error(`Data file ${name}.json is corrupt: ${e.message}`);
  }
}

function writeRaw(name, obj) {
  const fp = filePath(name);
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, fp);
}

// Runs `fn` exclusively with respect to other calls against the same table
// name, and persists whatever `fn` returns (mutated in place or returned).
function withTable(name, fn) {
  const prev = queues.get(name) || Promise.resolve();
  const next = prev
    .catch(() => {}) // don't let one failure jam the queue forever
    .then(async () => {
      const data = readRaw(name);
      const result = await fn(data);
      writeRaw(name, data);
      return result;
    });
  queues.set(name, next);
  return next;
}

function readTable(name) {
  // Reads don't need to go through the write queue for correctness (we
  // only ever replace-the-whole-file on write, never partial-write), but
  // routing through the same queue keeps read-after-write ordering sane
  // for a single process.
  return withTable(name, (data) => data);
}

module.exports = { withTable, readTable, DATA_DIR };
