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
    TupleBuilder,
} from '@ton/core';

export const BADGE_FIRST_TASK    = 1;
export const BADGE_TEN_TASKS     = 2;
export const BADGE_HUNDRED_TASKS = 4;
export const BADGE_ELITE         = 8;
export const BADGE_VERIFIED      = 16;
export const BADGE_PIONEER       = 32;
export const BADGE_RELIABLE      = 64;

const OP_TASK_COMPLETED = 0x3001;
const OP_MANUAL_VERIFY  = 0x3002;

export type ReputationUpdaterConfig = {
    owner:              Address;
    coordinatorAddress: Address;
};

export function reputationUpdaterConfigToCell(config: ReputationUpdaterConfig): Cell {
    return beginCell()
        .storeUint(0, 1)                          // empty reputations map
        .storeAddress(config.coordinatorAddress)
        .storeAddress(config.owner)
        .storeUint(0, 32)                         // agentCount = 0
        .storeUint(0, 32)                         // pioneerCount = 0
        .endCell();
}

export class ReputationUpdater implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromConfig(config: ReputationUpdaterConfig, code: Cell, workchain = 0) {
        const data = reputationUpdaterConfigToCell(config);
        const init = { code, data };
        return new ReputationUpdater(contractAddress(workchain, init), init);
    }

    static createFromAddress(address: Address) {
        return new ReputationUpdater(address);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendTaskCompleted(
        provider: ContractProvider,
        via: Sender,
        opts: { agent: Address; success: number; taskValue: bigint },
    ) {
        await provider.internal(via, {
            value: toNano('0.05'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_TASK_COMPLETED, 32)
                .storeAddress(opts.agent)
                .storeUint(opts.success, 8)
                .storeCoins(opts.taskValue)
                .endCell(),
        });
    }

    async sendManualVerify(
        provider: ContractProvider,
        via: Sender,
        opts: { agent: Address },
    ) {
        await provider.internal(via, {
            value: toNano('0.05'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_MANUAL_VERIFY, 32)
                .storeAddress(opts.agent)
                .endCell(),
        });
    }

    async getScore(provider: ContractProvider, agent: Address): Promise<number> {
        const tb = new TupleBuilder();
        tb.writeAddress(agent);
        const r = await provider.get('getScore', tb.build());
        return r.stack.readNumber();
    }

    async getBadges(provider: ContractProvider, agent: Address): Promise<number> {
        const tb = new TupleBuilder();
        tb.writeAddress(agent);
        const r = await provider.get('getBadges', tb.build());
        return r.stack.readNumber();
    }

    async isTrusted(
        provider: ContractProvider,
        agent: Address,
        threshold: number,
    ): Promise<boolean> {
        const tb = new TupleBuilder();
        tb.writeAddress(agent);
        tb.writeNumber(threshold);
        const r = await provider.get('isTrusted', tb.build());
        return r.stack.readNumber() === 1;
    }

    async getAgentCount(provider: ContractProvider): Promise<number> {
        const r = await provider.get('getAgentCount', []);
        return r.stack.readNumber();
    }
}