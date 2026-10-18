import { createHash, randomBytes } from 'node:crypto';
import type { AgentRow, Queryable } from './db.js';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Register an agent and return its bearer token (shown once; only the hash is stored). */
export async function addAgent(db: Queryable, id: string, opts: { email?: string; stripeAccount?: string } = {}): Promise<string> {
  if (!/^[A-Za-z0-9._@+-]{2,80}$/.test(id)) throw new Error(`invalid agent id "${id}": use letters, digits, . _ @ + - (an email address works)`);
  const token = `agt_${randomBytes(24).toString('base64url')}`;
  await db.query('INSERT INTO agents (id, token_hash, email, stripe_account, created_at) VALUES ($1, $2, $3, $4, $5)', [
    id,
    hash(token),
    opts.email ?? null,
    opts.stripeAccount ?? null,
    Date.now(),
  ]);
  return token;
}

/** Register the agent, or give an existing one a fresh token (the old one stops working). */
export async function mintToken(db: Queryable, id: string, opts: { email?: string } = {}): Promise<string> {
  const [existing] = await db.query<{ id: string }>('SELECT id FROM agents WHERE id = $1', [id]);
  if (!existing) return addAgent(db, id, opts);
  const token = `agt_${randomBytes(24).toString('base64url')}`;
  await db.query('UPDATE agents SET token_hash = $1, email = COALESCE($2, email) WHERE id = $3', [hash(token), opts.email ?? null, id]);
  return token;
}

export async function agentForToken(db: Queryable, token: string): Promise<AgentRow | undefined> {
  const [agent] = await db.query<AgentRow>('SELECT * FROM agents WHERE token_hash = $1', [hash(token)]);
  return agent;
}

export function listAgents(db: Queryable) {
  return db.query('SELECT id, email, stripe_account, created_at FROM agents ORDER BY created_at');
}
