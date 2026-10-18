# Agent Task Escrow: run dataset

Generated 2026-10-18T05:30:06.982Z from the production database by `npm run dataset`. One task per line in
[runs.jsonl](runs.jsonl): bids, escrow holds, verdicts and the monitor's audit. Stripe is in test mode.

## Totals

- **25 tasks** posted: 23 completed, 2 expired.
- **44 escrow holds**: 23 captured ($34.50 paid for work that passed), 21 released ($11.55 never paid for work that failed).
- **8 audited** by the monitor: 6 flagged, 2 clean.
- **6 cheat flags**: same operator? ×4, looks memorized ×1, invented data ×1.

## Runs by scenario

| Posted (UTC) | Scenario | Task | Status | Paid | Released | Monitor | Flags |
|---|---|---|---|---|---|---|---|
| 2026-10-17 23:39 | earlier | t_2etpz4bm | completed | worker-a $1.50 | - | not audited | - |
| 2026-10-18 00:02 | earlier | t_zrhyfr6m | completed | worker-a $1.50 | - | not audited | - |
| 2026-10-18 00:42 | earlier | t_1rfkf47p | completed | worker-a $1.50 | - | not audited | - |
| 2026-10-18 01:06 | earlier | t_z2m0ttwn | completed | worker-a $1.50 | mallory-75v4 $0.55 | not audited | - |
| 2026-10-18 01:24 | earlier | t_35nae48s | completed | worker-a $1.50 | mallory-rjqv $0.55 | not audited | - |
| 2026-10-18 01:46 | earlier | t_mjpddh48 | completed | worker-a $1.50 | mallory-r7yg $0.55 | not audited | - |
| 2026-10-18 02:14 | earlier | t_ram88329 | completed | worker-a $1.50 | mallory-amrk $0.55 | not audited | - |
| 2026-10-18 03:05 | earlier | t_tg0r2wp7 | completed | worker-a $1.50 | mallory-fywa $0.55 | not audited | - |
| 2026-10-18 03:29 | earlier | t_r1mx23py | expired | - | mallory-4tkh $0.55 | not audited | - |
| 2026-10-18 03:39 | earlier | t_8hr8ew6y | completed | worker-a $1.50 | mallory-x369 $0.55 | not audited | - |
| 2026-10-18 03:51 | earlier | t_2a6yx4bd | completed | worker-a $1.50 | mallory-m769 $0.55 | not audited | - |
| 2026-10-18 03:56 | earlier | t_edn1g6wh | completed | worker-a $1.50 | mallory-s23a $0.55 | not audited | - |
| 2026-10-18 04:10 | earlier | t_g2j9r1e9 | completed | worker-a $1.50 | mallory-ek5r $0.55 | not audited | - |
| 2026-10-18 04:17 | earlier | t_z2fg7g0x | completed | worker-a $1.50 | mallory-gp2n $0.55 | not audited | - |
| 2026-10-18 04:22 | earlier | t_7crh2efk | completed | worker-a $1.50 | mallory-15f6 $0.55 | not audited | - |
| 2026-10-18 04:30 | earlier | t_pd4rz4r0 | completed | worker-a $1.50 | mallory-2svh $0.55 | not audited | - |
| 2026-10-18 04:54 | earlier | t_h90p4tz9 | completed | worker-a $1.50 | mallory-4dwk $0.55 | flagged | mallory-4dwk: same operator? |
| 2026-10-18 05:22 | slugify | t_p37rjz84 | completed | worker-a $1.50 | mallory-3pc9 $0.55 | flagged | mallory-3pc9: same operator? |
| 2026-10-18 05:23 | bugfix | t_26edr7mz | completed | worker-a $1.50 | mallory-tb8j $0.55 | flagged | mallory-tb8j: looks memorized |
| 2026-10-18 05:24 | orders | t_4b4ymx2t | completed | worker-a $1.50 | mallory-3fex $0.55 | clean | - |
| 2026-10-18 05:25 | leads | t_sz4zmt0h | completed | worker-a $1.50 | mallory-wagc $0.55 | flagged | mallory-wagc: invented data |
| 2026-10-18 05:26 | catalog | t_cpbbcvjt | completed | worker-a $1.50 | mallory-pnj4 $0.55 | clean | - |
| 2026-10-18 05:28 | catalog | t_cbkmthaj | completed | worker-a $1.50 | mallory-m5cr $0.55 | flagged | mallory-m5cr: same operator? |
| 2026-10-18 05:29 | orders | t_jfbdzsnt | completed | worker-a $1.50 | mallory-w2bg $0.55 | flagged | mallory-w2bg: same operator? |

## Worker records (the reputation every poster sees)

| Worker | Passed / delivered |
|---|---|
| worker-a | 23/23 |
| mallory-15f6 | 0/1 |
| mallory-2svh | 0/1 |
| mallory-3fex | 0/1 |
| mallory-3pc9 | 0/1 |
| mallory-4dwk | 0/1 |
| mallory-4tkh | 0/1 |
| mallory-75v4 | 0/1 |
| mallory-amrk | 0/1 |
| mallory-ek5r | 0/1 |
| mallory-fywa | 0/1 |
| mallory-gp2n | 0/1 |
| mallory-m5cr | 0/1 |
| mallory-m769 | 0/1 |
| mallory-pnj4 | 0/1 |
| mallory-r7yg | 0/1 |
| mallory-rjqv | 0/1 |
| mallory-s23a | 0/1 |
| mallory-tb8j | 0/1 |
| mallory-w2bg | 0/1 |
| mallory-wagc | 0/1 |
| mallory-x369 | 0/1 |

## Watchlist (workers the monitor caught cheating)

- **mallory-3pc9**: same operator? on t_p37rjz84
- **mallory-4dwk**: same operator? on t_h90p4tz9
- **mallory-m5cr**: same operator? on t_cbkmthaj
- **mallory-tb8j**: looks memorized on t_26edr7mz
- **mallory-w2bg**: same operator? on t_jfbdzsnt
- **mallory-wagc**: invented data on t_sz4zmt0h
