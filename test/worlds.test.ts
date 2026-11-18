import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_WORLD,
  NET_LOCALE,
  NET_WORLDS,
  OPEN_WORLDS,
  worldById,
  worldByName,
  worldConfig,
} from '../src/auth/worlds.ts';

test('.net world list: unique ids, names and hosts; every host is an https .net world', () => {
  assert.equal(new Set(NET_WORLDS.map((world) => world.id)).size, NET_WORLDS.length);
  assert.equal(new Set(NET_WORLDS.map((world) => world.name)).size, NET_WORLDS.length);
  assert.equal(new Set(NET_WORLDS.map((world) => world.url)).size, NET_WORLDS.length);
  for (const world of NET_WORLDS) {
    assert.match(world.url, /^https:\/\/en\d+\.the-west\.net$/, world.name);
  }
  assert.equal(NET_LOCALE, 'en_DK');
  assert.equal(OPEN_WORLDS.length, 15);
  assert.ok(OPEN_WORLDS.every((world) => world.open));
});

test('world lookup: id, exact name, id as text and a unique name prefix', () => {
  assert.equal(worldById(38)?.name, 'Quebec');
  assert.equal(worldByName('Quebec')?.id, 38);
  assert.equal(worldByName(' quEbec ')?.id, 38);
  assert.equal(worldByName('38')?.id, 38);
  assert.equal(worldByName('Phoen')?.id, 37);
  assert.equal(worldByName('Juarez')?.id, 29);
  assert.equal(worldByName('shorts')?.id, 31);
  assert.equal(worldByName('nope'), undefined);
  assert.equal(worldByName(''), undefined);
});

test('Quebec is the default (unless TW_WORLD_URL overrides it) and worldConfig copies the portal data', () => {
  if (!process.env.TW_WORLD_URL) {
    assert.equal(DEFAULT_WORLD.id, 38);
    assert.equal(DEFAULT_WORLD.name, 'Quebec');
    assert.equal(DEFAULT_WORLD.url, 'https://en32.the-west.net');
  }
  assert.equal(DEFAULT_WORLD.locale, process.env.TW_LOCALE ?? 'en_DK');
  assert.deepEqual(worldConfig(OPEN_WORLDS[0]!), {
    url: 'https://en13.the-west.net',
    locale: process.env.TW_LOCALE ?? 'en_DK',
    id: 18,
    name: 'Arizona',
  });
});
