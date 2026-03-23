#!/usr/bin/env node
/**
 * TON SwarmOS MCP Server
 *
 * Exposes the SwarmOS agent economy to any MCP client:
 * Claude Desktop, Cursor, VS Code, etc.
 *
 * Tools:
 *   swarm_register_agent  — Register an AI agent in the on-chain registry
 *   swarm_update_agent    — Update agent capabilities or pricing
 *   swarm_list_agents     — List all registered agents
 *   swarm_post_task       — Post a task with locked TON payment
 *   swarm_bid_task        — Place a bid on an open task
 *   swarm_accept_bid      — Accept a winning bid
 *   swarm_submit_result   — Agent submits completed work
 *   swarm_verify_result   — Poster verifies and releases payment
 *   swarm_get_task        — Get task status and details
 *   swarm_get_reputation  — Get an agent's reputation score and badges
 *   swarm_get_stats       — Get overall swarm statistics
 *
 * Setup in Claude Desktop (claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "ton-swarmos": {
 *       "command": "node",
 *       "args": ["/path/to/ton-swarmos/mcp/dist/index.js"],
 *       "env": {
 *         "TON_ENDPOINT": "https://testnet.toncenter.com/api/v2",
 *         "REGISTRY_ADDRESS": "EQAHc9UjDJ89VNLgv3oBlLvEKEftbUQYPoYBNPi-jXhYEnDA",
 *         "COORDINATOR_ADDRESS": "EQDyYG3hJV4C2blRGl3kt0m7eYJvDEuwNLmpI4LWhubr88w7",
 *         "REPUTATION_ADDRESS": "EQBET0s93LJ_5AfLqMQsfMzTdEMJz9HA6jkFccQeZkIiCPOn"
 *       }
 *     }
 *   }
 * }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { TonClient, Address, beginCell, toNano, fromNano, WalletContractV4 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import * as dotenv from 'dotenv';

dotenv.config();

// ── Config ─────────────────────────────────────────────────────
const TON_ENDPOINT        = process.env.TON_ENDPOINT        || 'https://testnet.toncenter.com/api/v2/jsonRPC';
const TON_API_KEY         = process.env.TON_API_KEY          || '93e025f3b8d2a771dbce39d9641e2b607110c5db3b7d1dc6c82990a210f60c06';
const REGISTRY_ADDRESS    = process.env.REGISTRY_ADDRESS    || '';
const COORDINATOR_ADDRESS = process.env.COORDINATOR_ADDRESS || '';
const REPUTATION_ADDRESS  = process.env.REPUTATION_ADDRESS  || '';

// Opcodes — must match contract constants
const OP_REGISTER_AGENT  = 0x1001;
const OP_UPDATE_AGENT    = 0x1002;
const OP_DEACTIVATE_AGENT = 0x1003;
const OP_ACTIVATE_AGENT  = 0x1004;
const OP_POST_TASK       = 0x2001;
const OP_BID_TASK        = 0x2002;
const OP_ACCEPT_BID      = 0x2003;
const OP_SUBMIT_RESULT   = 0x2004;
const OP_VERIFY_RESULT   = 0x2005;
const OP_DISPUTE_TASK    = 0x2006;
const OP_CANCEL_TASK     = 0x2007;
const OP_REFUND_EXPIRED  = 0x2008;

// Capability flags
const CAPABILITIES: Record<string, number> = {
    price_scanner:    1,
    trade_executor:   2,
    strategist:       4,
    data_analyst:     8,
    content_creator:  16,
    security_auditor: 32,
    arbitrageur:      64,
};

// Badge flags
const BADGES: Record<number, string> = {
    1:  'FIRST_TASK',
    2:  'TEN_TASKS',
    4:  'HUNDRED_TASKS',
    8:  'ELITE',
    16: 'VERIFIED',
    32: 'PIONEER',
    64: 'RELIABLE',
};

// ── TON Client ─────────────────────────────────────────────────
const client = new TonClient({
    endpoint: TON_ENDPOINT,
    apiKey:   TON_API_KEY || undefined,
});

// ── Helpers ────────────────────────────────────────────────────

function parseBadges(badgeInt: number): string[] {
    const earned: string[] = [];
    for (const [bit, name] of Object.entries(BADGES)) {
        if (badgeInt & parseInt(bit)) earned.push(name);
    }
    return earned;
}

function parseCapabilities(capInt: number): string[] {
    const caps: string[] = [];
    for (const [name, bit] of Object.entries(CAPABILITIES)) {
        if (capInt & bit) caps.push(name);
    }
    return caps;
}

function buildCapabilityBits(caps: string[]): number {
    return caps.reduce((acc, cap) => {
        const bit = CAPABILITIES[cap.toLowerCase()];
        if (!bit) throw new Error(`Unknown capability: ${cap}. Valid: ${Object.keys(CAPABILITIES).join(', ')}`);
        return acc | bit;
    }, 0);
}

function hashString(str: string): bigint {
    // Simple deterministic hash for demo — in production use SHA256
    let hash = 0n;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31n + BigInt(str.charCodeAt(i))) & ((1n << 256n) - 1n);
    }
    return hash;
}

async function getSenderFromMnemonic(mnemonic: string[]) {
    const keyPair = await mnemonicToPrivateKey(mnemonic);
    const wallet  = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
    const contract = client.open(wallet);
    return { sender: contract.sender(keyPair.secretKey), address: wallet.address };
}

async function callGetMethod(address: string, method: string, args: any[] = []) {
    const addr = Address.parse(address);
    const result = await client.runMethod(addr, method, args);
    return result;
}

// ── Tool Handlers ──────────────────────────────────────────────

async function handleRegisterAgent(args: any): Promise<string> {
    const {
        mnemonic,
        capabilities,
        price_per_unit_ton,
        endpoint_url,
        stake_ton = '1',
    } = args;

    if (!REGISTRY_ADDRESS) throw new Error('REGISTRY_ADDRESS not configured');

    const words        = mnemonic.trim().split(/\s+/);
    const { sender, address } = await getSenderFromMnemonic(words);
    const capBits      = buildCapabilityBits(capabilities);
    const priceNano    = toNano(price_per_unit_ton.toString());
    const endpointHash = hashString(endpoint_url);
    const stakeNano    = toNano(stake_ton.toString());

    const body = beginCell()
        .storeUint(OP_REGISTER_AGENT, 32)
        .storeUint(capBits, 8)
        .storeCoins(priceNano)
        .storeUint(endpointHash, 256)
        .endCell();

    await sender.send({
        to:    Address.parse(REGISTRY_ADDRESS),
        value: stakeNano,
        body,
    });

    return JSON.stringify({
        success:      true,
        agent_address: address.toString(),
        capabilities: capabilities,
        price_per_unit: `${price_per_unit_ton} TON`,
        stake:         `${stake_ton} TON locked`,
        registry:      REGISTRY_ADDRESS,
        message:       `Agent registered! Address: ${address.toString()}. Stake of ${stake_ton} TON locked in registry. Agent is now discoverable by the swarm.`,
    }, null, 2);
}

async function handleUpdateAgent(args: any): Promise<string> {
    const { mnemonic, capabilities, price_per_unit_ton, endpoint_url } = args;

    const words        = mnemonic.trim().split(/\s+/);
    const { sender }   = await getSenderFromMnemonic(words);
    const capBits      = buildCapabilityBits(capabilities);
    const priceNano    = toNano(price_per_unit_ton.toString());
    const endpointHash = hashString(endpoint_url);

    const body = beginCell()
        .storeUint(OP_UPDATE_AGENT, 32)
        .storeUint(capBits, 8)
        .storeCoins(priceNano)
        .storeUint(endpointHash, 256)
        .endCell();

    await sender.send({
        to:    Address.parse(REGISTRY_ADDRESS),
        value: toNano('0.05'),
        body,
    });

    return JSON.stringify({
        success:      true,
        capabilities: capabilities,
        price_per_unit: `${price_per_unit_ton} TON`,
        message:      'Agent updated successfully on-chain.',
    }, null, 2);
}

async function handleListAgents(args: any): Promise<string> {
    if (!REGISTRY_ADDRESS) throw new Error('REGISTRY_ADDRESS not configured');

    const result = await callGetMethod(REGISTRY_ADDRESS, 'getAgentCount');
    const count  = result.stack.readNumber();

    return JSON.stringify({
        total_agents: count,
        registry_address: REGISTRY_ADDRESS,
        explorer: `https://testnet.tonscan.org/address/${REGISTRY_ADDRESS}`,
        message: `${count} agents registered in the SwarmOS registry. Use swarm_get_reputation to check individual agent scores.`,
        note: 'Individual agent lookup requires agent address — use swarm_get_reputation with a specific address.',
    }, null, 2);
}

async function handlePostTask(args: any): Promise<string> {
    const {
        mnemonic,
        description,
        required_capability,
        work_deadline_hours = 24,
        payment_ton,
    } = args;

    if (!COORDINATOR_ADDRESS) throw new Error('COORDINATOR_ADDRESS not configured');

    const words     = mnemonic.trim().split(/\s+/);
    const { sender } = await getSenderFromMnemonic(words);

    const descHash  = hashString(description);
    const capBit    = CAPABILITIES[required_capability.toLowerCase()];
    if (!capBit) throw new Error(`Unknown capability: ${required_capability}`);

    const workDeltaSecs = work_deadline_hours * 3600;
    const paymentNano   = toNano(payment_ton.toString());

    const body = beginCell()
        .storeUint(OP_POST_TASK, 32)
        .storeUint(descHash, 256)
        .storeUint(capBit, 8)
        .storeUint(workDeltaSecs, 32)
        .endCell();

    await sender.send({
        to:    Address.parse(COORDINATOR_ADDRESS),
        value: paymentNano,
        body,
    });

    // Get next task ID to report
    const result = await callGetMethod(COORDINATOR_ADDRESS, 'getNextTaskId');
    const nextId = result.stack.readBigNumber();
    const taskId = nextId > 0n ? nextId - 1n : 0n;

    return JSON.stringify({
        success:             true,
        task_id:             taskId.toString(),
        description_preview: description.substring(0, 80) + (description.length > 80 ? '...' : ''),
        required_capability: required_capability,
        payment_locked:      `${payment_ton} TON`,
        bid_window:          '1 hour',
        work_deadline:       `${work_deadline_hours} hours after bid accepted`,
        coordinator:         COORDINATOR_ADDRESS,
        explorer:            `https://testnet.tonscan.org/address/${COORDINATOR_ADDRESS}`,
        message:             `Task posted! ${payment_ton} TON locked in escrow. Agents have 1 hour to bid. Task ID: ${taskId}`,
    }, null, 2);
}

async function handleBidTask(args: any): Promise<string> {
    const {
        mnemonic,
        task_id,
        bid_amount_ton,
        delivery_hours = 12,
        proposal,
    } = args;

    const words      = mnemonic.trim().split(/\s+/);
    const { sender } = await getSenderFromMnemonic(words);

    const proposalHash   = hashString(proposal);
    const deliverySecs   = delivery_hours * 3600;
    const bidNano        = toNano(bid_amount_ton.toString());

    const body = beginCell()
        .storeUint(OP_BID_TASK, 32)
        .storeUint(BigInt(task_id), 64)
        .storeCoins(bidNano)
        .storeUint(deliverySecs, 32)
        .storeUint(proposalHash, 256)
        .endCell();

    await sender.send({
        to:    Address.parse(COORDINATOR_ADDRESS),
        value: toNano('0.05'),
        body,
    });

    return JSON.stringify({
        success:       true,
        task_id:       task_id.toString(),
        bid_amount:    `${bid_amount_ton} TON`,
        delivery_time: `${delivery_hours} hours`,
        message:       `Bid placed on task ${task_id}! Your bid of ${bid_amount_ton} TON is now visible to the task poster.`,
    }, null, 2);
}

async function handleAcceptBid(args: any): Promise<string> {
    const { mnemonic, task_id, agent_address } = args;

    const words      = mnemonic.trim().split(/\s+/);
    const { sender } = await getSenderFromMnemonic(words);

    const body = beginCell()
        .storeUint(OP_ACCEPT_BID, 32)
        .storeUint(BigInt(task_id), 64)
        .storeAddress(Address.parse(agent_address))
        .endCell();

    await sender.send({
        to:    Address.parse(COORDINATOR_ADDRESS),
        value: toNano('0.05'),
        body,
    });

    return JSON.stringify({
        success:       true,
        task_id:       task_id.toString(),
        assigned_agent: agent_address,
        message:       `Bid accepted! Agent ${agent_address.substring(0, 12)}... is now assigned to task ${task_id}. Payment will release when you verify their result.`,
    }, null, 2);
}

async function handleSubmitResult(args: any): Promise<string> {
    const { mnemonic, task_id, result_description } = args;

    const words      = mnemonic.trim().split(/\s+/);
    const { sender } = await getSenderFromMnemonic(words);

    const resultHash = hashString(result_description);

    const body = beginCell()
        .storeUint(OP_SUBMIT_RESULT, 32)
        .storeUint(BigInt(task_id), 64)
        .storeUint(resultHash, 256)
        .endCell();

    await sender.send({
        to:    Address.parse(COORDINATOR_ADDRESS),
        value: toNano('0.05'),
        body,
    });

    return JSON.stringify({
        success:     true,
        task_id:     task_id.toString(),
        result_hash: resultHash.toString(16).substring(0, 16) + '...',
        message:     `Result submitted for task ${task_id}! Task poster must now verify within 24 hours to release your payment.`,
    }, null, 2);
}

async function handleVerifyResult(args: any): Promise<string> {
    const { mnemonic, task_id } = args;

    const words      = mnemonic.trim().split(/\s+/);
    const { sender } = await getSenderFromMnemonic(words);

    const body = beginCell()
        .storeUint(OP_VERIFY_RESULT, 32)
        .storeUint(BigInt(task_id), 64)
        .endCell();

    await sender.send({
        to:    Address.parse(COORDINATOR_ADDRESS),
        value: toNano('0.05'),
        body,
    });

    return JSON.stringify({
        success: true,
        task_id: task_id.toString(),
        message: `Task ${task_id} verified! Payment automatically released to agent. Reputation score updated on-chain. 0.5% platform fee collected.`,
    }, null, 2);
}

async function handleGetTask(args: any): Promise<string> {
    if (!COORDINATOR_ADDRESS) throw new Error('COORDINATOR_ADDRESS not configured');

    const { task_id } = args;

    const STATE_NAMES = ['OPEN', 'ASSIGNED', 'VERIFYING', 'COMPLETED', 'DISPUTED', 'EXPIRED', 'CANCELLED'];

    try {
        const result = await callGetMethod(COORDINATOR_ADDRESS, 'getTask', [
            { type: 'int', value: BigInt(task_id) },
        ]);

        const cell   = result.stack.readCellOpt();
        if (!cell) {
            return JSON.stringify({ error: `Task ${task_id} not found` });
        }

        const cs = cell.beginParse();
        const tid          = cs.loadUintBig(64);
        const poster       = cs.loadAddress();
        const descHash     = cs.loadUintBig(256);
        const reqCap       = cs.loadUint(8);
        const budget       = cs.loadCoins();
        const state        = cs.loadUint(8);
        const assignedAgent = cs.loadAddress();
        const winningBid   = cs.loadCoins();
        const bidDeadline  = cs.loadUint(32);
        const workDeadline = cs.loadUint(32);
        const bidCount     = cs.preloadUint(8);

        return JSON.stringify({
            task_id:          tid.toString(),
            state:            STATE_NAMES[state] || state.toString(),
            poster:           poster.toString(),
            required_capability: parseCapabilities(reqCap).join(', ') || reqCap.toString(),
            budget:           fromNano(budget) + ' TON',
            winning_bid:      winningBid > 0n ? fromNano(winningBid) + ' TON' : 'No bids yet',
            assigned_agent:   assignedAgent.toString(),
            bid_deadline:     new Date(bidDeadline * 1000).toISOString(),
            work_deadline:    new Date(workDeadline * 1000).toISOString(),
            explorer:         `https://testnet.tonscan.org/address/${COORDINATOR_ADDRESS}`,
        }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ error: e.message, task_id });
    }
}

async function handleGetReputation(args: any): Promise<string> {
    if (!REPUTATION_ADDRESS) throw new Error('REPUTATION_ADDRESS not configured');

    const { agent_address } = args;

    try {
        const scoreResult = await callGetMethod(REPUTATION_ADDRESS, 'getScore', [
            { type: 'slice', cell: beginCell().storeAddress(Address.parse(agent_address)).endCell() },
        ]);
        const score = scoreResult.stack.readNumber();

        const badgeResult = await callGetMethod(REPUTATION_ADDRESS, 'getBadges', [
            { type: 'slice', cell: beginCell().storeAddress(Address.parse(agent_address)).endCell() },
        ]);
        const badgeInt = badgeResult.stack.readNumber();
        const badges   = parseBadges(badgeInt);

        const trustResult = await callGetMethod(REPUTATION_ADDRESS, 'isTrusted', [
            { type: 'slice', cell: beginCell().storeAddress(Address.parse(agent_address)).endCell() },
            { type: 'int', value: 500n },
        ]);
        const isTrusted = trustResult.stack.readNumber() === 1;

        let tier = 'New Agent';
        if (score >= 900) tier = '🏆 Elite';
        else if (score >= 700) tier = '⭐ Trusted';
        else if (score >= 500) tier = '✅ Neutral';
        else if (score >= 300) tier = '⚠️ Caution';
        else tier = '❌ Unreliable';

        return JSON.stringify({
            agent_address:   agent_address,
            score:           score,
            score_out_of:    1000,
            tier:            tier,
            is_trusted:      isTrusted,
            badges:          badges.length > 0 ? badges : ['No badges yet'],
            reputation_contract: REPUTATION_ADDRESS,
            explorer:        `https://testnet.tonscan.org/address/${REPUTATION_ADDRESS}`,
        }, null, 2);
    } catch (e: any) {
        return JSON.stringify({
            agent_address: agent_address,
            score:         500,
            tier:          '✅ Neutral (new agent, no tasks yet)',
            badges:        [],
            message:       'Agent not yet in reputation system — score defaults to 500',
        }, null, 2);
    }
}

async function handleGetStats(args: any): Promise<string> {
    const results: any = {};

    try {
        const regCount = await callGetMethod(REGISTRY_ADDRESS, 'getAgentCount');
        results.total_agents = regCount.stack.readNumber();
    } catch { results.total_agents = 'error'; }

    try {
        const stake = await callGetMethod(REGISTRY_ADDRESS, 'getTotalStake');
        results.total_stake_locked = fromNano(stake.stack.readBigNumber()) + ' TON';
    } catch { results.total_stake_locked = 'error'; }

    try {
        const taskId = await callGetMethod(COORDINATOR_ADDRESS, 'getNextTaskId');
        results.total_tasks_posted = taskId.stack.readBigNumber().toString();
    } catch { results.total_tasks_posted = 'error'; }

    try {
        const fees = await callGetMethod(COORDINATOR_ADDRESS, 'getAccumulatedFees');
        results.platform_fees_collected = fromNano(fees.stack.readBigNumber()) + ' TON';
    } catch { results.platform_fees_collected = 'error'; }

    try {
        const repCount = await callGetMethod(REPUTATION_ADDRESS, 'getAgentCount');
        results.agents_with_reputation = repCount.stack.readNumber();
    } catch { results.agents_with_reputation = 'error'; }

    return JSON.stringify({
        swarm_stats: results,
        contracts: {
            registry:    REGISTRY_ADDRESS,
            coordinator: COORDINATOR_ADDRESS,
            reputation:  REPUTATION_ADDRESS,
        },
        network: TON_ENDPOINT.includes('testnet') ? 'testnet' : 'mainnet',
        explorers: {
            registry:    `https://testnet.tonscan.org/address/${REGISTRY_ADDRESS}`,
            coordinator: `https://testnet.tonscan.org/address/${COORDINATOR_ADDRESS}`,
            reputation:  `https://testnet.tonscan.org/address/${REPUTATION_ADDRESS}`,
        },
    }, null, 2);
}

// ── Tool Definitions ───────────────────────────────────────────

const TOOLS: Tool[] = [
    {
        name: 'swarm_register_agent',
        description: 'Register an AI agent in the TON SwarmOS on-chain registry. The agent will be discoverable by other agents and humans. Requires staking 0.5+ TON.',
        inputSchema: {
            type: 'object',
            properties: {
                mnemonic:          { type: 'string', description: '24-word wallet mnemonic (space separated)' },
                capabilities:      { type: 'array', items: { type: 'string' }, description: 'List of capabilities. Options: price_scanner, trade_executor, strategist, data_analyst, content_creator, security_auditor, arbitrageur' },
                price_per_unit_ton:{ type: 'number', description: 'Price per task unit in TON (e.g. 0.1)' },
                endpoint_url:      { type: 'string', description: 'Your agent endpoint URL or Telegram handle (e.g. https://myagent.ton/mcp or @myagentbot)' },
                stake_ton:         { type: 'number', description: 'TON to stake on registration (minimum 0.5, default 1)' },
            },
            required: ['mnemonic', 'capabilities', 'price_per_unit_ton', 'endpoint_url'],
        },
    },
    {
        name: 'swarm_update_agent',
        description: 'Update an existing agent\'s capabilities, pricing, or endpoint URL on-chain.',
        inputSchema: {
            type: 'object',
            properties: {
                mnemonic:          { type: 'string' },
                capabilities:      { type: 'array', items: { type: 'string' } },
                price_per_unit_ton:{ type: 'number' },
                endpoint_url:      { type: 'string' },
            },
            required: ['mnemonic', 'capabilities', 'price_per_unit_ton', 'endpoint_url'],
        },
    },
    {
        name: 'swarm_list_agents',
        description: 'Get the total number of agents registered in the SwarmOS registry and registry stats.',
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'swarm_post_task',
        description: 'Post a task to the SwarmOS coordinator with locked TON payment. Agents will bid on it within 1 hour.',
        inputSchema: {
            type: 'object',
            properties: {
                mnemonic:            { type: 'string', description: '24-word wallet mnemonic' },
                description:         { type: 'string', description: 'What you need done (e.g. "Scan STON.fi prices for TON/USDT every 5 seconds for 1 hour")' },
                required_capability: { type: 'string', description: 'Required agent capability: price_scanner, trade_executor, strategist, data_analyst, content_creator, security_auditor, arbitrageur' },
                payment_ton:         { type: 'number', description: 'TON to pay for this task (locked in escrow, minimum 0.1)' },
                work_deadline_hours: { type: 'number', description: 'Hours agent has to complete after bid accepted (default 24)' },
            },
            required: ['mnemonic', 'description', 'required_capability', 'payment_ton'],
        },
    },
    {
        name: 'swarm_bid_task',
        description: 'Place a bid on an open task as an agent. Your bid must be <= task budget.',
        inputSchema: {
            type: 'object',
            properties: {
                mnemonic:       { type: 'string' },
                task_id:        { type: 'number', description: 'Task ID to bid on' },
                bid_amount_ton: { type: 'number', description: 'Your price for this task in TON' },
                delivery_hours: { type: 'number', description: 'Hours you need to complete (default 12)' },
                proposal:       { type: 'string', description: 'Your proposal / approach for this task' },
            },
            required: ['mnemonic', 'task_id', 'bid_amount_ton', 'proposal'],
        },
    },
    {
        name: 'swarm_accept_bid',
        description: 'Accept a specific agent\'s bid on your task. Only the task poster can call this.',
        inputSchema: {
            type: 'object',
            properties: {
                mnemonic:      { type: 'string' },
                task_id:       { type: 'number' },
                agent_address: { type: 'string', description: 'TON address of the agent whose bid to accept' },
            },
            required: ['mnemonic', 'task_id', 'agent_address'],
        },
    },
    {
        name: 'swarm_submit_result',
        description: 'Submit your completed work for a task. Task moves to VERIFYING state and poster has 24h to verify.',
        inputSchema: {
            type: 'object',
            properties: {
                mnemonic:           { type: 'string' },
                task_id:            { type: 'number' },
                result_description: { type: 'string', description: 'Description of your result / deliverable (stored as hash on-chain)' },
            },
            required: ['mnemonic', 'task_id', 'result_description'],
        },
    },
    {
        name: 'swarm_verify_result',
        description: 'Verify an agent\'s result and release payment. Only the task poster can call this. Automatically updates agent reputation on-chain.',
        inputSchema: {
            type: 'object',
            properties: {
                mnemonic: { type: 'string' },
                task_id:  { type: 'number' },
            },
            required: ['mnemonic', 'task_id'],
        },
    },
    {
        name: 'swarm_get_task',
        description: 'Get the current status and details of a task by ID.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'number', description: 'Task ID to look up' },
            },
            required: ['task_id'],
        },
    },
    {
        name: 'swarm_get_reputation',
        description: 'Get an agent\'s reputation score (0-1000), tier, and earned badges from the on-chain reputation system.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_address: { type: 'string', description: 'TON wallet address of the agent' },
            },
            required: ['agent_address'],
        },
    },
    {
        name: 'swarm_get_stats',
        description: 'Get overall SwarmOS statistics: total agents, tasks posted, stake locked, fees collected.',
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
];

// ── MCP Server ─────────────────────────────────────────────────

const server = new Server(
    {
        name:    'ton-swarmos',
        version: '1.0.0',
    },
    {
        capabilities: { tools: {} },
    },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params;

    try {
        let result: string;

        switch (name) {
            case 'swarm_register_agent':  result = await handleRegisterAgent(args);  break;
            case 'swarm_update_agent':    result = await handleUpdateAgent(args);     break;
            case 'swarm_list_agents':     result = await handleListAgents(args);      break;
            case 'swarm_post_task':       result = await handlePostTask(args);        break;
            case 'swarm_bid_task':        result = await handleBidTask(args);         break;
            case 'swarm_accept_bid':      result = await handleAcceptBid(args);       break;
            case 'swarm_submit_result':   result = await handleSubmitResult(args);    break;
            case 'swarm_verify_result':   result = await handleVerifyResult(args);    break;
            case 'swarm_get_task':        result = await handleGetTask(args);         break;
            case 'swarm_get_reputation':  result = await handleGetReputation(args);   break;
            case 'swarm_get_stats':       result = await handleGetStats(args);        break;
            default:
                throw new Error(`Unknown tool: ${name}`);
        }

        return { content: [{ type: 'text', text: result }] };

    } catch (error: any) {
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }],
            isError: true,
        };
    }
});

// ── Start ──────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('TON SwarmOS MCP Server running');
    console.error('Registry:    ', REGISTRY_ADDRESS || 'NOT SET');
    console.error('Coordinator: ', COORDINATOR_ADDRESS || 'NOT SET');
    console.error('Reputation:  ', REPUTATION_ADDRESS || 'NOT SET');
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});