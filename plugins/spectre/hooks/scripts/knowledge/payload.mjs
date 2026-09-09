// Minimum useful prose verified by the real-host boundary protocol.
const PROSE_CORE_CHARS = 6_000;
// Minimum useful code verified separately because punctuation raises token density.
const CODE_CORE_CHARS = 4_000;
// Dense 9,000-character fixtures must be rejected rather than use host fallback.
const PUNCTUATION_UNSAFE_CHARS = 9_000;
// Non-ASCII byte density makes this 9,000-character fixture intentionally unsafe.
const UNICODE_UNSAFE_CHARS = 9_000;
// Legal-size unbroken numeric and encoded runs must fail the Codex injection budget.
const DENSE_DIGIT_UNSAFE_CHARS = 8_000;
const DENSE_ALPHANUMERIC_UNSAFE_CHARS = 8_000;
// Bounded numeric fields can aggregate past the host limit without one long run.
const NUMERIC_TABLE_UNSAFE_CHARS = 8_700;
const FOUR_DIGIT_TABLE_UNSAFE_CHARS = 7_036;
const THREE_DIGIT_TABLE_UNSAFE_CHARS = 8_700;
// This mixed run keeps its complete registration frame just below the Codex budget.
const DENSE_ALPHANUMERIC_PROBE_CHARS = 2_050;
// Prompt framing always reserves the complete secondary-match allowance.
const SECONDARY_METADATA_RESERVE_CHARS = 750;
// Claude's documented 10,000-character cap retains a 1,000-character safety reserve.
const CLAUDE_SAFE_OUTPUT_CHARS = 9_000;
const CLAUDE_RESERVE_CHARS = 1_000;
// Codex documents roughly 2,500 tokens; retain 250 estimated tokens for host variance.
const CODEX_ESTIMATED_TOKEN_LIMIT = 2_250;
const CODEX_TOKEN_RESERVE = 250;
// Short words use the byte baseline; long runs need explicit tokenizer-density rates.
const DENSE_ALPHANUMERIC_RUN_MIN_CHARS = 32;
// Decimal tokens contain at most three digits; each maximal run rounds up.
const DIGIT_TOKEN_GROUP_CHARS = 3;
// Hash/base64-like runs can approach three tokens per four ASCII characters.
const DENSE_ALPHANUMERIC_TOKENS_PER_CHAR = 3 / 4;
const ASCII_BYTE_BASELINE_TOKENS_PER_CHAR = 1 / 4;

export const PAYLOAD_BOUNDARIES = Object.freeze({
  proseCoreChars: PROSE_CORE_CHARS,
  codeCoreChars: CODE_CORE_CHARS,
  punctuationUnsafeChars: PUNCTUATION_UNSAFE_CHARS,
  unicodeUnsafeChars: UNICODE_UNSAFE_CHARS,
  denseDigitUnsafeChars: DENSE_DIGIT_UNSAFE_CHARS,
  denseAlphanumericUnsafeChars: DENSE_ALPHANUMERIC_UNSAFE_CHARS,
  numericTableUnsafeChars: NUMERIC_TABLE_UNSAFE_CHARS,
  fourDigitTableUnsafeChars: FOUR_DIGIT_TABLE_UNSAFE_CHARS,
  threeDigitTableUnsafeChars: THREE_DIGIT_TABLE_UNSAFE_CHARS,
  denseAlphanumericProbeChars: DENSE_ALPHANUMERIC_PROBE_CHARS,
  digitTokenGroupChars: DIGIT_TOKEN_GROUP_CHARS,
  secondaryMetadataReserveChars: SECONDARY_METADATA_RESERVE_CHARS,
  claudeSafeOutputChars: CLAUDE_SAFE_OUTPUT_CHARS,
  claudeReserveChars: CLAUDE_RESERVE_CHARS,
  codexEstimatedTokenLimit: CODEX_ESTIMATED_TOKEN_LIMIT,
  codexTokenReserve: CODEX_TOKEN_RESERVE,
});

function digitRunPenalty(length) {
  return (
    Math.ceil(length / DIGIT_TOKEN_GROUP_CHARS) -
    length * ASCII_BYTE_BASELINE_TOKENS_PER_CHAR
  );
}

function denseAlphanumericPenalty(content) {
  let penalty = 0;
  const coveredRanges = [];
  const runs = content.matchAll(
    new RegExp(`[A-Za-z0-9]{${DENSE_ALPHANUMERIC_RUN_MIN_CHARS},}`, 'g'),
  );
  for (const match of runs) {
    const [run] = match;
    const pureDigits = /^\d+$/.test(run);
    const runPenalty = pureDigits
      ? digitRunPenalty(run.length)
      : run.length * (
        DENSE_ALPHANUMERIC_TOKENS_PER_CHAR -
        ASCII_BYTE_BASELINE_TOKENS_PER_CHAR
      );
    penalty += runPenalty;
    coveredRanges.push({
      start: match.index,
      end: match.index + run.length,
      pureDigits,
      penaltyPerCharacter: runPenalty / run.length,
    });
  }

  const digitRuns = content.matchAll(/\d+/g);
  for (const match of digitRuns) {
    const [run] = match;
    const runEnd = match.index + run.length;
    const coveringRange = coveredRanges.find(({ start, end }) =>
      match.index >= start && runEnd <= end);
    const desiredPenalty = digitRunPenalty(run.length);
    const coveredPenalty = coveringRange
      ? coveringRange.pureDigits
        ? desiredPenalty
        : run.length * coveringRange.penaltyPerCharacter
      : 0;
    penalty += Math.max(0, desiredPenalty - coveredPenalty);
  }
  return penalty;
}

function estimateCodexTokens(content) {
  let punctuation = 0;
  let nonAscii = 0;
  for (const character of content) {
    const codePoint = character.codePointAt(0);
    if (codePoint > 0x7f) nonAscii += 1;
    else if (!/[A-Za-z0-9\s]/.test(character)) punctuation += 1;
  }

  const byteBaseline = Buffer.byteLength(content, 'utf8') / 4;
  return Math.ceil(
    byteBaseline +
    denseAlphanumericPenalty(content) +
    punctuation * 0.22 +
    nonAscii * 0.35,
  );
}

export function estimatePayloadTokens(content) {
  if (typeof content !== 'string') throw new TypeError('content must be a string');
  return estimateCodexTokens(content);
}

export function measurePayload(host, framedContent) {
  if (typeof framedContent !== 'string') {
    throw new TypeError('framedContent must be a string');
  }
  if (host === 'claude') {
    return {
      ok: framedContent.length <= CLAUDE_SAFE_OUTPUT_CHARS,
      measured: framedContent.length,
      limit: CLAUDE_SAFE_OUTPUT_CHARS,
      reserve: CLAUDE_RESERVE_CHARS,
    };
  }
  if (host === 'codex') {
    const measured = estimateCodexTokens(framedContent);
    return {
      ok: measured <= CODEX_ESTIMATED_TOKEN_LIMIT,
      measured,
      limit: CODEX_ESTIMATED_TOKEN_LIMIT,
      reserve: CODEX_TOKEN_RESERVE,
    };
  }
  throw new RangeError(`Unsupported payload host: ${host}`);
}
