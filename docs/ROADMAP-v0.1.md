# Road to v0.1

What exists today is a **battle engine with a demo scenario attached**. What v0.1 needs is a
**game loop**. That distinction is the whole roadmap — most of the remaining work is not more
battle features, it is the connective tissue that turns one fight into a campaign.

---

## What is actually done

| | state |
|---|---|
| Battle rules | Complete. CT turn order, height/jump, facing, FFT damage formulas, zodiac, statuses, reactions, deterministic replay |
| Jobs | 34 across FFT/EQ2/WoW, ~395 abilities, JP economy, unlock tree |
| AI | Engages, uses terrain, resolves. 16/16 across 8 seeds × 2 maps |
| Renderer | HD-2D diorama; blind judges prefer it to shipped SRPG frames (p < 0.001) |
| Animation | FFT SHP/SEQ decoded and playing |
| Tests | 441, typecheck clean |

## What is missing, and why it's bigger than it looks

**Two maps.** `orbonne-courtyard` and `mandalia-plains`. Both hand-authored in `core/grid.ts`.

**No persistence at all.** No save, no load, nothing survives a refresh. This is the single
hardest blocker: every other feature below assumes state that outlives a battle.

**No meta-loop.** There is no world map, no battle selection, no chapter progression. The game boots
straight into a hardcoded scenario. Nothing carries forward — not JP, not levels, not the roster.

**The management screens are viewers, not editors.** Job, Formation, Roster and Result all render
correctly with real data. But Formation doesn't actually deploy a chosen squad, and Roster can't
recruit, dismiss or equip. They display state; they don't mutate it.

**No economy.** `gil` and items exist in the data model, no shop, no loot drops, no rewards.

---

## The work, in dependency order

### 1. Persistence — do this first, everything depends on it
A serialisable `CampaignState`: roster, JP/levels per unit, inventory, gil, story progress,
completed battles. Save to `localStorage`, versioned so a schema change doesn't brick saves.

The engine is already deterministic and `BattleState` is plain data, so this is mostly
serialisation discipline rather than architecture. **Estimate: small.** Highest leverage in the
project — nothing else is real until state survives a refresh.

### 2. Make the management screens two-way
The hard part (view models, layout, the job tree) is done. What's missing is the intent handling:
- **Formation** — choose who deploys and where, honouring a deploy limit and the map's start tiles
- **Roster** — equip from inventory, change secondary/reaction/support/movement, dismiss, rename
- **Shop** — buy/sell against gil, gated by story progress

**Estimate: medium.** Mostly wiring `UIIntent` cases to core mutations that already exist
(`setJob`, `learnAbility`, equipment slots).

### 3. World map and progression
A node graph of locations, story battles gated on progress, optional random encounters, and a
travel screen. FFT's structure — linear spine with side branches — is the model.

Needs: a `Chapter`/`StoryNode` model in `core/`, a world map screen, and a battle-launch path that
takes a scenario id plus the *current* roster rather than a hardcoded unit list.

**Estimate: medium-large.** The battle-launch refactor is the real work: `buildScenario` currently
owns unit creation, and it needs to accept a persisted party instead.

### 4. Content — maps and encounters
Realistically **6–10 maps** for a v0.1 campaign arc, each with authored encounters (unit roster,
placement, objective, AI personalities).

Two exist. The map format is hand-written `MapDef` in `core/grid.ts`, which is fine for two and
painful for ten. Consider a data file format plus a small editor, or at minimum move maps out of the
source file. **Estimate: large, and mostly authoring rather than engineering.**

### 5. Battle polish
- The four player-reported items currently with Grok (sprite bob, icon blur, targeting readability,
  tile-vs-unit targeting) — **in flight**
- Ability VFX are generic archetypes; distinctive effects for signature abilities
- Sound: `ui/audio.ts` exists but is near-empty. Needs SFX for hit/heal/miss/spell/step, plus music
- Battle intro/victory/defeat presentation
- Camera work for ability animations

**Estimate: medium, and it never really ends.**

### 6. Onboarding
Title screen, new game, load game, a first battle that teaches the systems. Currently the game boots
mid-battle with no framing. **Estimate: small-medium.**

---

## Suggested order

1. **Persistence** — unblocks everything
2. **Formation + Roster two-way** — makes the party feel owned
3. **Battle-launch refactor** — take a persisted party, not a hardcoded list
4. **World map + 2 more maps** — proves the loop end to end with four battles
5. **Shop + rewards** — closes the economy
6. **Title/onboarding**, then content to 6–10 maps
7. **Polish continuously**, delegated via `npm run delegate`

The milestone that matters most is after step 4: *a player can start a game, fight three or four
battles on a world map, level their party between them, and have it all survive a refresh.* That is
the first point at which this is a game rather than a demo.

---

## What NOT to do next

- **More rendering rounds.** Blind judges already prefer the frame to shipped commercial games.
  The remaining gap is texel density (see `docs/STATUS.md`), which is an art-direction decision,
  not a tuning problem — and it is invisible next to "there is no save button".
- **More jobs or abilities.** 34 and ~395 is already more than a v0.1 campaign can teach.
- **Rebuilding anything in `docs/STATUS.md` marked FIXED.** Agents have burned rounds on this twice.
