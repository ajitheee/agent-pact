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
| "The poster needs data it can't produce. It posts a $2 task, and the acceptance criteria are code, not prose: 20 contacts with real names, matching work emails and distinct companies." | `→ post_task … verifier: python` |
| "Two workers bid within two seconds. Mallory is new and cheapest." | Both `bid` lines |
| "The poster takes the cheapest bid that fits the deadline. Stripe authorizes 55 cents: held, not moved." | `accept_bid … "status":"held"` |
| **"Mallory delivers junk. The verifier runs in a Blaxel sandbox, never on the worker, and fails it. The hold is released, so the poster pays nothing, and Mallory's record drops to zero."** | `verdict FAIL (gmail.com is free mail) · verified in blaxel · escrow released` |
| "The poster filters by reputation and re-hires worker A." | `list_bids {"min_reputation":0.5}` |
| "Verified in Blaxel. A dollar fifty captured. No human touched anything." | `verdict PASS · verified in blaxel · escrow captured` |
| "Here's Stripe: one hold canceled, one captured, and the verdict is written on each payment." | Stripe tab: the two PaymentIntents from the settlement table |
| "And every step is one email thread that no human read: posted, bids, award, fail, pass, payment." | Primitive: poster@ inbox, the task's thread |

**2:15–2:40 · How it's built** (one breath per sponsor)
- **Manufact:** an MCP server built on mcp-use, used from Claude Code, the mcp-use client and Claude Desktop.
- **Stripe:** escrow holds use PaymentIntents with manual capture.
- **Blaxel:** the verifier runs in a sandbox, so a worker can never certify its own work.
- **Primitive:** email is the transport, and an agent can bid by replying to the thread.

**2:40–3:00 · Close**
> "I already run a business that gets paid only on verified outcomes, Apelori. This is the same model for the
> agent economy. Every agent-to-agent transaction needs it. Builders here told us: [quote 1], [quote 2]."

## Runbook

**T-30 minutes**
- [ ] `npm run live`: one full rehearsal. It starts with a warm-up that wakes the server, the database pool and the
      Blaxel sandbox, and it should print `warm-up: … ready` with no errors.
- [ ] Open the tabs: Stripe test payments (https://dashboard.stripe.com/test/payments) and Primitive (the
      `poster@rosy-finch.primitive.email` inbox, thread view).
- [ ] Optional third client: restart Claude Desktop and paste `clients/worker-b.md` into a chat. Worker B bids
      80¢ with a 300s ETA, which doesn't fit the 240s deadline, so the poster passes it over for being too slow.
      That's the brief's "poster picks on deadline" beat.
- [ ] Set the terminal to a large font, maximize it, and turn off notifications.

**On stage:** run `npm run live`, narrate from the table above, and say the warm-up line if anyone asks about setup.
The poster waits up to 90 seconds for bids, so keep talking if there's a pause.

**If something breaks**
| Problem | Do this |
|---|---|
| Wi-Fi or the venue network is down | Play the backup video. Offline fallback: `npm run demo`, which runs fully local with in-memory payments and email |
| A `connect attempt 1 failed … retrying` line | Harmless: the worker reconnects. The warm-up makes it rare |
| Claude Code can't authenticate | Check `ANTHROPIC_API_KEY` and `ANTHROPIC_WORKSPACE_ID` in `.env`, then rerun |
| Production is down | `npm run deploy`, then wait for `npx mcp-use deployments list` to show the new build; it takes about 3 minutes |

**Backup video** (record Sunday morning): `npm run live` full screen, then about 10 seconds each on the Stripe
tab and the Primitive thread. Keep it under 3 minutes.

## Q&A prep

**Who needs this now?** Anyone building agents that pay other agents or APIs.

**Why you?** The founder already runs a business that's paid only on verified outcomes, Apelori.

**Why big?** Every agent-to-agent transaction needs verification, so this grows with agent payment volume.

**Demand evidence:** ask 5 builders "would your agent use this?" and write their exact words here:
1. …

**"The verifier only checks format, not truth."** True, and the poster in our demo says so itself. Verification is
as strong as the check the poster writes. We make strong checks cheap: code instead of prose, sandboxed in Blaxel.
Next steps are checks against reference data, attested sources, and staked judges.

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
- 20 automated tests pass.
- Each task gets one email thread with every step in it.
