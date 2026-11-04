# Metrics

Every number that may go on the resume is recorded here with its method, setup and baseline. The raw output of every benchmark run is in `bench/results/`, one JSON file per run.

**Machine (all Week 1 numbers):**
- Hardware: laptop with Intel i5-13500H (16 logical cores), 16 GB RAM.
- Software: Windows 11, Node 22.17.1.
- Conditions: not an isolated benchmark box. The Vite dev server, a browser and unrelated Node processes were also running.

**Code:** commit `24bf046`, measured 2026-11-04.

---

## 1. Convergence property tests

| Suite | TP1 cases | Compose cases | Multi-client simulations | Result | Time |
|---|---:|---:|---:|---|---|
| `npm test` (every run) | 10,000 | 10,000 | 10,000 | all pass | ~5 s |
| `OT_SCALE=10 npm test` (soak) | 100,000 | 100,000 | 100,000 | all pass | 71 s (run alongside other work) |

**What each case is** (`packages/ot/test/convergence.test.ts`):
- **TP1:** a random document (0–40 chars) and two random concurrent ops `a` and `b`. Checks `apply(apply(d, a), b') === apply(apply(d, b), a')`.
- **Compose:** random `a`, then random `b` on the result. Checks `apply(d, compose(a, b)) === apply(apply(d, a), b)`.
- **Simulation:**
  - Setup: one `ServerDoc` and 2–4 real `OTClient`s, joined by FIFO queues that behave like WebSockets (in order, but arbitrarily delayed).
  - Run: 20–139 random steps. A step is one of: a client edits, the server takes a client's next message, a client takes its next message from the server, or (3%) a new client joins mid-session.
  - Check: drain every queue, then every client must be synced and hold exactly the server's text.
- **Seeds:** random ops mix single keystrokes with multi-part edits (inserts, deletes, newlines). Every case uses seed 1…N of a mulberry32 PRNG, so a failure names the seed that reproduces it.

**Do the tests catch real bugs?** I broke the code three ways, ran a reduced suite each time, and every break was caught:

| Deliberate bug | Caught by |
|---|---|
| Server breaks insert ties the opposite way to the client | simulation, seed 1 (texts differ) |
| `transform` deletes text both sides already deleted | unit tests, transform cases |
| Client forgets to transform its buffered op | simulation, seed 1 (base length mismatch) |

## 2. Browser exit test (Week 1 exit criterion)

**Command:** `WEB_URL=http://localhost:5180 TABS=n SECONDS=s npm run e2e` (`packages/bench/src/e2e.ts`).

**Method:**
- Real headless Edge tabs, each in its own browser context, join one room.
- Every tab edits at the same time through Monaco's own commands, one edit every 10–40 ms. The mix is:
  - `type` of a random character (including `{`, `(` and newline, so auto-close and auto-indent fire);
  - `deleteLeft`;
  - 10% of edits with two cursors at once.
- When typing stops, every tab must have no unacked op and the same text as the server.

| Tabs | Seconds | Edits (total) | Server revisions | Final length | Result |
|---:|---:|---:|---:|---:|---|
| 2 | 10 | 695 | 625 | 416 | PASS |
| 4 | 20 | 2,430 | 2,043 | 1,423 | PASS |
| 2 | 10 | 689 | 637 | 424 | PASS |
| 2 | 10 | 706 | 672 | 408 | PASS |
| 3 | 15 | 1,513 | 1,281 | 893 | PASS |

**Revisions are lower than edits** because edits made while an op is in flight get composed into one op.

**Does the test catch real bugs?** With the sort removed from `changesToOp` (a real multi-cursor bug), the 2-tab run **FAILED**: the tabs ended at 18 and 28 characters and the server rejected the bad op.

**Live check (2026-11-04):** `npm run demo` ran against the deployed site. Two headless Edge windows typed real keystrokes into one room at the same time; at the end, both editors and the Render server held identical text (revision 220, 339 characters). The recording is `docs/demo.gif`.

**Manual check:** two tabs ("Asha" and "Ravi") typed by hand ended identical to the server (revision 4). Each tab showed the other's caret and selection in that peer's colour.

## 3. Op round-trip under load

**Command:** `WS_URL=ws://localhost:4100/ws ROOMS=M BOTS_PER_ROOM=4 SECONDS=60 npm run bench` (`packages/bench/src/bots.ts`).

**Method:**
- **Setup:** one server process. N bots in M rooms, 4 per room (the room limit). Each bot is a real `OTClient` over its own WebSocket. All bots run in one Node process on the same machine as the server.
- **Workload:** the room starts from a 2,000-char file. Every bot inserts one character at a random position every 75–225 ms (uniformly random, mean 150 ms, about 6.7 keys/s, a fast typist), and all bots in a room type at once.
- **Measurement:** round-trip is the time from sending an op to receiving its ack, timed in the bot with `performance.now()`. There is one sample per acked op. At this latency the ack always returns before the next keystroke, so ops = keystrokes.
- **Network:** localhost. The figure is server processing, queueing and loopback, not internet latency. Week 3 re-runs the test against the VPS.

| Bots × rooms | Ops (60 s) | Ops/s | p50 ms | p95 ms | p99 ms | max ms | Lost | Diverged rooms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 200 × 50 (run 1) | 77,534 | 1,292 | 0.95 | **2.74** | 4.56 | 15.01 | 0 | 0 |
| 200 × 50 (run 2) | 77,555 | 1,293 | 1.02 | **2.97** | 4.72 | 13.67 | 0 | 0 |
| 200 × 50 (run 3) | 77,595 | 1,293 | 0.97 | **2.64** | 4.21 | 9.42 | 0 | 0 |
| 400 × 100 | 156,417 | 2,607 | 1.59 | **4.88** | 8.94 | 26.09 | 0 | 0 |
| 2 × 1 (3 runs) | 385–389 each | ~13 | 0.55–0.90 | 1.20–1.77 | 1.49–2.85 | 1.64–11.85 | 0 | 0 |

**Note:** `botEventLoopLagP99Ms` in the JSON is about 17–25 ms in every run, even idle ones. That's Windows timer granularity, not saturation, so it shouldn't be quoted.

## 4. Bytes per keystroke and lost edits: OT vs naive baseline

**Baseline:**
- **What it reproduces.** Code-Sync's editor emits `FILE_UPDATED` with the whole file on every change, with no debounce (`client/src/components/editor/Editor.tsx`). Its server relays the message to the rest of the room (`server/src/server.ts`), checked at commit `6740054`.
- **How it runs here.** Duet's `DUET_SYNC=naive` reproduces that pattern on Duet's own transport (plain JSON over `ws`; socket.io's extra framing is not counted).
- **Client behaviour.** Bots in naive mode send their whole text after each keystroke and replace their text with whatever arrives.

**Commands:**
- OT: `WS_URL=ws://localhost:4100/ws ROOMS=1 BOTS_PER_ROOM=2 SECONDS=30 LATENCY_MS=L npm run bench`.
- Naive: the same with `WS_URL=ws://localhost:4101/ws`, a server started with `DUET_SYNC=naive`.

**Method:**
- **Workload:** 2 people in one room, both typing at once at random positions (the workload from section 3) for 30 s, starting from a 2,000-char file.
- **Lost keystrokes:** each bot types only its own letter (`A` or `B`), and the starter file is all lowercase. A lost keystroke is a typed letter missing from the server's final text.
- **Bytes:** the JSON payload of every message in both directions (client→server and server→client) during the typing window, divided by keystrokes. WebSocket frame headers (2–8 B per frame) and TCP/IP are not included. Presence (cursor) messages are excluded in both modes.
- **Diverged:** the two bots ended holding different text.
- **`LATENCY_MS`:** a one-way delay the bot adds to every message it sends and receives. 0 is raw localhost. 50 approximates users about 100 ms round-trip from the server.

| Mode | One-way delay | Runs | Keystrokes | Bytes/keystroke | Lost keystrokes | Runs where the two bots diverged |
|---|---:|---:|---:|---:|---:|---:|
| **OT** | 0 ms | 3 | 1,161 | **80.7** | **0 (0%)** | 0 / 3 |
| naive | 0 ms | 3 | 1,171 | 4,480–4,504 (mean 4,489) | 71 (6.1%) | 1 / 3 |
| **OT** | 50 ms | 3 | 1,152 | **80.5–80.6** | **0 (0%)** | 0 / 3 |
| naive | 50 ms | 3 | 1,152 | 4,290–4,296 (mean 4,293) | 648 (56.3%) | 3 / 3 |

**Reading it:**
- **Bytes.** At a 2–2.4 KB file, OT uses about **56× fewer bytes per keystroke** (80.7 vs 4,489). Naive bytes grow linearly with file size. OT bytes stay about constant, because only the digits of the retain counts grow.
- **Bigger rooms.** With 4 people a room, OT is 142 B/keystroke: one op up, one ack, three broadcasts (section 3 runs).
- **Lost keystrokes.** Naive mode loses keystrokes whenever two whole-file writes cross. Even on localhost it lost 6.1%. With 50 ms one-way delay it lost **56.3%**, and the two people ended up looking at different code in every run.
- **OT.** Lost **0 of 391,414 keystrokes** across every OT run in sections 3 and 4.
- **Fairness.** Both bots typing at the same time for 30 s is a worst case. In a real interview, one person types most of the time, so real-world loss will be lower than these figures.

## 5. Deployed servers over a real network (2026-11-04)

**Setup:**
- **Servers:** `duet-server` (OT) and `duet-server-naive` on Render's free tier (Docker, Singapore, 0.1 CPU and 512 MB each), deployed from commit `f638002`.
- **Bots:** run from the dev laptop over its normal internet connection, through Render's TLS proxy (`wss://…onrender.com/ws`). No simulated delay (`LATENCY_MS=0`).
- **Workload:** the same as sections 3 and 4.
- **Network baseline:** each run first times 20 WebSocket ping frames. Pings get answered without running any Duet code, so the gap between op round-trip and ping is the server's own share plus proxy noise.

**OT vs naive, 2 people, 30 s, 3 runs each:**

| Mode | Keystrokes | Ping p50 / p95 ms | Op round-trip p50 / p95 ms | Bytes/keystroke | Lost keystrokes | Runs that diverged |
|---|---:|---|---|---:|---:|---:|
| **OT** | 1,151 | 81.6–92.9 / 83.6–95.2 | 89.7–100.3 / 98.9–105.3 | **80.6–80.8** | **0 (0%)** | 0 / 3 |
| naive | 1,145 | 81.7–93.0 / 83.5–95.5 | (no acks in naive mode) | 4,313–4,325 (mean 4,320) | 564 (**49.3%**) | 2 / 3 |

Over a real ~90 ms network, the naive baseline lost **about half** of all keystrokes, and in 2 of 3 runs the two people ended with different code. OT lost none and used about **54× fewer bytes per keystroke**. An OT op's round-trip is the network ping plus about 1–8 ms at p50.

**Load on the free instance (OT, 4 bots per room, 60 s):**

| Bots × rooms | Ops/s offered | Ping p95 ms | Op p50 ms | Op p95 ms | Op p99 ms | Max ms | Lost | Diverged rooms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 40 × 10 | 264 | 97.7 | 94.6 | **105.2** | 112.5 | 315.9 | 0 | 0 |
| 100 × 25 | 661 | 97.8 | 101.1 | 177.8 | 352.4 | 8,839 | 0 | 0 |

- **40 bots:** the free instance adds single-digit milliseconds over the network at p95.
- **100 bots:** the 0.1-CPU instance saturates. The tail grows (p99 352 ms, one op took 8.8 s), but nothing was lost and no room diverged.
- **Composing.** Under that latency, keystrokes typed while an op is in flight get composed: 38,088 ops for 39,677 keystrokes, and 137.5 B/keystroke instead of 142.
- **What this measures.** These figures describe the free instance, not the code's ceiling. Section 3 measures the same code at 2,607 ops/s on a laptop core.

**OT across every run in sections 3–5:** 0 of 448,059 keystrokes lost.

## 6. Runner (Week 2: not measured yet)

- Cold start vs warm-pool start (p50/p95): *pending*
- Runs per second at a fixed worker count: *pending*
- Hostile-program suite (fork bomb, infinite loop, memory bomb, network call, file write): *pending*

## 7. Saved rooms: crash recovery and the cost of saving (2026-11-04)

**Setup:**
- Postgres 16 in Docker on the laptop (`postgres:16-alpine`), and the server with `DATABASE_URL` set.
- Code at the commits "server: save rooms to Postgres" and "bench: crash-recovery test".
- Snapshot every 200 ops.

**Crash recovery** (`npm run recovery`, `packages/bench/src/recovery.ts`):
- **Method:** two clients make N edits until all are acknowledged. The server process is then killed outright (SIGKILL, no shutdown code runs), started again, and a client rejoins.
- **Pass:** the room's text and revision are identical to before the crash.
- **Timing:** *reload + join* is from opening the socket to receiving the room. It covers loading the snapshot and the ops after it from Postgres, replaying them, and sending the room.

| Edits (mode) | Revision | Snapshot at | Ops replayed | Server start | Reload + join | Result |
|---|---:|---:|---:|---:|---:|---|
| 150 (both typing) | 38 | none | 38 | 590 ms | 28.3 ms | PASS |
| 450 (both typing) | 89 | none | 89 | 558 ms | 23.0 ms | PASS |
| 1,000 (both typing) | 188 | none | 188 | 529 ms | 23.8 ms | PASS |
| 199 (`EXACT=1`) | 199 | none | 199 | 703 ms | 38.0 ms | PASS |
| 200 (`EXACT=1`) | 200 | 200 | 0 | 835 ms | 24.8 ms | PASS |
| 399 (`EXACT=1`) | 399 | 200 | 199 | 529 ms | 29.6 ms | PASS |
| 1,000 (`EXACT=1`) | 1,000 | 1,000 | 0 | 580 ms | 37.9 ms | PASS |
| 1,199 (`EXACT=1`) | 1,199 | 1,000 | 199 | 732 ms | 33.4 ms | PASS |

**Reading the table:**
- With both clients typing at once, keystrokes typed while an op is in flight are composed. That's why 1,000 edits became 188 revisions.
- `EXACT=1` waits for each ack, so every keystroke is one revision. That lands on both sides of the snapshot boundary.
- Reload time didn't depend on how many ops were replayed (0 or 199). At this document size the snapshot interval bounds the worst case rather than changing the typical case.

**Full app check** (`brag-output/work/saved-room-check.mjs`, a one-off script, not in the repo):
1. A browser started a room, switched it to JavaScript and loaded the example.
2. The front page listed the room under "Your rooms" by its problem title.
3. The server was killed and restarted, and the room reopened.

The first run showed the problem, language and code restored but **the 4 test cases missing**. That was a race between two settings saves, fixed by queueing them (see DESIGN §11). After the fix, all 3 runs restored the problem, 4 tests, language and code.

**Cost of saving each edit before acknowledging it** (fresh server per run, 4 bots per room, 30 s; `bench/results/*-local-ot-*`):

| Server | Bots × rooms | Edits/s | p50 ms | p95 ms | p99 ms | Lost |
|---|---|---:|---:|---:|---:|---:|
| in memory, new code | 200 × 50 | ~1,300 | 1.00–1.35 | 2.25–8.77 | 3.17–16.18 | 0 |
| in memory, code before saving existed (b2bf7af) | 200 × 50 | ~1,300 | 1.29–1.54 | 8.74–12.97 | 17.26–224.23 | 0 |
| saving to Postgres | 40 × 10 | ~260 | 2.82 | 5.92 | 9.88 | 0 |
| saving to Postgres | 200 × 50 | ~1,300 | 9.77–124.3 | 133–380 | 203–816 | 0 |

- **The new queues add no measurable cost.** Old and new code alternated, each on a fresh server process. Run-to-run spread on this laptop this evening, with other programs running, was larger than any difference. The earlier §3 runs (p95 2.6–3.0 ms) were on a quieter machine.
- **Saving costs about 2–3 ms per edit at 40 editors.** At 200 editors the database's commit rate is the bottleneck. A pool of 10 connections instead of 5 didn't help (p95 194 ms, file `…mw27csnp`), so the pool went back to 5. Group commit is the known fix.
- **Discarded:** two earlier runs on a server that had been running for a long time and held about 250 large benchmark rooms in memory (p95 14.7–16.4 ms, files `…mw2741ng`, `…mw275lcs`). They measured garbage-collection pressure, not the code.
- **Losses:** none in any run (0 lost keystrokes, 0 diverged rooms).

## 8. Usage (not measured yet)

- Sessions held and unique users: *pending (real usage only)*

## 9. Reconnect: exactly once (2026-11-04)

**Property test** (`packages/ot/test/reconnect.test.ts`):

| Run | Runs | Result | Time |
|---|---:|---|---|
| `npm test` (every run) | 3,000 | all pass | 0.7–1.4 s |
| `OT_SCALE=10` (soak) | 30,000 | all pass | 8.4 s |

- **Setup:** one `ServerDoc` and 2–4 real `OTClient`s behind FIFO queues.
- **Run:** 40–199 random steps. A step is one of: a client types (online or not), the server takes a client's next op, a client takes its next message, a connection drops, or a dropped client reconnects.
- **What a drop does:** it loses every message in flight in both directions: ops on their way up, acks and ops on their way down. A send while offline is lost too.
- **Reconnect:** the client applies `since(revision)` with its own ops marked, then `resend()`.
- **Check:** each keystroke types a character nobody else typed. At the end every client is synced and equal to the server, and the server's characters are exactly the characters typed, each once.

**Mutation checks.** Each break below was caught:

| Deliberate bug | Property test | Browser test |
|---|---|---|
| The client applies its own committed op again (ignores `mine`) | seed 2: a character doubled | fails: stray `<` in the text |
| The client never resends after a catch-up | seed 1: a client never synced | fails: tabs never converge |
| The server still takes ops from a replaced connection | seed 1: op based on the wrong length | (server rule; the test models it) |

**Browser test** (`npm run reconnect`, `packages/bench/src/reconnect.ts`, headless Edge, local server with Postgres):
- **Setup:** tabs A and B share a room. B's WebSocket runs through a Playwright proxy (`routeWebSocket`) that can drop messages either way or cut the connection.
- **Cases:**
  1. *Lost ack:* B types while the server's replies are dropped, A types too, then the connection is cut.
  2. *Lost op:* B types while its messages are dropped, then the connection is cut.
  3. *Outage:* every connection attempt fails for 2.5 s while both tabs type.
- **Result:** all 3 pass. After each case both tabs and the server held the same text, with every marker typed exactly once and no other text. B stayed editable while offline and showed no lost-edits notice.

**Lost history** (one-off script, not in the repo): a server with no database was restarted, refilled to revision 8 while B was offline at revision 6, and then B rejoined. B's check found the catch-up didn't fit, B started over from the server's copy and showed the notice, and A, B and the server then agreed.

**Regression on the same code:**
- `npm run e2e` with 3 tabs for 10 s: 1,039 edits; all tabs identical to the server.
- `npm run recovery`: 450 edits, server killed and restarted, identical text and revision.
- Roles check: a candidate is still refused on the problem and tests, also after a restart.

**Wire cost:** op, ack and broadcast messages are unchanged, so the bytes per keystroke in §4 and §5 still hold. Only the join message grew: a client id and two revision numbers.

## 10. Replay (2026-11-05)

**Exit test** (`npm run e2e`, extended; local server with Postgres):
- **Session:** 3 tabs in headless Edge type and delete at random for 10 s, including two-cursor edits and auto-closed brackets.
- **Replay:** after the tabs converge, the replay page opens on the finished session (text rebuilt from the log), then plays every edit from the start at 16× (applied to the editor in small steps).
- **Check:** both the opening text and the played-back text must equal the server's final text.

| Run | Edits typed | Ops committed | Opened on final text | Played back to final text |
|---|---:|---:|---|---|
| 3 tabs, 10 s | 1,038 | 1,028 | yes | yes |

**Mutation check:** removing the replay editor's `\n` line-ending pin made the same test fail (opened: no, played: no).

**Session check** (one-off script; two people, an example problem, 213 code ops):
- The page opened on the final text.
- It played at 4× to the final text.
- Scrubbing to the middle and pressing End gave the final text again.
- An unknown room showed "wasn't saved".
- A raw client sending an op with `\r` was refused.

**Bugs these checks found before shipping:** both were line endings (DESIGN §16). The replay editor defaulted to `\r\n` on Windows, and `setValue('')` reset it again on "Play from the start".

---

## Resume lines (SDE resume v3.2, 2026-11-04)

These are the Duet bullets as they appear on the resume. Each number points to the section of this file that measured it.

1. "Built a live coding-interview room where 2–4 people edit one file, on its own operational-transformation sync engine (no CRDT library) that **30,000** randomized tests check on every push."
   - 30,000 = 10,000 TP1 + 10,000 compose + 10,000 simulations, run by `npm test` in CI on every push (§1, `.github/workflows/ci.yml`).
2. "Measured the live deploy against a whole-file re-broadcast baseline: with two people typing at once over a 90 ms network, re-broadcast lost **49%** of keystrokes and Duet lost **none**, while sending **54x** fewer bytes per keystroke."
   - §5, both servers deployed, 3 runs each. Ping p50 was 82–93 ms.
   - Lost keystrokes: re-broadcast lost 564 of 1,145 (49.3%); OT lost 0 of 1,151.
   - Bytes per keystroke: 4,320 vs 80.7, which is 53.5×.
3. "Load-tested the Node WebSocket server with 200 bot editors in 50 rooms (**1,300 edits/s** at p95 under 3 ms on a laptop) and deployed it in Docker on Render with a Vercel front end."
   - §3, 3 runs at 1,292–1,293 ops/s with p95 2.64–2.97 ms on localhost.

**Not on the resume until built and measured:** the sandboxed runner (cold vs warm start, hostile suite), replay, and Postgres recovery.
