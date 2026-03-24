import { Bot, InlineKeyboard } from 'grammy';
import { TonClient, Address, beginCell, toNano, fromNano, WalletContractV4, internal, TupleBuilder } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import * as dotenv from 'dotenv';
dotenv.config();

// ── Config ────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const TON_ENDPOINT = 'https://testnet.toncenter.com/api/v2/jsonRPC';
const TON_API_KEY = process.env.TON_API_KEY;
const REGISTRY_ADDRESS = Address.parse(process.env.REGISTRY_ADDRESS || 'EQCir-AB7H6u6FhSZMagzCFzSrEYuBz5TA_vkJHrb0hsIeOz');
const REPUTATION_ADDRESS = Address.parse(process.env.REPUTATION_ADDRESS || 'EQBfcq2vjkS8Dn8ymnJk6X0pd_e4umeQICBIemOvSY143QXT');
const COORDINATOR_ADDRESS = Address.parse(process.env.COORDINATOR_ADDRESS || 'EQDPnZ0qidH4Y7LYcsud7oUnYqHDXcbkjtJVt5LPza49Q_hA');
const MNEMONIC = process.env.BOT_MNEMONIC;

// ── Opcodes ───────────────────────────────────────────────────
const OP_REGISTER_AGENT = 0x1001;
const OP_POST_TASK = 0x2001;
const OP_BID_TASK = 0x2002;
const OP_ACCEPT_BID = 0x2003;
const OP_SUBMIT_RESULT = 0x2004;
const OP_VERIFY_RESULT = 0x2005;

// ── TON Client & Wallet ───────────────────────────────────────
const ton = new TonClient({ endpoint: TON_ENDPOINT, apiKey: TON_API_KEY });

let keyPair, wallet, contract;
async function initWallet() {
    if (!MNEMONIC) throw new Error('BOT_MNEMONIC not set');
    keyPair = await mnemonicToPrivateKey(MNEMONIC.split(' '));
    wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
    contract = ton.open(wallet);
}

// ── Helpers ───────────────────────────────────────────────────
const CAPABILITIES = {
    '1': 'price_scanner', '2': 'trade_executor', '3': 'strategist',
    '4': 'data_analyst', '5': 'content_creator', '6': 'security_auditor',
    '7': 'arbitrageur'
};

const CAP_BITS = {
    price_scanner: 1, trade_executor: 2, strategist: 4,
    data_analyst: 8, content_creator: 16, security_auditor: 32, arbitrageur: 64
};

function getCapBit(nameOrBit) {
    if (CAP_BITS[nameOrBit]) return CAP_BITS[nameOrBit];
    return parseInt(nameOrBit) || 0;
}

// ── Bot ───────────────────────────────────────────────────────
const bot = new Bot(BOT_TOKEN);

// Initialize wallet before starting
await initWallet();

// /start
bot.command('start', async (ctx) => {
    const keyboard = new InlineKeyboard()
        .text('📊 Swarm Stats', 'stats')
        .text('📋 How It Works', 'howto').row()
        .text('🤖 Agent Info', 'register_info')
        .text('📝 Task Info', 'post_info').row()
        .text('🏦 My Wallet', 'my_wallet')
        .text('📋 Open Tasks', 'list_tasks');

    await ctx.reply(
        `🌐 *TON SwarmOS*
_Autonomous AI Agent Marketplace_

Your wallet: \`${wallet.address.toString()}\`

*Commands:*
/register <cap> <price> — Register as agent
/post <cap> <payment> <desc> — Post a new task
/bid <taskId> <amount> — Bid on a task
/accept <taskId> <agentAddr> — Award task
/submit <taskId> — Submit work
/verify <taskId> — Complete & pay
/tasks — Recent tasks
/bids <taskId> — See bids on a task
/reputation — Check your score
/leaderboard — Top agents by reputation
/wallet — Show balance`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
});

// /reputation
bot.command('reputation', async (ctx) => {
    await ctx.reply('⏳ Fetching reputation...');
    try {
        const tb = new TupleBuilder();
        tb.writeAddress(wallet.address);
        const res = await ton.runMethod(REPUTATION_ADDRESS, 'getScore', tb.build());
        const score = res.stack.readNumber();
        const medal = score >= 700 ? '🥇' : score >= 600 ? '🥈' : score >= 500 ? '🥉' : '⬇️';
        await ctx.reply(`🌟 *Reputation Score:*\n\nAddress: \`${wallet.address.toString()}\`\nScore: *${score}* ${medal}`, { parse_mode: 'Markdown' });
    } catch (e) {
        await ctx.reply('❌ Unknown or unranked. Score is likely default (500).');
    }
});

// /leaderboard — top agents by reputation
bot.command('leaderboard', async (ctx) => {
    await ctx.reply('⏳ Fetching leaderboard...');
    try {
        // Get all registered agents
        const countRes = await ton.runMethod(REGISTRY_ADDRESS, 'getAgentCount');
        const count = countRes.stack.readNumber();
        if (count === 0) return ctx.reply('📭 No agents registered yet.');

        // Unfortunately with current contract we can\'t enumerate agents by index,
        // so show the requesting user\'s score + known agents from tasks
        const tb = new TupleBuilder();
        tb.writeAddress(wallet.address);
        const myScore = (await ton.runMethod(REPUTATION_ADDRESS, 'getScore', tb.build())).stack.readNumber();

        // Scan task assignees to gather unique agents we\'ve seen
        const agents = new Map();
        agents.set(wallet.address.toString(), myScore);

        const nextId = await ton.runMethod(COORDINATOR_ADDRESS, 'getNextTaskId');
        const taskCount = nextId.stack.readBigNumber();
        const start = taskCount > 20n ? taskCount - 20n : 0n;
        for (let i = start; i < taskCount; i++) {
            try {
                const r = await ton.runMethod(COORDINATOR_ADDRESS, 'getTask', [{ type: 'int', value: i }]);
                const cell = r.stack.readCellOpt();
                if (!cell) continue;
                const sc = cell.beginParse();
                sc.loadUintBig(64); sc.loadAddress(); sc.loadUint(8); sc.loadCoins(); sc.loadUint(8);
                const agent = sc.loadAddress();
                if (!agents.has(agent.toString())) {
                    const tb2 = new TupleBuilder();
                    tb2.writeAddress(agent);
                    const s = (await ton.runMethod(REPUTATION_ADDRESS, 'getScore', tb2.build())).stack.readNumber();
                    agents.set(agent.toString(), s);
                }
            } catch (_) {}
        }

        const sorted = [...agents.entries()].sort((a, b) => b[1] - a[1]);
        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
        let text = `🏆 *Agent Leaderboard*\n_(${sorted.length} agents found)_\n\n`;
        sorted.slice(0, 5).forEach(([addr, score], i) => {
            text += `${medals[i] || `${i+1}.`} \`${addr.slice(0, 8)}...${addr.slice(-4)}\` — Score: *${score}*\n`;
        });
        await ctx.reply(text, { parse_mode: 'Markdown' });
    } catch (e) {
        await ctx.reply('❌ Error fetching leaderboard: ' + e.message);
    }
});

// /bids <taskId> — show all bids on a task
bot.command('bids', async (ctx) => {
    const args = ctx.match.trim().split(' ');
    const taskId = BigInt(args[0] || 0);
    console.log(`[BIDS] Checking Task ${taskId}...`);
    await ctx.reply(`⏳ Fetching bids for Task ${taskId}...`);
    try {
        const nextId = await ton.runMethod(COORDINATOR_ADDRESS, 'getNextTaskId');
        const taskCount = nextId.stack.readBigNumber();
        const start = taskCount > 20n ? taskCount - 20n : 0n;

        const agentAddrs = new Set([wallet.address.toString()]);
        for (let i = start; i < taskCount; i++) {
            try {
                const r = await ton.runMethod(COORDINATOR_ADDRESS, 'getTask', [{ type: 'int', value: i }]);
                const cell = r.stack.readCellOpt();
                if (!cell) continue;
                const sc = cell.beginParse();
                sc.loadUintBig(64); sc.loadAddress(); sc.loadUint(8); sc.loadCoins(); sc.loadUint(8);
                const assigned = sc.loadAddress();
                if (assigned.toString() !== "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c") {
                    agentAddrs.add(assigned.toString());
                }
            } catch (_) {}
        }

        console.log(`[BIDS] Agent addresses to check:`, Array.from(agentAddrs));
        let bidsText = '';
        let bidCount = 0;
        for (const addrStr of agentAddrs) {
            try {
                const addr = Address.parse(addrStr);
                const tb = new TupleBuilder();
                tb.writeNumber(taskId);
                tb.writeAddress(addr);
                const r = await ton.runMethod(COORDINATOR_ADDRESS, 'getBid', tb.build());
                const cell = r.stack.readCellOpt();
                if (!cell) {
                    console.log(`[BIDS] No bid for ${addrStr.slice(0,10)}...`);
                    continue;
                }
                
                const sc = cell.beginParse();
                const agent = sc.loadAddress();
                const bidAmount = sc.loadCoins();
                const deliveryTime = sc.loadUint(32);
                
                console.log(`[BIDS] Found bid for ${addrStr.slice(0,10)}... -> ${fromNano(bidAmount)} TON`);
                bidCount++;
                bidsText += `🔹 Agent: \`${addrStr.slice(0, 8)}...\` | Bid: *${fromNano(bidAmount)} TON* | Delivery: ${Math.round(deliveryTime / 3600)}h\n`;
            } catch (e) {
                console.error(`[BIDS] Error fetching bid for ${addrStr}:`, e.message);
            }
        }

        if (bidCount === 0) return ctx.reply(`📭 No bids found on Task ${taskId}.`);
        await ctx.reply(`📨 *Bids on Task ${taskId}* (${bidCount} total):\n\n` + bidsText, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error(`[BIDS] Global error:`, e.message);
        await ctx.reply('❌ Error: ' + e.message);
    }
});


// /wallet
bot.command('wallet', async (ctx) => {
    const balance = await ton.getBalance(wallet.address);
    await ctx.reply(`🏦 *Wallet Status*\n\nAddress: \`${wallet.address.toString()}\`\nBalance: *${fromNano(balance)} TON*`, { parse_mode: 'Markdown' });
});
bot.callbackQuery('my_wallet', async (ctx) => {
    const balance = await ton.getBalance(wallet.address);
    await ctx.reply(`🏦 *Wallet Status*\n\nAddress: \`${wallet.address.toString()}\`\nBalance: *${fromNano(balance)} TON*`, { parse_mode: 'Markdown' });
});

// /register <cap> <price>
bot.command('register', async (ctx) => {
    const args = ctx.match.split(' ');
    if (args.length < 2) return ctx.reply('Usage: `/register <capability> <price_ton>`\nExample: `/register price_scanner 0.1`', { parse_mode: 'Markdown' });

    const cap = getCapBit(args[0]);
    const price = toNano(args[1]);

    // Check balance first
    const balance = await ton.getBalance(wallet.address);
    if (balance < toNano('1.1')) {
        return ctx.reply(
            `❌ *Insufficient Balance!*\n\nBot wallet needs at least *1.1 TON* to register (1 TON stake + gas).\n\nCurrent balance: *${fromNano(balance)} TON*\n\nPlease top up: \`${wallet.address.toString()}\``,
            { parse_mode: 'Markdown' }
        );
    }

    const seqno = await contract.getSeqno();
    await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
            internal({
                to: REGISTRY_ADDRESS,
                value: toNano('1.0'), // 1 TON for registration + stake
                body: beginCell()
                    .storeUint(OP_REGISTER_AGENT, 32)
                    .storeUint(cap, 8)
                    .storeCoins(price)
                    .storeUint(0, 256) // empty endpoint hash
                    .endCell()
            })
        ]
    });
    await ctx.reply('🚀 *Registration Sent!*\nWaiting for blockchain confirmation...', { parse_mode: 'Markdown' });
});

// /post <cap> <payment> <desc>
bot.command('post', async (ctx) => {
    const args = ctx.match.split(' ');
    if (args.length < 3) return ctx.reply('Usage: `/post <cap> <payment_ton> <desc...>`\nExample: `/post 1 5.0 Need price scan`', { parse_mode: 'Markdown' });

    const cap = getCapBit(args[0]);
    const payment = toNano(args[1]);
    const desc = args.slice(2).join(' ');

    // Check balance first
    const balance = await ton.getBalance(wallet.address);
    const required = payment + toNano('0.1');
    if (balance < required) {
        return ctx.reply(
            `❌ *Insufficient Balance!*\n\nNeed at least *${fromNano(required)} TON* to post this task.\n\nCurrent balance: *${fromNano(balance)} TON*\n\nPlease top up: \`${wallet.address.toString()}\``,
            { parse_mode: 'Markdown' }
        );
    }

    const seqno = await contract.getSeqno();
    await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
            internal({
                to: COORDINATOR_ADDRESS,
                value: payment + toNano('0.05'), // payment + gas
                body: beginCell()
                    .storeUint(OP_POST_TASK, 32)
                    .storeUint(0, 256) // desc hash dummy
                    .storeUint(cap, 8)
                    .storeUint(3600 * 24, 32) // 24h deadline
                    .endCell()
            })
        ]
    });
    await ctx.reply('📝 *Task Posting Sent!*\nLocked payment in escrow.\nWaiting for confirmation...', { parse_mode: 'Markdown' });
});

// /tasks
bot.command('tasks', async (ctx) => {
    await ctx.reply('⏳ Fetching tasks...');
    try {
        const nextId = await ton.runMethod(COORDINATOR_ADDRESS, 'getNextTaskId');
        const count = nextId.stack.readBigNumber();
        let taskText = '';
        let displayCount = 0;
        const startId = count > 5n ? count - 5n : 0n;

        for (let i = startId; i < count; i++) {
            const res = await ton.runMethod(COORDINATOR_ADDRESS, 'getTask', [{ type: 'int', value: i }]);
            const cell = res.stack.readCellOpt();
            if (cell) {
                const sc = cell.beginParse();
                sc.loadUintBig(64); // taskId
                const poster = sc.loadAddress();
                sc.loadUint(8); // cap
                const budget = sc.loadCoins();
                const state = sc.loadUint(8);

                const status = ['OPEN', 'ASSIGNED', 'VERIFYING', 'COMPLETED', 'DISPUTED', 'EXPIRED', 'CANCELLED'][state];
                displayCount++;
                taskText += `🔹 *ID: ${i}* | Status: \`${status}\` | Budget: *${fromNano(budget)} TON*\n`;
                taskText += `   Poster: \`${poster.toString().slice(0, 6)}...${poster.toString().slice(-4)}\`\n\n`;
            }
        }
        let text = `📋 *Recent Tasks (${displayCount})*\n\n` + taskText;
        if (displayCount === 0) text = "📋 *No tasks found.*";
        await ctx.reply(text, { parse_mode: 'Markdown' });
    } catch (e) {
        await ctx.reply('❌ Error: ' + e.message);
    }
});
bot.callbackQuery('list_tasks', async (ctx) => {
    ctx.answerCallbackQuery();
    await ctx.reply('⏳ Fetching tasks...');
    const nextId = await ton.runMethod(COORDINATOR_ADDRESS, 'getNextTaskId');
    await ctx.reply(`📋 Total Tasks: *${nextId.stack.readBigNumber()}*\nCheck /tasks for list.`, { parse_mode: 'Markdown' });
});

// /bid <taskId> <amount>
bot.command('bid', async (ctx) => {
    const args = ctx.match.split(' ');
    if (args.length < 2) return ctx.reply('Usage: `/bid <id> <ton>`');
    const id = BigInt(args[0]);
    const amt = toNano(args[1]);
    const seqno = await contract.getSeqno();
    await contract.sendTransfer({
        seqno, secretKey: keyPair.secretKey,
        messages: [internal({
            to: COORDINATOR_ADDRESS, value: toNano('0.05'),
            body: beginCell().storeUint(OP_BID_TASK, 32).storeUint(id, 64).storeCoins(amt).storeUint(3600, 32).storeUint(0, 256).endCell()
        })]
    });
    ctx.reply('🔨 *Bid Sent!*');
});

// /accept <taskId> <agent>
bot.command('accept', async (ctx) => {
    const args = ctx.match.split(' ');
    if (args.length < 2) return ctx.reply('Usage: `/accept <id> <address>`');
    const id = BigInt(args[0]);
    const agent = Address.parse(args[1]);
    const seqno = await contract.getSeqno();
    await contract.sendTransfer({
        seqno, secretKey: keyPair.secretKey,
        messages: [internal({
            to: COORDINATOR_ADDRESS, value: toNano('0.05'),
            body: beginCell().storeUint(OP_ACCEPT_BID, 32).storeUint(id, 64).storeAddress(agent).endCell()
        })]
    });
    ctx.reply('🤝 *Bid Accepted!*');
});

// /submit <taskId>
bot.command('submit', async (ctx) => {
    const id = BigInt(ctx.match);
    if (!id && id !== 0n) return ctx.reply('Usage: `/submit <id>`');
    const seqno = await contract.getSeqno();
    await contract.sendTransfer({
        seqno, secretKey: keyPair.secretKey,
        messages: [internal({
            to: COORDINATOR_ADDRESS, value: toNano('0.05'),
            body: beginCell().storeUint(OP_SUBMIT_RESULT, 32).storeUint(id, 64).storeUint(0, 256).endCell() // dummy result hash
        })]
    });
    ctx.reply('📤 *Work Submitted!* Waiting for verification from poster.');
});

// /verify <taskId>
bot.command('verify', async (ctx) => {
    const id = BigInt(ctx.match);
    if (!id && id !== 0n) return ctx.reply('Usage: `/verify <id>`');
    const seqno = await contract.getSeqno();
    const ok = await contract.sendTransfer({
        seqno, secretKey: keyPair.secretKey,
        messages: [internal({
            to: COORDINATOR_ADDRESS, value: toNano('0.05'),
            body: beginCell().storeUint(OP_VERIFY_RESULT, 32).storeUint(id, 64).endCell()
        })]
    });
    
    // PUSH TO LIVE HEARTBEAT
    try {
        await fetch(`http://localhost:3000/api/logs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                status: 'success', 
                badge: 'Verified', 
                msg: `Task #${id} verified by poster. Funds released!` 
            })
        });
    } catch (e) {}

    ctx.reply('✅ *Work Verified!* Payment released.');
});

// Existing commands integration
bot.command('stats', async (ctx) => {
    const s = await getStats();
    ctx.reply(`📊 *Stats*\nAgents: ${s.agents}\nTasks: ${s.tasks}\nStake: ${s.stake} TON`, { parse_mode: 'Markdown' });
});

async function getStats() {
    const [agents, tasks, stake] = await Promise.all([
        ton.runMethod(REGISTRY_ADDRESS, 'getAgentCount').then(r => r.stack.readNumber()),
        ton.runMethod(COORDINATOR_ADDRESS, 'getNextTaskId').then(r => r.stack.readBigNumber()),
        ton.runMethod(REGISTRY_ADDRESS, 'getTotalStake').then(r => fromNano(r.stack.readBigNumber())),
    ]);
    return { agents, tasks: tasks.toString(), stake };
}

bot.start();
console.log('🤖 TON SwarmOS Bot running — @tonswarm_bot');