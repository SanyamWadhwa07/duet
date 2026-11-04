# Explain it back

At the end of each milestone, answer these out loud without looking. Then check against the code. If you can't answer one, reread the file it points to before putting Duet on the resume.

---

## Week 1: sync core

**1. What is an operation in Duet? Give an example.**
A list of components that walks the *whole* document left to right. A positive number skips characters, a string inserts, a negative number deletes. On `"hello world"`, `[6, -5, "there"]` gives `"hello there"`.
*Code:* `packages/ot/src/operation.ts`, the top comment and `apply`.

**2. Why must an op cover the whole document?**
So `apply` can check that the op's base length equals the document length. If a client has drifted out of sync, its next op fails that check, and the server rejects it instead of corrupting the room.

**3. What does `transform(a, b)` return, and what property must it satisfy?**
It returns `[a', b']`, the versions of each op that apply *after* the other one has happened. The property is TP1: `apply(apply(d, a), b') === apply(apply(d, b), a')`. Both orders reach the same text.

**4. Asha and Ravi both insert at position 5 at the same moment. Whose text comes first, and why do both screens agree?**
The first argument of `transform` wins the tie. The client calls `transform(myPendingOp, serverOp)` and the server calls `transform(incomingClientOp, committedOp)`, so it's client op first on both sides. Same function, same order, same answer.
*Code:* `packages/ot/src/server.ts`, the comment in `receive`.

**5. Walk through one keystroke from Ravi's keyboard to Asha's screen.**
1. Monaco fires a change event, and `changesToOp` turns it into an op.
2. `OTClient.local` sends it with Ravi's revision, if nothing else is in flight.
3. The server transforms it past any ops committed since that revision, applies it, appends it to history, acks Ravi and broadcasts the committed op.
4. Asha's `OTClient.remote` transforms it past her own pending edits.
5. `applyRemote` turns it into Monaco edits.

**6. Why does a client keep only one op in flight?**
- **Bounded state.** The client only ever transforms incoming ops past two things: the in-flight op and the buffer.
- **The server's view stays simple.** Each client is "at revision r, plus one op".
- **Flow control.** On a slow link, keystrokes compose into the buffer and go out as one op when the ack arrives.

*Code:* `packages/ot/src/client.ts`.

**7. What does `compose` do, and where is it used?**
It merges "a then b" into one op with the same effect. The client uses it to fold new keystrokes into the buffer while an op is in flight.

**8. Why OT and not a CRDT like Yjs?**
- The server exists anyway (rooms, auth, runner, op log).
- OT ops are tiny and index-based.
- The server's history is already the op log I need for replay.
- CRDTs win for offline and peer-to-peer, which an interview room doesn't need.

The cost: no offline editing, and transform functions are easy to get wrong, which is why the property tests exist. *Doc:* `docs/DESIGN.md` §1.

**9. Why does a central server make OT easier?**
The server decides one order for every op, so the only property needed is TP1. Peer-to-peer OT also needs TP2 (agreement when transforming against sequences in any order). TP2 is hard, and several published algorithms got it wrong. *Doc:* `docs/DESIGN.md` §2.

**10. How do you know your OT is correct?**
- **Three seeded property tests:** TP1, compose, and a full simulation with 2–4 clients, random edits, random message timing and late joiners. Any failure prints a seed that replays it.
- **Mutation checks.** I broke the code three ways and each was caught: the server's tie-break flipped, deletes applied twice, and the client skipping the buffer transform.
- **A browser test.** The e2e test runs real tabs in Edge, typing concurrently through Monaco.

*Counts:* `docs/METRICS.md`.

**11. How do remote cursors stay on the right character while text moves?**
Each client stores remote cursors as offsets in its own copy. Every op it applies (local or remote) moves them with `transformIndex`: an insert before a cursor pushes it right, and a delete before it pulls it left. Cursors are ephemeral messages, not ops, so a cursor can be a few characters off for a moment under heavy concurrent typing, until that peer's next cursor message.

**12. How does the Monaco binding avoid echoing remote edits back to the server?**
While applying a remote op, the session sets `applyingRemote = true`, and the change handler ignores events during that window. Remote ops are applied with `model.applyEdits` in one batch, with every range computed against the text before the batch.
*Code:* `packages/web/src/session.ts`, `applyRemote` and `withRemote`.

**13. A multi-cursor edit produces one Monaco event with several changes. How do you turn that into one op?**
All the ranges in one event refer to the text *before* the event. Sort the changes by offset, then walk left to right: retain up to each change, insert its text, delete its old range. Finish by retaining the rest. The e2e test caught a version without the sort (the tabs diverged).

**14. What is the naive baseline, and what did you measure against it?**
`DUET_SYNC=naive` sends the whole file on every change, and the server relays it, as Code-Sync's `FILE_UPDATED` handler does. I measured bytes per keystroke and how many keystrokes survive when two people type at once. *Numbers and method:* `docs/METRICS.md`.

**15. What breaks first at 10× or 100× the rooms, and what would you do?**
- One Node process holds every room in memory. History grows with every op, and transform work lands on one event loop.
- The fix is to hash room IDs to server nodes, so all members of a room reach the same process and OT keeps one owner per room.
- After that, Postgres takes over history (Week 3), so memory only holds what's recent.

**16. What are the known gaps after Week 1?**
- Undo is Monaco's local undo and isn't transform-aware.
- A reconnect drops unacked edits.
- Nothing is persisted. Rooms live in memory.

All three are written down in `docs/DESIGN.md` §9, and the last two are scheduled for Week 3.

---

## Deploy MVP (Nov 4)

**1. Why isn't the WebSocket server on Vercel with the front end?**
Vercel runs short-lived functions. A Duet room needs one long-running process that keeps every member's socket open and the document in memory. Render runs the Dockerfile as an ordinary always-on process. *Doc:* `docs/DESIGN.md` §12.

**2. How does the front end on Vercel know where the server is?**
`VITE_WS_URL` is set in Vercel's environment variables, and Vite bakes it into the bundle at build time. Changing it means rebuilding. In development it's empty, and the app uses same-origin `/ws`, which Vite proxies to the local server. *Code:* `packages/web/src/session.ts`, top.

**3. What does `/health` do, and who calls it?**
- Render calls it to decide the service is up before sending traffic, and after each deploy.
- The landing page calls it too (`wakeServer`), so a sleeping free instance starts waking while the visitor types their name.

**4. Someone closes their laptop mid-interview. What happens to their seat and cursor?**
- **Before:** TCP may never send a close, so they stayed a "member" forever and held 1 of the room's 4 seats.
- **Now:** the server pings every socket every 30 s and terminates any that missed the previous ping. The normal leave path then runs: the seat is freed and the cursor is removed.

*Code:* `packages/server/src/index.ts`, heartbeat.

**5. Why do empty rooms get deleted, and why after 30 minutes and not immediately?**
- **Why delete:** rooms and their whole op history live in memory, so on a public server they'd pile up forever.
- **Why wait:** deleting the moment a room empties would wipe the document when the only person refreshes the page. 30 minutes covers refreshes and short breaks.

Postgres in Week 3 makes this safe for any gap.

**6. What happens to rooms when the free Render instance sleeps or redeploys?**
They're lost, because memory is the only copy. That's the main reason the Week 3 op log exists: on start, a room reloads its snapshot plus the ops after it.

**7. Why does the Docker image start with `node --import tsx` and not `tsx src/index.ts`?**
The `tsx` CLI starts a second Node process as a child. With `--import tsx`, a single process loads the TypeScript, so the SIGTERM that Render sends on redeploy goes straight to the server.

**8. Why can't the code runner be deployed today?**
Every run starts a fresh Docker container with network, memory, process and CPU limits. Starting containers needs access to a Docker daemon, which Render and Vercel services don't get. So the runner needs its own VM (Week 2).

**9. What does CI check on every push?**
Typecheck of all four packages, the unit tests plus the 30,000 randomized convergence cases, and a build of the server Docker image. *File:* `.github/workflows/ci.yml`.

---

## Interview room (Nov 4)

**1. Why does a coding interview need a shared editor, if the candidate does all the typing?**
The interviewer is there to watch the candidate *think*, not just to read the final answer. They see the approach take shape and the mistakes and fixes as they happen. They can also step in without taking over: add a test case, edit the problem with a follow-up, or put their cursor on a line ("look here"). Both people see the same run output. Screen sharing gives the interviewer a video; Duet gives them the code.

**2. Why OT, if one person types most of the time?**
- Most of the time one person types. But the moments when both type (the interviewer adds a comment or a test while the candidate is typing) are exactly when whole-file sync silently loses someone's edit.
- The op stream is also what makes replay possible: a keystroke-level history of how the solution grew.

**3. Where does the code run, and what stops `while True: pass`?**
In the browser of whoever presses Run, inside a Web Worker. After 5 s the worker is killed. Python runs on Pyodide (CPython in WebAssembly). *Code:* `packages/web/src/runner.ts`. *Doc:* `docs/DESIGN.md` §13.

**4. Why are test cases last-writer-wins and not OT?**
They're small, they're edited rarely, and they're saved when a field loses focus. Replacing the whole list is simple, and a lost edit to a test is easy to see and redo. The code and the problem are long, continuous text, so they get OT.

---

## Saved rooms (Nov 4)

**1. What exactly is saved, and when?**
- **Ops.** Every committed op goes to the `ops` table *before* the server acks it, so an edit you saw acknowledged survives a crash.
- **Snapshots.** Every 200 ops per document, the full text goes to `snapshots`.
- **Room row.** Settings, the last run and the problem's title go to `rooms`.

*Code:* `packages/server/src/store.ts`, `room.ts` (`handle`, `saveRoom`).

**2. How does a room come back after the server crashes?**
`Room.open` loads the latest snapshot per document and replays the ops after it with `ServerDoc.replay`. The document then continues from that revision. *Test:* `npm run recovery` kills the server process outright mid-session and checks the text and revision are identical after restart.

**3. Why is there a queue per room?**
Saving is async. If two ops' inserts finished out of order and each was broadcast when its insert finished, a client could receive op 6 before the ack for its own op 5. The client state machine assumes server messages arrive in commit order, so it would transform wrongly and diverge. One queue per room keeps commit, save and broadcast in a single order.

**4. The crash test found a bug. What was it?**
Settings saves were fire-and-forget. A save triggered by the problem's title change finished after the save that added the test cases, and overwrote them with older settings. Now a room's settings saves run one after another, and each writes the latest state.

**5. Why snapshot every 200 ops, if reload time didn't change?**
At interview-sized documents, replaying 199 ops costs almost nothing (reload was 23–38 ms either way). The interval bounds the worst case: a 3-hour session can't make a reload replay thousands of ops. It's cheap insurance, and the measurement says the exact number barely matters here.

**6. What does saving cost?**
About 2–3 ms per edit at 40 editors. At 200 editors on the laptop, the database's commit rate becomes the bottleneck (p95 133–380 ms). The known fix is group commit: one insert for all ops waiting in a room's queue.

---

## Roles (Nov 4)

**1. How does Duet know who the interviewer is, with no accounts?**
- Creating a room makes a random interviewer key in that browser.
- The first key a room sees becomes its interviewer key, saved with the room.
- Joining with it makes you an interviewer; joining without it makes you a candidate.

*Code:* `packages/web/src/App.tsx` (key), `packages/server/src/room.ts` (`join`).

**2. What stops a candidate editing the problem with the browser console?**
The server. The interface makes the problem editor read-only and hides the buttons, but every problem op and every tests/timer change is checked against the sender's role on the server, and refused if it's from a candidate. I tested it with a raw WebSocket client that skipped the interface: refused, and the problem stayed unchanged.

**3. How do I add a second interviewer?**
"Invite interviewer" copies `/r/<room>#host=<key>`. Browsers never send the part after `#` to a server, and the app saves the key and then removes it from the address bar, so it doesn't spread by accident.

**4. Why does the database connection carry a certificate file?**
Supabase signs its certificates with its own root CA, which Node doesn't trust. Plain `sslmode=require` fails, and switching verification off would allow a man-in-the-middle. Pinning Supabase's root (valid to 2031) keeps the connection both encrypted and verified. I proved it against the live pooler: pinned verifies, plain fails.
