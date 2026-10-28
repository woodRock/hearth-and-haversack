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
        },
        required: ["name", "qty", "price", "aisle", "spoil_days"],
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

export function readReceipt({ image, mediaType, signal }) {
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

Skip taxes, totals, bag fees, loyalty and payment lines. store is the shop name ("" if not shown) and total is the receipt total (0 if not shown). If the photo isn't a receipt, set is_receipt to false and return no items.`,
      },
    ],
  });
}

export function planWeek({ party, pack, perks, recent, signal }) {
  const partyText = party
    .map((m) => `- ${m.name}${m.likes ? `, likes ${m.likes}` : ""}${m.dislikes ? `, dislikes ${m.dislikes}` : ""}`)
    .join("\n");
  const packText = pack.map((p) => `- ${p.name} x${p.qty}${p.spoil ? ` (spoils in ${p.spoil} days)` : ""}`).join("\n");
  return ask({
    effort: "medium",
    schema: PLAN_SCHEMA,
    signal,
    content: `Plan 7 home-cooked dinners for this household, one per day in order.

Household:
${partyText || "- Just one person, no stated preferences."}

Already in the fridge and pantry:
${packText || "- Nothing noted."}

Cuisines and skills unlocked: ${perks.join(", ") || "none yet"}.
Dinners from recent weeks (avoid repeating these): ${recent.join(", ") || "none"}.

Rules:
- Use up items that spoil soon in the first few days. List those under uses_from_pack using their exact names from the list above.
- Mix easy weeknight meals with one or two bigger cooks. Set new_recipe to true for exactly one adventurous dish.
- approves and disapproves hold names from the household list, based on their likes and dislikes. Leave them empty when nobody has a strong view.
- ingredients lists only what still needs buying, with a rough cost at a typical supermarket. Use simple names a shopper would recognise.`,
  });
}

// Phone photos are large; shrink to a size Claude reads well and uploads fast.
export async function prepareImage(file, maxSide = 1600) {
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
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { image: dataUrl.split(",")[1], mediaType: "image/jpeg" };
}
