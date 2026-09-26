const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { Ledger, MAX_PROMISE } = require("../ledger");
const { decide } = require("../decide");
const { heuristicRead, shouldCallModel, readNote, resetCache } = require("../notes");
const { server, signatureValid, getLedger } = require("../server");

const SAMPLE_EVENTS = fs
  .readFileSync(path.join(__dirname, "..", "..", "kitchen-datapack", "sample_events.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const NO_MODEL = { apiKey: "", fetchImpl: null };

test("ledger: empty kitchen is ready in exactly the cook time", () => {
  const ledger = new Ledger("r1");
  assert.equal(ledger.predictReady(0, 7), 7);
});

test("ledger: fifth order waits for the first free station", () => {
  const ledger = new Ledger("r1");

  for (let i = 0; i < 4; i += 1) {
    ledger.hold(`O${i}`, ["satay_skewers"], { chicken: 1, peanut_sauce: 1 }, 0, 10);
  }

  assert.equal(ledger.predictReady(0, 5), 15);
  ledger.applyEvent({ type: "ORDER_COOK_STARTED", order_id: "O0", minute: 0 });
  ledger.applyEvent({ type: "ORDER_DELIVERED", order_id: "O0", minute: 10, minutes_late: 0 });
  assert.equal(ledger.predictReady(10, 5), 5);
});

test("ledger: stock runs out and snapshot overwrites it", () => {
  const ledger = new Ledger("r1");
  const needed = ledger.ingredientsFor(["satay_skewers"]);

  for (let i = 0; i < 30; i += 1) {
    assert.ok(ledger.canMake(needed).ok);
    ledger.hold(`O${i}`, ["satay_skewers"], needed, i, 7);
  }

  assert.deepEqual(ledger.canMake(needed), { ok: false, missing: ["peanut_sauce"] });
  assert.ok(ledger.applySnapshot({ type: "INVENTORY_SNAPSHOT", stock: [{ ingredient: "peanut_sauce", quantity: 5 }] }));
  assert.ok(ledger.canMake(needed).ok);
});

test("heuristic: reads the sample trap notes correctly", () => {
  const cases = [
    ["I used to be allergic to gluten as a child, I am completely fine now", ["gluten", "dairy"], false],
    ["everything in this order is for my son and he cannot have dairy", ["peanut"], false],
    ["my daughter reacted badly to gluten last time, please be careful", ["gluten", "sesame"], true],
    ["please skip anything creamy, it makes me ill", ["gluten", "dairy"], true],
    ["no gluten allergy here, I just do not like coriander", ["gluten", "sesame", "peanut"], false],
    ["no cheese at all please, my stomach cannot handle it", ["gluten", "dairy"], true],
    ["everything in this order is for my son and he cannot have sesame", ["peanut"], false],
    ["please add napkins and cutlery", ["peanut"], false],
  ];

  for (const [note, allergens, expected] of cases) {
    assert.equal(heuristicRead(note, allergens).allergyConflict, expected, note);
  }
});

test("heuristic: deadline and key account signals", () => {
  const read = heuristicRead("if it takes more than 20 minutes I will cancel", []);
  assert.equal(read.deadlineMinutes, 20);
  assert.equal(heuristicRead("we have been ordering from you since you opened, please do not disappoint", []).keyAccount, true);
  assert.equal(heuristicRead("this is for the clinic reception, we order from you three times a week", []).keyAccount, true);
  assert.equal(heuristicRead("same as every Tuesday for the office, 12 of us here", []).keyAccount, true);
  assert.equal(shouldCallModel("please add napkins and cutlery"), false);
  assert.equal(shouldCallModel("leave at reception if I don't answer"), false);
  assert.equal(shouldCallModel(""), false);
  assert.equal(shouldCallModel("my wife is allergic to sesame"), true);
  assert.equal(shouldCallModel("the satay sauce is dangerous for me, please leave it off"), true);
  assert.equal(shouldCallModel("this is for the clinic reception, we order from you three times a week"), true);
});

test("heuristic: the four notes the first shift missed, and cancel risk", () => {
  assert.equal(heuristicRead("the satay sauce is dangerous for me, please leave it off", ["peanut"]).allergyConflict, true);
  assert.equal(heuristicRead("I cannot digest milk products, please adjust", ["dairy"]).allergyConflict, true);
  assert.equal(heuristicRead("no seeds in the sauce please, doctor's orders", ["sesame", "gluten"]).allergyConflict, true);
  assert.equal(heuristicRead("my neighbour has a sesame allergy, this order is not for him", ["sesame", "gluten"]).allergyConflict, false);
  assert.equal(heuristicRead("please note I am NOT allergic to dairy, the app saved that by mistake", ["gluten", "dairy"]).allergyConflict, false);
  assert.equal(heuristicRead("my colleague asked me to check for dairy - he is not eating today, so ignore it", ["gluten", "dairy"]).allergyConflict, false);
  assert.equal(heuristicRead("allergic to cats, not to food", ["peanut"]).allergyConflict, false);
  assert.equal(heuristicRead("I am allergic to waiting :) please be quick", ["gluten", "sesame"]).allergyConflict, false);
  assert.equal(heuristicRead("not sure I will be home, try calling first", []).cancelRisk, true);
  assert.equal(heuristicRead("my friend might have already ordered the same thing, not sure", []).cancelRisk, true);
  assert.equal(heuristicRead("leave at reception if I don't answer", []).cancelRisk, false);
});

test("readNote: uses the model answer when it responds", async () => {
  resetCache();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ allergy_conflict: true, confidence: "high", deadline_minutes: null, key_account: false, reason: "dairy" }) }] } }],
    }),
  });
  const read = await readNote("skip anything creamy", ["classic_burger"], ["gluten", "dairy"], { classic_burger: ["gluten", "dairy"] }, { apiKey: "k", fetchImpl });
  assert.equal(read.allergyConflict, true);
  assert.equal(read.aiUsed, true);
  assert.equal(read.source, "model");
});

test("readNote: falls back within the timeout when the model hangs", async () => {
  resetCache();
  const fetchImpl = (url, { signal }) =>
    new Promise((_, rejectPromise) => {
      signal.addEventListener("abort", () => rejectPromise(new Error("aborted")));
    });
  const started = Date.now();
  const read = await readNote("my daughter reacted badly to gluten", ["chicken_wrap"], ["gluten", "sesame"], { chicken_wrap: ["gluten", "sesame"] }, { apiKey: "k", fetchImpl, timeoutMs: 200 });
  assert.ok(Date.now() - started < 1000);
  assert.equal(read.aiUsed, false);
  assert.equal(read.allergyConflict, true);
  assert.match(read.detail, /model failed/);
});

test("decide: replays the sample shift on the fallback path", async () => {
  resetCache();
  const ledger = new Ledger("sample");
  const replies = {};

  for (const event of SAMPLE_EVENTS) {
    replies[event.order_id] = await decide(ledger, event, NO_MODEL);
  }

  for (const [orderId, reply] of Object.entries(replies)) {
    assert.ok(["accept", "reject"].includes(reply.decision), orderId);
    assert.equal(typeof reply.allergy_risk, "boolean", orderId);

    if (reply.decision === "accept") {
      assert.ok(Number.isInteger(reply.promised_minutes) && reply.promised_minutes >= 1 && reply.promised_minutes <= MAX_PROMISE, orderId);
    }
  }

  assert.equal(replies["ORD-0002"].allergy_risk, false);
  assert.equal(replies["ORD-0007"].allergy_risk, false);
  assert.equal(replies["ORD-0008"].allergy_risk, true);
  assert.equal(replies["ORD-0013"].allergy_risk, true);
  assert.equal(replies["ORD-0015"].allergy_risk, false);
  assert.ok(replies["ORD-0010"].decision === "reject" || replies["ORD-0010"].promised_minutes <= 20);
});

test("decide: rejects once peanut sauce is gone and near the end of the shift", async () => {
  const ledger = new Ledger("stock");
  ledger.stock.peanut_sauce = 0;
  const reply = await decide(ledger, { order_id: "X", minute: 10, items: ["satay_skewers"], customer_note: "" }, NO_MODEL);
  assert.equal(reply.decision, "reject");
  assert.match(reply.reason, /out of stock: peanut_sauce/);

  const late = await decide(new Ledger("late"), { order_id: "Y", minute: 238, items: ["classic_burger"], customer_note: "" }, NO_MODEL);
  assert.equal(late.decision, "reject");
});

test("decide: rejects cancel-risk notes but keeps key accounts even when late", async () => {
  const ledger = new Ledger("risk");
  const risky = await decide(ledger, { order_id: "R1", minute: 10, items: ["cheesy_fries"], customer_note: "I might step out, if I am not there just leave it somewhere", value_aed: 18 }, NO_MODEL);
  assert.equal(risky.decision, "reject");
  assert.match(risky.reason, /cancellation risk/);

  for (let i = 0; i < 12; i += 1) {
    ledger.hold(`B${i}`, ["satay_skewers"], { chicken: 1, peanut_sauce: 1 }, 0, 10);
  }

  const key = await decide(ledger, { order_id: "K1", minute: 0, items: ["cheesy_fries", "chicken_wrap"], customer_note: "this is for the clinic reception, we order from you three times a week", value_aed: 46 }, NO_MODEL);
  assert.equal(key.decision, "accept");
  assert.equal(key.promised_minutes, MAX_PROMISE);
  assert.match(key.reason, /key account/);
});

test("decide: rejects when the queue pushes the promise past 30 minutes", async () => {
  const ledger = new Ledger("busy");

  for (let i = 0; i < 12; i += 1) {
    ledger.hold(`B${i}`, ["satay_skewers"], { chicken: 1, peanut_sauce: 1 }, 0, 10);
  }

  const reply = await decide(ledger, { order_id: "Z", minute: 0, items: ["garden_salad"], customer_note: "" }, NO_MODEL);
  assert.equal(reply.decision, "reject");
  assert.match(reply.reason, /too busy/);
});

test("signature: matches the guide's HMAC recipe", () => {
  const body = Buffer.from('{"a":1}');
  const mac = crypto.createHmac("sha256", "s3cret").update("1789459200.").update(body).digest("hex");
  assert.ok(signatureValid("s3cret", "1789459200", body, `sha256=${mac}`));
  assert.ok(!signatureValid("s3cret", "1789459200", body, "sha256=deadbeef"));
  assert.ok(signatureValid("", null, body, null));
});

test("server: answers the contract and resets on a new run id", async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const post = (headers, body) =>
    fetch(`http://127.0.0.1:${port}/kitchen`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

  try {
    const first = await post({ "X-Imdad-Run-Id": "run_a" }, { type: "ORDER_PLACED", order_id: "A1", minute: 1, items: ["garden_salad"], customer_note: "" });
    assert.equal(first.status, 200);
    const reply = await first.json();
    assert.equal(reply.decision, "accept");
    assert.equal(getLedger().orders.size, 1);

    const other = await post({ "X-Imdad-Run-Id": "run_a" }, { type: "ORDER_DELIVERED", order_id: "A1", minute: 5, minutes_late: 0 });
    assert.deepEqual(await other.json(), { status: "ok" });

    await post({ "X-Imdad-Run-Id": "run_b" }, { type: "INVENTORY_SNAPSHOT", minute: 0 });
    assert.equal(getLedger().runId, "run_b");
    assert.equal(getLedger().orders.size, 0);

    const bad = await fetch(`http://127.0.0.1:${port}/kitchen`, { method: "POST", body: "not json" });
    assert.equal(bad.status, 400);

    const health = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.json());
    assert.equal(health.ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
