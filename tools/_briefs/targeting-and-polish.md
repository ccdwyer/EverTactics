# Four player-reported defects: sprite bob, icon blur, targeting readability, tile-vs-unit targeting

These came from someone actually playing the game, not from a critic looking at a screenshot.
Treat them as gameplay-feel bugs, not visual polish.

---

## 1. Units float and bob like they have Levitate on them

The idle animation's vertical bob is far too strong, and/or sprites are not sitting on their tile
surface. In Final Fantasy Tactics a standing unit is planted; there is a *very* subtle idle motion,
nothing that reads as hovering.

Look at `src/render/sprites.ts` and `src/render/animation.ts`. Two separate suspects, check both:
- an idle bob amplitude that is simply too large, and
- the sprite's feet anchor not landing on the tile surface, so the unit sits above it.

`docs/ASSETS.md` documents `feetX/feetY` per pose — the anchor is the point that must land on the
tile, and a billboard placed by bounding-box centre floats because capes and weapons make the box
asymmetric.

**Success:** at default zoom a standing unit reads as planted on its tile. Bob amplitude should be
at most ~1 sprite pixel. Verify by capturing several frames a few hundred ms apart with
`node tools/play.mjs --steps "burst:8x150" --port 4173 --out shots/bob` and measuring the unit's
on-screen vertical travel — report the number of pixels.

## 2. Buff/debuff status icons are blurred

Status icons above units must be pixel-crisp like the sprites. They are almost certainly being
sampled with linear filtering, mipmapped, or drawn at a non-integer scale/position.

Find where the status strip is drawn (search `statusStrip` / `statusIcons` in `src/render/sprites.ts`
and the icon source in `src/ui/icons.ts`). Use `NearestFilter`, no mipmaps, and snap to whole device
pixels — the same discipline the unit sprites already use.

**Success:** icons are visibly sharp in a 3x crop. Show the crop.

## 3. It is hard to tell what is being targeted

Two changes:

**(a) The tile cursor/selection is too small.** Make the selected-tile indicator clearly larger and
higher contrast so it reads at gameplay zoom without hunting for it.

**(b) Units that will be affected must be highlighted.** When an ability is being aimed, every unit
inside the resulting area of effect should be visibly marked:
- **red** for units that would be hit as enemies of the caster
- **blue** for units that would be affected as allies of the caster

Use the caster's perspective, not the player's: a player unit caught in your own fireball is a
*friendly* target and should read blue-with-warning rather than red, because that is the mistake the
highlight exists to prevent.

The affected set is already computable — `affectedTiles` in `src/core/battle.ts` and the helpers in
`src/state/targeting.ts` (`coveredTiles`, `legalTargets`, `primaryTargetAt`). Do not reimplement the
rules; call the existing ones so the highlight cannot disagree with what the reducer will actually do.

**Success:** a screenshot with an AoE ability aimed, showing enlarged tile cursor plus red/blue unit
highlights that match the tiles the ability actually covers.

## 4. Tile-targeted vs unit-targeted abilities

In FFT an ability targets either a **tile** (it lands where you point, and hits whoever happens to
be there — Fire, Ice, geomancy, summons) or a **unit** (it follows the selected unit — most
single-target buffs, heals, Steal, Talk Skill). The distinction matters mechanically: a
tile-targeted spell still resolves if its victim moves away or dies before it fires, and a
unit-targeted one does not.

`Ability.targetsTiles?: boolean` already exists in `src/core/types.ts:194` and 23 abilities set it,
so the data is partly there. What is missing is that the *targeting UI and resolution* honour it.

Do:
- Audit the ability table and make `targetsTiles` correct across all of it, not just 23 entries.
- Tile-targeted: the cursor snaps to tiles, may be aimed at an empty tile, and resolution uses the
  tile.
- Unit-targeted: the cursor snaps to valid units only, and resolution follows that unit.
- Charged abilities (`ct > 0`) must respect this — a tile-targeted charge that lands after its
  victim walks away hits the tile; a unit-targeted one tracks the unit.

**Success:** `npx vitest run` passes with new tests in `tests/targeting.test.ts` covering both
modes, including the charged case where the target moves between cast and resolution.

---

## Constraints

- `src/core/` must not import three.js. Randomness only via the seeded `Rng`. Determinism is
  asserted by existing tests and must keep passing.
- Never put a backtick in a comment inside a shader file — it terminates the template literal and
  has broken this build six times. `npx vitest run tests/shader-source.test.ts` catches it.
- Render against a static build (`npx vite build && npx vite preview --port 4173 --strictPort &`),
  never the dev server; HMR reloads mid-capture and you will screenshot a boot splash.
- Do not regress the four gates in `tools/metrics.mjs`, and do not regress frame coherence.

## Definition of done

`npm run verify` green (typecheck + 429 tests + render + gates), plus for each of the four items the
specific evidence named above. Report the command you ran and the number or image it produced — not
a description of what you changed.
