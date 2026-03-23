// ============================================================
// AgentRegistry.tolk
// TON SwarmOS — Contract 1 of 3
//
// PURPOSE:
//   The on-chain phonebook for AI agents in the swarm.
//   Any agent can register itself here with its capabilities,
//   pricing, and endpoint. Other agents and humans discover
//   agents by querying this registry.
//
// KEY OPERATIONS:
//   - register_agent   → Add yourself to the registry
//   - update_agent     → Update your capabilities/price
//   - deactivate_agent → Go offline (preserves your record)
//   - activate_agent   → Re-activate after deactivation
//   - get_agent        → Look up an agent by address
//   - get_all_agents   → Paginated list of all agents
//
// STORAGE LAYOUT:
//   agents: map<address, AgentRecord>
//   agentCount: uint32
//   owner: address
//   totalStake: coins
// ============================================================

// ── Opcodes ─────────────────────────────────────────────────
const OP_REGISTER_AGENT   = 0x1001
const OP_UPDATE_AGENT     = 0x1002
const OP_DEACTIVATE_AGENT = 0x1003
const OP_ACTIVATE_AGENT   = 0x1004

// ── Agent Capability Flags ───────────────────────────────────
// Bitfield — an agent can have multiple capabilities.
// e.g. 0b00000011 = PRICE_SCANNER + TRADE_EXECUTOR
const CAP_PRICE_SCANNER    = 1
const CAP_TRADE_EXECUTOR   = 2
const CAP_STRATEGIST       = 4
const CAP_DATA_ANALYST     = 8
const CAP_CONTENT_CREATOR  = 16
const CAP_SECURITY_AUDITOR = 32
const CAP_ARBITRAGEUR      = 64

// ── Error Codes ──────────────────────────────────────────────
const ERR_ALREADY_REGISTERED = 1001
const ERR_NOT_REGISTERED     = 1002
const ERR_NOT_OWNER          = 1003
const ERR_ALREADY_INACTIVE   = 1004
const ERR_ALREADY_ACTIVE     = 1005
const ERR_INVALID_PRICE      = 1006
const ERR_INVALID_NAME       = 1007
const ERR_INSUFFICIENT_STAKE = 1008

// ── Minimum Stake ────────────────────────────────────────────
const MIN_STAKE = ton("0.5")

// ── Agent Record ─────────────────────────────────────────────
struct AgentExtra {
    reputationScore: uint16
    tasksCompleted:  uint32
    tasksFailed:     uint32
    stake:           coins
    registeredAt:    uint32
    lastActive:      uint32
    isActive:        uint8
}

struct AgentRecord {
    agentAddress:    address
    capabilities:    uint8
    pricePerUnit:    coins
    endpointHash:    uint256
    extra:           Cell<AgentExtra>
}


// ── Storage Structure ────────────────────────────────────────
struct Storage {
    agents: map<address, AgentRecord>
    agentCount: uint32
    owner: address
    totalStake: coins
}

// ── Storage Helpers ──────────────────────────────────────────

fun Storage.load(): Storage {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// ── Message Structures ───────────────────────────────────────

struct RegisterAgent {
    capabilities: uint8
    pricePerUnit: coins
    endpointHash: uint256
}

struct UpdateAgent {
    capabilities: uint8
    pricePerUnit: coins
    endpointHash: uint256
}

// ── Message Entry Point ──────────────────────────────────────

fun onInternalMessage(in: InMessage) {
    var body = in.body;
    if (body.isEmpty()) {
        return;
    }
    val opcode = body.loadUint(32);
    if (opcode == OP_REGISTER_AGENT) {
        val msg = RegisterAgent {
            capabilities: body.loadUint(8),
            pricePerUnit: body.loadCoins(),
            endpointHash: body.loadUint(256)
        };
        handleRegister(in.senderAddress, in.valueCoins, msg);
    } else if (opcode == OP_UPDATE_AGENT) {
        val msg = UpdateAgent {
            capabilities: body.loadUint(8),
            pricePerUnit: body.loadCoins(),
            endpointHash: body.loadUint(256)
        };
        handleUpdate(in.senderAddress, msg);
    } else if (opcode == OP_DEACTIVATE_AGENT) {
        handleDeactivate(in.senderAddress);
    } else if (opcode == OP_ACTIVATE_AGENT) {
        handleActivate(in.senderAddress);
    } else {
        throw 0xFFFF;
    }
}

// ── Handler: Register Agent ──────────────────────────────────
fun handleRegister(sender: address, value: coins, msg: RegisterAgent) {
    var storage = Storage.load();

    assert (value >= MIN_STAKE) throw ERR_INSUFFICIENT_STAKE;
    assert (msg.pricePerUnit > 0) throw ERR_INVALID_PRICE;
    assert (!storage.agents.exists(sender)) throw ERR_ALREADY_REGISTERED;

    val extra: AgentExtra = {
        reputationScore: 500,
        tasksCompleted:  0,
        tasksFailed:     0,
        stake:           value,
        registeredAt:    blockchain.now() as uint32,
        lastActive:      blockchain.now() as uint32,
        isActive:        1,
    };

    val record: AgentRecord = {
        agentAddress:    sender,
        capabilities:    msg.capabilities,
        pricePerUnit:    msg.pricePerUnit,
        endpointHash:    msg.endpointHash,
        extra:           extra.toCell(),
    };

    storage.agents.set(sender, record);
    storage.agentCount += 1;
    storage.totalStake += value;
    storage.save();
}


// ── Handler: Update Agent ────────────────────────────────────
fun handleUpdate(sender: address, msg: UpdateAgent) {
    var storage = Storage.load();

    assert (storage.agents.exists(sender)) throw ERR_NOT_REGISTERED;
    assert (msg.pricePerUnit > 0) throw ERR_INVALID_PRICE;

    var record = storage.agents.mustGet(sender);
    var extra  = record.extra.load();
    record.capabilities  = msg.capabilities;
    record.pricePerUnit  = msg.pricePerUnit;
    record.endpointHash  = msg.endpointHash;
    extra.lastActive     = blockchain.now() as uint32;

    record.extra = extra.toCell();
    storage.agents.set(sender, record);
    storage.save();
}


// ── Handler: Deactivate Agent ────────────────────────────────
fun handleDeactivate(sender: address) {
    var storage = Storage.load();

    assert (storage.agents.exists(sender)) throw ERR_NOT_REGISTERED;

    var record = storage.agents.mustGet(sender);
    var extra  = record.extra.load();
    assert (extra.isActive == 1) throw ERR_ALREADY_INACTIVE;

    extra.isActive   = 0;
    extra.lastActive = blockchain.now() as uint32;

    record.extra = extra.toCell();
    storage.agents.set(sender, record);
    storage.save();
}


// ── Handler: Activate Agent ──────────────────────────────────
fun handleActivate(sender: address) {
    var storage = Storage.load();

    assert (storage.agents.exists(sender)) throw ERR_NOT_REGISTERED;

    var record = storage.agents.mustGet(sender);
    var extra  = record.extra.load();
    assert (extra.isActive == 0) throw ERR_ALREADY_ACTIVE;

    extra.isActive   = 1;
    extra.lastActive = blockchain.now() as uint32;

    record.extra = extra.toCell();
    storage.agents.set(sender, record);
    storage.save();
}


// ── Get Methods (off-chain, no gas) ──────────────────────────

get fun getAgentCount(): uint32 {
    val storage = Storage.load();
    return storage.agentCount
}

get fun getTotalStake(): coins {
    val storage = Storage.load();
    return storage.totalStake
}

get fun getOwner(): address {
    val storage = Storage.load();
    return storage.owner
}