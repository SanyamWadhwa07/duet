# Duet: build plan

Duet is a live collaborative coding-interview room. 2–4 people edit one file together in the browser (React + Monaco), run it against test cases in a sandbox, and replay the session keystroke by keystroke afterwards.

The parts that make it more than library glue are written here, not imported:

- **Sync:** my own operational transformation (OT) with a central server. No Yjs, ShareDB or Automerge.
- **Runner:** my own Docker sandbox fed by a Redis queue. No Judge0, Piston or JDoodle.
- **History:** my own append-only op log with snapshots, used for both replay and crash recovery.

Start date: 2026-11-04. Every number on the resume comes from `docs/METRICS.md`. Each entry there says how it was measured and what it was compared against.

---

## Week 1 (Nov 4–10): sync core

**Status (2026-11-04): done.** The exit test passes and the numbers are in `docs/METRICS.md` §1–4.

**Ship**
1. `packages/ot`: the operation type (retain / insert / delete), with `apply`, `compose` and `transform`; the client state machine (one op in flight, a buffer behind it); and the server document (orders ops, transforms them against history, acks the sender).
2. Randomized property tests, all seeded so any failure can be replayed:
   - transform convergence (TP1);
   - compose correctness;
   - full multi-client simulations with random message interleavings.
3. `packages/server`: Node + `ws`. Rooms of up to 4 people. Presence (join, leave, cursors) travels as separate ephemeral messages.
4. `packages/web`: React + Monaco. The binding turns Monaco changes into ops and applies remote ops back to Monaco as edits. Remote cursors are shown in each peer's colour.
5. **Naive baseline mode** (`DUET_SYNC=naive`). Every change sends the whole file, and the server relays it to the room, which is what Code-Sync's `FILE_UPDATED` handler does. It works in the browser too, so the difference can be shown live.
6. `packages/bench`: bot clients that drive the real `@duet/ot` client code. They give:
   - p95 op round-trip under load (N bots, M rooms);
   - bytes per keystroke and lost keystrokes, OT against naive.

**Exit test**
- `npm test`: every convergence property test passes.
- `npm run e2e`: two real browser tabs (headless Edge) type and delete concurrently at random positions in the same room. When they go quiet, both editors hold identical text.
- A manual check: two tabs typed by hand stay identical.

**Metrics recorded:** convergence test counts, p95 op round-trip, bytes per keystroke, and lost keystrokes against the naive baseline.

---

## Deploy the MVP (Nov 4, re-scoped)

Sanyam asked for the MVP live today, ahead of the original Week 3 deploy.

**What ships:** the Week 1 sync engine, rooms, presence, the Monaco UI, the naive-baseline flag and its measurements.

**Where:**
- the front end on Vercel;
- the WebSocket server on Render (Docker, free tier, Singapore);
- a second Render service in naive mode, so the baseline can be measured over a real network.

**Preparation:**
- server: `/health`, a heartbeat that drops dead sockets, empty-room eviction, and a room cap;
- front end: `VITE_WS_URL`, and a wake-up ping for sleeping free instances;
- config: Dockerfile, `render.yaml`, `vercel.json`, `.env.example` files and CI.

**Exit test:** two devices edit a room on the public URL and stay identical. The bots measure p95 round-trip, bytes per keystroke and lost keystrokes against the deployed OT and naive servers over the real network.

**Not today:** the runner needs a VM with Docker, so it gets its own deploy in Week 2. Postgres and replay stay in Week 3.

---

## Week 2 (Nov 11–17): sandboxed runner

**Ship**
1. `packages/runner`: a separate Node service. It pulls run requests from a Redis list, runs each one in Docker and publishes the result back.
2. Container limits:
   - `--network none` and `--read-only`, with a small `tmpfs` for `/tmp`;
   - `--pids-limit`, `--memory` (swap set equal, so no swap) and `--cpus`;
   - all capabilities dropped and `no-new-privileges`, running as a non-root user;
   - a wall-clock timeout that kills the container;
   - output capped in bytes.
3. A warm pool per language (C++, Python, JS). Containers are pre-started, used once and then thrown away, and the pool is refilled in the background. Single use means no state leaks from one run to the next.
4. Test cases per room. Results stream back into the room over the existing WebSocket.
5. A hostile-program suite: fork bomb, infinite loop, memory bomb, network call, file write. Each one must be contained, with the reason recorded.

**Exit test**
- Inside a room, pick a language, run code against the room's test cases, and every peer sees the result.
- `npm run hostile`: all five hostile programs are contained.

**Metrics recorded:** cold start vs warm-pool start (p50/p95), runs per second at a fixed worker count, and hostile-suite results.

**Before starting:** Docker Desktop must be running (`docker info`). Redis runs in Docker.

---

## Week 3 (Nov 18–24): history, replay, accounts, deploy

**Status (2026-11-04):** started early.
- **Done:** the Postgres op log, snapshots and crash recovery (tested); "Your rooms" per browser; Markdown problem upload; interviewer/candidate roles enforced on the server; named sessions; an example library; reconnect without losing or doubling an edit (tested); and the replay page (tested).
- **Next:** Google sign-in.

**Ship**
1. Postgres: an append-only `ops` table per room `(room_id, rev, client_id, op, created_at)`, plus a `snapshots` table holding the document every 200 ops.
2. Crash recovery: on start, a room loads its latest snapshot and replays the ops after it. Tested by killing the server mid-session.
3. Reconnect without losing edits. Each op carries a `(clientId, seq)` pair so the server can drop duplicates. A client that reconnects resends its unacked op, and the server catches it up. *Built without the `seq`: one connection per page makes the catch-up enough (DESIGN §15).*
4. A replay UI: a scrubber over the op log, played at 1×, 4× or 16×, with run events shown on the timeline. *Built (DESIGN §16), without run events: runs aren't logged yet.*
5. Google sign-in, plus interviewer and candidate roles (for example, only the interviewer edits test cases).
6. Move the server next to the runner on the VPS (Docker Compose, TLS), or keep it on Render, whichever the Week 2 runner deploy makes simpler. Then re-run the load test there.
7. Recruit real mock-interview pairs, and log the sessions held and unique users.

**Exit test**
- Kill the server mid-session, restart it, and the document is unchanged with no lost edits.
- A finished session replays to exactly the final text.
- The load test runs against the deployed VPS.

**Metrics recorded:**
- recovery time against op count since the last snapshot;
- storage per session;
- p95 on the VPS;
- sessions held and unique users (real numbers only).

---

## Optional, last, and only after the core works: AI debrief

A post-interview summary generated from the session's op log and run history. Every claim must cite timestamps from the log. If the debrief can't be grounded, it isn't shown.

## Rules this build follows

- References were studied (ot.js, avelin, corust, Code-Sync, piston, kira, pesto, isolate), but no code was copied and nothing was forked. If anything is adapted from an MIT-licensed source, its notice goes in and it is credited in the README.
- Commits carry their real dates. Nothing is pushed to GitHub without Sanyam's OK.
- Each milestone ends with an "explain it back" list in `docs/EXPLAIN-BACK.md`.
