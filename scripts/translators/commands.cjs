'use strict';

function rewriteUserCommandRefsForCodex(source) {
  const legacyCommand = source.match(/\/spectre:(?!spectre-)([A-Za-z0-9_-]+)/);
  if (legacyCommand) {
    throw new Error(
      `Legacy Spectre command reference "${legacyCommand[0]}"; use /spectre:spectre-${legacyCommand[1]}`,
    );
  }

  return source.replace(
    /\/spectre:(spectre-[A-Za-z0-9_-]+)/g,
    (_match, skillName) => `$spectre:${skillName}`,
  );
}

module.exports = {
  rewriteUserCommandRefsForCodex,
};
