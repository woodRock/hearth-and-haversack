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
- **New recipes.** Roll a d20 against DC 12. A natural 20 adds the dish to your recipe book.
- **Supplies.** The week's shopping list, grouped by aisle. Tick items off, or scan the receipt afterwards.
- **Pack.** Your fridge and pantry as an inventory grid. Combine leftovers before they spoil.
- **Act complete.** At the end of the week you see how it went, earn bonus XP for staying under budget and wasting nothing, then hold the next war council.

## Claude features

Three features use Claude:

- **Receipt scanning.** Take a photo of a receipt and Claude reads every item, its price and roughly how long it keeps. The items go into your Pack and are ticked off your shopping list.
- **Week planning.** Claude plans the nights you leave blank and works out ingredients for the dinners you pick yourself. It uses what you enter in the war council (picks, busy nights, nights off, notes), your party's likes and dislikes, everything in your Pack (items about to spoil come first), your budget, your unlocked cuisines and your recent dinners. It doesn't see receipts directly: scanned items go into your Pack, and Claude reads the Pack.
- **Recipes.** The first time you open a dinner's recipe, Claude writes it for your party's size, using what's in your Pack and what was bought for that dish, and avoiding your party's dislikes. The recipe is saved with the dinner, so it costs nothing to open again. You can ask for a different version.

These use your own Claude API key:

1. Create a key at [platform.claude.com](https://platform.claude.com/settings/keys), and set a monthly spend limit while you're there. Reading a receipt costs about a cent.
2. In the app, open **Settings** and paste the key.

The key is saved in your browser (and, if you choose, in your own Firebase account) and is sent only to Claude's API. It is never part of this repository. Anyone who can use your unlocked device could find it, so only save it on devices you trust.

## Saves and sync

Your campaign is always saved in the browser. Choose **Sign in to sync** on the main menu to sign in with Google, and your campaign is stored in your account (Firebase Firestore) and kept in step across every device you sign in on. If a device already has a different campaign when you sign in, you choose which one to keep.

In Settings you can also tick **Keep the key in my account** so your other devices pick up your Claude API key automatically. The Firestore rules in `firestore.rules` let each account read and write only its own document.

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
  - `cloud.js` is Google sign-in and campaign sync through Firebase.
  - `claude.js` handles everything that talks to Claude: receipt reading, week planning and image resizing. To keep the API key off devices, replace this file with calls to a small serverless function.
- `firebase.json`, `.firebaserc`, `firestore.rules`: the Firebase project (`hearth-and-haversack`) and its database rules. Deploy rule changes with `firebase deploy --only firestore`.
- `old/prototype-v1.html` is the first clickable mock-up.
