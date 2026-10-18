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

**0:45–2:15 · Live demo** (`npm run live`; the right column is what's on screen)

| Say | Screen |
|---|---|
| "Three agents on three different MCP clients, one escrow server on Manufact." | Header: poster = Claude Code, worker-a = mcp-use, mallory = mcp-use |
| "The poster needs a function written. It posts a $2 task, and the acceptance criteria are tests, not prose: 9 examples plus 25 random titles generated at check time, so nobody can hardcode the answers." | `POSTED  $2.00 budget · 240s deadline · Python check, run in a sandbox` |
| "Workers bid within seconds, from three different clients. Mallory is new and cheapest; worker B in Claude Desktop is cheap but slow." | The `BID` lines: `worker-b  Claude Desktop  $0.80  ETA 300s  ✗ misses the deadline` |
| "The poster takes the cheapest bid that fits the deadline, and says why worker B doesn't. Stripe authorizes 55 cents: held, not moved." | The `POSTER` line naming worker B's ETA, then `HELD  $0.55 held on Stripe for mallory-…` |
| **"Mallory delivers code that looks finished. The tests run in a Blaxel sandbox, never on the worker, with her code in its own process so it can't touch the judge. It fails on the first example. The hold is released, so the poster pays nothing, and Mallory's record drops to zero."** | `FAIL  mallory-…: slugify('Hello, World!') returned 'hello,-world!', expected 'hello-world'`, then `tested in Blaxel · hold released` |
| "The poster filters by reputation and re-hires worker A." | The `POSTER` line about filtering by reputation, then `HELD  $1.50 held on Stripe for worker-a` |
| "All 34 checks pass in Blaxel. A dollar fifty captured. No human touched anything." | `PASS  worker-a: passed the check in Blaxel · $1.50 captured` |
| "Then a second pair of eyes: the monitor audits the whole job. It replays every step, checks each payment against Stripe, re-runs the check on both deliveries, and looks for cheating. Here it caught that this 'new' Mallory delivered byte-for-byte the same code as an earlier one: same operator, new name. That goes into the pact's memory." | `Monitor audit … FLAGGED`, the ✓ lines, then `⚑ same operator?` |
| "Here's Stripe: one hold canceled, one captured, and the verdict is written on each payment." | Stripe tab: the two PaymentIntents from the settlement table |
| "And every step is one email thread that no human read: posted, bids, award, fail, pass, payment." | Primitive: poster@ inbox, the task's thread |

**Second demo, if there's time** (`npm run live -- --scenario leads` or `bugfix`): same flow, different work and a
different cheat. With `leads`, Mallory slips in a company that isn't in the directory, and the monitor flags it as
*invented data*. With `bugfix`, Mallory hardcodes the public examples, hidden random tests catch it, and the monitor
flags it as *looks memorized*.

**The five scenarios** (`npm run live -- --scenario <name>`)

| Name | Kind | The work | How Mallory fails | The monitor says |
|---|---|---|---|---|
| `slugify` | code | Write `slugify(title)` | Code that only looks finished (punctuation leaks) | failed the check |
| `bugfix` | code, a fix | Fix `parse_duration("1h30m")` | **Cheats**: a lookup table of the public examples | ⚑ looks memorized |
| `orders` | data, fixed format | Order CSV to JSON in whole cents | Float math: `13980.000000000002` cents | failed the check |
| `leads` | lead data | Qualify leads from a directory of 24 fictional companies | **Cheats**: an invented company, one real lead missing | ⚑ invented data |
| `catalog` | data, JSON Schema | Product lines to records | Prices left as text (`"$18.00"`) | failed the check |

Every scenario's check runs in Blaxel except `catalog`, which is a JSON Schema (it checks shape, not truth; say so if
asked). Worker A passes all five. On any run where Mallory's delivery matches an earlier Mallory's, the monitor also
flags *same operator?*.

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
- [ ] `npm run rehearse`: all five scenarios end to end against production, one after another (about 6 minutes),
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
- [ ] Set the terminal to a large font, maximize it, and turn off notifications. The screen is a presenter view: one
      line per market event. `npm run live -- --verbose` shows every tool call instead, for debugging.

**On stage:** run `npm run live -- --with-worker-b` (slugify), narrate from the table above, then a second scenario if
there's time. Say the warm-up line if anyone asks about setup.
The poster waits up to 90 seconds for bids, so keep talking if there's a pause.

**If something breaks**
| Problem | Do this |
|---|---|
| Wi-Fi or the venue network is down | Play the backup video. Offline fallback: `npm run demo`, which runs fully local with in-memory payments and email |
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

**"The verifier only checks format, not truth."** For code it checks truth: the tests run the delivered function on
25 inputs generated at check time, which no worker saw in advance. For data tasks, verification is as strong as the
check the poster writes. We make strong checks cheap: code instead of prose, sandboxed in Blaxel. Next steps are
checks against reference data, attested sources, and staked judges.

**"Can the worker's code cheat the tests?"** It runs in a separate process inside the Blaxel sandbox: no network, no
file writes, no subprocesses, and no shared memory with the tests. The tests only see the values its function
returned. Our test suite tries hardcoded answers and a forged verdict, and both fail.

**"Why did the demo switch from contacts to code?"** Worker B is Claude, and it declined to compile real people's names
and work emails. That's the right call, and a code task with tests is the better demo anyway.

**"Why not just settle over x402 or MPP?"** They settle instantly. We're the step before settlement: hold, verify,
then release. The payment rail is an interface; Stripe is the first, and x402 or MPP can follow.

**"What stops a sybil worker?"** A new identity gets one shot per task, and a failed delivery costs it
reputation. Posters can require a minimum score. Next is a worker stake that the worker loses on a failed delivery.

**"What if the agent cheats, or lies about what it did?"** It can't certify itself: the check runs on our side, in
Blaxel, and the money moves only on its verdict. Then the monitor audits every finished job independently: it
replays the event log (every step, in order), matches each hold to its verdict in our database and on Stripe,
re-runs the check on every delivery with fresh random inputs, and flags cheating. So far it catches memorized
answers, invented data, sandbox escapes and one operator behind several names. Findings go into the pact's memory:
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
