import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

/**
 * Read env-style keys from ~/.claude/settings.json (settings.env object).
 */
export function readClaudeSettingsEnv(keys: string[]): Record<string, string> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, 'utf-8');
  } catch (err) {
    logger.debug({ err }, 'settings.json not found, skipping user env');
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> };
    const source = parsed.env || {};
    const result: Record<string, string> = {};
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) {
        result[key] = value.trim();
      }
    }
    return result;
  } catch (err) {
    logger.warn({ err }, 'Failed to parse ~/.claude/settings.json');
    return {};
  }
}

/**
 * Read env keys with priority: ~/.claude/settings.json env > process.env > .env
 */
export function readMergedEnv(keys: string[]): Record<string, string> {
  const envFile = readEnvFile(keys);
  const settingsEnv = readClaudeSettingsEnv(keys);
  const result: Record<string, string> = {};

  for (const key of keys) {
    const settingsValue = settingsEnv[key];
    if (settingsValue) {
      result[key] = settingsValue;
      continue;
    }
    const processValue = process.env[key]?.trim();
    if (processValue) {
      result[key] = processValue;
      continue;
    }
    const envFileValue = envFile[key];
    if (envFileValue) {
      result[key] = envFileValue;
    }
  }

  return result;
}
