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

## 7. Persistence and usage (Week 3: not measured yet)

- Recovery time vs ops since the last snapshot: *pending*
- Sessions held and unique users: *pending (real usage only)*

---

## Draft resume lines

Each line uses only numbers from this file.

- Built an operational-transformation sync engine (TypeScript; insert/retain/delete ops, a central server ordering ops by revision) with no CRDT library. It is verified by 30,000 seeded randomized convergence tests on every run (300,000 in a soak run), all passing.
- On the deployed server (Render, Singapore), over a real ~90 ms network, two people typing at once lost 0 keystrokes vs 49% lost by a whole-file-rebroadcast baseline (the Code-Sync approach), using about 54× fewer bytes per keystroke (80.7 B vs 4,320 B on a 2 KB file).
- Served 200 concurrent bot editors in 50 rooms (about 1,290 ops/s) on one Node `ws` process at p95 op round-trip of 2.6–3.0 ms (localhost). On the deployed free instance, 40 editors saw p95 105 ms against a 98 ms network ping.
