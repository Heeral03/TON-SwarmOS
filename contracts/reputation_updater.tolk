// ============================================================
// ReputationUpdater.tolk
// TON SwarmOS — Contract 3 of 3
// ============================================================

const BADGE_FIRST_TASK    = 1;
const BADGE_TEN_TASKS     = 2;
const BADGE_HUNDRED_TASKS = 4;
const BADGE_ELITE         = 8;
const BADGE_VERIFIED      = 16;
const BADGE_PIONEER       = 32;
const BADGE_RELIABLE      = 64;

const INITIAL_SCORE = 500;
const MAX_SCORE     = 1000;
const MIN_SCORE     = 0;

const SCORE_SUCCESS_SMALL  = 10;
const SCORE_SUCCESS_MEDIUM = 20;
const SCORE_SUCCESS_LARGE  = 40;
const SCORE_FAILURE        = 50;

const SMALL_TASK_THRESHOLD  = ton("1");
const MEDIUM_TASK_THRESHOLD = ton("10");

const PIONEER_LIMIT = 100;
 
// ── Opcodes ───────────────────────────────────────────────────
const OP_TASK_COMPLETED = 0x3001;
const OP_MANUAL_VERIFY  = 0x3002;


const ERR_NOT_COORDINATOR  = 3001;
const ERR_NOT_OWNER        = 3002;
const ERR_AGENT_NOT_FOUND  = 3003;
const ERR_ALREADY_VERIFIED = 3004;

struct ReputationRecord {
    agentAddress:    address;
    score:           uint16;
    peakScore:       uint16;
    tasksCompleted:  uint32;
    tasksFailed:     uint32;
    badges:          uint8;
    lastUpdated:     uint32;
    firstSeen:       uint32;
    totalEarned:     coins;
}

struct Storage {
    reputations:         map<address, ReputationRecord>;
    coordinatorAddress:  address;
    owner:               address;
    agentCount:          uint32;
    pioneerCount:        uint32;
}

fun Storage.load(): Storage {
    return Storage.fromCell(contract.getData());
}

fun Storage.save(self) {
    contract.setData(self.toCell());
}

struct TaskCompleted {
    agent:     address;
    success:   uint8;
    taskValue: coins;
}

struct ManualVerify {
    agent: address;
}

// type ReputationMessage = TaskCompleted | ManualVerify; // Removed union

fun clampScore(current: int, delta: int): uint16 {
    val next = current + delta;
    if (next > MAX_SCORE) { return MAX_SCORE as uint16; }
    if (next < MIN_SCORE) { return 0; }
    return next as uint16;
}

fun scoreDelta(success: uint8, taskValue: coins): int {
    if (success == 0) {
        return -SCORE_FAILURE;
    }
    if (taskValue < SMALL_TASK_THRESHOLD)  { return SCORE_SUCCESS_SMALL; }
    if (taskValue < MEDIUM_TASK_THRESHOLD) { return SCORE_SUCCESS_MEDIUM; }
    return SCORE_SUCCESS_LARGE;
}

fun computeBadges(record: ReputationRecord): uint8 {
    var b = record.badges;

    if (record.tasksCompleted >= 1   && (b & BADGE_FIRST_TASK)    == 0) { b = b | BADGE_FIRST_TASK; }
    if (record.tasksCompleted >= 10  && (b & BADGE_TEN_TASKS)     == 0) { b = b | BADGE_TEN_TASKS; }
    if (record.tasksCompleted >= 100 && (b & BADGE_HUNDRED_TASKS) == 0) { b = b | BADGE_HUNDRED_TASKS; }
    if (record.score >= 900          && (b & BADGE_ELITE)         == 0) { b = b | BADGE_ELITE; }

    if (record.tasksCompleted >= 10 && record.tasksFailed == 0 && (b & BADGE_RELIABLE) == 0) {
        b = b | BADGE_RELIABLE;
    }

    return b as uint8;
}

fun getOrCreate(storage: Storage, agent: address): ReputationRecord {
    val existing = storage.reputations.get(agent);
    if (existing.isFound) {
        return existing.loadValue();
    }
    return ReputationRecord {
        agentAddress:   agent,
        score:          INITIAL_SCORE as uint16,
        peakScore:      INITIAL_SCORE as uint16,
        tasksCompleted: 0,
        tasksFailed:    0,
        badges:         0,
        lastUpdated:    blockchain.now() as uint32,
        firstSeen:      blockchain.now() as uint32,
        totalEarned:    0,
    };
}

fun onInternalMessage(in: InMessage) {
    var body = in.body;
    if (body.isEmpty()) {
        return;
    }
    val opcode = body.loadUint(32);
    if (opcode == OP_TASK_COMPLETED) {
        val msg = TaskCompleted {
            agent: body.loadAddress(),
            success: body.loadUint(8),
            taskValue: body.loadCoins()
        };
        handleTaskCompleted(in.senderAddress, msg);
    } else if (opcode == OP_MANUAL_VERIFY) {
        val msg = ManualVerify {
            agent: body.loadAddress()
        };
        handleManualVerify(in.senderAddress, msg);
    } else {
        throw 0xFFFF;
    }
}

fun handleTaskCompleted(sender: address, msg: TaskCompleted) {
    var storage = Storage.load();

    assert(sender == storage.coordinatorAddress) throw ERR_NOT_COORDINATOR;

    val isNew  = !storage.reputations.exists(msg.agent);
    var record = getOrCreate(storage, msg.agent);

    val delta   = scoreDelta(msg.success, msg.taskValue);
    record.score = clampScore(record.score as int, delta);

    if (record.score > record.peakScore) {
        record.peakScore = record.score;
    }

    if (msg.success == 1) {
        record.tasksCompleted += 1;
        record.totalEarned    += msg.taskValue;
    } else {
        record.tasksFailed += 1;
    }

    if (isNew && storage.pioneerCount < PIONEER_LIMIT) {
        record.badges = (record.badges | BADGE_PIONEER) as uint8;
        storage.pioneerCount += 1;
    }

    record.badges      = computeBadges(record);
    record.lastUpdated = blockchain.now();

    storage.reputations.set(msg.agent, record);

    if (isNew) {
        storage.agentCount += 1;
    }

    storage.save();
}

fun handleManualVerify(sender: address, msg: ManualVerify) {
    var storage = Storage.load();

    assert(sender == storage.owner) throw ERR_NOT_OWNER;
    assert(storage.reputations.exists(msg.agent)) throw ERR_AGENT_NOT_FOUND;

    var record = storage.reputations.mustGet(msg.agent);
    assert((record.badges & BADGE_VERIFIED) == 0) throw ERR_ALREADY_VERIFIED;

    record.badges      = (record.badges | BADGE_VERIFIED) as uint8;
    record.lastUpdated = blockchain.now();

    storage.reputations.set(msg.agent, record);
    storage.save();
}

get fun getReputation(agent: address): ReputationRecord? {
    val storage = Storage.load();
    val record  = storage.reputations.get(agent);
    if (!record.isFound) { return null; }
    return record.loadValue();
}

get fun getScore(agent: address): uint16 {
    val storage = Storage.load();
    val record  = storage.reputations.get(agent);
    if (!record.isFound) { return INITIAL_SCORE as uint16; }
    return record.loadValue().score;
}

get fun getBadges(agent: address): uint8 {
    val storage = Storage.load();
    val record  = storage.reputations.get(agent);
    if (!record.isFound) { return 0; }
    return record.loadValue().badges;
}
get fun isTrusted(agent: address, threshold: uint16): uint8 {
    val storage = Storage.load();
    val record  = storage.reputations.get(agent);
    if (!record.isFound) { return 0; }
    if (record.loadValue().score >= threshold) { return 1; }
    return 0;
}
get fun getAgentCount(): uint32 {
    val storage = Storage.load();
    return storage.agentCount;
}