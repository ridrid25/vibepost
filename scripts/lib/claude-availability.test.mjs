import test from 'node:test';
import assert from 'node:assert/strict';
import { причинаОстановкиClaude } from './claude-availability.mjs';

test('weekly limit pauses until the reset time from Claude CLI', () => {
  const now = new Date(2026, 7, 22, 17, 0, 0);
  const result = причинаОстановкиClaude(
    "You've hit your weekly limit · resets 11pm (Europe/Moscow)", now,
  );
  assert.equal(result.reason, 'limit');
  assert.match(result.progress, /23:00/);
  assert.equal(new Date(result.until).getHours(), 23);
});

test('past reset time rolls over to tomorrow', () => {
  const now = new Date(2026, 7, 22, 23, 30, 0);
  const result = причинаОстановкиClaude(
    "You've hit your weekly limit · resets 11pm (Europe/Moscow)", now,
  );
  assert.equal(new Date(result.until).getDate(), 23);
});

test('auth and network failures keep their existing instructions', () => {
  assert.equal(причинаОстановкиClaude('OAuth session expired').reason, 'auth');
  assert.equal(причинаОстановкиClaude('403 Request not allowed').reason, 'vpn');
  assert.equal(причинаОстановкиClaude('normal completion'), null);
});
