# v0.1 soft-lock audit

Audited against a static `vite build` + `vite preview --host localhost` build with real keyboard
and pointer input through `tools/play.mjs`. The cited frames are from the static preview runs.

| Case | Verdict | Evidence and measured result |
| --- | --- | --- |
| Battle lost | **SAFE** | [Defeat result](../shots/softlock/lost-legacy/09-defeat-result.png) → Escape → [world map with the encounter still available](../shots/softlock/lost-legacy/11-defeat-return-map.png). The harness reported `phase: defeat`, `playerTurns: 1`, then `screen: world`; 0 errors and 0 rejected commands. |
| Formation below deploy minimum | **SAFE** | [Zero deployed](../shots/softlock/formation/04-zero-deployment-disabled.png) shows `0 / 6 deployed`, a disabled Begin Battle button, and Close. Escape reaches the [world map](../shots/softlock/formation/06-formation-back-map.png); 0 errors and 0 rejected commands. |
| Empty inventory / nothing affordable at 0 gil | **SAFE BUT UNCLEAR** | [Zero-gil shop](../shots/softlock/empty-shop-static/04-zero-gil-empty-shop.png) has a blank Sell pane and disabled purchase options, but Close remains available. Escape reaches the [world map](../shots/softlock/empty-shop-static/06-shop-back-map.png); 0 errors and 0 rejected commands. |
| Last completed node, no successor | **SAFE** | [Completed campaign map](../shots/softlock/campaign-complete/03-campaign-complete.png) explicitly says the campaign and every destination are complete, and Close remains available; 0 errors and 0 rejected commands. |
| World map back route | **TRAPPED before fix; SAFE after fix** | Before the fix, the top-level map consumed Escape and had no Close control. After the fix, [Close is visible](../shots/softlock/world-back/02-world-map-with-close.png) and Escape reaches a [title screen with Continue](../shots/softlock/world-back/04-title-after-world-back.png); 0 errors and 0 rejected commands. |
| Formation back route | **SAFE** | The same zero-deployment run above returned to the [world map](../shots/softlock/formation/06-formation-back-map.png). |
| Roster back route | **SAFE** | [Roster](../shots/softlock/roster-back-static/04-roster-screen.png) → Escape → [world map](../shots/softlock/roster-back-static/06-roster-back-map.png); 0 errors and 0 rejected commands. |
| Job back route | **SAFE** | [Job tree](../shots/softlock/job-back/04-job-screen.png) → Escape → [world map](../shots/softlock/job-back/06-job-back-map.png); 0 errors and 0 rejected commands. |
| Shop back route | **SAFE BUT UNCLEAR** | The zero-gil run above returned to the [world map](../shots/softlock/empty-shop-static/06-shop-back-map.png). The empty Sell pane has no explanatory copy. |
| Result back route | **SAFE** | [Defeat result](../shots/softlock/lost-legacy/09-defeat-result.png) → Escape → [world map](../shots/softlock/lost-legacy/11-defeat-return-map.png). |
| Older-schema save | **SAFE** | A 651-byte version-0 blob with no `version` field booted through Continue to the [world map](../shots/softlock/lost-legacy/03-legacy-save-map.png). Starting the encounter persisted a migrated 748-byte current-schema save; 0 errors and 0 rejected commands. |

## Finding fixed

`WorldMapScreen` was explicitly non-closable and consumed cancel input, leaving no backward route.
It now uses the shared Close/Escape behavior. Closing the world map returns to the title screen,
where Continue remains enabled for the current campaign. A routing regression test covers that
exact `close-screen` intent and verifies the campaign is preserved.

## Static-run measurements

Seven final `tools/play.mjs` reports covered the cases above. All seven reported `booted: true`,
`errors: 0`, `rejectedCommands: 0`, and no Vite client/HMR log entries. The loss scenario used a
single level-5 unit at Lionel Reckoning and reached defeat after one player turn.

The static server was built and started with:

```sh
npm run build
npx vite preview --host localhost --port 4173 --strictPort
```

The seven final input runs were:

```sh
node tools/play.mjs --host localhost --port 4173 --cdp 57038 --out shots/softlock/world-back --report shots/softlock/world-back.json --steps "title-new,mark:world-map-with-close,key:Escape,mark:title-after-world-back"
node tools/play.mjs --host localhost --port 4173 --cdp 57038 --out shots/softlock/formation --report shots/softlock/formation.json --steps "key:ArrowDown,key:Enter,selector:[data-node-id=battle-open],clear-formation,key:Escape,mark:formation-back-map"
node tools/play.mjs --host localhost --port 4173 --cdp 57038 --out shots/softlock/empty-shop-static --report shots/softlock/empty-shop-static.json --steps "key:ArrowDown,key:Enter,selector:[data-node-id=gariland-camp],mark:zero-gil-empty-shop,key:Escape,mark:shop-back-map"
node tools/play.mjs --host localhost --port 4173 --cdp 57038 --out shots/softlock/roster-back-static --report shots/softlock/roster-back-static.json --steps "key:ArrowDown,key:Enter,selector:.et-worldmap__action:nth-child(2),mark:roster-screen,key:Escape,mark:roster-back-map"
node tools/play.mjs --host localhost --port 4173 --cdp 57038 --out shots/softlock/job-back --report shots/softlock/job-back.json --steps "key:ArrowDown,key:Enter,selector:.et-worldmap__action:nth-child(1),mark:job-screen,key:Escape,mark:job-back-map"
node tools/play.mjs --host localhost --port 4173 --cdp 57038 --out shots/softlock/lost-legacy --report shots/softlock/lost-legacy.json --steps "key:ArrowDown,key:Enter,wait:.et-worldmap.is-open,mark:legacy-save-map,selector:[data-node-id=lionel-reckoning],wait:.et-formation.is-open,mark:loss-formation,nav-selector:.et-formation__confirm,autoplay,mark:defeat-result,key:Escape,wait:.et-worldmap.is-open,mark:defeat-return-map"
node tools/play.mjs --host localhost --port 4173 --cdp 57038 --out shots/softlock/campaign-complete --report shots/softlock/campaign-complete.json --steps "key:ArrowDown,key:Enter,mark:campaign-complete"
```

The shop run began from a current save measured at 4,893 bytes, 0 gil, and 0 inventory entries.
The legacy/loss run began from a 651-byte version-0 blob with no `version` field and one level-5
unit. The campaign-complete run began from a 767-byte current save with all 14 nodes completed.
