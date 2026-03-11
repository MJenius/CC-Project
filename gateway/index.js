const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const http = require('http');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 8080;
const REPLICAS = process.env.REPLICAS ? process.env.REPLICAS.split(',') : [
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3003',
  'http://localhost:3004'
];

let currentLeader = null;
let currentTerm = -1;

// Periodically check who is the leader to handle failovers early
setInterval(async () => {
    let highestTerm = -1;
    let newLeader = null;

    for (const replica of REPLICAS) {
        try {
            const res = await axios.get(`${replica}/status`, { timeout: 1000 });
            if (res.data) {
                const { state, term, id } = res.data;
                if (state === 'Leader' && term > highestTerm) {
                    highestTerm = term;
                    newLeader = replica;
                }
            }
        } catch (err) {
            // Replica is down or unreachable
        }
    }

    if (newLeader && highestTerm >= currentTerm) {
        if (currentLeader !== newLeader) {
            console.log(`[Gateway] Learned new leader: ${newLeader} for term ${highestTerm}`);
        }
        currentLeader = newLeader;
        currentTerm = highestTerm;
    }
}, 500);

// Receive committed strokes from the backend leader and broadcast to clients
app.post('/broadcast', (req, res) => {
    const stroke = req.body;
    io.emit('draw_stroke', stroke);
    res.sendStatus(200);
});

// Used by frontend to get the full current canvas if they join late (optional shortcut, or can ask leader)
app.get('/canvas', async (req, res) => {
    if (!currentLeader) {
        return res.status(503).json({ error: "No leader available" });
    }
    try {
        const leaderRes = await axios.get(`${currentLeader}/canvas`, { timeout: 2000 });
        res.json(leaderRes.data);
    } catch (err) {
        res.status(503).json({ error: "Leader unavailable" });
    }
});

// Websocket for real-time strokes from clients
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on('draw_stroke', async (stroke) => {
        if (!currentLeader) {
            console.log("[Gateway] Dropped stroke, no known leader.");
            return;
        }

        try {
            // Forward stroke to the leader
            await axios.post(`${currentLeader}/stroke`, stroke, { timeout: 1000 });
        } catch (err) {
            console.log(`[Gateway] Failed to forward stroke to leader ${currentLeader}. Triggering leader discovery.`);
            currentLeader = null; // Will be discovered on next check
        }
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

server.listen(PORT, () => {
    console.log(`Gateway listening on port ${PORT}`);
});
