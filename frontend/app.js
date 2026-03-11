// ---------- CANVAS LOGIC ----------
const canvas = document.getElementById('drawingBoard');
const ctx = canvas.getContext('2d');

let isDrawing = false;
let currentColor = '#000000';
let currentStroke = []; // Array of {x,y} representing current drag

// Optimistic local strokes that haven't been committed yet
let localUncommittedStrokes = [];
// Confirmed strokes from the server
let confirmedStrokes = [];

// Setup colors
document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        currentColor = e.target.dataset.color;
    });
});

function getMousePos(evt) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: evt.clientX - rect.left,
        y: evt.clientY - rect.top
    };
}

canvas.addEventListener('mousedown', (e) => {
    isDrawing = true;
    const pos = getMousePos(e);
    currentStroke = [pos];
});

canvas.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;
    const pos = getMousePos(e);
    
    // Draw optimistically
    const lastPos = currentStroke[currentStroke.length - 1];
    drawLine(lastPos.x, lastPos.y, pos.x, pos.y, currentColor);
    
    currentStroke.push(pos);
});

canvas.addEventListener('mouseup', () => finishStroke());
canvas.addEventListener('mouseout', () => {
    if (isDrawing) finishStroke();
});

function finishStroke() {
    isDrawing = false;
    if (currentStroke.length > 1) {
        const strokeObj = {
            id: Math.random().toString(36).substring(2, 10), // temporary client ID
            color: currentColor,
            points: currentStroke
        };
        
        localUncommittedStrokes.push(strokeObj);
        updateUIStats();
        
        // Send to Gateway
        if (socket && socket.connected) {
            socket.emit('draw_stroke', strokeObj);
        }
    }
    currentStroke = [];
}

function drawLine(x1, y1, x2, y2, color) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.closePath();
}

function drawStrokeFull(stroke) {
    if (!stroke || !stroke.points || stroke.points.length < 2) return;
    const pts = stroke.points;
    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
    ctx.closePath();
}

function redrawEverything() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw confirmed
    confirmedStrokes.forEach(drawStrokeFull);
    // Draw uncommitted optimistically
    localUncommittedStrokes.forEach(drawStrokeFull);
}


// ---------- WEBSOCKET LOGIC ----------
const GATEWAY_URL = window.location.hostname === 'localhost' ? 'http://localhost:8080' : 'http://gateway:8080';
const socket = io(GATEWAY_URL);
const sysLogs = document.getElementById('sysLogs');

function logToUI(msg) {
    const d = new Date().toLocaleTimeString();
    sysLogs.textContent += `[${d}] ${msg}\n`;
    sysLogs.scrollTop = sysLogs.scrollHeight;
}

socket.on('connect', async () => {
    document.getElementById('connectionStatus').textContent = 'Connected (Gateway)';
    document.getElementById('connectionStatus').className = 'connected';
    logToUI('Connected to Gateway WebSocket');
    
    // Fetch full canvas on startup
    try {
        const res = await fetch(`${GATEWAY_URL}/canvas`);
        if (res.ok) {
            const strokes = await res.json();
            confirmedStrokes = strokes;
            redrawEverything();
            logToUI(`Fetched ${strokes.length} past strokes`);
        }
    } catch(e) {
        logToUI("Failed to fetch past strokes: " + e.message);
    }
});

socket.on('disconnect', () => {
    document.getElementById('connectionStatus').textContent = 'Disconnected';
    document.getElementById('connectionStatus').className = 'disconnected';
    logToUI('Disconnected from Gateway');
});

socket.on('draw_stroke', (committedStroke) => {
    // A stroke was officially committed by RAFT
    confirmedStrokes.push(committedStroke);
    
    // Remove from uncommitted if it was ours
    const idx = localUncommittedStrokes.findIndex(s => s.id === committedStroke.id);
    if (idx !== -1) {
        localUncommittedStrokes.splice(idx, 1);
    }
    
    updateUIStats();
    redrawEverything();
});

function updateUIStats() {
    document.getElementById('infoStrokes').textContent = `Local uncommitted: ${localUncommittedStrokes.length}`;
}

// ---------- DASHBOARD POLLING ----------
const REPLICAS = [
    { url: 'http://localhost:3001', id: 1 },
    { url: 'http://localhost:3002', id: 2 },
    { url: 'http://localhost:3003', id: 3 },
    { url: 'http://localhost:3004', id: 4 }
];

async function pollDashboard() {
    const container = document.getElementById('nodesCards');
    let html = '';
    
    for (const rep of REPLICAS) {
        try {
            const res = await fetch(`${rep.url}/status`);
            const data = await res.json();
            
            let badgeClass = data.state.toLowerCase();
            
            html += `
                <div class="node-card ${badgeClass}">
                    <div class="node-title">
                        Node ${data.id}
                        <span class="node-badge">${data.state}</span>
                    </div>
                    <div class="node-stats">
                        Term: ${data.term} <br/>
                        Log Size: ${data.logLength} | Commit: ${data.commitIndex}
                    </div>
                </div>
            `;
        } catch (e) {
            html += `
                <div class="node-card down">
                    <div class="node-title">
                        Node ${rep.id} <span class="node-badge">DOWN</span>
                    </div>
                </div>
            `;
        }
    }
    
    container.innerHTML = html;
}

// Poll every 1 second
setInterval(pollDashboard, 1000);
pollDashboard();
