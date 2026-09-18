/**
 * Session names.
 *
 * A name is the addressable identity shown as `@name` in ListAgents/SendMessage,
 * so it has to be address- and filesystem-safe: lowercase, `[a-z0-9_.-]`, at most
 * 32 characters. Every session gets one automatically and the user can replace
 * it with `--name` or `/rename`.
 */

export const MAX_NAME_LENGTH = 32;

const ADJECTIVES = [
  'calm', 'bold', 'bright', 'clever', 'eager', 'gentle', 'keen', 'lucky',
  'nimble', 'quiet', 'rapid', 'sharp', 'steady', 'swift', 'sunny', 'wise',
];

const NOUNS = [
  'otter', 'panda', 'falcon', 'lynx', 'crane', 'koi', 'raven', 'tiger',
  'wren', 'ibex', 'lemur', 'bison', 'finch', 'heron', 'gecko', 'osprey',
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** A readable default name such as `calm-otter`. */
export function autoName() {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

/**
 * Turn user input into a valid name, or `null` when nothing usable is left.
 * Invalid runs collapse to a single `-` so `"Front End"` becomes `front-end`.
 */
export function normalizeName(value) {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/[._-]+$/, '');
  return slug || null;
}

/**
 * First free name: `base` when untaken, otherwise `base-2`, `base-3`, and so on.
 * The first claimant keeps the plain name; newcomers get the variant.
 */
export function uniqueName(base, taken = []) {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
