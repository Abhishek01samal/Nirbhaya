import test from 'node:test';
import assert from 'node:assert/strict';
import { createSOSchema } from '../src/modules/sos/sos.validation.js';

test('accepts a manual SOS with only triggerType', () => {
  const result = createSOSchema.safeParse({ triggerType: 'MANUAL' });

  assert.equal(result.success, true);
  assert.equal(result.data.triggerType, 'MANUAL');
});

test('accepts every valid trigger type', () => {
  for (const triggerType of ['MANUAL', 'VOICE_DANGER', 'OFF_ROUTE', 'LONG_STOP']) {
    const result = createSOSchema.safeParse({ triggerType });
    assert.equal(result.success, true, `${triggerType} should be valid`);
  }
});

test('accepts a full automated-trigger payload', () => {
  const result = createSOSchema.safeParse({
    triggerType: 'VOICE_DANGER',
    safetySessionId: '64b0f0f0f0f0f0f0f0f0f0f0',
    triggerData: { riskLevel: 'HIGH', confidence: 0.92, reason: 'Potential danger detected' },
    location: { lat: 19.31, lng: 84.79, address: 'Cuttack, Odisha' },
  });

  assert.equal(result.success, true);
  assert.equal(result.data.triggerData.confidence, 0.92);
  assert.equal(result.data.location.lat, 19.31);
});

test('rejects an invalid trigger type', () => {
  const result = createSOSchema.safeParse({ triggerType: 'SOS' });

  assert.equal(result.success, false);
  assert.equal(result.error.issues[0].path[0], 'triggerType');
});

test('rejects a missing trigger type', () => {
  assert.equal(createSOSchema.safeParse({}).success, false);
});

test('rejects invalid location coordinates', () => {
  assert.equal(
    createSOSchema.safeParse({ triggerType: 'MANUAL', location: { lat: 91, lng: 0 } }).success,
    false
  );
  assert.equal(
    createSOSchema.safeParse({ triggerType: 'MANUAL', location: { lat: 0, lng: -181 } }).success,
    false
  );
  assert.equal(
    createSOSchema.safeParse({ triggerType: 'MANUAL', location: { lat: 'x', lng: 0 } }).success,
    false
  );
});

test('rejects a malformed safetySessionId', () => {
  assert.equal(
    createSOSchema.safeParse({ triggerType: 'MANUAL', safetySessionId: 'not-an-id' }).success,
    false
  );
});

test('rejects triggerData outside allowed ranges', () => {
  assert.equal(
    createSOSchema.safeParse({
      triggerType: 'VOICE_DANGER',
      triggerData: { confidence: 1.5 },
    }).success,
    false
  );
});

test('ignores a client-supplied userId', () => {
  const result = createSOSchema.safeParse({
    triggerType: 'MANUAL',
    userId: 'attacker-controlled-id',
  });

  assert.equal(result.success, true);
  assert.equal('userId' in result.data, false);
});
