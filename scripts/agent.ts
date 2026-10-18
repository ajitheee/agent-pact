// Register agents and mint bearer tokens, against DATABASE_URL (Supabase) or the local PGlite store.
//   npm run agent -- add <id> [--email a@b.primitive.email] [--stripe-account acct_…]
//   npm run agent -- list
// Local PGlite is single-process: stop `npm run dev` before running this against it.
import { parseArgs } from 'node:util';
import { addAgent, listAgents } from '../src/agents.js';
import { openDb } from '../src/db.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { email: { type: 'string' }, 'stripe-account': { type: 'string' } },
});
const [command, id] = positionals;
const db = await openDb();

try {
  if (command === 'add' && id) {
    const token = await addAgent(db, id, { email: values.email, stripeAccount: values['stripe-account'] });
    console.log(JSON.stringify({ agent_id: id, token, mcp_header: `Authorization: Bearer ${token}` }));
  } else if (command === 'list') {
    console.table(await listAgents(db));
  } else {
    console.error('usage: npm run agent -- add <id> [--email …] [--stripe-account acct_…] | list');
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
