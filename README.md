# Duet

A live coding-interview room. 2–4 people open a room link and edit one file together in the browser. Code runs against test cases in a sandbox (Week 2), and sessions can be replayed keystroke by keystroke (Week 3).

The sync engine is my own operational transformation (OT) with a central server. No Yjs, ShareDB or Automerge. See [docs/DESIGN.md](docs/DESIGN.md) for every decision and [docs/METRICS.md](docs/METRICS.md) for every number, with how each was measured.

**Status:** Week 1 of 3 is done (sync core, rooms, presence, Monaco binding). The plan is in [PLAN.md](PLAN.md).

## Layout

| Path | What it is |
|---|---|
| `packages/ot` | Operations (retain/insert/delete) with `apply`, `compose`, `transform`; the client state machine; the server document; the wire protocol types; and the randomized convergence tests |
| `packages/server` | Node + `ws` WebSocket server: rooms of up to 4, presence, and the naive baseline mode |
| `packages/web` | React + Monaco front end and the editor ↔ OT binding (`src/session.ts`) |
| `packages/bench` | Bot load test plus the OT-vs-naive comparison (`src/bots.ts`), and the browser exit test (`src/e2e.ts`) |
| `bench/results` | Raw JSON from every benchmark run quoted in `METRICS.md` |

## Run it

Needs Node 22+.

```bash
npm install
npm run server                     # WebSocket server on :4000 (PORT=... to change)
npm run web                        # Vite dev server on :5173, proxies /ws and /api to :4000
```

Open `http://localhost:5173`, create a room, and open the link in a second tab.

If the ports are taken, run `PORT=4100 npm run server` and `DUET_SERVER=http://localhost:4100 npm run web -- --port 5180`.

For the naive baseline, run `DUET_SYNC=naive npm run server`. Every change then sends the whole file and the server relays it, as Code-Sync does. Type in two tabs at once and watch edits disappear.

## Deploy

The front end deploys to Vercel (`vercel.json`) and the WebSocket server to Render as a Docker web service (`render.yaml`, `Dockerfile`). Step-by-step instructions and free-tier caveats are in [docs/DEPLOY.md](docs/DEPLOY.md).

## Tests and measurements

```bash
npm test                           # unit + randomized convergence property tests
OT_SCALE=10 npm test               # 10x soak run of the property tests
npm run e2e                        # exit test: browser tabs type concurrently, must end identical (needs server + web running; uses installed Edge)
npm run bench                      # bot load test (see the header of packages/bench/src/bots.ts for settings)
```

## References and credits

I studied these projects for structure and ideas. **No code was copied from any of them, and none of them was forked.**

- [ot.js](https://github.com/Operational-Transformation/ot.js) by Tim Baumann (MIT). The operation encoding (positive integer = retain, string = insert, negative integer = delete) and the client model (one op in flight plus a buffer) follow its design. The code in `packages/ot` was written from the algorithm.
- [avelin](https://github.com/avelinapp/avelin) and [corust](https://github.com/brylee10/corust): how a collaborative editor splits into web, API and sync services.
- [Code-Sync](https://github.com/sahilatahar/Code-Sync) and [caucus](https://github.com/Rishabh-malhotraa/caucus): the common version, which syncs with whole-file rebroadcast (Code-Sync) or Yjs (caucus). Duet's naive baseline mode reproduces Code-Sync's `FILE_UPDATED` behaviour so the two can be measured against each other.
- [piston](https://github.com/engineer-man/piston), [kira](https://github.com/FlorianWoelki/kira), [pesto](https://github.com/teknologi-umum/pesto) and [isolate](https://github.com/ioi/isolate): runner and sandbox designs (Week 2).
