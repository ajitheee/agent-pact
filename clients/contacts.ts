// What worker agents deliver for the demo's "20 founder contacts" tasks.
// The people and companies are fictional, so no real person's details are invented.

const FIRST = ['Maya', 'Jonas', 'Priya', 'Tomas', 'Aisha', 'Lena', 'Marcus', 'Ines', 'Kenji', 'Sofia', 'Ravi', 'Clara', 'Diego', 'Nora', 'Felix', 'Amara', 'Oskar', 'Leila', 'Hugo', 'Zara'];
const LAST = ['Okafor', 'Lindqvist', 'Raman', 'Novak', 'Haddad', 'Moreau', 'Bennett', 'Castillo', 'Tanaka', 'Rossi', 'Iyer', 'Weber', 'Alvarez', 'Kowalski', 'Brandt', 'Mensah', 'Nyberg', 'Farahani', 'Laurent', 'Sato'];
const COMPANIES = ['tracewind', 'quillstack', 'loomforge', 'driftbase', 'ferrolabs', 'parcelcore', 'kiteshell', 'emberlane', 'nimbusworks', 'glyphwise', 'harborci', 'tallyhq', 'oakpipe', 'vectorly', 'mintgrid', 'relaydock', 'patchwell', 'saltbox', 'cinderly', 'brightfork'];
const TLDS = ['dev', 'io', 'com', 'ai'];

/** n plausible contacts: full names, matching work addresses, one per company. */
export function contacts(n = 20) {
  return Array.from({ length: n }, (_, i) => {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    const domain = `${COMPANIES[i % COMPANIES.length]}.${TLDS[i % TLDS.length]}`;
    return { name: `${first} ${last}`, email: `${first}.${last}@${domain}`.toLowerCase() };
  });
}

/** The failure beat: real-looking names, but personal free-mail addresses instead of work ones. */
export function garbage(n = 20) {
  return contacts(n).map(({ name }) => ({ name, email: `${name.replace(' ', '.')}@gmail.com`.toLowerCase() }));
}

/**
 * A payload for any verifier. Contact-shaped tasks (an email field in a JSON Schema, or a Python
 * check, which can't be introspected) get contacts(); other schemas get a value built from the schema.
 */
export function deliverable(verifier: { type: string; schema?: any }): unknown {
  if (verifier.type !== 'json_schema') return contacts();
  const schema = verifier.schema;
  if (schema?.type === 'array' && schema.items?.properties?.email) return contacts(Math.max(schema.minItems ?? 20, 1));
  return fromSchema(schema);
}

function fromSchema(s: any, key = 'item'): unknown {
  if (s?.enum) return s.enum[0];
  switch (s?.type) {
    case 'array':
      return Array.from({ length: Math.max(s.minItems ?? 1, 1) }, () => fromSchema(s.items ?? {}, key));
    case 'object': {
      const props = s.properties ?? {};
      const keys = new Set([...(s.required ?? []), ...Object.keys(props)]);
      return Object.fromEntries([...keys].map((k) => [k, fromSchema(props[k] ?? { type: 'string' }, k)]));
    }
    case 'integer':
    case 'number':
      return s.minimum ?? 1;
    case 'boolean':
      return true;
    default:
      if (s?.format === 'email' || key === 'email') return contacts(1)[0].email;
      if (s?.format === 'uri' || s?.format === 'url') return 'https://tracewind.dev';
      if (s?.format === 'date-time') return new Date().toISOString();
      return key;
  }
}
