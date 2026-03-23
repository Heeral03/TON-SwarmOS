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

export const CAP_PRICE_SCANNER    = 1;
export const CAP_TRADE_EXECUTOR   = 2;
export const CAP_STRATEGIST       = 4;
export const CAP_DATA_ANALYST     = 8;
export const CAP_CONTENT_CREATOR  = 16;
export const CAP_SECURITY_AUDITOR = 32;
export const CAP_ARBITRAGEUR      = 64;

const OP_REGISTER_AGENT   = 0x1001;
const OP_UPDATE_AGENT     = 0x1002;
const OP_DEACTIVATE_AGENT = 0x1003;
const OP_ACTIVATE_AGENT   = 0x1004;

export type AgentRegistryConfig = { owner: Address };

export function agentRegistryConfigToCell(config: AgentRegistryConfig): Cell {
    return beginCell()
        .storeUint(0, 1)            // empty agents map
        .storeUint(0, 32)           // agentCount = 0
        .storeAddress(config.owner)
        .storeCoins(0)              // totalStake = 0
        .endCell();
}

export class AgentRegistry implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromConfig(config: AgentRegistryConfig, code: Cell, workchain = 0) {
        const data = agentRegistryConfigToCell(config);
        const init = { code, data };
        return new AgentRegistry(contractAddress(workchain, init), init);
    }

    static createFromAddress(address: Address) {
        return new AgentRegistry(address);
    }

    // provider is injected by blockchain.openContract() — always first param
    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendRegisterAgent(
        provider: ContractProvider,
        via: Sender,
        opts: {
            capabilities: number;
            pricePerUnit: bigint;
            endpointHash: bigint;
            stake?: bigint;
        },
    ) {
        await provider.internal(via, {
            value: opts.stake ?? toNano('1'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_REGISTER_AGENT, 32)
                .storeUint(opts.capabilities, 8)
                .storeCoins(opts.pricePerUnit)
                .storeUint(opts.endpointHash, 256)
                .endCell(),
        });
    }

    async sendUpdateAgent(
        provider: ContractProvider,
        via: Sender,
        opts: { capabilities: number; pricePerUnit: bigint; endpointHash: bigint },
    ) {
        await provider.internal(via, {
            value: toNano('0.05'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_UPDATE_AGENT, 32)
                .storeUint(opts.capabilities, 8)
                .storeCoins(opts.pricePerUnit)
                .storeUint(opts.endpointHash, 256)
                .endCell(),
        });
    }

    async sendDeactivateAgent(provider: ContractProvider, via: Sender) {
        await provider.internal(via, {
            value: toNano('0.05'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_DEACTIVATE_AGENT, 32).endCell(),
        });
    }

    async sendActivateAgent(provider: ContractProvider, via: Sender) {
        await provider.internal(via, {
            value: toNano('0.05'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(OP_ACTIVATE_AGENT, 32).endCell(),
        });
    }

    async getAgentCount(provider: ContractProvider): Promise<number> {
        const r = await provider.get('getAgentCount', []);
        return r.stack.readNumber();
    }

    async getTotalStake(provider: ContractProvider): Promise<bigint> {
        const r = await provider.get('getTotalStake', []);
        return r.stack.readBigNumber();
    }

    async getOwner(provider: ContractProvider): Promise<Address> {
        const r = await provider.get('getOwner', []);
        return r.stack.readAddress();
    }
}