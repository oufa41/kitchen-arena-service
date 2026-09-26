/**
 * Kitchen ledger: the service's own picture of stock and station load.
 * The arena never sends kitchen state with an order, so this is reconstructed
 * from what we accepted, the cook-time table, and the outcome events.
 *
 * Covers skeleton TODO 1 (stock) and TODO 2 (ready time), plus the
 * "other events tell you when capacity frees up" note.
 */
// JSON require works in Node and is bundled by wrangler for the Worker build.
const WORLD = require("./world.json");
const MENU = Object.fromEntries(WORLD.menu.map((m) => [m.item, m]));
const STATIONS = WORLD.kitchen.stations;
const SHIFT_MINUTES = WORLD.kitchen.shift_minutes;
const MAX_PROMISE = WORLD.kitchen.max_promise_minutes;
const ALLERGY_HANDLING_MINUTES = 3;

const OPEN = "open";
const DONE = "done";

class Ledger {
  constructor(runId) {
    this.runId = runId;
    this.stock = Object.fromEntries(WORLD.opening_stock.map((r) => [r.ingredient, r.quantity]));
    this.orders = new Map();
    this.lastMinute = 0;
    this.stats = { accepted: 0, rejected: 0, delivered: 0, failed: 0, cancelled: 0, lateMinutes: 0 };
  }

  /** Total ingredients an order needs, or null if an item is not on the menu. */
  ingredientsFor(items) {
    const needed = {};

    for (const item of items) {
      const menuItem = MENU[item];

      if (!menuItem) {
        return null;
      }

      for (const [ingredient, qty] of Object.entries(menuItem.ingredients)) {
        needed[ingredient] = (needed[ingredient] || 0) + qty;
      }
    }

    return needed;
  }

  /** Distinct allergens present in the order. */
  allergensFor(items) {
    const set = new Set();

    for (const item of items) {
      for (const allergen of MENU[item]?.allergens || []) {
        set.add(allergen);
      }
    }

    return [...set];
  }

  cookMinutesFor(items, allergyRisk = false) {
    const base = items.reduce((n, item) => n + (MENU[item]?.cook_minutes || 0), 0);
    return base + (allergyRisk ? ALLERGY_HANDLING_MINUTES : 0);
  }

  /** TODO 1: can the kitchen make this with what we believe is left? */
  canMake(needed) {
    const missing = [];

    for (const [ingredient, qty] of Object.entries(needed)) {
      if ((this.stock[ingredient] || 0) < qty) {
        missing.push(ingredient);
      }
    }

    return { ok: missing.length === 0, missing };
  }

  /** TODO 1: hold the ingredients and book the order into the queue. */
  hold(orderId, items, needed, minute, cookMinutes) {
    for (const [ingredient, qty] of Object.entries(needed)) {
      this.stock[ingredient] -= qty;
    }

    this.orders.set(orderId, {
      items,
      cookMinutes,
      acceptedAt: minute,
      startedAt: null,
      doneAt: null,
      status: OPEN,
    });
    this.stats.accepted += 1;
  }

  /**
   * TODO 2: minutes from `minute` until a new order of `cookMinutes` would be
   * ready, given four stations and everything already accepted.
   * Simulates the kitchen as FIFO over the stations.
   */
  predictReady(minute, cookMinutes) {
    const stationsFreeAt = new Array(STATIONS).fill(minute);
    const open = [...this.orders.values()].filter((o) => o.status === OPEN);
    const active = open.filter((o) => o.startedAt !== null).sort((a, b) => a.startedAt - b.startedAt);
    const pending = open.filter((o) => o.startedAt === null).sort((a, b) => a.acceptedAt - b.acceptedAt);

    // Orders the kitchen told us are cooking occupy a station until done.
    // If we somehow think more are active than there are stations, the extras queue.
    const overflow = [];

    for (const order of active) {
      const slot = stationsFreeAt.indexOf(Math.min(...stationsFreeAt));

      if (stationsFreeAt[slot] > minute) {
        overflow.push(order);
        continue;
      }

      stationsFreeAt[slot] = Math.max(minute, order.startedAt + order.cookMinutes);
    }

    for (const order of [...overflow, ...pending]) {
      const slot = stationsFreeAt.indexOf(Math.min(...stationsFreeAt));
      stationsFreeAt[slot] += order.cookMinutes;
    }

    const start = Math.min(...stationsFreeAt);
    return start - minute + cookMinutes;
  }

  /** Minutes of cooking already committed and not yet done. Used in reasons. */
  backlogMinutes() {
    let total = 0;

    for (const order of this.orders.values()) {
      if (order.status === OPEN) {
        total += order.cookMinutes;
      }
    }

    return total;
  }

  /** Plain object for persistence (Durable Object storage). */
  toJSON() {
    return { runId: this.runId, stock: this.stock, orders: [...this.orders.entries()], lastMinute: this.lastMinute, stats: this.stats };
  }

  /** Rebuild a ledger from toJSON() output. */
  static fromJSON(data) {
    const ledger = new Ledger(data.runId);
    ledger.stock = { ...data.stock };
    ledger.orders = new Map(data.orders);
    ledger.lastMinute = data.lastMinute || 0;
    ledger.stats = { ...ledger.stats, ...data.stats };
    return ledger;
  }

  /** Feed every non-order event back into the ledger. */
  applyEvent(event) {
    if (typeof event.minute === "number") {
      this.lastMinute = Math.max(this.lastMinute, event.minute);
    }

    const order = event.order_id ? this.orders.get(event.order_id) : null;

    switch (event.type) {
      case "ORDER_COOK_STARTED": {
        if (order) {
          order.startedAt = event.minute;
        }
        break;
      }
      case "ORDER_DELIVERED": {
        this.stats.delivered += 1;
        this.stats.lateMinutes += Number(event.minutes_late) || 0;
        this.close(order, event.minute);
        break;
      }
      case "ORDER_FAILED": {
        this.stats.failed += 1;
        this.close(order, event.minute);
        break;
      }
      case "ORDER_CANCELLED_BY_CUSTOMER": {
        this.stats.cancelled += 1;
        this.close(order, event.minute);
        break;
      }
      case "INVENTORY_SNAPSHOT": {
        this.applySnapshot(event);
        break;
      }
      default:
        break;
    }
  }

  close(order, minute) {
    if (order) {
      order.status = DONE;
      order.doneAt = minute;
    }
  }

  /**
   * Overwrite our stock with the kitchen's real numbers. The payload shape is
   * not documented, so accept the likely forms: an array of
   * {ingredient, quantity} or an object map, under any of a few keys.
   */
  applySnapshot(event) {
    const candidate = event.stock ?? event.inventory ?? event.levels ?? event.ingredients ?? event.snapshot;

    if (!candidate) {
      return false;
    }

    let applied = 0;

    if (Array.isArray(candidate)) {
      for (const row of candidate) {
        const name = row.ingredient ?? row.name ?? row.item;
        const qty = row.quantity ?? row.qty ?? row.remaining;

        if (typeof name === "string" && Number.isFinite(Number(qty))) {
          this.stock[name] = Number(qty);
          applied += 1;
        }
      }
    } else if (typeof candidate === "object") {
      for (const [name, qty] of Object.entries(candidate)) {
        if (Number.isFinite(Number(qty))) {
          this.stock[name] = Number(qty);
          applied += 1;
        }
      }
    }

    return applied > 0;
  }
}

module.exports = { Ledger, WORLD, MENU, STATIONS, SHIFT_MINUTES, MAX_PROMISE, ALLERGY_HANDLING_MINUTES };
