const { exec } = require('child_process');

const REPLICAS = ['replica1', 'replica2', 'replica3', 'replica4'];
let isRunning = true;

console.log("=========================================");
console.log("= Mini-RAFT Chaos Engineering Script =");
console.log("=========================================");
console.log("WARNING: This will randomly restart docker containers!");
console.log("Ctrl+C to stop.\n");

function getRandomReplica() {
    return REPLICAS[Math.floor(Math.random() * REPLICAS.length)];
}

function runChaos() {
    if (!isRunning) return;

    const target = getRandomReplica();
    console.log(`[CHAOS] Selecting ${target} for termination...`);
    
    // Send stop command (simulates a crash or graceful shutdown based on docker stop mechanism)
    exec(`docker stop ${target}`, (error, stdout, stderr) => {
        if (error) {
            console.log(`[CHAOS] Failed to stop ${target}: ${error.message}`);
            return scheduleNext();
        }
        console.log(`[CHAOS] ${target} stopped successfully. Waiting 5 seconds before restart...`);
        
        // Wait then restart
        setTimeout(() => {
            console.log(`[CHAOS] Restarting ${target}...`);
            exec(`docker start ${target}`, (err) => {
                if (err) {
                    console.log(`[CHAOS] Failed to start ${target}: ${err.message}`);
                } else {
                    console.log(`[CHAOS] ${target} is back online! Watch the Catch-Up Sync!`);
                }
                scheduleNext();
            });
        }, 5000);
    });
}

function scheduleNext() {
    if (!isRunning) return;
    // Next chaos event happens between 10s and 20s
    const delay = Math.floor(Math.random() * 10000) + 10000;
    console.log(`\n[CHAOS] Next chaos event scheduled in ${delay/1000} seconds.\n`);
    setTimeout(runChaos, delay);
}

// Start first event quickly
setTimeout(runChaos, 3000);

// Handle exit
process.on('SIGINT', () => {
    console.log("\n[CHAOS] Shutting down. Ensuring all containers are started...");
    isRunning = false;
    REPLICAS.forEach(rep => exec(`docker start ${rep}`));
    setTimeout(() => process.exit(0), 3000);
});
