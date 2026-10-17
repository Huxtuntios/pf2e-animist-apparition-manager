# Pf2e Animist Apparition Manager

[Русская версия](README.ru.md)

A standalone manager for the **Pathfinder 2e Animist** in **Foundry VTT 14**. Bond apparitions, keep their spells, Vessels and Lore skills in order, choose the primary apparitions, and let the focus pool and the nightly cleanup follow along - all from the character sheet and one management window, without **PF2e Dailies**.

It can sit next to PF2e Dailies (only Dailies' own Animist daily is switched off for the characters this module handles) and it works with **PF2e Avatars**.

> Report bugs and requests on the [issue tracker](https://github.com/Huxtuntios/pf2e-animist-apparition-manager/issues).

## Requirements

|          | Module               | Notes                                                                                                        |
| -------- | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Required | Foundry VTT 13 or 14 | Built for 14                                                                                                 |
| Required | Pathfinder 2e system | 8.6 or newer grants apparition Lore skills through Rule Elements; older versions use Lore items              |
| Optional | PF2e Dailies         | Stays usable for everything else; only its Animist and Wandering Feats dailies are switched off for Animists |
| Optional | PF2e Avatars         | The Avatar spell offers the forms of the primary apparitions                                                 |

## Install

1. In Foundry's **Add-on Modules → Install Module**, paste the manifest URL:
   `https://github.com/Huxtuntios/pf2e-animist-apparition-manager/releases/latest/download/module.json`
   For a specific version, use the manifest attached to that version on the [releases page](https://github.com/Huxtuntios/pf2e-animist-apparition-manager/releases).
2. Enable **Pf2e Animist Apparition Manager** in your world.
3. Open an Animist's character sheet, go to the **Spellcasting** tab and press **Manage Animist Abilities** at the top.
4. Bond apparitions with the **Bond** button, or with **Bond a random apparition** next to the search field.

The module id is `pf2e-dailies-apparition-fix`; settings, flags and the API live under it.

## What it does

- **Bonding.** Bonding an apparition grants its spells (never above the highest rank the character can cast), its Vessel spell and its Lore skills, creates the Apparition Spellcasting and Vessel Spells entries when they are missing, and never makes a duplicate. What several apparitions share is reference-counted: unbonding one keeps what another still grants.
- **Cast button.** Non-cantrip spells of the Apparition Spellcasting entry get one Cast button with a rank picker that calls the normal PF2e `cast()`. When the spell can be cast at only one rank (a 10th-rank spell, or only one rank has slots left) it is cast at once, without the menu.
- **Primary apparitions.** Choose them with the star next to an apparition's name. The primary set has a fixed size: one, or two with Medium from level 9. Clicking the star of another apparition swaps it in (with two primaries a small dialog asks which one it replaces); clicking a primary star removes it from the set. Automatic selection is optional.
- **Vessel Spells list.** The Vessel spell of every attuned apparition is listed, but only the primary apparitions' are usable: the others are struck out with a disabled Cast button. A swap button on each struck-out row and a **change primary apparition** button in the list header pick another one.
- **Spells from class feats.** Found by exact compendium id, added once a day with the other apparition spells and removed with the feat: Heal and Harm (Embodiment of the Balance), Avatar (Supreme Incarnation, which also gives the 10th-rank slot at level 19), Animal Form (Walk the Wilds), Aerial Form (Wind Seeker) and Monstrosity Form (Monstrous Inclinations). A spell above the entry's highest rank is held back until the entry has a slot for it.
- **Lore skills.** On PF2e 8.6+ each Lore is a Rule Element on the apparition feat: trained, expert from level 8, master from level 16, updated when the character levels up. Lore names are read in English, in Russian and in the Russian translation's double names such as "Знания фей (Fey) Lore".
- **Class features.** Every bonded apparition is granted by Apparition Attunement (Animist Dedication if that is all the character has), so the sheet lists it nested under that feature.
- **Relinquish Control.** A character with the feat gets a section to choose the permanent apparition. It is bonded at once and again after every night's rest, kept when a profile is applied or yesterday's set is restored, marked with a pin, and cannot be unbonded until another one is chosen.
- **Nightly cleanup.** On `pf2e.restForTheNight` the module's temporary feats, entries, spells and Lore are removed after a snapshot of the day's set is saved. **Restore yesterday** brings it back; **Clean up leftovers** removes old or orphaned data only, never the current day.
- **Profiles, diagnostics, repair.** Save a set of apparitions and primaries as a preparation profile and apply it later; the preview shows what applying it would do. **Diagnostics** reports the actor's state and **Repair actor** rebuilds it in one click.
- **Built-in macro.** A GM client creates a "Bond/Unbond Apparition" world macro once; it opens the same window from the hotbar.

### Wandering Feats

For an Animist, or any character with a wandering feat, the window lists each wandering feat with **every animist wandering class feat of the level it was taken at or lower**: a feat taken at 14 can become a level 2, 6, 12 or 14 one. Choices come from the PF2e feats pack, the `pf2e-anachronism` pack and world feats; a feat the character already has is not offered again. A feat of a level other than 6, 12 or 16 (a homebrew one) counts as the nearest of those below it, so it is never left out.

Some wandering feats need an attuned apparition of a certain kind. That requirement is written only in the feat's description, so the module keeps a **list of suitable apparitions per feat**:

- For the system's feats the list comes from a table of the Lores each feat asks for (matched by exact compendium id; any one Lore will do): Blazing Spirit - Battlegrounds or Volcano; Roaring Heart - Mountain; Grudge Strike - Heraldry or Underworld; Shadows Within Shadows - Hunting or Underworld; Forest's Heart - Forest or Herbalism; Monstrous Inclinations - Forest or Ocean; Jester's Gambol - Circus or Fey.
- A GM adds apparitions to a feat's list, takes them off, or resets the feat in **Configure Settings → Pf2e Animist Apparition Manager → Wandering Feat Requirements**.
- A custom wandering feat has the apparitions its GM marked (none marked means no requirement).

A feat the character has, but none of whose suitable apparitions the character is bonded to, is marked with a warning. In the retrain list such an option is marked ⚠ and cannot be chosen (a GM still can). Other prerequisites are not checked. The new feat takes the old one's place (same location, level taken and granting feature), the old one is deleted, and a chat message records the change.

In the same settings window a GM can **create a custom wandering feat**: name, icon, level, tags, description and a tick list of suitable apparitions. It is saved as an ordinary world class feat with the Animist and Wandering traits.

### Focus pool

The maximum is kept by one Rule Element on Apparition Attunement (Animist Dedication if that is all the character has), recomputed whenever the bonded apparitions or the primary set change:

- PF2e adds 1 to the maximum for every non-cantrip focus spell, and every Vessel spell is one. The Vessels of apparitions that are **not primary** are taken off again with a *subtract* rule: with three bonded apparitions and one primary the maximum is 1; with two primaries it is 2.
- With **Circle of Spirits** nothing is subtracted: the pool is the number of focus spells or of attuned apparitions, whichever is higher (maximum 3), through an *upgrade* rule. The primary set is not enlarged.
- **Manual maximum:** the window has a **Manual focus maximum** field (*Set* / *Back to automatic*). It overrides the automatic value until reset, is stored on the character and survives the night's rest.

### Custom apparitions

**Configure Settings → Pf2e Animist Apparition Manager → Manage Custom Apparitions** opens the editor for homebrew apparitions. A custom apparition is an ordinary world feat with its own spell list, Lore skills and an authored Vessel spell, so it shows up in the management window like any other. The editor has its own icon picker (Foundry's file browser or a typed path), keeps manual edits to the Vessel, and supports copying and JSON import and export. When PF2e Avatars is active, each custom apparition can be assigned one of the existing Animist Avatar forms.

## Settings

| Setting                                  | Scope | What it does                                                                                    |
| ---------------------------------------- | ----- | ----------------------------------------------------------------------------------------------- |
| Enable Animist Apparition Manager        | World | Master switch. Turn it off before removing the module so that Dailies gets its daily back      |
| Apparition Spellcasting Entry Identifier | World | Marks the module's Apparition Spellcasting entry and its spells (default `animist-spontaneous`) |
| Vessel Spells Entry Identifier           | World | Marks the module's Vessel Spells entry and its focus spells (default `animist-focus`)           |
| Automatically fill primary apparitions   | World | Bonding fills a free primary slot; unbonding a primary promotes another bonded apparition       |
| Manage Custom Apparitions                | Menu  | Editor for homebrew apparitions (GM)                                                            |
| Wandering Feat Requirements              | Menu  | Suitable apparitions per wandering feat, and custom wandering feats (GM)                        |

## Working next to PF2e Dailies

PF2e Dailies can stay installed for everything else. For characters with Apparition Attunement or Animist Dedication this module takes over. The only thing it writes into Dailies' data is the per-actor "switch this daily off" flag for Dailies' Animist daily (`flags.pf2e-dailies.disabled.dailies.animist`) and, for a character of the Animist class, for its Wandering Feats daily. Bonded rows, primary Vessels and homebrew entries are not copied into Dailies: its sheet code would strike out Vessels that are not in its own list and offer a retrain button that works on a different set.

The previous value of each flag is remembered and put back when **Enable Animist Apparition Manager** is switched off. **Switch that setting off before removing the module**: once the module is no longer loaded, the flags cannot be restored. A character that gains Apparition Attunement or Animist Dedication while the world is running is switched over at once.

## PF2e Avatars

When `pf2e-avatars` is active, the Avatar spell cast by an Animist offers the forms of this module's primary apparitions. PF2e Dailies protects its API from changes, so the module wraps the Avatar module's own chat handler as it registers and answers its Animist branch itself; nothing is assigned to `game.dailies`. Custom Vessel spells without a matching form leave the Avatar module's normal choices available. Nothing is installed when `pf2e-avatars` is absent or disabled.

## API

```js
const api = game.modules.get("pf2e-dailies-apparition-fix").api;
await api.addApparition(actor, apparitionItemOrUuid);
await api.removeApparition(actor, apparitionItemOrUuid, { silent: true });
api.openManageApparitions(actor);
```

- `addApparition(actor, apparition)` / `removeApparition(actor, apparition, { silent })`
- `openManageApparitions(actor)` / `openCustomApparitions()` / `openWanderingRequirements()`
- `getApparitionState(actor)` / `getPrimaryVesselState(actor)` / `setPrimaryVessel(actor, apparitionKey, isPrimary, { replaceKey })`
- `getFocusPointsOverride(actor)` / `setFocusPointsOverride(actor, value)`
- `getApparitionProfiles(actor)`, `saveApparitionProfile(actor, name, { id })`, `deleteApparitionProfile(actor, profileId)`, `applyApparitionProfile(actor, profileId)`
- `getLastDayApparitionSnapshot(actor)` / `restoreLastDayApparitions(actor)`
- `getPermanentApparition(actor)` / `setPermanentApparition(actor, apparitionUuid)` - the Relinquish Control choice
- `isAutoPrimaryEnabled()` / `setAutoPrimaryEnabled(enabled)`
- `diagnose(actor)` / `repairApparitionActor(actor)` (alias `fixCurrentAnimist`) / `getManagedOrigin(item)`
- `syncDailiesIsolation(actor)` - re-apply the Dailies switch-off for an Animist character

Hooks, emitted with `Hooks.callAll`:

| Hook                                              | Arguments                                         | When                                                               |
| ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| `pf2e-dailies-apparition-fix:apparition-bonded`   | `actor, { key, apparition }`                      | After everything the apparition grants exists; only for a new bond |
| `pf2e-dailies-apparition-fix:apparition-unbonded` | `actor, { key, apparition }`                      | After an apparition is unbonded                                     |
| `pf2e-dailies-apparition-fix:primary-changed`     | `actor, primaryKeys`                              | Whenever the primary set really changes                            |
| `pf2e-dailies-apparition-fix:rest-cleanup`        | `actor, removedCount`                             | After the night's rest cleanup                                     |
| `pf2e-dailies-apparition-fix:apparition-repaired` | `actor, { repaired, removed, missing, warnings }` | After **Repair actor**                                             |

## Known limits

- The module attaches to the PF2e character sheet (the Spellcasting tab, the Cast buttons and the Vessel Spells list). A system update that restructures that template can need a module update.
- Wandering-feat prerequisites other than the apparition requirement are not checked.
- Spells, Vessel and Lore of an apparition are read from the apparition feat's description, so a homebrew apparition keeps the structure the custom-apparition editor produces.

## Development

```
npm ci                      # install development tools
npm test                    # lint, formatting, language files, release check
npm run format              # format scripts and styles
npm run build:release -- --repo Huxtuntios/pf2e-animist-apparition-manager
```

The code is plain ES modules: no build step, no `libWrapper`, no jQuery. `npm run build:release` writes `dist/module.json` and `dist/module.zip`, the same files the release workflow attaches to a GitHub release. Publishing a release is described in [docs/RELEASING.md](docs/RELEASING.md).

## Credits

The Animist handling follows the approach of [PF2e Dailies](https://github.com/reonZ/pf2e-dailies) by reonZ; this module runs it as a standalone feature.

## License

MIT. See [LICENSE](LICENSE).
