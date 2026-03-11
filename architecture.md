# Mini-RAFT Architecture Document

## 1. System Components
The Mini-RAFT cluster implements a leader-based real-time whiteboard utilizing exactly one websocket connection to a custom stateless gateway.

### Gateway Module (`/gateway`) 
- **Role:** Forward WebSocket client drawing events (`POST /stroke`) directly to the Replica Leader. Receives back (`POST /broadcast`) the committed strokes to fan out via WebSockets to all clients identically.
- **Failover Concept:** Emits no disconnects to the client. Uses a 500ms `setInterval` to constantly query all Replicas `/status` using an optimistic ping strategy to stay aware of Leader shifts in near-realtime.

### Minion Replica Module (`/replica[1-4]`)
- **Role:** Maintain a deterministic Append-Only Log of drawing events. Follows precise RAFT protocol.
- **Ports:** `:3001` - `:3004`.
- **States:** `Follower`, `Candidate`, `Leader`.

---

## 2. API Definition

### Internal Cluster RPCs (Replicas -> Replicas)

#### `POST /request-vote`
- **Request:** `{ term, candidateId, lastLogIndex, lastLogTerm }`
- **Response:** `{ term, voteGranted }`
- Initiates an election cycle. Follows RAFT term dominance and log completion safety bounds.

#### `POST /append-entries`
- **Request:** `{ term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit }`
- **Response:** `{ term, success, reason, matchIndex }`
- Heartbeat and Log Appending wrapper.

#### `POST /sync-log`
- **Request:** `{ entries, term, commitIndex, leaderId }`
- **Response:** `200 OK`
- When a volatile node receives an `AppendEntries` with `prevLogIndex > 0` and it has an empty log, it fails with `reason: 'needs_sync'`. The leader fires `/sync-log` containing every committed item.

### External & Admin APIs (Gateway, Frontend)

#### `GET /status`
- **Used by:** Gateway polling & Dashboard UI polling.
- **Yields:** `{ id, state, term, logLength, commitIndex }`

#### `POST /stroke`
- **Used by:** Gateway forwarder.
- The leader accepts a new stroke event to append to the log. 

#### `GET /canvas`
- **Used by:** Frontend Initial Load Strategy.
- Yields an array of all previously committed JSON stroke vectors.

--- 

## 3. State Transitions

### Follower -> Candidate
Triggered when the node's individual `electionTimeoutTimer` elapses before receiving a heartbeat from the leader. The timer varies between 500ms and 800ms to reduce likelihood of ties.

### Candidate -> Leader
Triggered upon receiving a majority of `/request-vote` `voteGranted:true` responses. Initiates state setup setting nextIndex bindings for peers and starts the `150ms` fixed heartbeat cadence.

### Any State -> Follower
Triggered upon interacting with a peer broadcasting a `term` higher than the node's local `currentTerm`. The node strictly accepts the higher term.

---

## 4. Failure Handling Strategy
- **Container Disconnect / Restart:** A restarted Container boots as a volatile `Follower` at `Term 0` with zero log state. The active Leader immediately spots the log disconnect when heartbeating and forces a massive Catch-Up Sync (`/sync-log`) transferring all committed history across the physical container boundaries instantly, reviving the replica to `commitIndex`.

## 5. Running the evaluation Simulation "Chaos Mode"
Run:
`node chaos.js` 
The script randomly targets containers to invoke an external Docker exit, then revives them 5 seconds later. The frontend maintains zero downtime. To view logs and leader shifts see the browser UI's Dashboard panel containing Gateway diagnostic output.
