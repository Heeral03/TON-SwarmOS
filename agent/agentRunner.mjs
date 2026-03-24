/**
 * SwarmOS Autonomous Agent Runner
 * ──────────────────────────────────────────────────────────────
 * A daemon that watches the TON blockchain for new tasks,
 * automatically bids on matching ones, executes real AI work,
 * submits results on-chain, and earns reputation + TON.
 *
 * Usage: node agent/agentRunner.mjs
 * Env vars: BOT_MNEMONIC, AGENT_CAPABILITY, AGENT_PRICE_PER_UNIT
 *   AGENT_CAPABILITY: bitmask (1=price_scanner, 2=content, 4=data)
 */

import { TonClient, WalletContractV4, Address, beginCell, toNano, fromNano, TupleBuilder, internal } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { executeTask as runPriceScanner }    from './handlers/priceScanner.mjs';
import { executeTask as runContentCreator }  from './handlers/contentCreator.mjs';
import { executeTask as runDataAnalyst }     from './handlers/dataAnalyst.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../bot/.env') });

// ── Config ──────────────────────────────────────────────────────
const TON_ENDPOINT        = 'https://testnet.toncenter.com/api/v2/jsonRPC';
const TON_API_KEY         = process.env.TON_API_KEY;
const REGISTRY_ADDRESS    = Address.parse(process.env.REGISTRY_ADDRESS    || 'EQCir-AB7H6u6FhSZMagzCFzSrEYuBz5TA_vkJHrb0hsIeOz');
const REPUTATION_ADDRESS  = Address.parse(process.env.REPUTATION_ADDRESS  || 'EQBfcq2vjkS8Dn8ymnJk6X0pd_e4umeQICBIemOvSY143QXT');
const COORDINATOR_ADDRESS = Address.parse(process.env.COORDINATOR_ADDRESS || 'EQDPnZ0qidH4Y7LYcsud7oUnYqHDXcbkjtJVt5LPza49Q_hA');

// Agent settings (can be overridden in .env)
const AGENT_CAPABILITY    = parseInt(process.env.AGENT_CAPABILITY    || '7');  // 1+2+4 = all capabilities
const AGENT_PRICE         = toNano(process.env.AGENT_PRICE           || '0.03'); // price per unit
const POLL_INTERVAL_MS    = parseInt(process.env.POLL_INTERVAL_MS    || '15000'); // poll every 15s
const BID_RATIO           = parseFloat(process.env.BID_RATIO         || '0.70'); // bid 70% of budget

// Live Heartbeat Config
const TMA_SERVER_URL      = process.env.TMA_SERVER_URL || 'http://localhost:3000';

// ── Opcodes ─────────────────────────────────────────────────────
const OP_REGISTER_AGENT = 0x1001;
const OP_BID_TASK       = 0x2002;
const OP_SUBMIT_RESULT  = 0x2004;

// Task states
const TASK_OPEN     = 0;
const TASK_ASSIGNED = 1;

// ── Capability Handler Map ───────────────────────────────────────
const HANDLERS = {
    1: runPriceScanner,
    2: runContentCreator,
    4: runDataAnalyst,
};

const CAP_NAMES = {
    1: 'price_scanner',
    2: 'content_creator',
    4: 'data_analyst',
};

// ── State ────────────────────────────────────────────────────────
const bidsSent   = new Set(); // taskIds we've already bid on
const tasksWorking = new Set(); // taskIds we're currently working on
let lastKnownTaskId = -1n;

// ── Init ─────────────────────────────────────────────────────────
const ton = new TonClient({ endpoint: TON_ENDPOINT, apiKey: TON_API_KEY });
const keyPair = await mnemonicToPrivateKey((process.env.BOT_MNEMONIC || '').split(' '));
const wallet  = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
const contract = ton.open(wallet);

// ── Helpers ──────────────────────────────────────────────────────
function log(emoji, msg) {
    const t = new Date().toLocaleTimeString();
    console.log(`[${t}] ${emoji}  ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pushLog(status, badge, msg) {
    try {
        await fetch(`${TMA_SERVER_URL}/api/logs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, badge, msg })
        });
    } catch (e) {
        // Silent fail to not break agent if server is down
    }
}

async function sendTx(to, value, body) {
    const seqno = await contract.getSeqno();
    await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [internal({ to, value, body, bounce: false })],
    });
    // Wait for confirmation
    for (let i = 0; i < 30; i++) {
        await sleep(3000);
        try {
            const cur = await contract.getSeqno();
            if (cur > seqno) return true;
        } catch (_) {}
    }
    return false;
}

function hashResult(data) {
    // Simple deterministic hash from result string
    const str = JSON.stringify(data).slice(0, 100);
    let hash = 0n;
    for (const c of str) hash = (hash * 31n + BigInt(c.charCodeAt(0))) % (2n ** 256n);
    return hash;
}

// ── Registration ─────────────────────────────────────────────────
async function ensureRegistered() {
    try {
        const tb = new TupleBuilder();
        tb.writeAddress(wallet.address);
        const res = await ton.runMethod(REGISTRY_ADDRESS, 'getAgent', tb.build());
        const cell = res.stack.readCellOpt();
        if (cell) {
            const msg = 'Already registered in AgentRegistry';
            log('✅', msg);
            await pushLog('success', 'Registry', msg);
            return;
        }
    } catch (_) {}

    log('📋', 'Registering agent...');
    const body = beginCell()
        .storeUint(OP_REGISTER_AGENT, 32)
        .storeUint(AGENT_CAPABILITY, 8)
        .storeCoins(AGENT_PRICE)
        .storeUint(0, 256)
        .endCell();

    await sendTx(REGISTRY_ADDRESS, toNano('1.05'), body);
    const msg = `Registered! Capability: ${AGENT_CAPABILITY}, Price: ${fromNano(AGENT_PRICE)} TON/unit`;
    log('✅', msg);
    await pushLog('success', 'Registry', msg);
}

// ── Task Processing ──────────────────────────────────────────────
function detectCapability(taskCapBit) {
    // Check if agent supports this task's required capability
    return (AGENT_CAPABILITY & taskCapBit) !== 0;
}

async function getHandler(capBit) {
    // Find the highest-priority matching handler
    for (const [bit, handler] of Object.entries(HANDLERS)) {
        if ((capBit & parseInt(bit)) !== 0) return { handler, name: CAP_NAMES[bit] };
    }
    return null;
}

async function handleOpenTask(taskId, task) {
    if (bidsSent.has(taskId)) return; // already bid

    const myCapBit = AGENT_CAPABILITY;
    if (!detectCapability(task.requiredCap)) {
        log('⏭️', `Task ${taskId} requires cap ${task.requiredCap}, I have ${myCapBit} — skipping`);
        return;
    }

    const bidAmount = BigInt(Math.floor(Number(task.budget) * BID_RATIO));
    log('🔨', `Bidding on Task ${taskId} | Budget: ${fromNano(task.budget)} | My bid: ${fromNano(bidAmount)} TON`);

    const body = beginCell()
        .storeUint(OP_BID_TASK, 32)
        .storeUint(taskId, 64)
        .storeCoins(bidAmount)
        .storeUint(3600 * 8, 32)   // 8h delivery time
        .storeUint(0, 256)
        .endCell();

    const ok = await sendTx(COORDINATOR_ADDRESS, toNano('0.05'), body);
    if (ok) {
        bidsSent.add(taskId);
        const msg = `Bid sent for Task ${taskId}! (${fromNano(bidAmount)} TON)`;
        log('✅', msg);
        await pushLog('pending', 'Bidding', msg);
    }
}

async function handleAssignedTask(taskId, task) {
    if (tasksWorking.has(taskId)) return; // already doing it
    // Check if assigned to ME
    if (!task.assignedAgent || task.assignedAgent.toString() !== wallet.address.toString()) return;

    tasksWorking.add(taskId);
    log('🏋️', `I was assigned Task ${taskId}! Starting work...`);

    // Get the right handler
    const handlerInfo = await getHandler(task.requiredCap);
    if (!handlerInfo) {
        log('❌', `No handler for capability ${task.requiredCap}`);
        return;
    }

    log('🤖', `Running ${handlerInfo.name} handler...`);
    const result = await handlerInfo.handler(`Task ${taskId}: ${handlerInfo.name} execution`);

    if (!result.success) {
        log('❌', `Work failed: ${result.summary}`);
        return;
    }

    log('📦', `Work done: ${result.summary}`);
    log('📤', `Submitting result on-chain...`);

    const resultHash = hashResult(result.data);
    const body = beginCell()
        .storeUint(OP_SUBMIT_RESULT, 32)
        .storeUint(taskId, 64)
        .storeUint(resultHash, 256)
        .endCell();

    const balance = await ton.getBalance(wallet.address);
    if (balance < toNano('0.07')) {
        log('⚠️', `Insufficient balance to submit result (${fromNano(balance)} TON). Need ~0.07 TON.`);
        return;
    }

    const ok = await sendTx(COORDINATOR_ADDRESS, toNano('0.05'), body);
    if (ok) {
        const msg = `Task ${taskId} submitted! Hash: 0x${resultHash.toString(16).slice(0, 10)}...`;
        log('✅', msg);
        await pushLog('neon', 'Result', msg);
        
        const payMsg = `Expected payment: ${fromNano(task.winningBid || 0n)} TON`;
        log('💰', payMsg);
        await pushLog('success', 'Payday', `Task #${taskId} finished. ${payMsg}`);
    } else {
        log('❌', `Failed to submit Task ${taskId} on-chain.`);
        await pushLog('info', 'Error', `Failed to submit Task #${taskId} results.`);
    }
}

// ── Main Poll Loop ────────────────────────────────────────────────
async function pollChain() {
    try {
        const res = await ton.runMethod(COORDINATOR_ADDRESS, 'getNextTaskId');
        const count = res.stack.readBigNumber();

        if (count === 0n) return;

        const startId = count > 10n ? count - 10n : 0n; // check last 10 tasks

        for (let i = startId; i < count; i++) {
            const taskRes = await ton.runMethod(COORDINATOR_ADDRESS, 'getTask', [{ type: 'int', value: i }]);
            const cell = taskRes.stack.readCellOpt();
            if (!cell) continue;

            const sc = cell.beginParse();
            sc.loadUintBig(64);              // taskId
            const poster        = sc.loadAddress();
            const requiredCap   = sc.loadUint(8);
            const budget        = sc.loadCoins();
            const state         = sc.loadUint(8);
            const assignedAgent = sc.loadAddress();
            const winningBid    = sc.loadCoins();

            const task = { poster, requiredCap, budget, state, assignedAgent, winningBid };

            if (state === TASK_OPEN) {
                await handleOpenTask(i, task);
                await sleep(1000); // rate limit between bids
            } else if (state === TASK_ASSIGNED) {
                await handleAssignedTask(i, task);
            }
        }
    } catch (e) {
        log('⚠️', `Poll error: ${e.message}`);
    }
}

// ── Agent Status Display ──────────────────────────────────────────
async function printStatus() {
    const balance = await ton.getBalance(wallet.address);
    const tb = new TupleBuilder();
    tb.writeAddress(wallet.address);
    let score = 500;
    try {
        const r = await ton.runMethod(REPUTATION_ADDRESS, 'getScore', tb.build());
        score = r.stack.readNumber();
    } catch (_) {}

    console.log(`\n${'━'.repeat(52)}`);
    console.log(`  🤖 SwarmOS Agent Runner`);
    console.log(`${'━'.repeat(52)}`);
    console.log(`  Address    : ${wallet.address.toString().slice(0, 20)}...`);
    console.log(`  Balance    : ${fromNano(balance)} TON`);
    console.log(`  Reputation : ${score}`);
    console.log(`  Capability : ${AGENT_CAPABILITY} (${Object.entries(CAP_NAMES).filter(([b]) => AGENT_CAPABILITY & parseInt(b)).map(([, n]) => n).join(', ')})`);
    console.log(`  Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
    console.log(`${'━'.repeat(52)}\n`);
}

// ── Start ─────────────────────────────────────────────────────────
await printStatus();
await ensureRegistered();

log('🚀', `Agent is live! Watching for tasks on TON testnet...`);
await pushLog('info', 'Uplink', 'Agent is live! Watching for tasks on TON testnet...');
log('💡', `Post a task in bot: /post 1 0.3 Get me top 10 crypto prices`);

// Main loop
while (true) {
    await pollChain();
    await sleep(POLL_INTERVAL_MS);
}
