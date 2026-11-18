# Farming products

The Farm module queues a chosen set of jobs round-robin to harvest crafting materials. It is off by default;
see `docs/autopilot.md` “Products farm” for the planner details. Products are counted as units, not valued by
shop sell price.

## Blacksmith preset

`src/game/farm.ts` ships the early blacksmith products, one job per product, in this order. Expected drops are
from the live en32 `work/index` values (2026-11-07), per long run:

| Product        | Item id | Job (id)                 | Expected per long run (12 E) |
| -------------- | ------: | ------------------------ | ---------------------------: |
| Granite blocks |     716 | Granite mining (25)      |                         4.05 |
| Hammer         |     747 | Repair fences (23)       |                         1.98 |
| Iron rod       |     790 | Iron mining (85)         |                         2.54 |
| Wood           |     711 | Clearing the forest (55) |                         6.75 |
| Cotton         |     704 | Picking cotton (5)       |                         4.95 |
| Wool           |     707 | Tending sheep (10)       |                         4.05 |
| Leather        |     712 | Tanning deer skin (17)   |                         3.15 |
| Coal           |     721 | Coal mining (40)         |                         2.43 |

The expected value is `(prop + probBonus) / 100`; long runs list more per run and are far better per energy.
Wood is also dropped by Rafting wood (46, more XP/money) and Felling trees (27, less per energy); the preset
picks Clearing the forest for product rate, and the picker can add the others to a custom list.

One full cycle is 96 energy for about 30 items across all eight products. Short runs are slightly better per
hour but cost far more energy per hour (a 15 s run costs 1 E, a 1 h run 12 E), so with job duration Auto the
farm picks the best duration per energy. A fixed job duration on `g a` overrides that, like all autopilot jobs.

## Floor and motivation

Product drop volume does not depend on motivation (verified live; XP, cash and luck chance do). A floor of 50 %
therefore protects XP/money/luck and keeps the accounts useful for the normal priority, not the item count. For
pure harvesting set the floor to 0 % and leave motivation items off; verify that a job can still be started at
exactly 0 % (the planner assumes it can).

At the floor the farm uses one motivation item per plan if `use motivation items at the floor` is on, then
replans. With no item, that job is hidden from the farm and from the normal score for the rest of the plan.
When no selected job is left, the normal priority runs. Whether a “Work motivation increase” item raises one
job or all is unverified.

## Custom farm

`g a` → `farm jobs` → `Space` opens the picker. `/` filters by job or product name, `Space` adds/removes in
round-robin order, `J K` moves the selected job, `P` loads the blacksmith preset, `Esc` closes. The selection is
saved in `autopilot.json` per account; multiple instances need no coordination. A selected job that is on the
autopilot's job blacklist is skipped.
