import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyRedemption, redemptionResult, grantExpired} from '../src/redemption-model.js';

test('legacy credentials are parsed without any request and malformed tokens fail closed', () => {
  const credential = 'a'.repeat(64);
  assert.deepEqual(legacyRedemption(new URL(`https://example.test/dl/private/tool.zip?token=${credential}`)), {resources: [{name: 'tool.zip', credential}]});
  assert.deepEqual(legacyRedemption(new URL('https://example.test/dl/private/tool.zip?card=A&key=B')), {card: 'A', key: 'B', resource: 'private/tool.zip'});
  assert.equal(legacyRedemption(new URL('https://example.test/redeem')), null);
  assert.throws(() => legacyRedemption(new URL('https://example.test/dl/private/tool.zip?token=bad')));
});

test('redemption validates the whole response before replacing previous results', () => {
  const good = {quota: 0, resources: [{name: 'Tool', credential: 'b'.repeat(64)}]};
  assert.equal(redemptionResult(good), good);
  assert.throws(() => redemptionResult({resources: [{name: 'Tool', credential: ''}]}));
  assert.throws(() => redemptionResult({resources: null}));
  assert.deepEqual(redemptionResult({resources: []}), {resources: []});
});

test('invalid, absent and expired grants cannot be downloaded or copied', () => {
  const now = Date.parse('2026-10-09T01:00:00Z');
  assert.equal(grantExpired(null, now), true);
  assert.equal(grantExpired({expires_at: 'invalid'}, now), true);
  assert.equal(grantExpired({expires_at: '2026-10-09T01:00:00Z'}, now), true);
  assert.equal(grantExpired({expires_at: '2026-10-09T01:01:00Z'}, now), false);
});
