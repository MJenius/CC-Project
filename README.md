# Mini-RAFT Whiteboard

A distributed real-time whiteboard built with a simplified RAFT cluster.

The system has:
- 1 gateway service for WebSocket clients and leader forwarding
- 4 replica nodes running RAFT leader election and log replication
- 1 frontend whiteboard UI

The goal is to keep the whiteboard available during leader changes and replica restarts.

## Project Structure

- `frontend/`: Browser UI (canvas, undo/redo, dashboard)
- `gateway/`: WebSocket gateway and leader discovery
- `replica1/` to `replica4/`: RAFT nodes
- `docker-compose.yml`: Full multi-container setup
- `chaos.js`: Randomly stops/starts replica containers for failure testing
- `architecture.md`: Detailed architecture and API notes

## How It Works (High Level)

1. The frontend sends drawing events to the gateway via WebSocket.
2. The gateway forwards each stroke to the current RAFT leader (`/stroke`).
3. The leader replicates entries to followers (`/append-entries`).
4. Once committed by majority, the leader sends committed strokes to the gateway (`/broadcast`).
5. The gateway broadcasts committed strokes to all connected clients.

Replica nodes expose status data (`/status`) used by the frontend dashboard and gateway leader polling.

## Prerequisites

Install the following before running:
- Docker Desktop (with Docker Compose)
- Node.js 18+ (only required to run `chaos.js` from host)

## Run The Project

From the project root:

```bash
docker compose up --build
```

This starts:
- Frontend on `http://localhost`
- Gateway on `http://localhost:8080`
- Replicas on `http://localhost:3001` to `http://localhost:3004`

Open your browser at:
- `http://localhost`

## Stop The Project

In the same terminal:

```bash
Ctrl+C
```

Or from a new terminal:

```bash
docker compose down
```

## Run Chaos Mode (Failure Simulation)

Keep the cluster running, then in a second terminal run:

```bash
node chaos.js
```

Chaos mode will:
- Randomly stop one replica container
- Wait 5 seconds
- Start it again
- Repeat every 10 to 20 seconds

Use Ctrl+C to stop chaos mode.

## Useful Commands

Rebuild and restart:

```bash
docker compose up --build -d
```

Follow all logs:

```bash
docker compose logs -f
```

Follow one service logs:

```bash
docker logs -f gateway
docker logs -f replica1
```

## Notes

- Replicas are intentionally volatile (in-memory log).
- A restarted replica catches up from the current leader using sync logic.
- Gateway polls replicas frequently to track leader changes.

For deeper protocol details, see `architecture.md`.
