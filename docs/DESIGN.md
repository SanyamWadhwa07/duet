# Duet: design decisions

Each section gives the decision, the reason, and what was given up for it. Sections marked *planned* belong to later weeks and will be revised once they're built and measured.

---

## 1. OT, not CRDT

**Decision.** Duet syncs text with operational transformation (OT) through a central server, in the style of Google Docs and ot.js. It does not use a CRDT (Yjs, Automerge).

**Why.**
- **The server exists anyway.** Duet needs one for rooms, auth, the code runner and the op log. CRDTs pay off when there is no central authority (peer-to-peer or offline-first apps). An interview room is online by definition.
- **Ops are small.** An OT op is "skip 120 characters, insert `x`, skip the rest", which is a few bytes. A CRDT gives every character a unique ID and keeps tombstones for deleted ones. That metadata grows with the editing history, not with the document.
- **The history is a plain list.** The server puts every op in one total order: rev 0, 1, 2… That list *is* the op log in Week 3. Replay just applies it in order, and crash recovery is snapshot + suffix of the list.
- **It's the part worth owning.** The common student version imports Yjs. Writing OT means every interview question about sync has an answer I wrote.

**Given up.**
- No offline editing and no peer-to-peer.
- Each room's ops pass through one server process, which is fine for 2–4 people.
- Transform functions are easy to get subtly wrong. That's why the randomized property tests (section 7) exist and why they gate every commit.

## 2. Why a central server makes OT simpler

Peer-to-peer OT has to satisfy two properties:
- **TP1:** transforming two concurrent ops either way round gives the same document;
- **TP2:** transforming against *sequences* of concurrent ops, in any order, agrees.

TP2 is notoriously hard, and several published algorithms were later shown to break it.

With a central server, only TP1 is needed:
1. The server decides one order for all ops and is the only place where an op is "committed".
2. Each client has **at most one op in flight**. While it waits for the server's ack, new local edits go into a single buffer op (composed together).
3. So a client only ever transforms its one in-flight op and its one buffer op against each op that arrives from the server. That's exactly two TP1 transforms per incoming op.

The server transforms an incoming op that was based on an old revision against every op committed since then, in order. Both sides use the same function with the same argument order, `transform(clientOp, serverOp)`, so they make identical tie-break decisions.

**Tie-break.** When two inserts land at the same position, the first argument's insert goes first. Because both sides always pass the client's op first, everyone agrees.

**Flow control falls out of this.** If the network is slow, keystrokes pile up in the buffer and leave as one composed op. A slow link sends fewer, larger ops instead of a flood.

## 3. Operation format

An operation is a list of components that walks the whole document from left to right:

| Component | Meaning |
|---|---|
| positive integer `n` | retain: skip `n` characters |
| string `s` | insert `s` here |
| negative integer `-n` | delete the next `n` characters |

For example, `[5, "x", -2, 10]` on a 17-character document skips 5 characters, inserts `x`, deletes 2 and skips the last 10. This compact encoding is the convention ot.js uses. The code in `packages/ot` was written from the algorithm, not copied.

**Rules that keep it unambiguous.**
- Adjacent components of the same kind are merged.
- An insert is always placed before a delete at the same position.
- With one canonical form, two ops that do the same thing compare equal in tests.

**Lengths are UTF-16 code units**, the same unit as JavaScript string indexes and Monaco offsets, so no conversion is needed in the editor binding.

**Every op covers the whole document** (its base length must equal the document length). The server rejects an op whose base length doesn't match. This catches a client that has fallen out of sync immediately, rather than letting it corrupt the room.

## 4. Client state machine

The client keeps three things: `revision` (the last server revision it has seen), `outstanding` (the op sent and not yet acked) and `buffer` (local edits made since then).

| Event | What happens |
|---|---|
| Local edit | No outstanding op: send it. Otherwise compose it into `buffer`. |
| Ack from the server | `revision++`. The buffer, if any, becomes the new outstanding op and is sent. |
| Op from another client | `revision++`. Transform it past `outstanding`, then past `buffer`. Apply what's left to the editor. Keep the transformed `outstanding` and `buffer`. |

The exact same class runs in the browser and in the load-test bots. The numbers in `METRICS.md` therefore exercise the real client code, not a model of it.

## 5. Presence travels separately from ops

Cursors and selections are **ephemeral** messages:
- they don't go in the op log;
- they don't get a revision;
- losing one is harmless, because the next cursor move replaces it.

Each client stores remote cursors as offsets in its *own* copy of the document. Every op it applies, local or remote, shifts those offsets (an insert before a cursor pushes it right, a delete before it pulls it left). A cursor sent during heavy concurrent typing can be a few characters off for a moment, until that peer's next cursor message.

Joins and leaves are also presence messages. Each peer gets a colour from a fixed palette by slot.

**Why not put cursors in the op stream?** It would make every cursor move a revision, bloat the op log, and make replay replay mouse clicks. A separate channel keeps the log about the text.

## 6. Naive baseline mode

`DUET_SYNC=naive` switches the server and clients to the approach in Code-Sync (`server/src/server.ts`, handler `FILE_UPDATED`, checked at commit `6740054`):
- every change sends the whole file;
- the server relays it to everyone else in the room (Duet's naive mode also keeps the latest file, so a late joiner gets it);
- each receiver replaces its text.

There is no ordering and no merging. It exists only to measure against: bytes per keystroke, and how many concurrent keystrokes are lost when two whole-file writes cross on the wire. It works in the browser too, so the lost edits can be shown live.

## 7. Testing convergence

The property tests in `packages/ot/test` use a seeded random generator (mulberry32), so any failure prints a seed that reproduces it exactly. There are three properties:
1. **TP1.** For a random document and two random concurrent ops `a` and `b`: `apply(apply(d, a), b') == apply(apply(d, b), a')`.
2. **Compose.** `apply(d, compose(a, b)) == apply(apply(d, a), b)`.
3. **Full simulation.** 2–4 `OTClient`s and one `ServerDoc` run behind FIFO message queues.
   - At each step a random event happens: a client edits, a client→server message is delivered, or a server→client message is delivered.
   - This covers in-flight ops, buffered ops and long concurrent runs.
   - At the end, every queue is drained and every client's text must equal the server's.

The counts are in `METRICS.md`.

## 8. Rooms and the WebSocket server

- One Node process holds a `Map<roomId, Room>` in memory. A room holds the server document, its history and up to 4 connected peers (5th join is refused).
- Messages are JSON. Binary would be smaller, but JSON can be read in the browser's network tab, and the cost is measured (bytes per keystroke in `METRICS.md`).
- **Scaling path** (*planned*, not built). A room's state lives in one process, so scaling out means routing every member of a room to the same node. There are two options:
  - hash the room ID to a node (sticky routing);
  - put Redis pub/sub between nodes, with one node owning each room's ordering.

  Hashing is simpler and keeps one owner per room, which OT needs.

## 9. Known limits after Week 1

- **Undo is local and not transform-aware.** Monaco's undo stack isn't transformed against remote edits, so undo after a remote edit can undo something slightly different from what you expect. Whatever undo does is still sent as a normal op, so peers never diverge.
- **Reconnect drops unacked edits.** A dropped connection rejoins with fresh state. Fixed in Week 3 with `(clientId, seq)` dedup (section 11).
- **No persistence.** Rooms live in memory until the server restarts (Week 3).

## 10. Sandbox limits (*planned*, Week 2)

Every run happens in its own Docker container. The flags and the attack each one stops:

| Limit | Docker flag | Stops |
|---|---|---|
| No network | `--network none` | network calls, data exfiltration |
| Read-only root, small `/tmp` | `--read-only --tmpfs /tmp:size=…` | writing outside a scratch area, filling the disk |
| Process count | `--pids-limit` | fork bombs |
| Memory, no swap | `--memory` = `--memory-swap` | memory bombs (killed by the OOM killer) |
| CPU | `--cpus` | one run starving the others |
| Wall clock | runner kills the container after T seconds | infinite loops, `sleep` forever |
| Privileges | `--cap-drop ALL --security-opt no-new-privileges`, non-root user | escalating inside the container |
| Output size | runner stops reading after N bytes | output floods |

**Warm pool.** Containers are pre-started per language, each is used for one run and then destroyed, and a replacement is started in the background. Reusing a container would be faster but could leak files or processes from one candidate's run into the next.

**Why Docker, not isolate or gVisor.** Docker runs on a dev laptop and a cheap VPS, and its limits map one-to-one onto the table above. `isolate` (used by IOI) is stricter, but it needs cgroup setup on the host. That's the upgrade path if the threat model grows.

## 11. Op log and snapshots (*planned*, Week 3)

- **The log.** An append-only `ops` table in Postgres stores one row per committed op `(room_id, rev, client_id, op, created_at)`. The server writes the row before it acks. An acked op is therefore durable, and an op that wasn't acked is resent by the client after reconnect.
- **Snapshots.** Every **200 ops** the server stores the full document text.
  - Recovery and replay load the latest snapshot and apply the ops after it, so they never apply more than 199.
  - 200 is a starting point. It trades replay time (each apply is linear in document size) against snapshot storage (one document copy per 200 ops). Week 3 measures recovery time against ops since the last snapshot, and the interval is set from that.
- **Replay.** Replay applies the log from rev 0 with each op's original timestamp, scaled for 1×, 4× or 16× playback.
