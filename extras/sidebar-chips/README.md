# Linear chips in the spaces sidebar (optional)

Name a space after an issue (`ENG-142 cart fix`), or work on a branch that has it (`me/eng-142-cart`), and the sidebar shows the issue's state as a chip before the name: the state icon and the identifier, in the state's color. It covers spaces on every machine, so you see at a glance which work is in progress, in review or done.

```
◐ ENG-142  cart fix          ← in progress (yellow)
◕ ENG-139  webhook retries   ← in review (blue)
✓ ENG-128  image cache       ← done (purple)
```

## Why it's a separate piece

A Herdr mod draws only its own place. The Linear mod is a window; the sidebar is another mod (Herdr's `spaces`, or one you made from it), so the chip has to be drawn by the sidebar. Mods can't import each other's files either, so `linear-chips.js` is self-contained: copy it into the sidebar mod's folder. The sidebar is always on screen, so it keeps the states fresh on its own (every 90 s, or as soon as the set of issues changes; one request for all of them).

## Add it to your sidebar

1. Install the Linear mod (`mods/linear`): the chips use its state icons by path, and its API key.
2. Make your own copy of the sidebar (Herdr can clone the built-in `spaces` mod) and copy `linear-chips.js` into its folder.
3. In its `main.js`:

```js
import { LinearChips } from "./linear-chips.js";

// init(), plus a timer if the sidebar doesn't have one
this.chips = new LinearChips();
cx.timer.every(5000, (cx) => this.chips.check(spaces().map((s) => [s.name, s.branch]), cx));

// where a space's row is drawn
const c = this.chips.of(space.name, space.branch);
row.when(Boolean(c), (el) => el.child(this.chips.chip(c, theme())))
   .child(c ? this.chips.nameWithout(space.name, c.id) : space.name);
```

4. `herdr-app check mods/<your sidebar>` and use it in your layout in place of `spaces`.

## Notes

- The key comes from `LINEAR_API_KEY` in the login environment, or the credentials file the Linear mod saves when you enter a key (`~/.config/herdr-linear/credentials`). Without one, nothing is shown.
- The states are also shared as `linear.states` (`shared("linear.states")`), so another mod can read them without asking Linear again.
- Only identifiers of teams your key can see get a chip; other text that looks like one (`UTF-8`) is asked about once and left out.
