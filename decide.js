/**
 * Decision policy. Covers skeleton TODO 4.
 * Rejecting an ordinary order is free. A bad accept is not. So every check
 * that can fail cheaply runs before the model is consulted.
 */
const { MENU, SHIFT_MINUTES, MAX_PROMISE, WORLD } = require("./ledger");
const { readNote } = require("./notes");

const PROMISE_BUFFER_MINUTES = 2;
const KEY_ACCOUNT_BUFFER_MINUTES = 1;
const LATE_PENALTY_PER_MINUTE = WORLD.scoring.penalty_per_minute_late_aed;
const KEY_ACCOUNT_PENALTY_MULTIPLIER = WORLD.scoring.penalty_lost_key_account_x_value;

function reject(reason, aiUsed = false) {
  return { decision: "reject", allergy_risk: false, reason, ai_used: aiUsed };
}

/**
 * @param {import("./ledger").Ledger} ledger
 * @param {object} event  ORDER_PLACED payload
 * @param {object} noteOptions  passed to readNote (fetchImpl, apiKey, model, timeoutMs)
 */
async function decide(ledger, event, noteOptions = {}) {
  const items = Array.isArray(event.items) ? event.items : [];
  const minute = Number(event.minute) || ledger.lastMinute;
  ledger.lastMinute = Math.max(ledger.lastMinute, minute);

  if (items.length === 0) {
    ledger.stats.rejected += 1;
    return reject("order has no items");
  }

  const needed = ledger.ingredientsFor(items);

  if (!needed) {
    ledger.stats.rejected += 1;
    return reject("order contains an item not on the menu");
  }

  const stockCheck = ledger.canMake(needed);

  if (!stockCheck.ok) {
    ledger.stats.rejected += 1;
    return reject(`out of stock: ${stockCheck.missing.join(", ")}`);
  }

  // Coarse shift-end check before spending a model call.
  const baseCook = ledger.cookMinutesFor(items, false);

  if (minute + baseCook > SHIFT_MINUTES) {
    ledger.stats.rejected += 1;
    return reject("shift ends before this order could be cooked");
  }

  const orderAllergens = ledger.allergensFor(items);
  const allergensByItem = Object.fromEntries(items.map((i) => [i, MENU[i].allergens]));
  const note = await readNote(event.customer_note, items, orderAllergens, allergensByItem, noteOptions);
  const allergyRisk = note.allergyConflict;

  // F6: a customer who may not be there wastes food and station time. Rejecting is free.
  if (note.cancelRisk && !note.keyAccount) {
    ledger.stats.rejected += 1;
    return reject(`cancellation risk in note (${note.source}: ${note.detail})`, note.aiUsed);
  }

  const cookMinutes = ledger.cookMinutesFor(items, allergyRisk);
  const ready = ledger.predictReady(minute, cookMinutes);

  if (minute + ready > SHIFT_MINUTES) {
    ledger.stats.rejected += 1;
    return reject(`queue would push this past the end of the shift (ready in ${ready} min)`, note.aiUsed);
  }

  const buffer = note.keyAccount ? KEY_ACCOUNT_BUFFER_MINUTES : PROMISE_BUFFER_MINUTES;
  let promise = ready + buffer;
  const reasons = [];

  if (promise > MAX_PROMISE) {
    // F5: for a key account, a few late minutes cost less than the 2x rejection penalty.
    const lateMinutes = Math.max(0, ready - MAX_PROMISE);
    const latePenalty = lateMinutes * LATE_PENALTY_PER_MINUTE;
    const rejectPenalty = (Number(event.value_aed) || 0) * KEY_ACCOUNT_PENALTY_MULTIPLIER;

    if (note.keyAccount && latePenalty < rejectPenalty) {
      promise = MAX_PROMISE;
      reasons.push(`key account, promise capped at ${MAX_PROMISE} (expected ${lateMinutes} min late, ${latePenalty} AED vs ${rejectPenalty} AED to reject)`);
    } else {
      ledger.stats.rejected += 1;
      return reject(`kitchen too busy: ready in ${ready} min, max promise ${MAX_PROMISE}`, note.aiUsed);
    }
  }

  if (note.deadlineMinutes !== null && promise > note.deadlineMinutes) {
    if (ready <= note.deadlineMinutes) {
      promise = note.deadlineMinutes;
      reasons.push(`promise tightened to customer deadline of ${note.deadlineMinutes} min`);
    } else {
      ledger.stats.rejected += 1;
      return reject(`cannot meet customer deadline of ${note.deadlineMinutes} min (ready in ${ready})`, note.aiUsed);
    }
  }

  promise = Math.max(1, Math.min(MAX_PROMISE, Math.round(promise)));
  ledger.hold(event.order_id, items, needed, minute, cookMinutes);

  reasons.unshift(`ready in ~${ready} min, backlog ${ledger.backlogMinutes()} cook-min`);

  if (allergyRisk) {
    reasons.push(`allergy flagged (${note.source}: ${note.detail})`);
  } else if (note.source === "model" || note.source === "heuristic") {
    reasons.push(`note read by ${note.source}, no conflict`);
  }

  return {
    decision: "accept",
    promised_minutes: promise,
    allergy_risk: allergyRisk,
    reason: reasons.join("; "),
    ai_used: note.aiUsed,
  };
}

module.exports = { decide, PROMISE_BUFFER_MINUTES };
