import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventReadyItems, parseActiveEvent, withEventPoints } from '../src/game/event.ts';
import { Inventory } from '../src/game/inventory.ts';
import { ItemCatalog, slimItem } from '../src/game/items.ts';
import type { JsonObject } from '../src/util/json.ts';

const game: JsonObject = {
  sesData: {
    DayOfDead: {
      meta: { end: '16.11.2026 12:00:59' },
      rewards: {
        90000: { id: 54973000, desc: "Xólotl Spirit's spear for you!" },
        110000: { id: 54975000, desc: "Xólotl Spirit's torch for you!" },
        140000: { id: 54976000, desc: 'Clothing set' },
      },
      counter: { key: 'ses:dayofdead_collected', value: 95000 },
    },
  },
  ceData: { dayofdead: { event_name: 'Day of the Dead 2026', event_end: '16.11.2026 12:00' } },
};

test('event: personal progress, next reward and live SesStat values', () => {
  const event = parseActiveEvent(game);

  assert.ok(event);
  assert.deepEqual(
    [event.id, event.name, event.points, event.counterKey],
    ['dayofdead', 'Day of the Dead 2026', 95000, 'ses:dayofdead_collected'],
  );
  assert.equal(event.next?.at, 110000);
  assert.match(event.next?.text ?? '', /torch/);
  assert.equal(withEventPoints(event, 111000).next?.at, 140000);
  assert.equal(parseActiveEvent({}), null);
});

test('event: generator items are reminded only when the active event matches and the cooldown is over', () => {
  const catalog = new ItemCatalog();
  catalog.add(
    slimItem({
      item_id: 2665000,
      name: 'Flower pot',
      type: 'yield',
      usetype: 'use',
      action: true,
      description:
        'Generates 1250 flowers for the day of the dead event, which can be collected once every 11.5 hours.',
      usebonus: ['1250 Cempasúchil'],
    }),
  );
  catalog.add(
    slimItem({
      item_id: 2558000,
      name: 'Large heart bag',
      type: 'yield',
      usetype: 'use',
      action: true,
      description: "Generates 2500 hearts for the Valentine's Day event, which can be collected once every 23 hours.",
      usebonus: ['2500 Hearts'],
    }),
  );
  const inventory = new Inventory();
  inventory.bag.set(2665000, { itemId: 2665000, count: 1, invId: 1, type: 'yield' });
  inventory.bag.set(2558000, { itemId: 2558000, count: 1, invId: 2, type: 'yield' });
  const event = parseActiveEvent(game);
  const now = 1_800_000_000;
  inventory.itemCooldown.set(2665000, now - 1);
  inventory.itemLifetime.set(2665000, 1000);

  assert.deepEqual(
    eventReadyItems(inventory, catalog, event, now).map((item) => [item.name, item.amount]),
    [['Flower pot', 1250]],
  );

  inventory.itemCooldown.set(2665000, now + 1);
  assert.deepEqual(eventReadyItems(inventory, catalog, event, now), []);

  inventory.itemCooldown.set(2665000, now - 1);
  inventory.itemLifetime.set(2665000, 0);
  assert.deepEqual(eventReadyItems(inventory, catalog, event, now), []);
});
