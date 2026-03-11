const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const REPLICA_ID = parseInt(process.env.REPLICA_ID || '1');
const PORT = process.env.PORT || 3001;
const PEERS = process.env.PEERS ? process.env.PEERS.split(',') : [
  'http://localhost:3002',
  'http://localhost:3003',
  'http://localhost:3004'
];

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://gateway:8080';

// RAFT State
let state = 'Follower'; // Follower, Candidate, Leader
let currentTerm = 0;
let votedFor = null;
let log = []; // Array of { term, stroke }
let commitIndex = 0;

// Leader volatile state
let nextIndex = {};
let matchIndex = {};

// Timers
let electionTimeoutTimer = null;
let heartbeatTimer = null;

// Constants
const HEARTBEAT_INTERVAL_MS = 150;
const ELECTION_TIMEOUT_MIN = 500;
const ELECTION_TIMEOUT_MAX = 800;

function getRandomElectionTimeout() {
    return Math.floor(Math.random() * (ELECTION_TIMEOUT_MAX - ELECTION_TIMEOUT_MIN + 1)) + ELECTION_TIMEOUT_MIN;
}

function resetElectionTimeout() {
    clearTimeout(electionTimeoutTimer);
    electionTimeoutTimer = setTimeout(startElection, getRandomElectionTimeout());
}

function stopElectionTimeout() {
    clearTimeout(electionTimeoutTimer);
}

// ---------------- RAFT LOGIC ----------------

function startElection() {
    state = 'Candidate';
    currentTerm++;
    votedFor = REPLICA_ID;
    console.log(`[Node ${REPLICA_ID}] Starting election for term ${currentTerm}`);

    let votesReceived = 1; // Voted for self
    const lastLogIndex = log.length;
    const lastLogTerm = lastLogIndex > 0 ? log[lastLogIndex - 1].term : 0;

    resetElectionTimeout(); // In case election splits

    PEERS.forEach(async (peer) => {
        try {
            const res = await axios.post(`${peer}/request-vote`, {
                term: currentTerm,
                candidateId: REPLICA_ID,
                lastLogIndex,
                lastLogTerm
            }, { timeout: 200 });

            if (state === 'Candidate' && res.data.term === currentTerm && res.data.voteGranted) {
                votesReceived++;
                if (votesReceived > Math.floor((PEERS.length + 1) / 2)) {
                    becomeLeader();
                }
            } else if (res.data.term > currentTerm) {
                stepDown(res.data.term);
            }
        } catch (err) {
            // Expected if peer is down
        }
    });
}

function becomeLeader() {
    console.log(`[Node ${REPLICA_ID}] Became LEADER for term ${currentTerm}`);
    state = 'Leader';
    votedFor = null;
    stopElectionTimeout();

    // Initialize volatile state
    PEERS.forEach(peer => {
        nextIndex[peer] = log.length + 1;
        matchIndex[peer] = 0;
    });

    sendHeartbeats();
}

function stepDown(newTerm) {
    if (newTerm > currentTerm) {
        console.log(`[Node ${REPLICA_ID}] Stepping down to term ${newTerm}`);
        currentTerm = newTerm;
        votedFor = null;
    }
    if (state !== 'Follower') {
        console.log(`[Node ${REPLICA_ID}] Reverting to Follower`);
    }
    state = 'Follower';
    resetElectionTimeout();
    clearTimeout(heartbeatTimer);
}

function sendHeartbeats() {
    if (state !== 'Leader') return;

    PEERS.forEach(async (peer) => {
        const prevLogIndex = nextIndex[peer] - 1;
        const prevLogTerm = prevLogIndex > 0 && prevLogIndex <= log.length ? log[prevLogIndex - 1].term : 0;
        const entries = log.slice(prevLogIndex);

        try {
            const res = await axios.post(`${peer}/append-entries`, {
                term: currentTerm,
                leaderId: REPLICA_ID,
                prevLogIndex,
                prevLogTerm,
                entries,
                leaderCommit: commitIndex
            }, { timeout: 200 });

            if (state !== 'Leader') return;

            if (res.data.term > currentTerm) {
                stepDown(res.data.term);
                return;
            }

            if (res.data.success) {
                nextIndex[peer] = log.length + 1;
                matchIndex[peer] = prevLogIndex + entries.length;

                // Update commitIndex if majority has matching logs
                let matches = [log.length]; // Self
                for (const p of PEERS) {
                    matches.push(matchIndex[p]);
                }
                matches.sort((a,b) => b-a); // Descending
                const majorityMatch = matches[Math.floor((PEERS.length + 1) / 2)];

                if (majorityMatch > commitIndex && log[majorityMatch - 1].term === currentTerm) {
                    const oldCommitIndex = commitIndex;
                    commitIndex = majorityMatch;
                    for (let i = oldCommitIndex; i < commitIndex; i++) {
                        commitToGateway(log[i].stroke);
                    }
                }

            } else {
                // Next index backoff, or full resync request
                if (res.data.reason === 'needs_sync') {
                   // Triggers full sync catchup mechanism
                   catchUpPeer(peer, res.data.matchIndex);
                } else {
                   // Simple decrement if mismatch
                   nextIndex[peer] = Math.max(1, nextIndex[peer] - 1);
                }
            }

        } catch(err) {
            // peer down
        }
    });

    heartbeatTimer = setTimeout(sendHeartbeats, HEARTBEAT_INTERVAL_MS);
}

// Full Sync Catch-Up mechanism for restarted nodes
function catchUpPeer(peer, lastMatchIndex) {
    console.log(`[Node ${REPLICA_ID}] Performing full sync for peer ${peer} from index ${lastMatchIndex}`);
    const missingEntries = log.slice(lastMatchIndex);
    axios.post(`${peer}/sync-log`, {
        entries: missingEntries,
        term: currentTerm,
        leaderId: REPLICA_ID,
        commitIndex: commitIndex
    }).catch(err => {
        console.log(`Failed to sync peer ${peer}`);
    });
}

// ---------------- HTTP ENDPOINTS ----------------

app.post('/request-vote', (req, res) => {
    const { term, candidateId, lastLogIndex, lastLogTerm } = req.body;

    if (term > currentTerm) {
        stepDown(term);
    }

    let voteGranted = false;
    if (term === currentTerm && (votedFor === null || votedFor === candidateId)) {
        const myLastLogIndex = log.length;
        const myLastLogTerm = myLastLogIndex > 0 ? log[myLastLogIndex - 1].term : 0;

        // Log completeness check
        if (lastLogTerm > myLastLogTerm || (lastLogTerm === myLastLogTerm && lastLogIndex >= myLastLogIndex)) {
            voteGranted = true;
            votedFor = candidateId;
            resetElectionTimeout();
        }
    }

    res.json({ term: currentTerm, voteGranted });
});

app.post('/append-entries', (req, res) => {
    const { term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit } = req.body;

    if (term > currentTerm) {
        stepDown(term);
    }

    if (term < currentTerm) {
        return res.json({ term: currentTerm, success: false });
    }

    // Recognize leader
    state = 'Follower';
    resetElectionTimeout();

    // Volatile Restart Check: If we have an empty log but leader is sending a later entry
    if (log.length === 0 && prevLogIndex > 0) {
        return res.json({ term: currentTerm, success: false, reason: 'needs_sync', matchIndex: 0 });
    }

    // Mismatched log
    if (prevLogIndex > 0 && (prevLogIndex > log.length || log[prevLogIndex - 1].term !== prevLogTerm)) {
        // Truncate conflicts would go here
        return res.json({ term: currentTerm, success: false, reason: 'needs_sync', matchIndex: log.length });
    }

    // Valid append
    // Truncate if conflicting
    for (let i = 0; i < entries.length; i++) {
       const index = prevLogIndex + 1 + i;
       if (index <= log.length && log[index - 1].term !== entries[i].term) {
           log = log.slice(0, index - 1); // Truncate
       }
       if (index > log.length) {
           log.push(...entries.slice(i));
           break;
       }
    }

    if (leaderCommit > commitIndex) {
        commitIndex = Math.min(leaderCommit, log.length);
    }

    res.json({ term: currentTerm, success: true });
});

// Full Log Sync 
app.post('/sync-log', (req, res) => {
    const { entries, term, commitIndex: newCommitIndex } = req.body;
    if (term >= currentTerm) {
        stepDown(term);
        // Assuming we are receiving this because our log was empty / we restarted
        log = entries; // Override (simplified for the volatile state assumption)
        commitIndex = newCommitIndex;
    }
    res.sendStatus(200);
});

// Accept stroke from Gateway
app.post('/stroke', (req, res) => {
    if (state !== 'Leader') {
        const leaderPeer = PEERS.find(p => p.includes(`replica${votedFor}`)) || null;
        return res.status(400).json({ error: 'Not the leader', leader: leaderPeer });
    }

    const stroke = req.body;
    log.push({ term: currentTerm, stroke });
    // It will be replicated in the next heartbeat
    res.sendStatus(200);
});

app.get('/status', (req, res) => {
    res.json({
        id: REPLICA_ID,
        state,
        term: currentTerm,
        logLength: log.length,
        commitIndex
    });
});

app.get('/canvas', (req, res) => {
    // Return all COMMITTED strokes
    const strokes = log.slice(0, commitIndex).map(e => e.stroke);
    res.json(strokes);
});

// Send committed stroke to Gateway for broadcast
function commitToGateway(stroke) {
    axios.post(`${GATEWAY_URL}/broadcast`, stroke).catch(err => {
        // Gateway might be restarting
    });
}

// Graceful Shutdown (Zero Downtime / Volatile State handling)
function gracefulShutdown() {
    console.log(`[Node ${REPLICA_ID}] Received kill signal, shutting down gracefully.`);
    clearTimeout(electionTimeoutTimer);
    clearTimeout(heartbeatTimer);
    app.close(() => {
        process.exit(0);
    });
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Start
resetElectionTimeout();
console.log(`[Node ${REPLICA_ID}] Started as Follower.`);

const server = app.listen(PORT, () => {
    console.log(`[Node ${REPLICA_ID}] Listening on port ${PORT}`);
});
app.close = (cb) => server.close(cb);
