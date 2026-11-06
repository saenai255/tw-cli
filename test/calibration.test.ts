import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Calibration } from '../src/game/calibration.ts';
import { parseJobReport } from '../src/game/mail.ts';
import { questEnds } from '../src/game/quests.ts';

test("calibration: drops blend reports with the game's number; HP and rooms from samples", () => {
  const candidate = new Calibration(null);
  assert.equal(candidate.dropRate(4, 'long', 704000, 0.4), 0.4, "no reports: the game's number");
  for (let index = 0; index < 5; index++) {
    candidate.addJobRun(4, 'long', index < 1 ? [[704000, 2]] : []);
  }
  assert.ok(
    Math.abs(candidate.dropRate(4, 'long', 704000, 0.4) - (2 + 0.4 * 5) / 10) < 1e-9,
    'half prior, half observed',
  );
  assert.equal(candidate.hpScale, 1);
  candidate.addHp(10, 30);
  assert.ok(candidate.hpScale > 1 && candidate.hpScale < 3, 'pulled toward 3× by one run');
  const capped = new Calibration(null);
  capped.addHp(1, 100);
  assert.equal(capped.hpScale, 3, 'HP scale never exceeds 3');
  const floored = new Calibration(null);
  for (let index = 0; index < 10; index++) {
    floored.addHp(10, 0);
  }
  assert.equal(floored.hpScale, 0.5, 'HP scale never drops below 0.5');
  assert.equal(candidate.roomScale, 1);
  candidate.addRoom(0.2);
  assert.ok(Math.abs(candidate.roomScale - 0.6) < 1e-9);
  candidate.addLevelUp(true);
  assert.deepEqual(candidate.data.levelUps, { seen: 1, refilled: 1 });
});

test('job report: job, items and run length for calibration; quest end date', () => {
  const result = parseJobReport({
    reportType: 'job',
    reportInfo: { job_id: 18, items: [[708000, true, 5, 'yield']] },
    page: '<div><span>Duration</span><span>1 hour</span></div>',
  });
  assert.deepEqual(result, { jobId: 18, items: [[708000, 5]], seconds: 3600 });
  assert.equal(parseJobReport({ reportType: 'duel', reportInfo: {} }), null);
  assert.equal(
    questEnds('This quest is only available from 28.10.2026 at 00:00 until the 16.11.2026 at 12:00.'),
    Date.UTC(2026, 10, 16, 12, 0) / 1000,
  );
  assert.equal(questEnds(''), null);
});
