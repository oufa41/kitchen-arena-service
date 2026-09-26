/**
 * Cloudflare Workers entry point.
 *
 * The Worker itself is stateless, so every request is forwarded to one Durable
 * Object named "kitchen". A Durable Object is a single instance by contract,
 * which is exactly what the arena asks for. It keeps the ledger in memory and
 * writes a copy to storage after every event, so an eviction mid-shift loses
 * nothing.
 *
 * The decision modules are the same files the Node server uses.
 */
import { DurableObject } from "cloudflare:workers";
import { Ledger } from "./ledger.js";
import { decide } from "./decide.js";
import { resetCache, DEFAULT_MODEL } from "./notes.js";

const DECISION_BUDGET_MS = 8000;
const MAX_BODY_BYTES = 64 * 1024;
const LEDGER_KEY = "ledger";

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** HMAC-SHA256 over "{timestamp}." + body, hex, prefixed "sha256=". */
async function signatureValid(secret, timestamp, bodyBytes, header) {
  if (!secret) {
    return true;
  }

  if (!timestamp || !header) {
    return false;
  }

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const data = new Uint8Array(prefix.length + bodyBytes.length);
  data.set(prefix);
  data.set(bodyBytes, prefix.length);
  const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, data))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expected = `sha256=${mac}`;

  if (expected.length !== header.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  }

  return diff === 0;
}

function withBudget(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class Kitchen extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.env = env;
    this.ledger = null;
    this.ready = state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get(LEDGER_KEY);
      this.ledger = saved ? Ledger.fromJSON(saved) : new Ledger(null);
    });
  }

  noteOptions() {
    return {
      apiKey: this.env.GEMINI_API_KEY || "",
      model: this.env.GEMINI_MODEL || DEFAULT_MODEL,
      fallbackModel: this.env.GEMINI_FALLBACK_MODEL,
    };
  }

  async ensureRun(runId) {
    if (runId && runId !== this.ledger.runId) {
      console.log(`new run ${runId}, resetting ledger (previous ${this.ledger.runId ?? "none"})`);
      this.ledger = new Ledger(runId);
      resetCache();
      await this.persist();
    }
  }

  async persist() {
    await this.ctx.storage.put(LEDGER_KEY, this.ledger.toJSON());
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return json(200, {
        ok: true,
        run: this.ledger.runId,
        minute: this.ledger.lastMinute,
        stats: this.ledger.stats,
        model: this.env.GEMINI_API_KEY ? this.env.GEMINI_MODEL || DEFAULT_MODEL : "none (heuristic only)",
        host: "cloudflare-worker",
      });
    }

    const bodyBytes = new Uint8Array(await request.arrayBuffer());

    if (bodyBytes.length > MAX_BODY_BYTES) {
      return json(400, { decision: "reject", allergy_risk: false, reason: "body too large" });
    }

    const valid = await signatureValid(this.env.IMDAD_SIGNING_SECRET || "", request.headers.get("x-imdad-timestamp"), bodyBytes, request.headers.get("x-imdad-signature"));

    if (!valid) {
      return json(401, { error: "invalid signature" });
    }

    let event;

    try {
      event = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return json(400, { decision: "reject", allergy_risk: false, reason: "body is not valid JSON" });
    }

    if (!event || typeof event !== "object") {
      return json(400, { decision: "reject", allergy_risk: false, reason: "body must be a JSON object" });
    }

    await this.ensureRun(request.headers.get("x-imdad-run-id"));

    if (event.type !== "ORDER_PLACED") {
      this.ledger.applyEvent(event);

      if (event.type === "ORDER_DELIVERED" || event.type === "ORDER_FAILED" || event.type === "ORDER_CANCELLED_BY_CUSTOMER") {
        console.log(`${event.order_id} min=${event.minute} ${event.type}${event.minutes_late ? ` late=${event.minutes_late}` : ""}`);
      }

      await this.persist();
      return json(200, { status: "ok" });
    }

    const started = Date.now();
    const fallback = { decision: "reject", allergy_risk: false, reason: "internal time budget exceeded", ai_used: false };
    let reply;

    try {
      reply = await withBudget(decide(this.ledger, event, this.noteOptions()), DECISION_BUDGET_MS, fallback);
    } catch (error) {
      console.error(`decision failed for ${event.order_id}: ${error.stack || error.message}`);
      reply = { decision: "reject", allergy_risk: false, reason: "internal error", ai_used: false };
    }

    await this.persist();
    console.log(
      `${event.order_id} min=${event.minute} ${reply.decision}${reply.promised_minutes ? ` promise=${reply.promised_minutes}` : ""} allergy=${reply.allergy_risk} ai=${reply.ai_used} ${Date.now() - started}ms :: ${reply.reason}`,
    );
    return json(200, reply);
  }
}

export default {
  async fetch(request, env) {
    const stub = env.KITCHEN.get(env.KITCHEN.idFromName("kitchen"));
    return stub.fetch(request);
  },
};
