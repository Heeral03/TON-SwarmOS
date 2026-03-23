import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import { AgentRegistry, CAP_PRICE_SCANNER, CAP_TRADE_EXECUTOR } from '../wrappers/AgentRegistry';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';

describe('AgentRegistry', () => {
    let code:     any;
    let chain:    Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let agent1:   SandboxContract<TreasuryContract>;
    let agent2:   SandboxContract<TreasuryContract>;
    let registry: SandboxContract<AgentRegistry>;

    const HASH = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn;

    beforeAll(async () => { code = await compile('AgentRegistry'); });

    beforeEach(async () => {
        chain    = await Blockchain.create();
        deployer = await chain.treasury('deployer');
        agent1   = await chain.treasury('agent1');
        agent2   = await chain.treasury('agent2');

        registry = chain.openContract(
            AgentRegistry.createFromConfig({ owner: deployer.address }, code)
        );
        await registry.sendDeploy(deployer.getSender(), toNano('0.1'));
    });

    it('deploys with 0 agents', async () => {
        expect(await registry.getAgentCount()).toBe(0);
    });

    it('owner is set correctly', async () => {
        const owner = await registry.getOwner();
        expect(owner.toString()).toBe(deployer.address.toString());
    });

    it('registers agent successfully', async () => {
        const tx = await registry.sendRegisterAgent(agent1.getSender(), {
            capabilities: CAP_PRICE_SCANNER,
            pricePerUnit: toNano('0.01'),
            endpointHash: HASH,
            stake:        toNano('1'),
        });
        expect(tx.transactions).toHaveTransaction({
            from: agent1.address, to: registry.address, success: true,
        });
        expect(await registry.getAgentCount()).toBe(1);
    });

    it('rejects stake below minimum', async () => {
        const tx = await registry.sendRegisterAgent(agent1.getSender(), {
            capabilities: CAP_PRICE_SCANNER,
            pricePerUnit: toNano('0.01'),
            endpointHash: HASH,
            stake:        toNano('0.1'),  // below 0.5 minimum
        });
        expect(tx.transactions).toHaveTransaction({
            from: agent1.address, to: registry.address,
            success: false, exitCode: 1008,
        });
    });

    it('rejects duplicate registration', async () => {
        await registry.sendRegisterAgent(agent1.getSender(), {
            capabilities: CAP_PRICE_SCANNER, pricePerUnit: toNano('0.01'),
            endpointHash: HASH, stake: toNano('1'),
        });
        const tx = await registry.sendRegisterAgent(agent1.getSender(), {
            capabilities: CAP_PRICE_SCANNER, pricePerUnit: toNano('0.01'),
            endpointHash: HASH, stake: toNano('1'),
        });
        expect(tx.transactions).toHaveTransaction({
            success: false, exitCode: 1001,
        });
    });

    it('registers two agents independently', async () => {
        await registry.sendRegisterAgent(agent1.getSender(), {
            capabilities: CAP_PRICE_SCANNER, pricePerUnit: toNano('0.01'),
            endpointHash: HASH, stake: toNano('1'),
        });
        await registry.sendRegisterAgent(agent2.getSender(), {
            capabilities: CAP_TRADE_EXECUTOR, pricePerUnit: toNano('0.05'),
            endpointHash: HASH + 1n, stake: toNano('1'),
        });
        expect(await registry.getAgentCount()).toBe(2);
    });

    it('updates agent listing', async () => {
        await registry.sendRegisterAgent(agent1.getSender(), {
            capabilities: CAP_PRICE_SCANNER, pricePerUnit: toNano('0.01'),
            endpointHash: HASH, stake: toNano('1'),
        });
        const tx = await registry.sendUpdateAgent(agent1.getSender(), {
            capabilities: CAP_PRICE_SCANNER | CAP_TRADE_EXECUTOR,
            pricePerUnit: toNano('0.02'),
            endpointHash: HASH + 1n,
        });
        expect(tx.transactions).toHaveTransaction({ success: true });
    });

    it('rejects update from unregistered agent', async () => {
        const tx = await registry.sendUpdateAgent(agent1.getSender(), {
            capabilities: CAP_PRICE_SCANNER, pricePerUnit: toNano('0.01'), endpointHash: HASH,
        });
        expect(tx.transactions).toHaveTransaction({ success: false, exitCode: 1002 });
    });

    it('deactivates agent', async () => {
        await registry.sendRegisterAgent(agent1.getSender(), {
            capabilities: CAP_PRICE_SCANNER, pricePerUnit: toNano('0.01'),
            endpointHash: HASH, stake: toNano('1'),
        });
        const tx = await registry.sendDeactivateAgent(agent1.getSender());
        expect(tx.transactions).toHaveTransaction({ success: true });
    });

    it('rejects double deactivation', async () => {
        await registry.sendRegisterAgent(agent1.getSender(), {
            capabilities: CAP_PRICE_SCANNER, pricePerUnit: toNano('0.01'),
            endpointHash: HASH, stake: toNano('1'),
        });
        await registry.sendDeactivateAgent(agent1.getSender());
        const tx = await registry.sendDeactivateAgent(agent1.getSender());
        expect(tx.transactions).toHaveTransaction({ success: false, exitCode: 1004 });
    });

    it('reactivates agent', async () => {
        await registry.sendRegisterAgent(agent1.getSender(), {
            capabilities: CAP_PRICE_SCANNER, pricePerUnit: toNano('0.01'),
            endpointHash: HASH, stake: toNano('1'),
        });
        await registry.sendDeactivateAgent(agent1.getSender());
        const tx = await registry.sendActivateAgent(agent1.getSender());
        expect(tx.transactions).toHaveTransaction({ success: true });
    });

    it('rejects activate on already active agent', async () => {
        await registry.sendRegisterAgent(agent1.getSender(), {
            capabilities: CAP_PRICE_SCANNER, pricePerUnit: toNano('0.01'),
            endpointHash: HASH, stake: toNano('1'),
        });
        const tx = await registry.sendActivateAgent(agent1.getSender());
        expect(tx.transactions).toHaveTransaction({ success: false, exitCode: 1005 });
    });
});