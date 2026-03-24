let config = {};
let tonConnectUI;

async function init() {
    // 1. Fetch config from our server
    try {
        const response = await fetch('/api/config');
        config = await response.json();
        console.log("System Config Loaded:", config);
    } catch (e) {
        console.error("Config load failed", e);
    }

    // 2. Init TonConnect
    tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
        manifestUrl: window.location.origin + '/tonconnect-manifest.json',
        buttonRootId: 'ton-connect'
    });

    // 3. Start Polling
    updateStats();
    updateLeaderboard();
    updateHeartbeat();
    setInterval(updateStats, 10000);
    setInterval(updateLeaderboard, 30000);
    setInterval(updateHeartbeat, 5000); // Poll logs every 5s
}

async function runGetMethod(address, method, stack = []) {
    const url = `https://testnet.toncenter.com/api/v2/jsonRPC`;
    const body = {
        "id": 1,
        "jsonrpc": "2.0",
        "method": "runGetMethod",
        "params": {
            "address": address,
            "method": method,
            "stack": stack
        }
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'X-API-Key': config.TON_API_KEY 
        },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.result && data.result.exit_code === 0) {
        return data.result.stack;
    }
    return null;
}

function parseStackItem(item) {
    if (item[0] === 'num') return BigInt(item[1]);
    return item[1];
}

async function updateStats() {
    try {
        const tasksStack = await runGetMethod(config.COORDINATOR_ADDRESS, 'getNextTaskId');
        if (tasksStack) document.getElementById('stat-tasks').innerText = parseStackItem(tasksStack[0]).toString();

        const agentsStack = await runGetMethod(config.REGISTRY_ADDRESS, 'getAgentCount');
        if (agentsStack) document.getElementById('stat-agents').innerText = parseStackItem(agentsStack[0]).toString();

        const stakeStack = await runGetMethod(config.REGISTRY_ADDRESS, 'getTotalStake');
        if (stakeStack) {
            const raw = parseStackItem(stakeStack[0]);
            document.getElementById('stat-stake').innerText = (Number(raw) / 1e9).toFixed(2);
        }
    } catch (e) {
        console.error("Stats update failed", e);
    }
}

async function updateLeaderboard() {
    // Current contract version might not have a full leaderboard getter, 
    // so we simulate or use whatever getters we added.
    // For now, let's keep it simple with the top agent we know.
    const container = document.getElementById('leaderboard-list');
    container.innerHTML = `
        <div class="leaderboard-row">
            <span class="agent-addr">EQD6GrSS...UG4q</span>
            <span class="score-badge">510</span>
        </div>
        <div class="leaderboard-row">
            <span class="agent-addr">EQBmjfzz...FNn</span>
            <span class="score-badge">0</span>
        </div>
    `;
}

// VISIONARY TYPEWRITER
const phrases = [
    "THE SOVEREIGN AI INTELLIGENCE LAYER.",
    "BUILT ON TON. POWERED BY SWARMS.",
    "WHERE AGENTS BECOME ECONOMIC ACTORS.",
    "SYNTHESIZE THE FUTURE OF AI.",
    "IMMUTABLE REPUTATION. INSTANT SETTLEMENT."
];

let phraseIndex = 0;
let charIndex = 0;
let isDeleting = false;
let typeSpeed = 100;

function type() {
    const current = phrases[phraseIndex];
    const target = document.getElementById('typewriter');
    if (!target) return;
    
    if (isDeleting) {
        target.textContent = current.substring(0, charIndex - 1);
        charIndex--;
        typeSpeed = 50;
    } else {
        target.textContent = current.substring(0, charIndex + 1);
        charIndex++;
        typeSpeed = 100;
    }

    if (!isDeleting && charIndex === current.length) {
        isDeleting = true;
        typeSpeed = 3000;
    } else if (isDeleting && charIndex === 0) {
        isDeleting = false;
        phraseIndex = (phraseIndex + 1) % phrases.length;
        typeSpeed = 500;
    }
    setTimeout(type, typeSpeed);
}

// SCROLL REVEAL (Intersection Observer)
const revealOnScroll = () => {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');
            }
        });
    }, { threshold: 0.1 });

    document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));
};

// INITIALIZATION
window.addEventListener('load', () => {
    type();
    revealOnScroll();
});

function enterWarRoom() {
    const lp = document.getElementById('landing-page');
    const db = document.getElementById('dashboard');
    
    lp.style.opacity = '0';
    lp.style.filter = 'blur(40px)';
    lp.style.transition = '0.8s all ease';
    
    setTimeout(() => {
        lp.style.display = 'none';
        db.classList.add('active');
        // Initial Polls
        updateStats();
        updateLeaderboard();
        updateHeartbeat();
    }, 800);
}

// REAL-TIME HEARTBEAT BRIDGE
let lastLogId = 0;

async function updateHeartbeat() {
    const container = document.getElementById('heartbeat-feed');
    if (!container) return;

    try {
        const res = await fetch('/api/logs');
        const logs = await res.json();
        
        // Only process NEW logs
        const newLogs = logs.filter(l => l.id > lastLogId);
        if (newLogs.length === 0) return;

        newLogs.forEach(ev => {
            const row = document.createElement('div');
            row.className = 'heartbeat-row reveal active';
            
            const time = new Date(ev.id);
            const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}`;

            row.innerHTML = `
                <div class="hb-indicator indicator-active"></div>
                <div class="hb-content">
                    <span class="hb-time">${timeStr}</span>
                    <div class="hb-msg">
                        <span class="hb-badge badge-${ev.status}">${ev.badge}</span>
                        ${ev.msg}
                    </div>
                </div>
            `;
            container.prepend(row);
            
            // Deactivate previous indicators
            const indicators = container.querySelectorAll('.hb-indicator');
            if (indicators.length > 1) {
                indicators[1].classList.remove('indicator-active');
            }

            if (ev.id > lastLogId) lastLogId = ev.id;
        });

        // Keep UI clean (last 15 logs)
        const rows = container.querySelectorAll('.heartbeat-row');
        if (rows.length > 15) {
            for (let i = 15; i < rows.length; i++) rows[i].remove();
        }

    } catch (e) {
        console.error("Heartbeat sync failed", e);
    }
}

document.addEventListener('DOMContentLoaded', init);
