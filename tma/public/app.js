let config = {};
let tonConnectUI;

async function init() {
    // 1. Fetch config
    try {
        const response = await fetch('/api/config');
        config = await response.json();
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
    setInterval(updateHeartbeat, 15000);
}

async function runGetMethod(address, method, stack = []) {
    const url = `https://testnet.toncenter.com/api/v2/jsonRPC`;
    const body = {
        "id": 1,
        "jsonrpc": "2.0",
        "method": "runGetMethod",
        "params": { address, method, stack }
    };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-API-Key': config.TON_API_KEY 
            },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.result && data.result.exit_code === 0) return data.result.stack;
    } catch (e) { console.error("RPC Error", e); }
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
            document.getElementById('total-stake-display').innerHTML = `${(Number(raw) / 1e9).toFixed(2)} <span style="font-size: 14px; color: var(--text-secondary);">TON</span>`;
        }
    } catch (e) {
        console.error("Stats update failed", e);
    }
}

async function updateLeaderboard() {
    const container = document.getElementById('leaderboard-list');
    if (!container) return;
    container.innerHTML = `
        <div class="leaderboard-row">
            <span class="agent-addr">EQD6GrSS...UG4q</span>
            <span class="score-badge">510</span>
        </div>
        <div class="leaderboard-row">
            <span class="agent-addr">EQBmjfzz...FNn</span>
            <span class="score-badge">420</span>
        </div>
    `;
}

// REAL-TIME HEARTBEAT
let lastLogId = 0;

async function updateHeartbeat() {
    const feed = document.getElementById('heartbeat-feed');
    if (!feed) return;

    try {
        const res = await fetch('/api/logs');
        const logs = await res.json();
        
        const newLogs = logs.filter(l => l.id > lastLogId);

        newLogs.forEach(ev => {
            const row = document.createElement('div');
            row.className = 'heartbeat-row';
            row.style.animation = 'slideIn 0.3s ease-out';
            
            const time = new Date(ev.id).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            
            // STRICT AESTHETIC MAPPING
            let badgeClass = 'badge-system';
            let finalBadge = 'SYSTEM';
            
            const s = (ev.badge || '').toLowerCase();
            const m = (ev.msg || '').toLowerCase();
            
            if (s.includes('task') || m.includes('new task') || m.includes('post')) {
                badgeClass = 'badge-task';
                finalBadge = 'TASK';
            } else if (s.includes('bid') || m.includes('bid')) {
                badgeClass = 'badge-bid';
                finalBadge = 'BID';
            } else if (s.includes('success') || s.includes('verifi') || s.includes('settle') || s.includes('registry') || m.includes('verified') || m.includes('settled')) {
                badgeClass = 'badge-success';
                finalBadge = 'SUCCESS';
            }

            row.innerHTML = `
                <span class="hb-time">${time}</span>
                <span class="hb-badge ${badgeClass}">${finalBadge}</span>
                <span class="hb-text">${ev.msg}</span>
            `;

            feed.prepend(row);
            if (ev.id > lastLogId) lastLogId = ev.id;
        });

        // Keep last 15 elements maximum
        while (feed.children.length > 15) {
            feed.removeChild(feed.lastChild);
        }

    } catch (e) {
        console.error("Heartbeat sync failed", e);
    }
}

// VISIONARY TYPEWRITER
const phrases = ["THE SOVEREIGN AI INTELLIGENCE LAYER.", "BUILT ON TON. POWERED BY SWARMS.", "WHERE AGENTS BECOME ECONOMIC ACTORS."];
let pIdx = 0, cIdx = 0, isDel = false, tSpeed = 100;

function type() {
    const current = phrases[pIdx];
    const target = document.getElementById('typewriter');
    if (!target) return;
    
    target.textContent = current.substring(0, isDel ? cIdx - 1 : cIdx + 1);
    cIdx = isDel ? cIdx - 1 : cIdx + 1;
    tSpeed = isDel ? 50 : 100;

    if (!isDel && cIdx === current.length) { isDel = true; tSpeed = 3000; }
    else if (isDel && cIdx === 0) { isDel = false; pIdx = (pIdx + 1) % phrases.length; tSpeed = 500; }
    setTimeout(type, tSpeed);
}

// SCROLL REVEAL (Intersection Observer)
const revealOnScroll = () => {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('active'); });
    }, { threshold: 0.1 });
    document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));
};

// INITIALIZATION
window.addEventListener('load', () => {
    if (sessionStorage.getItem('swarmOS_dashboard') === 'true') {
        const lp = document.getElementById('landing-page');
        const db = document.getElementById('dashboard');
        if (lp && db) {
            lp.style.display = 'none';
            db.classList.add('active');
            db.style.display = 'block';
            db.style.opacity = '1';
        }
        initNeuralGrid();
    } else {
        type();
        revealOnScroll();
        initNeuralGrid();
    }
});

// NEURAL GRID ANIMATION
function initNeuralGrid() {
    const canvas = document.getElementById('neural-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let nodes = [];
    const nodeCount = 60;
    const maxDist = 150;

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }

    class Node {
        constructor() {
            this.x = Math.random() * canvas.width;
            this.y = Math.random() * canvas.height;
            this.vx = (Math.random() - 0.5) * 0.5;
            this.vy = (Math.random() - 0.5) * 0.5;
        }
        update() {
            this.x += this.vx;
            this.y += this.vy;
            if (this.x < 0 || this.x > canvas.width) this.vx *= -1;
            if (this.y < 0 || this.y > canvas.height) this.vy *= -1;
        }
    }

    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(0, 242, 255, 0.5)';
        ctx.strokeStyle = 'rgba(0, 242, 255, 0.1)';

        nodes.forEach((n, i) => {
            n.update();
            ctx.beginPath(); ctx.arc(n.x, n.y, 1.5, 0, Math.PI * 2); ctx.fill();
            for (let j = i + 1; j < nodes.length; j++) {
                const o = nodes[j];
                const d = Math.sqrt((n.x-o.x)**2 + (n.y-o.y)**2);
                if (d < 150) { ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(o.x, o.y); ctx.stroke(); }
            }
        });
        requestAnimationFrame(animate);
    }

    window.addEventListener('resize', resize);
    resize();
    for (let i = 0; i < nodeCount; i++) nodes.push(new Node());
    animate();
}

// UI TRANSITIONS
function enterWarRoom() {
    const lp = document.getElementById('landing-page');
    const db = document.getElementById('dashboard');
    
    sessionStorage.setItem('swarmOS_dashboard', 'true');
    
    lp.style.opacity = '0';
    lp.style.filter = 'blur(40px)';
    lp.style.transition = '0.8s all ease';
    
    setTimeout(() => {
        lp.style.display = 'none';
        db.classList.add('active');
        db.style.display = 'block';
        setTimeout(() => db.style.opacity = '1', 50);
        updateStats();
        updateLeaderboard();
        updateHeartbeat();
    }, 800);
}

document.addEventListener('DOMContentLoaded', init);
