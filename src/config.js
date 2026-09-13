/**
 * Configuration resolution for deepseek-code.
 *
 * Precedence (lowest to highest):
 *   built-in defaults
 *   ~/.deepseek-code/config.json
 *   <cwd>/.claude/settings.json          (Claude Code compatible)
 *   <cwd>/.claude/settings.local.json    (Claude Code compatible)
 *   <cwd>/.deepseek-code/settings.json
 *   <cwd>/.deepseek-code/settings.local.json
 *   DEEPSEEK_* environment variables
 *   command line flags
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = path.join(os.homedir(), '.deepseek-code');
export const USER_CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  smallModel: 'deepseek-flash',
  maxTokens: 16384,
  thinking: true,
  effort: 'high',
  permissionMode: 'default',
  maxSteps: 60,
  maxToolOutput: 30000,
};

const PERMISSION_MODES = ['plan', 'default', 'acceptEdits', 'bypassPermissions'];

export function permissionModes() {
  return [...PERMISSION_MODES];
}

export function normalizePermissionMode(value) {
  if (!value) return null;
  const map = {
    auto: 'default',
    plan: 'plan',
    default: 'default',
    acceptEdits: 'acceptEdits',
    acceptedits: 'acceptEdits',
    bypassPermissions: 'bypassPermissions',
    bypasspermissions: 'bypassPermissions',
    yolo: 'bypassPermissions',
    dontask: 'bypassPermissions',
  };
  return map[value] ?? map[String(value).toLowerCase()] ?? null;
}

/** Read a JSON file, returning null when it does not exist. */
export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot parse ${file}: ${error.message}`);
  }
}

export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Files consulted for settings, in precedence order. */
export function settingsFiles(cwd) {
  return [
    USER_CONFIG_PATH,
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.deepseek-code', 'settings.json'),
    path.join(cwd, '.deepseek-code', 'settings.local.json'),
  ];
}

function mergeInto(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const [key, value] of Object.entries(source)) {
    if (key === 'permissions') {
      const previous = target.permissions ?? {};
      target.permissions = {
        ...previous,
        ...value,
        allow: [...(previous.allow ?? []), ...(value.allow ?? [])],
        deny: [...(previous.deny ?? []), ...(value.deny ?? [])],
        additionalDirectories: [
          ...(previous.additionalDirectories ?? []),
          ...(value.additionalDirectories ?? []),
        ],
      };
    } else if (key === 'env') {
      target.env = { ...(target.env ?? {}), ...(value ?? {}) };
    } else if (value !== undefined && value !== null) {
      target[key] = value;
    }
  }
  return target;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).toLowerCase());
}

function parseIntStrict(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: "${value}" (expected a positive integer)`);
  }
  return parsed;
}


/**
 * Resolve the effective configuration.
 * @param {{cwd?: string, flags?: object, env?: object}} options
 */
export function loadConfig(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const flags = options.flags ?? {};

  const settings = {};
  const sources = [];
  for (const file of settingsFiles(cwd)) {
    const parsed = readJsonFile(file);
    if (parsed) {
      sources.push(file);
      mergeInto(settings, parsed);
    }
  }

  const fileEnv = settings.env ?? {};
  const pickEnv = (...names) => {
    for (const name of names) {
      if (env[name] !== undefined && env[name] !== '') return env[name];
      if (fileEnv[name] !== undefined && fileEnv[name] !== '') return fileEnv[name];
    }
    return undefined;
  };

  const permissionMode =
    normalizePermissionMode(flags.permissionMode) ??
    normalizePermissionMode(pickEnv('DEEPSEEK_PERMISSION_MODE')) ??
    normalizePermissionMode(settings.defaultMode) ??
    DEFAULTS.permissionMode;

  const apiKeyCandidates = [
    ['--api-key flag', flags.apiKey],
    ['DEEPSEEK_API_KEY', pickEnv('DEEPSEEK_API_KEY')],
    // Convenience: reuse an existing Claude Code + DeepSeek setup.
    ['ANTHROPIC_AUTH_TOKEN', pickEnv('ANTHROPIC_AUTH_TOKEN')],
    ['user config apiKey', settings.apiKey],
  ].filter(([, value]) => typeof value === 'string' && value.trim() !== '');

  const config = {
    ...DEFAULTS,
    ...settings,
    cwd,
    baseUrl: flags.baseUrl ?? pickEnv('DEEPSEEK_BASE_URL') ?? settings.baseUrl ?? DEFAULTS.baseUrl,
    model: flags.model ?? pickEnv('DEEPSEEK_MODEL') ?? settings.model ?? DEFAULTS.model,
    smallModel: pickEnv('DEEPSEEK_SMALL_MODEL') ?? settings.smallModel ?? DEFAULTS.smallModel,
    maxTokens: parseIntStrict(
      flags.maxTokens ?? pickEnv('DEEPSEEK_MAX_TOKENS') ?? settings.maxTokens,
      DEFAULTS.maxTokens,
      'max-tokens',
    ),
    maxSteps: parseIntStrict(
      flags.maxSteps ?? pickEnv('DEEPSEEK_MAX_STEPS') ?? settings.maxSteps,
      DEFAULTS.maxSteps,
      'max-steps',
    ),
    thinking: parseBool(
      flags.thinking ?? pickEnv('DEEPSEEK_THINKING') ?? settings.thinking,
      DEFAULTS.thinking,
    ),
    effort: String(
      flags.effort ?? pickEnv('DEEPSEEK_EFFORT') ?? settings.effort ?? DEFAULTS.effort,
    ).toLowerCase(),
    permissionMode,
    permissions: {
      allow: settings.permissions?.allow ?? [],
      deny: settings.permissions?.deny ?? [],
      additionalDirectories: settings.permissions?.additionalDirectories ?? [],
    },
    env: fileEnv,
    sources,
    apiKey: apiKeyCandidates.length ? apiKeyCandidates[0][1].trim() : null,
    apiKeySource: apiKeyCandidates.length ? apiKeyCandidates[0][0] : null,
    verbose: Boolean(flags.verbose),
  };

  if (!config.baseUrl.startsWith('http')) {
    throw new Error(`Invalid base URL: ${config.baseUrl}`);
  }
  config.baseUrl = config.baseUrl.replace(/\/+$/, '');
  return config;
}

/** Persist an always-allow rule into the project's local settings file. */
export function rememberAllowRule(cwd, rule) {
  const file = path.join(cwd, '.deepseek-code', 'settings.local.json');
  const current = readJsonFile(file) ?? {};
  const permissions = current.permissions ?? {};
  const allow = permissions.allow ?? [];
  if (!allow.includes(rule)) allow.push(rule);
  current.permissions = { ...permissions, allow };
  writeJsonFile(file, current);
  return file;
}
