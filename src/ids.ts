import { randomBytes } from 'node:crypto';

// Short, unambiguous ids are cheaper for a model to read and copy back than UUIDs.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function newId(prefix: string, len = 8): string {
  let s = '';
  for (const b of randomBytes(len)) s += ALPHABET[b & 31];
  return `${prefix}_${s}`;
}
