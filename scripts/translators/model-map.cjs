'use strict';

const defaultsByRole = {
  readonly: {
    sandbox_mode: 'read-only',
  },
  mutating: {
    sandbox_mode: 'workspace-write',
  },
};

const roleHints = {
  analyst: 'readonly',
  finder: 'readonly',
  patterns: 'readonly',
  reviewer: 'readonly',
  'web-research': 'readonly',
  dev: 'mutating',
  sync: 'mutating',
  tester: 'mutating',
};

const codexDefaultsByClaudeModel = {
  'claude-sonnet-5': {
    model: 'gpt-6-luna',
    model_reasoning_effort: 'high',
  },
  'claude-opus-5-5': {
    model: 'gpt-6-sol',
    model_reasoning_effort: 'high',
  },
};

function defaultsForAgent(agentName) {
  const role = roleHints[agentName] || 'mutating';
  return defaultsByRole[role];
}

function codexDefaultsForClaudeModel(claudeModel) {
  const defaults = codexDefaultsByClaudeModel[claudeModel];
  if (!defaults) {
    throw new Error(`Unsupported Claude agent model "${claudeModel}"`);
  }
  return defaults;
}

module.exports = {
  codexDefaultsByClaudeModel,
  codexDefaultsForClaudeModel,
  defaultsByRole,
  roleHints,
  defaultsForAgent,
};
