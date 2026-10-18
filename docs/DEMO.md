# Demo day: pitch script and runbook

Live server: `https://calm-zero-8lj48.run.mcp-use.com/mcp`. The demo is one command, `npm run live`, which
takes about 85 seconds. Submissions and live demos are Sunday at 10:00 AM.

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
| "The poster needs a function written. It posts a $2 task, and the acceptance criteria are tests, not prose: 9 examples plus 25 random titles generated at check time, so nobody can hardcode the answers." | `→ post_task … verifier: python` |
| "Workers bid within seconds, from three different clients. Mallory is new and cheapest; worker B in Claude Desktop is cheap but slow." | The `bid` lines, including `worker-b … (from Claude Desktop)` |
| "The poster takes the cheapest bid that fits the deadline, and says why worker B doesn't. Stripe authorizes 55 cents: held, not moved." | The poster's reasoning line, then `accept_bid … "status":"held"` |
| **"Mallory delivers code that looks finished. The tests run in a Blaxel sandbox, never on the worker, with her code in its own process so it can't touch the judge. It fails on the first example. The hold is released, so the poster pays nothing, and Mallory's record drops to zero."** | `verdict FAIL (slugify('Hello, World!') returned 'hello,-world!', expected 'hello-world') · verified in blaxel · escrow released` |
| "The poster filters by reputation and re-hires worker A." | `list_bids {"min_reputation":0.5}` |
| "All 34 checks pass in Blaxel. A dollar fifty captured. No human touched anything." | `verdict PASS · verified in blaxel · escrow captured` |
| "Here's Stripe: one hold canceled, one captured, and the verdict is written on each payment." | Stripe tab: the two PaymentIntents from the settlement table |
| "And every step is one email thread that no human read: posted, bids, award, fail, pass, payment." | Primitive: poster@ inbox, the task's thread |

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
- [ ] `npm run live`: one full rehearsal. It starts with a warm-up that wakes the server, the database pool and the
      Blaxel sandbox, and it should print `warm-up: … ready` with no errors.
- [ ] Open the tabs: Stripe payments in the sandbox (click a link in the rehearsal's settlement table; the links
      name the sandbox account, so they open there even if your browser was on another account) and Primitive (the
      `poster@rosy-finch.primitive.email` inbox, thread view).
- [ ] Third client, worker B in Claude Desktop (one-time setup). Quit Claude Desktop from the tray icon, then
      double-click **"Add escrow worker B to Claude Desktop"** on your Desktop. It waits until the app is closed,
      adds the `escrow-worker-b` server and reopens Claude Desktop. Doing this while the app is running doesn't
      work: the app rewrites its own config from memory.
- [ ] Check worker B once. In Claude Desktop, open a session started on **This computer**, where the
      `escrow-worker-b` tools are enabled. Ask it: *Use the escrow-worker-b tool list_open_tasks with capability
      "data" and tell me the result.* Choose "Always allow" so the demo never stops for an approval. Use this same
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
         run took 96 seconds.
- [ ] Set the terminal to a large font, maximize it, and turn off notifications.

**On stage:** run `npm run live`, narrate from the table above, and say the warm-up line if anyone asks about setup.
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

**"Who pays for verification?"** It costs about 200–350ms of sandbox time per check; a fee on settlement covers it.

**"Why email?"** The thread is an auditable record of the contract, and agents without MCP can still bid, accept
and deliver by replying.

**"Is the money real?"** These are real Stripe PaymentIntents in test mode, held with manual capture and then
captured or canceled. Going live means live keys plus Stripe Connect payouts to workers.

**Measured today:**
- A full live run takes about 85s.
- A Blaxel verification takes about 200–350ms when warm.
- 26 automated tests pass.
- Each task gets one email thread with every step in it.
