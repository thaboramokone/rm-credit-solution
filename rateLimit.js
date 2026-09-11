// A minimal in-memory rate limiter — no Redis or external store needed.
// Good enough to blunt casual brute-forcing/spam on a single-process
// deployment; if you ever run multiple server instances behind a load
// balancer, replace this with a shared store (Redis) since each process
// would otherwise track its own counts independently.

const buckets = new Map(); // key -> [timestamps]

function hit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  buckets.set(key, arr);
  return arr.length <= limit;
}

// Periodically clear old entries so this doesn't grow unbounded on a
// long-running process.
setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of buckets) {
    const fresh = arr.filter((t) => now - t < 60 * 60 * 1000);
    if (fresh.length === 0) buckets.delete(key);
    else buckets.set(key, fresh);
  }
}, 10 * 60 * 1000).unref();

function clientIp(req) {
  // Trusts X-Forwarded-For's first hop when behind a reverse proxy (Render,
  // Railway, etc. set this). Fine for rate-limiting purposes; don't use
  // this for anything security-critical like access control.
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

// limit requests per IP+route to `limit` within `windowMs`. Throws a 429
// error (caught by the router's try/catch) when exceeded.
function rateLimit(req, routeKey, limit, windowMs) {
  const key = `${routeKey}:${clientIp(req)}`;
  if (!hit(key, limit, windowMs)) {
    const err = new Error("Too many attempts. Please wait a bit and try again.");
    err.status = 429;
    throw err;
  }
}

module.exports = { rateLimit };
