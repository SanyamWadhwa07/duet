# Deploying Duet

**Live since 2026-11-04:**
- Front end: https://duet-six-rose.vercel.app
- Server: https://duet-server.onrender.com/health
- Naive baseline server: https://duet-server-naive.onrender.com/health

The MVP runs on three pieces:

| Piece | Host | Config |
|---|---|---|
| WebSocket server (OT) | Render free web service, Singapore | `render.yaml`, `Dockerfile` |
| WebSocket server (naive baseline, for measurements only) | Render free web service, Singapore | `render.yaml` |
| Front end (static React + Monaco) | Vercel | `vercel.json` |

The code runner (Week 2) needs a VM that can run Docker containers. Render and Vercel can't do that, so the runner gets its own deploy later (see `PLAN.md`).

## One-time setup (account steps, done by Sanyam)

1. **GitHub repo.** Create `SanyamWadhwa07/duet` and push `main`:
   ```bash
   gh repo create SanyamWadhwa07/duet --private --source . --push   # or --public
   ```
2. **Render.**
   1. Sign in at render.com with GitHub.
   2. Click **New → Blueprint** and connect the `duet` repo (give Render access to it).
   3. Click **Apply**. Render creates `duet-server` and `duet-server-naive` from `render.yaml` and builds the Dockerfile.
   4. When both show **Live**, open `https://<duet-server host>/health`. It should return `{"ok":true,"mode":"ot",…}`.
3. **Vercel.**
   1. Sign in at vercel.com with GitHub.
   2. Click **Add New → Project → Import** `duet`.
   3. Leave Root Directory at `./`; `vercel.json` sets the install, build and output.
   4. Under Environment Variables, add `VITE_WS_URL` = `wss://<duet-server host>/ws`.
   5. Click **Deploy**.

From then on, every push to `main` redeploys Vercel. **Render did not redeploy on push (2026-11-04)**, even with Auto-Deploy set to "On Commit". The Blueprint was created through Render's repo-URL link while its GitHub repo list was failing, so the GitHub push hook may not be wired. Until that's fixed (reconnect the repo under the service's Settings), redeploy server changes with **Manual Deploy → Deploy latest commit** on both services. Render only rebuilds when server code changes (`buildFilter` in `render.yaml`).

## Saved rooms: the database (one-time, Sanyam)

Rooms are saved to Postgres when the server has `DATABASE_URL`. A free Neon database is enough: it doesn't expire and it scales to zero when idle.

1. Sign in at neon.tech with GitHub, create a project, and pick the Singapore region (next to the Render server).
2. Copy the connection string (`postgresql://…?sslmode=require`).
3. In Render, open **duet-server → Environment**, add `DATABASE_URL` with that value, and save. Render redeploys.
4. `https://duet-server.onrender.com/health` should now show `"saved": true`.

The server creates its tables on start. Only `duet-server` needs this; the naive baseline stays in memory.

## Things to know about the free tiers

- **Render free instances sleep after ~15 minutes without traffic.** The next visitor waits about a minute while it starts.
- **Rooms live in memory** until Postgres arrives in Week 3, so a sleep or a redeploy empties every room. The landing page pings `/health` when it opens to start waking the server early.
- **Free Render has 0.1 CPU and 512 MB.** Load numbers measured against it describe that instance, not the code's ceiling. `docs/METRICS.md` keeps the two apart.

## Checking a deploy

```bash
curl https://<duet-server host>/health
WS_URL=wss://<duet-server host>/ws ROOMS=1 BOTS_PER_ROOM=2 SECONDS=30 npm run bench
```

Then open the Vercel URL, create a room, and open the link in a second browser or on a phone.
