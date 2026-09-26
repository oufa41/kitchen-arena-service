/**
 * Kitchen Arena decision service.
 *   POST /kitchen   every arena event. ORDER_PLACED gets a real answer.
 *   GET  /          health.
 *
 * Run:  GEMINI_API_KEY=... node server.js
 */
const http = require("http");
const crypto = require("crypto");
const { Ledger } = require("./ledger");
const { decide } = require("./decide");
const { resetCache, DEFAULT_MODEL } = require("./notes");

const PORT = Number(process.env.PORT) || 8080;
const SIGNING_SECRET = process.env.IMDAD_SIGNING_SECRET || "";
const DECISION_BUDGET_MS = 8000;
const MAX_BODY_BYTES = 64 * 1024;

let ledger = new Ledger(null);

function log(line) {
  console.log(`${new Date().toISOString()} ${line}`);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

/** HMAC-SHA256 over "{timestamp}." + raw body, hex, prefixed "sha256=". */
function signatureValid(secret, timestamp, bodyBuffer, header) {
  if (!secret) {
    return true;
  }

  if (!timestamp || !header) {
    return false;
  }

  const mac = crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(bodyBuffer).digest("hex");
  const expected = Buffer.from(`sha256=${mac}`);
  const given = Buffer.from(String(header));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function withBudget(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ensureRun(runId) {
  if (runId && runId !== ledger.runId) {
    log(`new run ${runId}, resetting ledger (previous ${ledger.runId ?? "none"})`);
    ledger = new Ledger(runId);
    resetCache();
  }
}

async function handleKitchen(req, res) {
  let bodyBuffer;

  try {
    bodyBuffer = await readBody(req);
  } catch (error) {
    return sendJson(res, 400, { decision: "reject", allergy_risk: false, reason: error.message });
  }

  const timestamp = req.headers["x-imdad-timestamp"];
  const signature = req.headers["x-imdad-signature"];

  if (!signatureValid(SIGNING_SECRET, timestamp, bodyBuffer, signature)) {
    log("rejected request with invalid signature");
    return sendJson(res, 401, { error: "invalid signature" });
  }

  let event;

  try {
    event = JSON.parse(bodyBuffer.toString("utf8"));
  } catch {
    return sendJson(res, 400, { decision: "reject", allergy_risk: false, reason: "body is not valid JSON" });
  }

  ensureRun(req.headers["x-imdad-run-id"]);

  if (event.type !== "ORDER_PLACED") {
    ledger.applyEvent(event);

    // F3: one line per outcome so a bad accept can be traced to its decision.
    if (event.type === "ORDER_DELIVERED" || event.type === "ORDER_FAILED" || event.type === "ORDER_CANCELLED_BY_CUSTOMER") {
      log(`${event.order_id} min=${event.minute} ${event.type}${event.minutes_late ? ` late=${event.minutes_late}` : ""}`);
    }

    return sendJson(res, 200, { status: "ok" });
  }

  const started = Date.now();
  const fallback = { decision: "reject", allergy_risk: false, reason: "internal time budget exceeded", ai_used: false };
  const reply = await withBudget(decide(ledger, event), DECISION_BUDGET_MS, fallback);
  const elapsed = Date.now() - started;

  log(
    `${event.order_id} min=${event.minute} ${reply.decision}${reply.promised_minutes ? ` promise=${reply.promised_minutes}` : ""} allergy=${reply.allergy_risk} ai=${reply.ai_used} ${elapsed}ms :: ${reply.reason}`,
  );
  return sendJson(res, 200, reply);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST") {
      return await handleKitchen(req, res);
    }

    return sendJson(res, 200, {
      ok: true,
      run: ledger.runId,
      minute: ledger.lastMinute,
      stats: ledger.stats,
      model: process.env.GEMINI_API_KEY ? process.env.GEMINI_MODEL || DEFAULT_MODEL : "none (heuristic only)",
    });
  } catch (error) {
    log(`unhandled: ${error.stack || error.message}`);
    return sendJson(res, 200, { decision: "reject", allergy_risk: false, reason: "internal error", ai_used: false });
  }
});

if (require.main === module) {
  server.listen(PORT, () => log(`listening on http://localhost:${PORT} (signature check ${SIGNING_SECRET ? "on" : "off"})`));
}

module.exports = { server, signatureValid, getLedger: () => ledger };
