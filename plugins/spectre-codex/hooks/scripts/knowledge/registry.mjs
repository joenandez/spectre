import { estimatePayloadTokens } from './payload.mjs';

const SESSION_START_TOKEN_LIMIT = 300;

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function renderTagEntry([id, tag]) {
  const aliases = tag.aliases.length > 0 ? `; aliases: ${tag.aliases.join(', ')}` : '';
  return `- ${id}: ${oneLine(tag.description)}${aliases}`;
}

function renderContent(entries, omittedCount, cliPath) {
  return [
    '## Project knowledge',
    `Use ${shellQuote(cliPath)} with --project-dir . A matching listed tag uses search --tag '<tag>'; otherwise search '<task>' only if prior work is cited or a decision may depend on omitted/untagged knowledge. Substance alone is insufficient.`,
    'Discovery is per question, not skill. Reuse results/loads; refine only for an unresolved question or new subject; never repeat an equivalent query.',
    "Use load '<id>' only to resolve that question/decision; verified loads alone are guidance. Oversized loads require a blocked decision. Unrelated chat: load nothing.",
    "#tag is explicit: search --tag '<tag>', exact-load applicable matches; never create tags.",
    'Tags:',
    ...(entries.length > 0 ? entries.map(renderTagEntry) : ['- No tagged records yet; imported work remains searchable.']),
    `Omitted tags: ${omittedCount}; omitted tags remain searchable.`,
  ].join('\n');
}

export function knowledgeRegistryFrame(content) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: content },
  });
}

/** A complete-entry tag registry; record identity, bodies, activity, and paths never enter SessionStart. */
export function renderKnowledgeRegistry(options = {}) {
  const catalog = options.catalog || { tags: {} };
  const tagEntries = Object.entries(catalog.tags || []).sort(([left], [right]) => compareIds(left, right));
  let selected = { entries: [], omittedCount: tagEntries.length };
  for (let count = 0; count <= tagEntries.length; count += 1) {
    const entries = tagEntries.slice(0, count);
    const omittedCount = tagEntries.length - count;
    const content = renderContent(entries, omittedCount, options.cliPath || 'knowledge-cli.mjs');
    const frame = knowledgeRegistryFrame(content);
    const measured = estimatePayloadTokens(frame);
    if (measured <= SESSION_START_TOKEN_LIMIT) selected = { entries, omittedCount, content, frame, measured };
  }
  if (!selected.content) throw new RangeError('SessionStart retrieval rules exceed the token budget');
  return {
    content: selected.content,
    frame: selected.frame,
    measurement: { ok: true, measured: selected.measured, limit: SESSION_START_TOKEN_LIMIT },
    includedEntries: selected.entries.map(([id]) => id),
    omittedCount: selected.omittedCount,
  };
}

export { SESSION_START_TOKEN_LIMIT };
