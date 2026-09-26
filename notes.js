/**
 * Note reader: turns the customer's free text into four facts.
 *   allergyConflict  someone eating this order cannot have an allergen in it
 *   deadlineMinutes  a limit the customer wrote, or null
 *   keyAccount       reads as a repeat or corporate customer
 *   cancelRisk       the customer may not be there to receive it, or may have double ordered
 *
 * Covers skeleton TODO 3. Every non-empty note goes to the model unless it is a
 * known pure-logistics phrase (F4). Calls are cached per note, have a hard
 * timeout, and fall back to a keyword rule when the model fails. The service
 * never waits on the model to answer.
 */

// Allergen vocabulary, including dish and sauce names that imply an allergen (F4).
const ALLERGEN_WORDS = {
  dairy: ["dairy", "milk", "milk products", "cheese", "cheesy", "cream", "creamy", "lactose", "butter", "yogurt", "yoghurt"],
  gluten: ["gluten", "wheat", "bread", "bun", "buns", "celiac", "coeliac", "flour", "tortilla", "flatbread"],
  sesame: ["sesame", "tahini", "seeds", "sesame sauce"],
  peanut: ["peanut", "peanuts", "peanut sauce", "satay", "satay sauce", "nut", "nuts", "groundnut", "groundnuts"],
};

// Phrases that say the allergy does not apply to this order.
const NEGATION =
  /used to|no longer|not allergic|NOT allergic|no (\w+ )?allerg|fine now|grew out|not an allergy|just (do not|don't|dont) like|isn't allergic|is not allergic|not for (him|her|them)|not eating|only having|he is not|she is not|ignore it|saved that by mistake/i;

// The allergic person is explicitly not eating this order (F7). Overrides the model.
const NOT_EATING = /only having|only eating|not for (him|her|them)|is not eating|not eating today|ignore it|the rest is mine/i;

const DEADLINE = /(\d{1,3})\s*(min|mins|minute|minutes)\b/i;

// Repeat, regular or corporate customers (F5).
const KEY_ACCOUNT =
  /since you opened|regular|corporate|company|office|every (day|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|loyal|repeat customer|always order|been ordering|order(ing)? from you|times a week|weekly order|monthly order|team lunch|third order|you know what we like|\d+ of us|clinic reception/i;

// Customer may not receive the order, or may have ordered twice (F6).
const CANCEL_RISK =
  /not sure i will be home|might step out|if i am not there|might have already ordered|had to cancel|try calling first|not sure i('| wi)ll be|may not be (home|there|in)/i;

// Pure logistics notes that never need a model call. Matched on the whole note.
const SKIP_NOTES = [
  /^please add napkins and cutlery\.?$/i,
  /^ring the bell twice, baby is sleeping\.?$/i,
  /^extra ketchup please\.?$/i,
  /^make it spicy if you can\.?$/i,
  /^leave at reception if i don'?t answer\.?$/i,
  /^thanks?( you)?!?\.?$/i,
];

const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_FALLBACK_MODEL = "gemini-3.5-flash";
const DEFAULT_TIMEOUT_MS = 6000;
const RATE_LIMIT_COOLDOWN_MS = 20000;

const cache = new Map();
let modelCooldownUntil = 0;

function normalise(note) {
  return String(note || "").replace(/\s+/g, " ").trim();
}

/** F4: every note with content goes to the model unless it is pure logistics. */
function shouldCallModel(note) {
  if (!note || note.length < 3) {
    return false;
  }

  return !SKIP_NOTES.some((pattern) => pattern.test(note));
}

function allergensMentioned(note) {
  const lower = note.toLowerCase();
  const found = [];

  for (const [allergen, words] of Object.entries(ALLERGEN_WORDS)) {
    if (words.some((w) => new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`, "i").test(lower))) {
      found.push(allergen);
    }
  }

  return found;
}

function deadlineFrom(note) {
  const match = DEADLINE.exec(note);

  if (!match) {
    return null;
  }

  const minutes = Number(match[1]);
  return minutes > 0 && minutes <= 240 ? minutes : null;
}

/**
 * Fallback used when there is no model, or it failed. Flags any named allergen
 * that is in the order unless the note explicitly negates it.
 */
function heuristicRead(note, orderAllergens) {
  const mentioned = allergensMentioned(note);
  const conflict = mentioned.filter((a) => orderAllergens.includes(a));
  const negated = NEGATION.test(note);

  return {
    allergyConflict: conflict.length > 0 && !negated,
    deadlineMinutes: deadlineFrom(note),
    keyAccount: KEY_ACCOUNT.test(note),
    cancelRisk: CANCEL_RISK.test(note),
    aiUsed: false,
    source: "heuristic",
    detail: conflict.length
      ? `note mentions ${conflict.join(", ")}${negated ? " but negates it" : ""}`
      : "no allergen in note matches the order",
  };
}

function buildPrompt(note, items, orderAllergens, allergensByItem) {
  const itemLines = items
    .map((i) => `- ${i}: ${allergensByItem[i]?.length ? allergensByItem[i].join(", ") : "no allergens"}`)
    .join("\n");

  return `You are reading a restaurant order note to decide whether it is safe to cook and whether to accept it.

The order contains these items and allergens:
${itemLines}

Allergens present in this order: ${orderAllergens.length ? orderAllergens.join(", ") : "none"}.

Ingredient facts: satay sauce and peanut sauce contain peanut. Tahini and sesame sauce contain sesame.
Cheese, milk, cream and anything creamy contain dairy. Bun, bread, flour, wheat, tortilla, flatbread and wrap contain gluten.

Customer note (free text, written by a person, may be irrelevant, misspelled, or misleading):
"""${note}"""

Answer with JSON only, using exactly these keys:
{
  "allergy_conflict": true or false,   // true only if a person who will EAT THIS ORDER cannot have an allergen that is IN THIS ORDER
  "confidence": "high" or "low",
  "deadline_minutes": integer or null, // a time limit the customer states, else null
  "key_account": true or false,        // the note reads as a repeat, regular, office or corporate customer
  "cancel_risk": true or false,        // the customer may not be there to receive it, or may have ordered the same thing twice
  "reason": short string
}

Rules:
- A past allergy that is explicitly resolved is not a conflict.
- An allergy for someone who is not eating this order is not a conflict, even if the note says they are having an item that is not in the order. Example: "my wife is allergic to sesame but she is only having the salad, the rest is mine" is NOT a conflict, whatever the order contains.
- An allergen the note mentions that is NOT in this order is not a conflict.
- Indirect phrasing counts: "anything creamy makes me ill", "the satay sauce is dangerous for me", "cannot digest milk" are conflicts if the order has that allergen.
- A request to leave an ingredient off does not remove the allergen: the kitchen cannot change recipes.
- Preferences ("I do not like coriander") and jokes ("allergic to waiting") are not allergies.
- cancel_risk is true for notes like "not sure I will be home", "I might step out", "my friend might have already ordered this", "had to cancel the last two orders". It is false for delivery instructions like "leave at reception".`;
}

/**
 * One deadline shared across the primary and fallback model. A 5xx or a
 * retired-model 404 on the primary moves straight to the fallback.
 */
async function callGemini(prompt, { fetchImpl, timeoutMs, apiKey, models }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
      maxOutputTokens: 512,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  let lastError = null;

  try {
    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body,
        });

        if (response.status === 429) {
          modelCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
          throw new Error(`${model} rate limited`);
        }

        if (!response.ok) {
          throw new Error(`${model} http ${response.status}`);
        }

        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === "string")?.text;

        if (!text) {
          throw new Error(`${model} empty response`);
        }

        return { answer: JSON.parse(text), model };
      } catch (error) {
        lastError = error;

        if (controller.signal.aborted) {
          break;
        }
      }
    }

    throw lastError || new Error("no model configured");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a note. Never throws. Always answers within timeoutMs plus a few ms.
 * @param {string} rawNote
 * @param {string[]} items
 * @param {string[]} orderAllergens
 * @param {Record<string,string[]>} allergensByItem
 * @param {object} options  { fetchImpl, timeoutMs, apiKey, model, fallbackModel }
 */
async function readNote(rawNote, items, orderAllergens, allergensByItem, options = {}) {
  const note = normalise(rawNote);
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  const primaryModel = options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const fallbackModel = options.fallbackModel ?? process.env.GEMINI_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL;
  const models = [...new Set([primaryModel, fallbackModel].filter(Boolean))];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (!shouldCallModel(note)) {
    return {
      allergyConflict: false,
      deadlineMinutes: null,
      keyAccount: false,
      cancelRisk: false,
      aiUsed: false,
      source: note ? "skip" : "empty",
      detail: note ? "logistics note, no model needed" : "no note",
    };
  }

  const cacheKey = `${note.toLowerCase()}|${orderAllergens.join(",")}`;

  if (cache.has(cacheKey)) {
    return { ...cache.get(cacheKey), source: "cache" };
  }

  const heuristic = heuristicRead(note, orderAllergens);

  if (!apiKey || !fetchImpl || Date.now() < modelCooldownUntil) {
    return heuristic;
  }

  try {
    const prompt = buildPrompt(note, items, orderAllergens, allergensByItem);
    const { answer, model } = await callGemini(prompt, { fetchImpl, timeoutMs, apiKey, models });
    const lowConfidence = String(answer.confidence || "").toLowerCase() !== "high";
    const modelConflict = answer.allergy_conflict === true;

    // S6: unsure, and the allergen is in the order, and the keyword rule also sees it -> flag.
    // F7: an explicit "not eating" phrase wins over the model.
    const notEating = NOT_EATING.test(note);
    const allergyConflict = !notEating && (modelConflict || (lowConfidence && heuristic.allergyConflict));
    const deadlineRaw = Number(answer.deadline_minutes);
    const deadlineMinutes = Number.isInteger(deadlineRaw) && deadlineRaw > 0 ? deadlineRaw : heuristic.deadlineMinutes;

    const result = {
      allergyConflict,
      deadlineMinutes,
      keyAccount: answer.key_account === true || heuristic.keyAccount,
      cancelRisk: answer.cancel_risk === true || heuristic.cancelRisk,
      aiUsed: true,
      source: "model",
      model,
      detail: String(answer.reason || "").slice(0, 120),
    };
    cache.set(cacheKey, result);
    return result;
  } catch (error) {
    return { ...heuristic, detail: `${heuristic.detail}; model failed: ${error.message}` };
  }
}

function resetCache() {
  cache.clear();
  modelCooldownUntil = 0;
}

module.exports = { readNote, shouldCallModel, heuristicRead, deadlineFrom, resetCache, DEFAULT_MODEL, DEFAULT_FALLBACK_MODEL };
