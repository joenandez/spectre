#!/usr/bin/env node

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { measurePayload, PAYLOAD_BOUNDARIES } from './knowledge/payload.mjs';

function repeatToLength(unit, length) {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

function frameCore(core) {
  const reserve = repeatToLength(
    '[also matching: reserved metadata]\n',
    PAYLOAD_BOUNDARIES.secondaryMetadataReserveChars,
  );
  return ['# Spectre knowledge registry', '', core, '', reserve].join('\n');
}

function numericTableRecord(id, length, unit) {
  const prefix = [
    '---',
    `name: ${id}`,
    'description: Numeric table boundary fixture.',
    'metadata:',
    '  spectre-category: "testing"',
    '  spectre-triggers: \'["numeric table boundary"]\'',
    '  spectre-status: "active"',
    '  spectre-version: "1"',
    '---',
    `# ${id}`,
    '',
  ].join('\n');
  return `${prefix}${repeatToLength(unit, length - prefix.length)}`;
}

describe('knowledge registry payload estimator', () => {
  it('accepts the minimum useful prose and code registry payloads', () => {
    const prose = repeatToLength(
      'Reliable project knowledge is routed from compact metadata. ',
      PAYLOAD_BOUNDARIES.proseCoreChars,
    );
    const code = repeatToLength(
      'export function loadKnowledge(id) { return id.trim(); }\n',
      PAYLOAD_BOUNDARIES.codeCoreChars,
    );
    assert.equal(measurePayload('codex', frameCore(prose)).ok, true);
    assert.equal(measurePayload('codex', frameCore(code)).ok, true);
  });

  it('measures punctuation-heavy and Unicode boundaries deterministically', () => {
    const fixtures = [
      repeatToLength('(){}[]<>.,;:!?/\\|`~@#$%^&*-_=+ ', PAYLOAD_BOUNDARIES.punctuationUnsafeChars),
      repeatToLength('cafe\u0301 Tokyo:\u6771\u4eac Greek:\u0394 ', PAYLOAD_BOUNDARIES.unicodeUnsafeChars),
    ];
    for (const fixture of fixtures) {
      const first = measurePayload('codex', frameCore(fixture));
      assert.deepEqual(measurePayload('codex', frameCore(fixture)), first);
      assert.equal(first.ok, false);
    }
  });

  it('rejects unsafe dense runs while accepting the planned probe', () => {
    const unsafe = [
      repeatToLength('0123456789', PAYLOAD_BOUNDARIES.denseDigitUnsafeChars),
      repeatToLength('Az09By18Cx27', PAYLOAD_BOUNDARIES.denseAlphanumericUnsafeChars),
    ];
    for (const fixture of unsafe) {
      const measured = measurePayload('codex', frameCore(fixture));
      assert.equal(measured.ok, false);
      assert.equal(measured.measured > measured.limit, true);
    }
    const probe = repeatToLength(
      'Az09By18Cx27',
      PAYLOAD_BOUNDARIES.denseAlphanumericProbeChars,
    );
    assert.equal(measurePayload('codex', frameCore(probe)).ok, true);
  });

  it('rejects aggregate short numeric tables below the long-run threshold', () => {
    const content = numericTableRecord(
      'feature-numeric-table',
      PAYLOAD_BOUNDARIES.numericTableUnsafeChars,
      '1234567890123456789012345678901 \n',
    );
    assert.equal(Math.max(...[...content.matchAll(/\d+/g)].map(([run]) => run.length)), 31);
    assert.equal(/[A-Za-z0-9]{32,}/.test(content), false);
    assert.equal(measurePayload('codex', frameCore(content)).ok, false);
  });

  it('rounds maximal short digit fields to three-character groups', () => {
    const four = numericTableRecord(
      'feature-four-digit-table',
      PAYLOAD_BOUNDARIES.fourDigitTableUnsafeChars,
      '1234 \n',
    );
    const three = numericTableRecord(
      'feature-three-digit-table',
      PAYLOAD_BOUNDARIES.threeDigitTableUnsafeChars,
      '123 \n',
    );
    assert.equal(measurePayload('codex', frameCore(four)).ok, false);
    assert.equal(measurePayload('codex', frameCore(three)).ok, false);
  });

  it('does not double count digits inside a denser alphanumeric run', () => {
    const digits = measurePayload('codex', frameCore(`A${'1'.repeat(40)}B`));
    const letters = measurePayload('codex', frameCore(`A${'x'.repeat(40)}B`));
    assert.deepEqual(digits, letters);
  });

  it('enforces the Claude registry output boundary at 9,000 and 9,001 characters', () => {
    const exact = 'x'.repeat(PAYLOAD_BOUNDARIES.claudeSafeOutputChars);
    assert.deepEqual(measurePayload('claude', exact), {
      ok: true,
      measured: PAYLOAD_BOUNDARIES.claudeSafeOutputChars,
      limit: PAYLOAD_BOUNDARIES.claudeSafeOutputChars,
      reserve: PAYLOAD_BOUNDARIES.claudeReserveChars,
    });
    assert.equal(measurePayload('claude', `${exact}x`).ok, false);
  });
});
