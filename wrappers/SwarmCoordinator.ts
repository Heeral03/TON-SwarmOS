import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
    toNano,
} from '@ton/core';

export const TASK_OPEN      = 0;
export const TASK_ASSIGNED  = 1;
export const TASK_VERIFYING = 2;
export const TASK_COMPLETED = 3;
export const TASK_DISPUTED  = 4;
export const TASK_EXPIRED   = 5;
export const TASK_CANCELLED = 6;

const OP_POST_TASK      = 0x2001;
const OP_BID_TASK       = 0x2002;
const OP_ACCEPT_BID     = 0x2003;
const OP_SUBMIT_RESULT  = 0x2004;
const OP_VERIFY_RESULT  = 0x2005;
const OP_DISPUTE_TASK   = 0x2006;
const OP_CANCEL_TASK    = 0x2007;
const OP_REFUND_EXPIRED = 0x2008;

export type SwarmCoordinatorConfig = {
    owner:             Address;
    registryAddress:   Address;
    reputationAddress: Address;
};

export function swarmCoordinatorConfigToCell(config: SwarmCoordinatorConfig): Cell {
    return beginCell()
        .storeUint(0, 1)                       // empty tasks map
        .storeUint(0, 1)                       // empty bids map
        .storeUint(0, 64)                      // nextTaskId = 0
        .storeAddress(config.registryAddress)
        .storeAddress(config.reputationAddress)
        .storeAddress(config.owner)
        .storeCoins(0)                         // accumulatedFees = 0
        .endCell();
}

export class SwarmCoordinator implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromConfig(config: SwarmCoordinatorConfig, code: Cell, workchain = 0) {
        const data = swarmCoordinatorConfigToCell(config);
        const init = { code, data };
        return new SwarmCoordinator(contractAddress(workchain, init), init);
    }

    static createFromAddress(address: Address) {
        return new SwarmCoordinator(address);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendPostTask(
        provider: ContractProvider,
        via: Sender,
        opts: {
            descriptionHash:    bigint;
            requiredCapability: number;
            workDeadlineDelta:  number;
            payment:            bigint;
        },
    ) {
        await provider.internal(via, {
            value: opts.payment,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_POST_TASK, 32)
                .storeUint(opts.descriptionHash, 256)
                .storeUint(opts.requiredCapability, 8)
                .storeUint(opts.workDeadlineDelta, 32)
                .endCell(),
        });
    }

    async sendBidTask(
        provider: ContractProvider,
        via: Sender,
        opts: {
            taskId:       bigint;
            amount:       bigint;
            deliveryTime: number;
            proposalHash: bigint;
        },
    ) {
        await provider.internal(via, {
            value: toNano('0.05'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_BID_TASK, 32)
                .storeUint(opts.taskId, 64)
                .storeCoins(opts.amount)
                .storeUint(opts.deliveryTime, 32)
                .storeUint(opts.proposalHash, 256)
                .endCell(),
        });
    }

    async sendAcceptBid(
        provider: ContractProvider,
        via: Sender,
        opts: { taskId: bigint; agent: Address },
    ) {
        await provider.internal(via, {
            value: toNano('0.05'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_ACCEPT_BID, 32)
                .storeUint(opts.taskId, 64)
                .storeAddress(opts.agent)
                .endCell(),
        });
    }

    async sendSubmitResult(
        provider: ContractProvider,
        via: Sender,
        opts: { taskId: bigint; resultHash: bigint },
    ) {
        await provider.internal(via, {
            value: toNano('0.05'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_SUBMIT_RESULT, 32)
                .storeUint(opts.taskId, 64)
                .storeUint(opts.resultHash, 256)
                .endCell(),
        });
    }

    async sendVerifyResult(
        provider: ContractProvider,
        via: Sender,
        opts: { taskId: bigint },
    ) {
        await provider.internal(via, {
            value: toNano('0.05'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_VERIFY_RESULT, 32)
                .storeUint(opts.taskId, 64)
                .endCell(),
        });
    }

    async sendDisputeTask(
        provider: ContractProvider,
        via: Sender,
        opts: { taskId: bigint },
    ) {
        await provider.internal(via, {
            value: toNano('0.05'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_DISPUTE_TASK, 32)
                .storeUint(opts.taskId, 64)
                .endCell(),
        });
    }

    async sendCancelTask(
        provider: ContractProvider,
        via: Sender,
        opts: { taskId: bigint },
    ) {
        await provider.internal(via, {
            value: toNano('0.05'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_CANCEL_TASK, 32)
                .storeUint(opts.taskId, 64)
                .endCell(),
        });
    }

    async sendRefundExpired(
        provider: ContractProvider,
        via: Sender,
        opts: { taskId: bigint },
    ) {
        await provider.internal(via, {
            value: toNano('0.05'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_REFUND_EXPIRED, 32)
                .storeUint(opts.taskId, 64)
                .endCell(),
        });
    }

    async getNextTaskId(provider: ContractProvider): Promise<bigint> {
        const r = await provider.get('getNextTaskId', []);
        return r.stack.readBigNumber();
    }

    async getAccumulatedFees(provider: ContractProvider): Promise<bigint> {
        const r = await provider.get('getAccumulatedFees', []);
        return r.stack.readBigNumber();
    }
}