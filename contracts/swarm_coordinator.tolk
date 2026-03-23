// ============================================================
// SwarmCoordinator.tolk — TON SwarmOS Contract 2 of 3
// ============================================================

// ── Task State Constants ──────────────────────────────────────
const TASK_OPEN      = 0
const TASK_ASSIGNED  = 1
const TASK_VERIFYING = 2
const TASK_COMPLETED = 3
const TASK_DISPUTED  = 4
const TASK_EXPIRED   = 5
const TASK_CANCELLED = 6

// ── Error Codes ───────────────────────────────────────────────
const ERR_TASK_NOT_FOUND     = 2001
const ERR_TASK_NOT_OPEN      = 2002
const ERR_TASK_NOT_ASSIGNED  = 2003
const ERR_NOT_TASK_POSTER    = 2004
const ERR_NOT_ASSIGNED_AGENT = 2005
const ERR_BID_TOO_HIGH       = 2006
const ERR_DEADLINE_PASSED    = 2007
const ERR_NOT_EXPIRED        = 2008
const ERR_ALREADY_BID        = 2009
const ERR_NO_BIDS            = 2010
const ERR_PAYMENT_TOO_LOW    = 2011
const ERR_TASK_NOT_VERIFYING = 2012
 
// ── Opcodes ───────────────────────────────────────────────────
const OP_POST_TASK      = 0x2001
const OP_BID_TASK       = 0x2002
const OP_ACCEPT_BID     = 0x2003
const OP_SUBMIT_RESULT  = 0x2004
const OP_VERIFY_RESULT  = 0x2005
const OP_DISPUTE_TASK   = 0x2006
const OP_CANCEL_TASK    = 0x2007
const OP_REFUND_EXPIRED = 0x2008


// ── Config ────────────────────────────────────────────────────
const MIN_TASK_PAYMENT   = ton("0.1")
const BID_WINDOW         = 3600
const VERIFY_WINDOW      = 86400
const PLATFORM_FEE_BPS   = 50

// ── Structs ───────────────────────────────────────────────────

@overflow1023_policy("suppress")
struct TaskExtra {
    descriptionHash:    uint256
    bidDeadline:        uint32
    workDeadline:       uint32
    verifyDeadline:     uint32
    resultHash:         uint256
    createdAt:          uint32
    bidCount:           uint8
}

struct TaskRecord {
    taskId:             uint64
    poster:             address
    requiredCapability: uint8
    budget:             coins
    state:              uint8
    assignedAgent:      address
    winningBid:         coins
    extra:              Cell<TaskExtra>
}


struct BidRecord {
    agent:        address
    amount:       coins
    deliveryTime: uint32
    proposalHash: uint256
    placedAt:     uint32
}

// ── Storage ───────────────────────────────────────────────────

struct Storage {
    tasks:             map<uint64, Cell<TaskRecord>>
    bids:              map<uint64, BidRecord>
    nextTaskId:        uint64
    registryAddress:   address
    reputationAddress: address
    owner:             address
    accumulatedFees:   coins
}

fun Storage.load(): Storage {
    return Storage.fromCell(contract.getData());
}

fun Storage.save(self) {
    contract.setData(self.toCell());
}

// ── Message Structs ───────────────────────────────────────────

struct PostTask {
    descriptionHash:    uint256
    requiredCapability: uint8
    workDeadlineDelta:  uint32
}

struct BidTask {
    taskId:       uint64
    amount:       coins
    deliveryTime: uint32
    proposalHash: uint256
}

struct AcceptBid {
    taskId: uint64
    agent:  address
}

struct SubmitResult {
    taskId:     uint64
    resultHash: uint256
}

struct VerifyResult {
    taskId: uint64
}

struct DisputeTask {
    taskId: uint64
}

struct CancelTask {
    taskId: uint64
}

struct RefundExpired {
    taskId: uint64
}

struct ReputationUpdate {
    agent:   address
    success: uint8
}

// ── Helpers ───────────────────────────────────────────────────

fun makeBidKey(taskId: uint64, agent: address): uint64 {
    val agentHash = (agent as slice).hash();
    return (taskId << 32) | (agentHash & 0xFFFFFFFF);
}

fun calculateFee(amount: coins): coins {
    return amount * PLATFORM_FEE_BPS / 10000;
}

fun sendTon(dest: address, amount: coins) {
    val msg = createMessage({
        bounce: BounceMode.NoBounce,
        value:  amount,
        dest:   dest,
    });
    msg.send(SEND_MODE_REGULAR);
}

// ── Entry Point ───────────────────────────────────────────────

fun onInternalMessage(in: InMessage) {
    var body = in.body;
    if (body.isEmpty()) {
        return;
    }
    val opcode = body.loadUint(32);
    if (opcode == OP_POST_TASK) {
        val msg = PostTask {
            descriptionHash: body.loadUint(256),
            requiredCapability: body.loadUint(8),
            workDeadlineDelta: body.loadUint(32)
        };
        handlePostTask(in.senderAddress, in.valueCoins, msg);
    } else if (opcode == OP_BID_TASK) {
        val msg = BidTask {
            taskId: body.loadUint(64),
            amount: body.loadCoins(),
            deliveryTime: body.loadUint(32),
            proposalHash: body.loadUint(256)
        };
        handleBidTask(in.senderAddress, msg);
    } else if (opcode == OP_ACCEPT_BID) {
        val msg = AcceptBid {
            taskId: body.loadUint(64),
            agent: body.loadAddress()
        };
        handleAcceptBid(in.senderAddress, msg);
    } else if (opcode == OP_SUBMIT_RESULT) {
        val msg = SubmitResult {
            taskId: body.loadUint(64),
            resultHash: body.loadUint(256)
        };
        handleSubmitResult(in.senderAddress, msg);
    } else if (opcode == OP_VERIFY_RESULT) {
        val msg = VerifyResult { taskId: body.loadUint(64) };
        handleVerifyResult(in.senderAddress, msg);
    } else if (opcode == OP_DISPUTE_TASK) {
        val msg = DisputeTask { taskId: body.loadUint(64) };
        handleDisputeTask(in.senderAddress, msg);
    } else if (opcode == OP_CANCEL_TASK) {
        val msg = CancelTask { taskId: body.loadUint(64) };
        handleCancelTask(in.senderAddress, msg);
    } else if (opcode == OP_REFUND_EXPIRED) {
        val msg = RefundExpired { taskId: body.loadUint(64) };
        handleRefundExpired(msg);
    } else {
        throw 0xFFFF;
    }
}

// ── Post Task ─────────────────────────────────────────────────

fun handlePostTask(sender: address, msgValue: coins, msg: PostTask) {
    var storage = Storage.load();

    assert(msgValue >= MIN_TASK_PAYMENT) throw ERR_PAYMENT_TOO_LOW;

    val taskId       = storage.nextTaskId;
    val bidDeadline  = blockchain.now() + BID_WINDOW;
    val workDeadline = bidDeadline + msg.workDeadlineDelta;
    val verDeadline  = workDeadline + VERIFY_WINDOW;

    val zeroAddr = address.fromWorkchainAndHash(0, 0);

    val extra: TaskExtra = {
        descriptionHash:    msg.descriptionHash,
        bidDeadline:        bidDeadline as uint32,
        workDeadline:       workDeadline as uint32,
        verifyDeadline:     verDeadline as uint32,
        resultHash:         0,
        createdAt:          blockchain.now() as uint32,
        bidCount:           0,
    };

    val task: TaskRecord = {
        taskId:             taskId,
        poster:             sender,
        requiredCapability: msg.requiredCapability,
        budget:             msgValue,
        state:              TASK_OPEN as uint8,
        assignedAgent:      zeroAddr,
        winningBid:         0,
        extra:              extra.toCell(),
    };

    storage.tasks.set(taskId, task.toCell());
    storage.nextTaskId += 1;
    storage.save();
}


// ── Bid on Task ───────────────────────────────────────────────

fun handleBidTask(sender: address, msg: BidTask) {
    var storage = Storage.load();

    assert(storage.tasks.exists(msg.taskId)) throw ERR_TASK_NOT_FOUND;

    var task  = storage.tasks.mustGet(msg.taskId).load();
    var extra = task.extra.load();

    assert(task.state == TASK_OPEN)       throw ERR_TASK_NOT_OPEN;
    assert(blockchain.now() < extra.bidDeadline) throw ERR_DEADLINE_PASSED;
    assert(msg.amount <= task.budget)     throw ERR_BID_TOO_HIGH;
    assert(msg.amount > 0)               throw ERR_PAYMENT_TOO_LOW;


    val bidKey = makeBidKey(msg.taskId, sender);
    assert(!storage.bids.exists(bidKey))  throw ERR_ALREADY_BID;

    val bid: BidRecord = {
        agent:        sender,
        amount:       msg.amount,
        deliveryTime: msg.deliveryTime,
        proposalHash: msg.proposalHash,
        placedAt:     blockchain.now() as uint32,
    };

    storage.bids.set(bidKey, bid);
    extra.bidCount += 1;
    task.extra = extra.toCell();
    storage.tasks.set(msg.taskId, task.toCell());
    storage.save();
}


// ── Accept Bid ────────────────────────────────────────────────

fun handleAcceptBid(sender: address, msg: AcceptBid) {
    var storage = Storage.load();

    assert(storage.tasks.exists(msg.taskId)) throw ERR_TASK_NOT_FOUND;

    var task  = storage.tasks.mustGet(msg.taskId).load();
    var extra = task.extra.load();

    assert(sender == task.poster)         throw ERR_NOT_TASK_POSTER;
    assert(task.state == TASK_OPEN)       throw ERR_TASK_NOT_OPEN;
    assert(extra.bidCount > 0)             throw ERR_NO_BIDS;


    val bidKey = makeBidKey(msg.taskId, msg.agent);
    assert(storage.bids.exists(bidKey))   throw ERR_TASK_NOT_FOUND;

    val bid = storage.bids.mustGet(bidKey);

    task.state         = TASK_ASSIGNED as uint8;
    task.assignedAgent = msg.agent;
    task.winningBid    = bid.amount;

    storage.tasks.set(msg.taskId, task.toCell());
    storage.save();
}

// ── Submit Result ─────────────────────────────────────────────

fun handleSubmitResult(sender: address, msg: SubmitResult) {
    var storage = Storage.load();

    assert(storage.tasks.exists(msg.taskId)) throw ERR_TASK_NOT_FOUND;

    var task  = storage.tasks.mustGet(msg.taskId).load();
    var extra = task.extra.load();

    assert(sender == task.assignedAgent)  throw ERR_NOT_ASSIGNED_AGENT;
    assert(task.state == TASK_ASSIGNED)   throw ERR_TASK_NOT_ASSIGNED;
    assert(blockchain.now() < extra.workDeadline) throw ERR_DEADLINE_PASSED;

    task.state      = TASK_VERIFYING as uint8;
    extra.resultHash = msg.resultHash;
    task.extra      = extra.toCell();


    storage.tasks.set(msg.taskId, task.toCell());
    storage.save();
}

// ── Verify Result ─────────────────────────────────────────────

fun handleVerifyResult(sender: address, msg: VerifyResult) {
    var storage = Storage.load();

    assert(storage.tasks.exists(msg.taskId)) throw ERR_TASK_NOT_FOUND;

    var task = storage.tasks.mustGet(msg.taskId).load();

    assert(sender == task.poster)          throw ERR_NOT_TASK_POSTER;
    assert(task.state == TASK_VERIFYING)   throw ERR_TASK_NOT_VERIFYING;

    val fee          = calculateFee(task.winningBid);
    val agentPayment = task.winningBid - fee;
    val budgetRefund = task.budget - task.winningBid;

    task.state = TASK_COMPLETED as uint8;
    storage.tasks.set(msg.taskId, task.toCell());
    storage.accumulatedFees += fee;
    storage.save();

    sendTon(task.assignedAgent, agentPayment);

    if (budgetRefund > ton("0.01")) {
        sendTon(task.poster, budgetRefund);
    }

    val repMsg = createMessage({
        bounce: BounceMode.NoBounce,
        value:  ton("0.05"),
        dest:   storage.reputationAddress,
        body:   ReputationUpdate { agent: task.assignedAgent, success: 1 },
    });
    repMsg.send(SEND_MODE_REGULAR);
}

// ── Dispute Task ──────────────────────────────────────────────

fun handleDisputeTask(sender: address, msg: DisputeTask) {
    var storage = Storage.load();

    assert(storage.tasks.exists(msg.taskId)) throw ERR_TASK_NOT_FOUND;

    var task = storage.tasks.mustGet(msg.taskId).load();

    assert(sender == task.poster)         throw ERR_NOT_TASK_POSTER;
    assert(task.state == TASK_VERIFYING)  throw ERR_TASK_NOT_VERIFYING;

    task.state = TASK_DISPUTED as uint8;
    storage.tasks.set(msg.taskId, task.toCell());
    storage.save();
}

// ── Cancel Task ───────────────────────────────────────────────

fun handleCancelTask(sender: address, msg: CancelTask) {
    var storage = Storage.load();

    assert(storage.tasks.exists(msg.taskId)) throw ERR_TASK_NOT_FOUND;

    var task  = storage.tasks.mustGet(msg.taskId).load();
    var extra = task.extra.load();

    assert(sender == task.poster)    throw ERR_NOT_TASK_POSTER;
    assert(task.state == TASK_OPEN)  throw ERR_TASK_NOT_OPEN;
    assert(extra.bidCount == 0)       throw ERR_ALREADY_BID;


    task.state = TASK_CANCELLED as uint8;
    storage.tasks.set(msg.taskId, task.toCell());
    storage.save();

    sendTon(task.poster, task.budget);
}

// ── Refund Expired ────────────────────────────────────────────

fun handleRefundExpired(msg: RefundExpired) {
    var storage = Storage.load();

    assert(storage.tasks.exists(msg.taskId)) throw ERR_TASK_NOT_FOUND;

    var task  = storage.tasks.mustGet(msg.taskId).load();
    var extra = task.extra.load();

    assert(task.state == TASK_OPEN)            throw ERR_TASK_NOT_OPEN;
    assert(blockchain.now() > extra.bidDeadline) throw ERR_NOT_EXPIRED;


    task.state = TASK_EXPIRED as uint8;
    storage.tasks.set(msg.taskId, task.toCell());
    storage.save();

    sendTon(task.poster, task.budget);
}

// ── Get Methods ───────────────────────────────────────────────

get fun getNextTaskId(): uint64 {
    val storage = Storage.load();
    return storage.nextTaskId;
}

get fun getAccumulatedFees(): coins {
    val storage = Storage.load();
    return storage.accumulatedFees;
}