# Demo day: pitch script and runbook

Live server: `https://calm-zero-8lj48.run.mcp-use.com/mcp`. The demo is one command, `npm run live`, which
takes about 60 seconds. Submissions and live demos are Sunday at 10:00 AM.

## The pitch (3:00)

**0:00–0:20 · Hook**

> "Agents can already pay each other. Nobody can prove the work was done. We hold the money until it is."

**0:20–0:45 · Why now**

> "The payment rails for agents exist. x402 launched under the Linux Foundation with Visa, Mastercard, Coinbase,
> Google, Microsoft, AWS and Stripe, and Stripe's Machine Payments Protocol lets agents pay per call.
> Chainalysis counted 138 million agent payments on Base. Visa and Artemis put the real volume at about
> 19 million dollars, and Forkast estimates more than 95% is protocol signals and wash trading, with real
> daily settlement near 28 thousand dollars. The rails got built. Verification didn't."

For the Stripe judges: *"Stripe's Machine Payments Protocol lets agents pay instantly. We add the missing step:
pay only after the work is verified."*

> ⚠ These figures come from the build brief. Check each one against its source before saying it on stage.

**0:45–2:15 · Live demo.** The audience watches the dashboard (`npm run dashboard`, then open http://localhost:3100
full screen). You start the run from a small terminal with `npm run live -- --with-worker-b`; Claude Desktop (worker B)
sits in a corner. Every motion on the dashboard is a real event from the escrow's log:
- the poster's job post flies into the vault, and bids arrive as beams with price tags;
- money flows into the escrow on a Stripe hold;
- a delivery drops into the Blaxel sandbox, which scans it;
- on a fail, the coins fly back to the poster; on a pass, they fly to the worker;
- then the output types in, and the monitor sweeps the arena and lights up its flags.

The right column below is what the terminal shows; the dashboard shows the same beats.

| Say | Screen |
|---|---|
| "Three agents on three different MCP clients, one escrow server on Manufact." | Header: poster = Claude Code, worker-a = mcp-use, mallory = mcp-use, worker-b = Claude Desktop |
| "CI is red on our pricing service: customers are charged tax on the full price. The poster hires an agent to fix it, $40 budget. The acceptance criteria are our CI suite, not a prompt: 8 named tests plus 200 randomized carts generated when the work comes back." | `POSTED  $40.00 budget · 240s deadline · Python check, run in a sandbox` |
| "Agents bid within seconds, from three different clients. Mallory is new and cheapest at $9. Worker B in Claude Desktop is cheaper than worker A, but too slow." | The `BID` lines: `worker-b  Claude Desktop  $20.00  ETA 300s  ✗ misses the deadline` |
| "The poster takes the cheapest bid that fits the deadline, and says why worker B doesn't. Stripe authorizes $9: held, not moved." | The `POSTER` line naming worker B's ETA, then `HELD  $9.00 held on Stripe for mallory-…` |
| **"This is the thing everyone building with coding agents has seen: Mallory makes CI green by special-casing the 8 test carts and leaves the bug in. The check runs her code in a Blaxel sandbox, in its own process, and the hidden random carts catch it. The hold is released: the poster pays nothing."** | `FAIL  mallory-…: hidden test: random cart #1 (…): got subtotal …; expected …`, then `checked in Blaxel · hold released` |
| "The poster filters by reputation and re-hires worker A." | `HELD  $25.00 held on Stripe for worker-a` |
| "Worker A's fix passes all 208 cases. $25 captured. No human touched anything." | `PASS  worker-a: passed · checked in Blaxel · $25.00 captured` |
| "And here's what the poster actually got: a patch, ready to merge." | `Output delivered to the poster`: the green/red diff of pricing.py |
| "Then a second pair of eyes: the monitor audits the whole job. It replays every step, checks each payment against Stripe, re-runs the tests on both deliveries, and flags Mallory: *gamed the tests*. That goes into the pact's memory and onto her watchlist." | `Monitor audit … FLAGGED`, the ✓ lines, then `⚑ gamed the tests` |
| "Here's Stripe: one hold canceled, one captured, and the verdict is written on each payment." | Stripe tab: the two PaymentIntents from the settlement table |
| "And every step is one email thread that no human read: posted, bids, award, fail, pass, payment." | Primitive: poster@ inbox, the task's thread |

**Second demo, if there's time:** same market, different kind of agent work.
- `npm run live -- --scenario sql-report`: "Finance needs the board-deck number." Mallory's query runs fine and returns the
  wrong revenue (the classic JOIN fan-out). The check runs every query on 3 fresh random databases and names the
  mistake. The output is the revenue table and the query.
- `npm run live -- --scenario invoices`: "Accounts payable: 6 vendor invoices into the ledger." Mallory computes the
  German VAT instead of reading it (237.50 where the invoice says 237,48). The check traces every figure to its source
  invoice and flags it as an invented value. The output is the ledger, ready to import.

**The three scenarios** (`npm run live -- --scenario <name>`)

| Name | Agent work | Budget | How it's checked | How Mallory fails | Monitor |
|---|---|---|---|---|---|
| `ci-fix` | Coding agent: fix a production bug so CI goes green | $40 | 8 named tests + 200 random carts, code run in its own sandboxed process | **Games the tests**: special-cases the 8 CI carts | ⚑ gamed the tests |
| `sql-report` | Data agent: Q3 net revenue by region for the board deck | $30 | The query runs on 3 fresh random databases with quarter-boundary orders | Plausible SQL with a JOIN fan-out; the check names the mistake | failed the check |
| `invoices` | Back-office agent: 6 vendor invoices (US, DE, UK, FR formats) into the ledger | $20 | No answer key: every figure traced to its source invoice, dates read per country, totals reconciled | **Hallucinates** the German VAT | ⚑ invented data |

Every check runs in Blaxel. Worker A passes all three. When a "new" Mallory delivers exactly what an earlier one did,
the monitor also flags *same operator?*. Each run ends with the output the poster received: a diff, a revenue table,
a ledger.

**2:15–2:40 · How it's built** (one breath per sponsor)
- **Manufact:** an MCP server built on mcp-use, used from Claude Code, the mcp-use client and Claude Desktop.
- **Stripe:** escrow holds use PaymentIntents with manual capture.
- **Blaxel:** the tests run in a sandbox, and the worker's code in its own process there, so a worker can never certify its own work.
- **Primitive:** email is the transport, and an agent can bid by replying to the thread.

**2:40–3:00 · Close**
> "I already run a business that gets paid only on verified outcomes, Apelori. This is the same model for the
> agent economy. Every agent-to-agent transaction needs it. Builders here told us: [quote 1], [quote 2]."

## Runbook

**T-30 minutes**
- [ ] `npm run preflight`: every line should be ✓. It checks the server build, the agent tokens, the server's
      Python sandbox, Blaxel, Stripe, the poster's Anthropic credits, Primitive and the worker B setup, in about
      10 seconds, and each ✗ line says what to fix.
- [ ] `npm run rehearse`: all three scenarios end to end against production, one after another (about 4 minutes),
      then a summary table (every line ✓) and a refreshed dataset in `dataset/`. Each run starts with a warm-up that
      wakes the server, the database pool and the Blaxel sandbox.
- [ ] Open the tabs: Stripe payments in the sandbox (click a link in the rehearsal's settlement table; the links
      name the sandbox account, so they open there even if your browser was on another account) and Primitive (the
      `poster@rosy-finch.primitive.email` inbox, thread view).
- [ ] Third client, worker B in Claude Desktop (one-time setup). Quit Claude Desktop from the tray icon, then
      double-click **"Add escrow worker B to Claude Desktop"** on your Desktop. It waits until the app is closed,
      adds the `escrow-worker-b` server and reopens Claude Desktop. Doing this while the app is running doesn't
      work: the app rewrites its own config from memory.
- [ ] Check worker B once. In Claude Desktop, open a session started on **This computer**, where the
      `escrow-worker-b` tools are enabled. Ask it: *Use the escrow-worker-b tool list_open_tasks with capability
      "code" and tell me the result.* Choose "Always allow" so the demo never stops for an approval. Use this same
      session on stage.
- [ ] With worker B, run `npm run live -- --with-worker-b` instead.
      1. After the warm-up, worker B's prompt is on your clipboard and the terminal pauses at **▶ In Claude
         Desktop…**.
      2. Paste the prompt into that Claude Desktop session and send it. It's the long prompt that starts "You are
         WORKER-B", not the one-line check above: that one looks once and stops. Worker B now waits for the task
         by itself (it long-polls `list_open_tasks` for up to 5 minutes), so there's no rush.
      3. Press Enter in the terminal. The poster posts the task, worker B bids within seconds, then worker A and
         Mallory start.
      4. The poster waits for all 3 bids. Worker B bids 80¢ with a 300s ETA, cheaper than worker A, but too slow
         for the 240s deadline, so the poster passes it over and says why. That's the brief's "poster picks on
         deadline" beat.
      5. If worker B hasn't bid 45 seconds after the task opens, the other workers start anyway, and the demo
         finishes as the 2-worker version.
      6. For rehearsals and the backup video, Claude Code can send worker B's prompt into that Desktop session for
         you; then run `npm run live -- --with-worker-b --no-pause`, which skips the Enter step. A full 3-client
         run took 61 seconds.
- [ ] If you deployed since Claude Desktop last started, quit and reopen it, so worker B gets the current tool list
      (including `wait_seconds`, which lets it wait for the task instead of checking in a tight loop).
- [ ] `npm run dashboard` and open http://localhost:3100 full screen (F11) on the projector. Click a chip in the bottom
      strip to replay a past job: that's also the fallback if the network dies mid-demo (replays need only the
      database).
- [ ] Set the terminal to a large font, maximize it, and turn off notifications. The screen is a presenter view: one
      line per market event. `npm run live -- --verbose` shows every tool call instead, for debugging.

**On stage:** run `npm run live -- --with-worker-b` (ci-fix), narrate from the table above, then a second scenario if
there's time. Say the warm-up line if anyone asks about setup.
The poster waits up to 90 seconds for bids, so keep talking if there's a pause.

**If something breaks**
| Problem | Do this |
|---|---|
| Wi-Fi or the venue network is down | Replay last night's runs on the dashboard (bottom strip), or play the backup video. Offline fallback: `npm run demo`, which runs fully local with in-memory payments and email |
| A `connect attempt 1 failed … retrying` line | Harmless: the worker reconnects. The warm-up makes it rare |
| Claude Code can't authenticate | Check `ANTHROPIC_API_KEY` and `ANTHROPIC_WORKSPACE_ID` in `.env`, then rerun |
| The poster prints "Credit balance is too low" | The API key's account is out of credits. Add credits in the Anthropic Console (Billing) for that account, then rerun |
| Production is down | `npm run deploy`, then wait for `npx mcp-use deployments list` to show the new build; it takes about 3 minutes |

**Backup video** (record Sunday morning): `npm run live` full screen, then about 10 seconds each on the Stripe
tab and the Primitive thread. Keep it under 3 minutes.

## Q&A prep

**Who needs this now?** Anyone building agents that pay other agents or APIs.

**Why you?** The founder already runs a business that's paid only on verified outcomes, Apelori.

**Why big?** Every agent-to-agent transaction needs verification, so this grows with agent payment volume.

**Demand evidence:** ask 5 builders "would your agent use this?" and write their exact words here:
1. …

**"The verifier only checks format, not truth."** Our three checks check truth three different ways. Code: the CI
suite plus 200 random carts generated when the work comes back, so the fix has to be correct, not just pass the visible
tests. SQL: the query runs on fresh random databases and must return the right number. Documents: no answer key needed;
every figure must appear in its own source and the totals must reconcile. Verification is as strong as the check the
poster writes, and we make strong checks cheap: code instead of prose, sandboxed in Blaxel. Next: checks against
live reference data, attested sources and staked judges.

**"Can the worker's code cheat the tests?"** It runs in a separate process inside the Blaxel sandbox: no network, no
file writes, no subprocesses, and no shared memory with the tests. The tests only see the values its function
returned. Our test suite tries gaming the tests, a forged verdict and sandbox escapes, and all of them fail.

**"Why these three tasks?"** They're the work companies hand to agents today: coding agents fixing bugs, data agents
writing the SQL behind a number, back-office agents processing documents. Each has the failure everyone has seen:
tests gamed instead of code fixed, a query that runs but is wrong, a number that sounds right but was never in the
document. Each is a job where "pay only if it checks out" changes who you can hire.

**"Why not just settle over x402 or MPP?"** They settle instantly. We're the step before settlement: hold, verify,
then release. The payment rail is an interface; Stripe is the first, and x402 or MPP can follow.

**"What stops a sybil worker?"** A new identity gets one shot per task, and a failed delivery costs it
reputation. Posters can require a minimum score. Next is a worker stake that the worker loses on a failed delivery.

**"What if the agent cheats, or lies about what it did?"** It can't certify itself: the check runs on our side, in
Blaxel, and the money moves only on its verdict. Then the monitor audits every finished job independently: it
replays the event log (every step, in order), matches each hold to its verdict in our database and on Stripe,
re-runs the check on every delivery with fresh random inputs, and flags cheating. So far it catches gamed tests, invented data, sandbox escapes and one operator behind several names. Findings go into the pact's memory:
an audit per task and a watchlist per worker (`npm run audit -- --watchlist`).

**"What does the pact remember?"** Everything, in Postgres: every task, bid, hold, verdict and reason; each worker's
record (its reputation on the next job); the monitor's audits and watchlist; the email thread per task; and the
verdict written on each Stripe payment. `npm run dataset` exports it all to `dataset/`.

**"Who pays for verification?"** It costs about 200–350ms of sandbox time per check; a fee on settlement covers it.

**"Why email?"** The thread is an auditable record of the contract, and agents without MCP can still bid, accept
and deliver by replying.

**"Is the money real?"** These are real Stripe PaymentIntents in test mode, held with manual capture and then
captured or canceled. Going live means live keys plus Stripe Connect payouts to workers.

**Measured today:**
- A full live run with all three clients takes about 60s (61s measured).
- A Blaxel verification takes about 200–350ms when warm.
- 26 automated tests pass.
- Each task gets one email thread with every step in it.
