# Hearth & Haversack

A meal planner and grocery tracker played as a fantasy campaign. Each week is an act, each dinner is a quest, your fridge is an inventory, and the people you cook for are your party.

**Play it:** https://woodrock.github.io/hearth-and-haversack/

## How it plays

- **Main menu.** Continue your campaign, start a new one, or open Settings.
- **New campaign.** Name your character, pick a class and add the people you cook for, with what they like and dislike.
- **War council.** Before each week (including the first), pick any dinners you already want, mark busy nights and nights off, add notes, and list what's already in the kitchen. Claude fills in the rest and writes the shopping list. You can ask for something else on any night, or choose your own, before the act begins.
- **Camp.** Each day shows tonight's dinner, a companion with something to say (sometimes you'll need a Persuasion roll), and what's about to spoil.
- **Recipes.** Every dinner has a recipe page with amounts and the method. Each ingredient shows whether it's in your Pack, on the shopping list, or something to check the cupboard for. Tick ingredients off as you get them out. The screen stays awake while it's open.
- **Cook and rest.** Mark tonight's dinner as cooked, then take a Long Rest to move to the next day. Food in your Pack spoils overnight.
- **After dinner.** Rate the meal 👍 or 👎 for each person who ate. Anyone left blank wasn't there, so their approval doesn't change. Tick **Make it again** to save it to your recipe book, and say how many portions are left over (None, 1, 2 or 3+). Leftovers go into your Pack and keep for 3 days.
- **Recipe book.** Dishes you've marked to make again, with their saved recipes. Open it from the Quest Log, or pick from it when planning.
- **Re-plan mid-week.** When plans change, **Re-plan the rest of the week** in the Quest Log sends the remaining nights back to the war council. Nights you leave alone keep their shopping and recipe; Claude plans only the ones you clear. **Change dish** on a single night also asks Claude what to buy and updates the shopping list.
- **Used up.** After dinner you say what you finished from the Pack (a bag, a tin, two eggs), so the Pack stays accurate.
- **The Ledger.** Tap your gold to see this week's spending by aisle, every receipt and ticked item, and past weeks against their budgets.
- **Leftovers.** Mark any night as a **Leftovers night** when planning (Claude makes the dinner before it a bit bigger). On the night, choose which leftovers you ate. You can also add leftovers by hand from the Pack, for example after a takeaway.
- **New recipes.** Roll a d20 against DC 12. A natural 20 adds the dish to your recipe book.
- **Supplies.** The week's shopping list, grouped by aisle. Tick items off as they go in the trolley: ticking is only a checklist and doesn't change your Pack or spending. Scanning the receipt is what puts items in your Pack and records what they cost, and list items it covers show as **In your Pack**. With no receipt, **Add items to the Pack by hand** puts chosen list items in the Pack without recording spending. Ticks sync, so a household can shop from the same list.
- **Pack.** Your fridge and pantry as an inventory grid. Tap items to select them, then **Mark as eaten** for anything eaten on its own (a bag of chips, a lunch, a leftover), choosing how many of each. Select two or more to combine them into a meal.
- **Act complete.** At the end of the week you see how it went, earn bonus XP for staying under budget and wasting nothing, then hold the next war council.

## Claude features

Three features use Claude:

- **Receipt scanning.** Take a photo of a receipt and Claude reads every item, its price and roughly how long it keeps. The items go into your Pack. Claude also sees your shopping list and works out which entry each item covers even when the names differ ("Tasty Cheese" ticks off "Cheddar", but "Egg Noodles" doesn't tick off "Eggs"), and the loot screen shows what each item will tick off.
- **Week planning.** Claude plans the nights you leave blank and works out ingredients for the dinners you pick yourself. It uses what you enter in the war council (picks, busy nights, leftovers nights, nights off, notes), your party's likes and dislikes, how recent dinners went (who liked or disliked what), your recipe book, everything in your Pack (items about to spoil come first), your budget, your unlocked cuisines and your recent dinners. It doesn't see receipts directly: scanned items go into your Pack, and Claude reads the Pack. Claude uses what you already have first, including stand-ins (Tasty Cheese instead of Parmesan), and only puts something on the shopping list when nothing in your Pack can do its job. Recipe-book dishes are planned from their saved ingredients.
- **Recipes.** The first time you open a dinner's recipe, Claude writes it for your party's size from exactly what the plan set aside from your Pack and put on the shopping list for that dish, so the recipe and the shopping list agree. It doesn't swap in other ingredients or add anything you'd need to buy, and it avoids your party's dislikes. The recipe is saved with the dinner, so it costs nothing to open again. You can ask for a different version.

These use your own Claude API key:

1. Create a key at [platform.claude.com](https://platform.claude.com/settings/keys), and set a monthly spend limit while you're there. Reading a receipt costs about a cent.
2. In the app, open **Settings** and paste the key.

The key is saved in your browser (and, if you choose, in your own Firebase account) and is sent only to Claude's API. It is never part of this repository. Anyone who can use your unlocked device could find it, so only save it on devices you trust.

## Saves, sync and households

Your campaign is always saved in the browser. The first time you open the app it offers Google sign-in; you can also sign in later from the main menu. Signed in, your campaign is stored in Firebase Firestore and kept in step across every device you use. If a device already has a different campaign when you sign in, you choose which one to keep.

**Households** share one campaign between several Google accounts. In **Settings → Household**, make an invite code (valid for 7 days) and give it to someone; they sign in on their own device and enter it under **Join a household**. Everyone then sees the same plan, shopping list and Pack. The person who started the campaign can remove members, and anyone can leave. Each person uses their own Claude API key.

## Offline

Once you've opened it with signal, the app works offline: the camp, quest log, recipes you've already opened, shopping list and Pack. Changes sync when you're back online. Claude's features (scanning, planning, new recipes) need a connection.

In Settings you can also tick **Keep the key in my account** so your other devices pick up your Claude API key automatically. The Firestore rules in `firestore.rules` keep each account's settings private and let only a household's members read or save its campaign.

## Install on your phone

Open the site in Chrome on Android (or Safari on iPhone) and choose **Add to Home screen**. It opens full-screen like an app.

## Run it locally

It's a static site with no build step:

```bash
python3 -m http.server 5173 --directory docs
```

Then open http://localhost:5173.

## Project layout

- `docs/` is the whole site, served by GitHub Pages.
  - `index.html` holds the screens.
  - `styles.css` is the look.
  - `app.js` is the game: campaign state, the day cycle, quests, supplies, Pack and party.
  - `cloud.js` is Google sign-in, campaign sync and households through Firebase.
  - `sw.js` is the service worker that makes the app work offline.
  - `claude.js` handles everything that talks to Claude: receipt reading, week planning and image resizing. To keep the API key off devices, replace this file with calls to a small serverless function.
- `firebase.json`, `.firebaserc`, `firestore.rules`: the Firebase project (`hearth-and-haversack`) and its database rules. Deploy rule changes with `firebase deploy --only firestore`.
- `old/prototype-v1.html` is the first clickable mock-up.
