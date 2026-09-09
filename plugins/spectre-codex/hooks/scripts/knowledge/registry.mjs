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
    'For a substantive task, search the actual task, assess applicability, then exact-load only the needed record. For unrelated general conversation, load nothing.',
    'Search can find untagged imported work and tags omitted here; previews and history are not active guidance.',
    `Run ${shellQuote(cliPath)} search '<task>' --project-dir .; then replace search '<task>' with load '<id>'. Apply only a verified load.`,
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
