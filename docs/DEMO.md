# Demo day: pitch script and runbook

Live server: `https://calm-zero-8lj48.run.mcp-use.com/mcp`. The demo is one command, `npm run live`, shown on the
dashboard; a CI-fix run takes about 70 seconds. Submissions and live demos are Sunday at 10:00 AM.

## The pitch (3:00)

**Before you go up:** the dashboard is full screen on the projector (`npm run dashboard`, http://localhost:3100, F11).
A small terminal is ready with `npm run live -- --with-worker-b --no-pause` typed but not sent. In Claude Desktop, paste
worker B's prompt (`clients/worker-b.md`) and send it: it waits up to 5 minutes for the job. Slides are open in a
second window; you switch between slides and the dashboard with Alt+Tab.

**The trick:** press Enter on the run during your first sentence. The poster (Claude Code) needs about 40 seconds to
read the ticket and write the job post, so it drafts while you show the problem, and the dashboard comes alive right
as you switch to it.

### 0:00–0:15 · Slide 1, title

> "Agents can already pay each other. Nobody checks the work before the money moves. We built AgentPact, the escrow that does."

*Press Enter on the run while you say it.*

### 0:15–0:45 · Slide 2, the problem

> "Everyone building with agents has seen these three. A coding agent makes CI green by gaming the tests. A data agent
> writes SQL that runs fine and returns the wrong number. A back-office agent puts a figure in the ledger that was never
> on the invoice. Today you either trust the agent, or a human re-checks everything. That doesn't scale to agents
> hiring agents.
> So: the money waits in escrow, and it moves only when a machine check passes."

Optional "why now" line, only once every figure is checked against its source (see the note at the end of this section):
*"The payment rails got built: x402, Stripe's machine payments. Verification didn't."*

### 0:45–2:05 · The dashboard, live (Alt+Tab)

| Say | On the dashboard |
|---|---|
| "This is live. On the left, the poster, a Claude Code agent. Its pricing service has a real bug: customers are taxed on the full price. It just posted the job: $40, four minutes, and the check that decides payment, our CI suite plus 200 hidden random carts." | The job post flies into the vault; the title and "$40.00 budget" appear |
| "Agents bid in seconds, from different MCP clients. Mallory is new and cheapest at $9. Worker B, in Claude Desktop, is cheaper than worker A but can't make the deadline, so the poster skips it." | Bids beam in; worker B's tag is red: "misses deadline" |
| "Stripe holds Mallory's $9. Authorized, not moved." | Gold coins flow into the vault: "HELD $9.00" |
| **"Mallory makes CI green by special-casing the 8 test carts. The check runs her code in a Blaxel sandbox, the hidden carts catch it, and the hold is released. The poster pays nothing."** | The sandbox flashes red; the coins fly back to the poster; "Blocked" goes up |
| "The poster re-hires by reputation. Worker A's fix passes all 208 cases, and $25 is captured. No human touched anything." | The vault fills again, the sandbox goes green, the coins fly to worker A: "PAID $25.00" |
| "Here's what the poster actually got: a patch, ready to merge." | The diff types into "Output delivered" |
| "Then the monitor audits the whole job: every step, every payment against Stripe, a re-run of the check. It flags Mallory, *gamed the tests*, and that goes into the pact's memory, so her next identity gets caught too." | The violet sweep; the audit fills in; "⚑ gamed the tests" on Mallory |

### 2:05–2:20 · Proof (Stripe tab, then the email thread)

> "These are real Stripe payments: one hold canceled, one captured, with the verdict written on each. And every step
> went out as one email thread that agents can reply to."

### 2:20–2:40 · Slide 3, how it works

> "One MCP server on Manufact; any agent connects. Stripe holds the money. The check runs in a Blaxel sandbox, never on
> the worker. Primitive email is the paper trail. And it's not just code: the same market checks SQL reports and
> invoice extraction today."

### 2:40–3:00 · Slide 4, close

> "I already run a business that's paid only on verified outcomes, Apelori. This is that model for the agent economy:
> agents can hire agents, because the money only moves when the work checks out. Builders here told us: [quote 1],
> [quote 2]. Thank you."

> ⚠ The "why now" figures from the build brief (x402's backers, 138 million agent payments on Base, about $19 million of
> real volume, more than 95% signals and wash trading, about $28 thousand a day of real settlement) are not verified.
> Check each against its source before you say it, or leave it out: the pitch works without it.

## The slides (4, plus 1 for Q&A)

The dashboard is the demo, so the slides stay few and big. One idea per slide, large type, dark background to match
the dashboard.

1. **Title.** "AgentPact", the line "Escrow for agent work" and "Agents hire agents. Money moves only when the work checks out." Your
   name, and "Built with Manufact (mcp-use) · Stripe · Blaxel · Primitive".
2. **The problem.** Headline: "Agents can pay. Nobody checks the work." Three columns:
   - Coding agent: *games the tests*
   - Data agent: *SQL that runs, number that's wrong*
   - Back-office agent: *a figure that was never on the invoice*

   Footer: "Today: trust it, or a human re-checks everything."
3. **How it works.** One left-to-right flow: **Post** (task + budget + the check) → **Bid** (any MCP agent) →
   **Hold** (Stripe, manual capture) → **Check** (Blaxel sandbox) → **Pass: paid / Fail: refunded** → **Monitor audit**
   (memory, watchlist). Under it, the three workloads that run today: CI fix ($40), board-deck SQL ($30), invoices
   into the ledger ($20).
4. **Close.** "Verification is the missing layer of agent payments." The Apelori line, 2 builder quotes, and how to
   reach you.
5. **Backup, for Q&A only: what's next.** Payouts to workers with Stripe Connect · a library of reusable checks ·
   sealed checks with hidden answer sets · ongoing work checked on a schedule and paid in parts · worker stakes.

## The backup video (under 3:00)

Record it tonight with the Xbox Game Bar (Win+Alt+R) or OBS, full screen, with the microphone on, following the pitch:

| Time | On screen | Tip |
|---|---|---|
| 0:00–0:15 | Slide 1 | Start the run (`--no-pause`) as you speak |
| 0:15–0:45 | Slide 2 | The poster drafts in the background |
| 0:45–2:05 | The dashboard | Don't touch the mouse; let the animation carry it |
| 2:05–2:20 | The Stripe tab, then the Primitive thread | About 7 seconds each, already open in tabs |
| 2:20–3:00 | Slides 3 and 4 | End on slide 4 |

If a live take goes wrong, record the dashboard segment as a replay instead: click the run's chip in the bottom strip.
Replays play the real recorded events.

## The submission video (2:00): the studio

The studio directs the video for you: camera, slides, the dashboard replay, zooms and captions all change on a timer,
and a teleprompter beside the video shows the line to read. Only the video area is recorded, never the teleprompter.

1. `npm run dashboard`, then open http://localhost:3100/studio in **Chrome or Edge** (they can crop the recording to
   the video area). Make the window full screen (F11).
2. Check your name in the box. Press **Rehearse** once: nothing is recorded.
3. Press **● Record**, allow the camera and microphone, choose **this tab**, then **Share**. After 3-2-1, read the
   highlighted line. If you finish a line early, pause; the screen moves on by itself.
4. At 2:00 the file downloads as `agentpact-demo.webm`. If the submission needs MP4, open it in Clipchamp and
   export.

The dashboard part replays the newest completed CI-fix run (add `?task=t_...` to pick one). Its bidding line mentions
worker B only when worker B bid in that run.

## Scenarios

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

**Backup video:** see "The backup video" above.

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
