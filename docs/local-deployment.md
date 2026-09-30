# Local deployment

How to run Veenew on your own machine — natively with Node/npm, with a single
Docker container, or as the full app + coturn stack with Docker Compose.

The app listens on **port 824** and is served at <http://localhost:824>.

> **Camera/mic locally:** browsers treat `localhost` as a secure context, so
> `getUserMedia` works over plain `http://localhost` — no HTTPS needed for local
> testing. (On a real domain you *do* need HTTPS.)

> **TURN locally:** without `TURN_SECRET` set, the app serves a STUN-only ICE
> config. That's enough for peers on the same network. Cross-NAT relay needs a
> TURN server — run the full stack with Docker Compose (Option C below).

### How rooms pick a topology

Up to 4 people, a room is a peer-to-peer mesh. The 5th person to join moves the
whole room to the mediasoup SFU (up to 12 people): every client builds its SFU
connection first and only drops its mesh links once the SFU media is flowing.
When a room shrinks to 3 people it goes back to mesh the same way, after
`MESH_RETURN_DELAY_MS`. The gap between 4 and 3 is deliberate, so a room
hovering around the limit does not keep switching.

The SFU runs inside the app process and starts lazily, so mesh-only use needs no
media ports. mediasoup needs its native worker binary: `npm install` downloads a
prebuilt one, or compiles it (needs Python 3.10+, a C++ toolchain and make).
The browser bundle of `mediasoup-client` is committed as `assets/mediasoup-client.js`;
regenerate it with `npm run build:client` after upgrading that package.

---

## Option A — Native (npm)

**Prerequisites:** [Node.js](https://nodejs.org) LTS (18+) and npm.

```bash
# from the repo root
npm install        # install dependencies
npm start          # start the server (runs `node init.js`)
```

Then open <http://localhost:824>.

To create a room, add any path — e.g. <http://localhost:824/my-room> — and open
that same URL in a second tab or browser to test a call.

### Optional environment variables

| Variable      | Default                     | Purpose                                   |
| ------------- | --------------------------- | ----------------------------------------- |
| `PORT`        | `824`                       | Port the server listens on                |
| `CORS_ORIGIN` | `http://localhost:824`      | Comma-separated allowed origins (Socket.IO)|
| `TURN_SECRET` | *(unset → STUN only)*       | Shared secret for TURN credentials        |
| `TURN_HOST`   | `localhost`                 | Hostname advertised in TURN URLs          |
| `SFU_ANNOUNCED_IP` | `127.0.0.1`            | IP the SFU tells browsers to send media to |
| `SFU_PORT`    | `44440`                     | First SFU media port (UDP+TCP, one per worker) |
| `SFU_WORKERS` | CPU cores, max 4            | Number of mediasoup workers               |
| `MESH_MAX_PEERS` / `SFU_MAX_PEERS` | `4` / `12` | Room size at which it leaves mesh / hard cap |
| `MESH_RETURN_AT` | `3`                      | An SFU room returns to mesh at this many peers or fewer |
| `MESH_RETURN_DELAY_MS` | `10000`            | How long a room must stay that small first |

Example on a different port:

```bash
PORT=3000 CORS_ORIGIN=http://localhost:3000 npm start
```

### Auto-reload while developing (optional)

Node 18+ can watch and restart on file changes without extra dependencies:

```bash
node --watch init.js
```

---

## Option B — Docker

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/).

The repo ships a one-line convenience script that builds the image and runs it:

```bash
npm run docker
```

That is equivalent to running the two commands manually:

```bash
docker build -t veenew .
docker run --rm -p 824:824 veenew
```

Then open <http://localhost:824>. Stop the container with **Ctrl-C** (the `--rm`
flag removes it on exit).

### Passing environment variables

```bash
docker run --rm -p 824:824 \
  -e CORS_ORIGIN=http://localhost:824 \
  veenew
```

### Run in the background

```bash
docker run -d --name veenew -p 824:824 veenew   # start detached
docker logs -f veenew                          # follow logs
docker stop veenew && docker rm veenew           # stop & remove
```

---

## Option C — Full stack with Docker Compose (app + coturn)

Runs the app together with its own [coturn](https://github.com/coturn/coturn)
TURN server and a [Caddy](https://caddyserver.com) reverse proxy, as defined in
[docker-compose.yml](../docker-compose.yml). Use this when you need real TURN
relay (e.g. peers behind different NATs), not just STUN.

**Prerequisites:** Docker with the Compose plugin (`docker compose version`).

```bash
# from the repo root
cp .env.example .env
```

Edit `.env` and set:

| Variable            | Value                                                        |
| ------------------- | ----------------------------------------------------------- |
| `DOMAIN`            | domain that resolves to this host (Caddy issues a cert for it)|
| `EXTERNAL_IP`       | this host's public IPv4 (coturn `external-ip`)              |
| `LETSENCRYPT_EMAIL` | email for the Let's Encrypt cert                            |
| `TURN_SECRET`       | run `openssl rand -hex 32` and paste the output            |
| `TURN_TTL`          | credential lifetime in seconds (default `86400`)            |

Then build and start everything:

```bash
docker compose up -d --build     # build + start app, caddy, coturn
docker compose ps                # all three should be "Up"
docker compose logs -f           # follow logs (Ctrl-C to stop following)
```

Manage the stack:

```bash
docker compose restart coturn    # e.g. after a TLS cert renewal
docker compose down              # stop & remove the containers
```

**Notes**

- `coturn` uses **host networking**, so the TURN ports bind directly on the host:
  `3478` + `5349` (TCP+UDP) and the UDP relay range `49160–49200`. Open these in
  your firewall.
- The app container publishes the SFU media ports `44440–44443` (UDP **and** TCP).
  Open them in your firewall too, and set `EXTERNAL_IP` to the droplet's public
  IP: the SFU announces it to browsers, and media will not flow if it is wrong.
- Caddy needs `DOMAIN` to resolve to this host **before** it can obtain the TLS
  cert; coturn reuses that cert for `turns://<domain>:5349`.
- The app mints short-lived TURN credentials from `TURN_SECRET`, and coturn
  verifies them with the same secret — keep them identical (they both read `.env`).

---

## Troubleshooting

- **Port 824 already in use:** run on another port with `PORT=3000 npm start`
  (native) or `-p 3000:824` (Docker), then browse to that port.
- **Camera/mic not prompting:** make sure you're on `http://localhost` (not a
  LAN IP like `192.168.x.x`, which isn't a secure context).
- **Two tabs can't connect:** on `localhost` they should connect directly via
  STUN. Connecting across different networks requires TURN (production setup).
