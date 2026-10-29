// Talks to Claude straight from the browser using the API key saved on this
// device. Swap this file for a call to a small serverless function if the app
// is ever shared beyond the household.
import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.133.0/+esm";

const MODEL = "claude-opus-5-5";
const KEY_STORE = "hh-api-key";
const AISLES = ["Produce", "Butcher & Fishmonger", "Dairy", "Bakery", "Larder", "Frozen", "Household"];

export function getKey() {
  try { return localStorage.getItem(KEY_STORE) || ""; } catch { return ""; }
}
export function setKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORE, key.trim());
    else localStorage.removeItem(KEY_STORE);
  } catch {}
}
export const hasKey = () => Boolean(getKey());

const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    is_receipt: { type: "boolean" },
    store: { type: "string" },
    total: { type: "number" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          qty: { type: "integer" },
          price: { type: "number" },
          aisle: { type: "string", enum: AISLES },
          spoil_days: { type: "integer" },
          supply: { type: "integer" },
        },
        required: ["name", "qty", "price", "aisle", "spoil_days", "supply"],
        additionalProperties: false,
      },
    },
  },
  required: ["is_receipt", "store", "total", "items"],
  additionalProperties: false,
};

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    quests: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          difficulty: { type: "string", enum: ["Easy", "Moderate", "Hard"] },
          minutes: { type: "integer" },
          new_recipe: { type: "boolean" },
          approves: { type: "array", items: { type: "string" } },
          disapproves: { type: "array", items: { type: "string" } },
          uses_from_pack: { type: "array", items: { type: "string" } },
          ingredients: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                aisle: { type: "string", enum: AISLES },
                cost: { type: "number" },
              },
              required: ["name", "aisle", "cost"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "difficulty", "minutes", "new_recipe", "approves", "disapproves", "uses_from_pack", "ingredients"],
        additionalProperties: false,
      },
    },
  },
  required: ["quests"],
  additionalProperties: false,
};

const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    servings: { type: "integer" },
    minutes: { type: "integer" },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, amount: { type: "string" } },
        required: ["name", "amount"],
        additionalProperties: false,
      },
    },
    steps: { type: "array", items: { type: "string" } },
    tip: { type: "string" },
  },
  required: ["servings", "minutes", "ingredients", "steps", "tip"],
  additionalProperties: false,
};

export class ClaudeError extends Error {}

async function ask({ content, schema, effort, signal }) {
  const key = getKey();
  if (!key) throw new ClaudeError("Add your Claude API key in Settings first.");
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  let response;
  try {
    response = await client.beta.messages.create(
      {
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort, format: { type: "json_schema", schema } },
        messages: [{ role: "user", content }],
      },
      { signal },
    );
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError) throw new ClaudeError("Cancelled.");
    if (err instanceof Anthropic.AuthenticationError) throw new ClaudeError("Claude rejected the API key. Check it in Settings.");
    if (err instanceof Anthropic.PermissionDeniedError) throw new ClaudeError("This API key isn't allowed to use Claude. Check it in the Claude Console.");
    if (err instanceof Anthropic.RateLimitError) throw new ClaudeError("Claude is busy or your spending limit was reached. Try again in a minute.");
    if (err instanceof Anthropic.BadRequestError) throw new ClaudeError(`Claude couldn't use that request: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) throw new ClaudeError("Couldn't reach Claude. Check your internet connection.");
    if (err instanceof Anthropic.APIError) throw new ClaudeError(`Claude had a problem (error ${err.status}). Try again.`);
    throw err;
  }
  if (response.stop_reason === "refusal") throw new ClaudeError("Claude declined to read this one.");
  if (response.stop_reason === "max_tokens") throw new ClaudeError("Claude's answer was cut short. Try again.");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new ClaudeError("Claude's answer couldn't be read. Try again.");
  }
}

// shopping: names still to buy on the supply list. Each item's supply is its index there, or -1.
export function readReceipt({ image, mediaType, shopping = [], signal }) {
  const list = shopping.length
    ? shopping.map((name, i) => `${i}. ${name}`).join("\n")
    : "(the shopping list is empty)";
  return ask({
    effort: "low",
    schema: RECEIPT_SCHEMA,
    signal,
    content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
      {
        type: "text",
        text: `This is a photo of a grocery receipt. List every food and household item bought.

- name: a short, plain item name in Title Case. Expand till abbreviations ("ORG BNLS CHKN BRST" becomes "Chicken Breast"). Drop brand names unless the item is unclear without them.
- qty: how many were bought (weighed items count as 1).
- price: the line price after any discount on that line, as a number. Use 0 if you can't read it.
- aisle: the store section it belongs in.
- spoil_days: roughly how many days until it spoils when stored the usual way. Use 0 for shelf-stable items like tins, pasta, rice and spices.
- supply: the number of the shopping list entry below that this item covers, or -1 if none does. Match on what the item is, not the exact words: "Tasty Cheese" covers "Cheddar", "Scallions" covers "Spring Onions", "Beef Mince 500g" covers "Mince". Don't match items that only share a word: "Egg Noodles" doesn't cover "Eggs". Several receipt lines can cover the same entry.

Shopping list:
${list}

Skip taxes, totals, bag fees, loyalty and payment lines. store is the shop name ("" if not shown) and total is the receipt total (0 if not shown). If the photo isn't a receipt, set is_receipt to false and return no items.`,
      },
    ],
  });
}

// days: the nights to cook, in order: [{ label: "Mon 3 Nov", request: "Tacos" | "", busy: bool }].
// Returns { quests } with exactly one dinner per day, in the same order.
export function planDays({ days, party, pack, perks, recent, notes, budget, history = [], favourites = [], leftoverNights = [], signal }) {
  const historyText = history
    .map((h) => {
      const bits = [];
      if (h.liked.length) bits.push(`${h.liked.join(", ")} liked it`);
      if (h.disliked.length) bits.push(`${h.disliked.join(", ")} didn't`);
      if (h.again) bits.push("they want it again");
      return bits.length ? `- ${h.dish}: ${bits.join("; ")}` : null;
    })
    .filter(Boolean)
    .join("\n");
  const partyText = party
    .map((m) => `- ${m.name}${m.likes ? `, likes ${m.likes}` : ""}${m.dislikes ? `, dislikes ${m.dislikes}` : ""}`)
    .join("\n");
  const packText = pack.map((p) => `- ${p.name} x${p.qty}${p.spoil ? ` (spoils in ${p.spoil} days)` : ""}`).join("\n");
  const dayText = days
    .map((d, i) => `${i + 1}. ${d.label}: ${d.request ? `they've chosen "${d.request}"` : "your choice"}${d.busy ? " (busy night, 30 minutes or less)" : ""}${d.saved?.length ? `. Their saved recipe uses: ${d.saved.join(", ")}` : ""}`)
    .join("\n");
  const single = days.length === 1;
  return ask({
    effort: "medium",
    schema: PLAN_SCHEMA,
    signal,
    content: `Plan home-cooked dinners for this household. Return exactly ${days.length} ${single ? "dinner" : "dinners"} in the quests array, one per night, in this order:
${dayText}

Household:
${partyText || "- Just one person, no stated preferences."}

Already in the fridge and pantry:
${packText || "- Nothing noted."}

How recent dinners went (only people who ate are listed):
${historyText || "- No feedback yet."}

Their recipe book (dishes they've saved to make again): ${favourites.join(", ") || "empty"}.
${leftoverNights.length ? `Leftovers nights, with no cooking: ${leftoverNights.join(", ")}. Make the dinner the night before each one generous enough to leave leftovers.\n` : ""}
Their notes for this week: ${notes || "none"}
Weekly food budget: about ${budget} in their local currency, for everything on the list.
Cuisines and skills unlocked: ${perks.join(", ") || "none yet"}.
Dinners to avoid repeating: ${recent.join(", ") || "none"}.

Rules:
- Where they've chosen a dish, keep their dish and its name as they wrote it (tidy the capitalisation) and fill in its details and ingredients.
- Busy nights take 30 minutes or less.
- Lean towards what went down well and away from what people disliked. You may bring back a recipe-book dish now and then, but most nights should be new.
- Use what they already have first. Before putting anything on the shopping list, check the pantry list. If they have it, or something that does the same job in this dish (Tasty Cheese for Parmesan in a Caesar salad, Spinach for Kale, Chicken Thighs for Chicken Breast), use that instead. Only buy what the dish needs that nothing in the pantry can stand in for.
- Where a chosen dish comes with their saved recipe, plan for exactly those ingredients without substituting: use the pantry where it has them and buy the rest.
- uses_from_pack lists every pantry item the dish uses, with their exact names from the pantry list. Use items that spoil soon on the earliest nights. Only share a pantry item across several nights when the amount on hand covers them all.
- Oil, salt and pepper are always on hand: never buy them.
${single ? "- Set new_recipe to false unless this is clearly an adventurous dish." : "- Mix easy weeknight meals with one or two bigger cooks. Set new_recipe to true for exactly one adventurous dish you picked (never one they chose)."}
- approves and disapproves hold names from the household list, based on their likes and dislikes. Leave them empty when nobody has a strong view.
- ingredients lists only what still needs buying, with a rough cost at a typical supermarket. Use simple names a shopper would recognise. Together, uses_from_pack and ingredients are everything the dish needs apart from oil, salt and pepper.`,
  });
}

// Writes the full recipe for one planned dinner, built from the ingredients the plan set aside and bought for it,
// so the recipe and the shopping list agree.
export function writeRecipe({ dish, eaters, minutes, busy, uses = [], buy = [], pack = [], dislikes, signal }) {
  const planned = uses.length || buy.length;
  return ask({
    effort: "medium",
    schema: RECIPE_SCHEMA,
    signal,
    content: `Write a home-cooking recipe for "${dish}" for ${eaters.length} ${eaters.length === 1 ? "person" : "people"} (${eaters.join(", ")}).

Aim for about ${minutes} minutes in total${busy ? ", and no more than 30 minutes because it's a busy night" : ""}.
${planned ? `The plan for this dinner:
- From their Pack: ${uses.join(", ") || "nothing"}
- Bought for it: ${buy.join(", ") || "nothing"}
Also in their kitchen: ${pack.join(", ") || "nothing else noted"}.

Build the recipe from the plan. Use every planned ingredient, under the same name, and never swap one for something else: if Parmesan was bought, the recipe uses Parmesan, not another cheese from the kitchen. Beyond the plan, use only oil, salt, pepper and water, plus anything from the kitchen list the dish clearly needs. Don't add ingredients they'd have to buy.` : `In their kitchen: ${pack.join(", ") || "nothing noted"}.

Use what's in their kitchen first, and keep anything they'd have to buy to a minimum.`}
${dislikes ? `Avoid where you can: ${dislikes}.` : ""}

- servings: how many it serves.
- minutes: total time from start to plate.
- ingredients: every ingredient, including oil, salt and other basics. name is a plain name, written exactly as it appears in the lists above. amount uses metric with everyday measures, like "400 g", "2 tbsp" or "1 large".
- steps: 4 to 10 steps in order, one clear action each, with heat levels and times where they matter.
- tip: one short, useful tip for this dish, or "" if there's nothing worth adding.`,
  });
}

// Phone photos are large; shrink to a size Claude reads well and uploads fast.
export async function prepareImage(file, maxSide = 1600, quality = 0.85) {
  let source;
  try {
    source = await createImageBitmap(file);
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new ClaudeError("That file couldn't be opened as an image."));
      img.src = URL.createObjectURL(file);
    });
  }
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  return { image: dataUrl.split(",")[1], mediaType: "image/jpeg" };
}
