import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano, Address } from '@ton/core';
import { SwarmCoordinator } from '../wrappers/SwarmCoordinator';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';

describe('SwarmCoordinator', () => {
    let code:        any;
    let chain:       Blockchain;
    let deployer:    SandboxContract<TreasuryContract>;
    let poster:      SandboxContract<TreasuryContract>;
    let agent1:      SandboxContract<TreasuryContract>;
    let agent2:      SandboxContract<TreasuryContract>;
    let coordinator: SandboxContract<SwarmCoordinator>;

    const DESC_HASH     = 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890n;
    const PROPOSAL_HASH = 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefn;
    const RESULT_HASH   = 0xcafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebaben;
    const ZERO_ADDR     = Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c');

    beforeAll(async () => { code = await compile('SwarmCoordinator'); });

    beforeEach(async () => {
        chain    = await Blockchain.create();
        deployer = await chain.treasury('deployer');
        poster   = await chain.treasury('poster');
        agent1   = await chain.treasury('agent1');
        agent2   = await chain.treasury('agent2');

        coordinator = chain.openContract(
            SwarmCoordinator.createFromConfig({
                owner:             deployer.address,
                registryAddress:   ZERO_ADDR,
                reputationAddress: ZERO_ADDR,
            }, code)
        );
        await coordinator.sendDeploy(deployer.getSender(), toNano('0.1'));
    });

    it('deploys with nextTaskId = 0', async () => {
        expect(await coordinator.getNextTaskId()).toBe(0n);
    });

    it('deploys with 0 accumulated fees', async () => {
        expect(await coordinator.getAccumulatedFees()).toBe(0n);
    });

    it('posts task and increments ID', async () => {
        const tx = await coordinator.sendPostTask(poster.getSender(), {
            descriptionHash: DESC_HASH, requiredCapability: 1,
            workDeadlineDelta: 3600, payment: toNano('1'),
        });
        expect(tx.transactions).toHaveTransaction({
            from: poster.address, to: coordinator.address, success: true,
        });
        expect(await coordinator.getNextTaskId()).toBe(1n);
    });

    it('rejects post task with payment below minimum', async () => {
        const tx = await coordinator.sendPostTask(poster.getSender(), {
            descriptionHash: DESC_HASH, requiredCapability: 1,
            workDeadlineDelta: 3600, payment: toNano('0.01'),
        });
        expect(tx.transactions).toHaveTransaction({ success: false, exitCode: 2011 });
    });

    it('bids on open task', async () => {
        await coordinator.sendPostTask(poster.getSender(), {
            descriptionHash: DESC_HASH, requiredCapability: 1,
            workDeadlineDelta: 3600, payment: toNano('1'),
        });
        const tx = await coordinator.sendBidTask(agent1.getSender(), {
            taskId: 0n, amount: toNano('0.8'), deliveryTime: 1800, proposalHash: PROPOSAL_HASH,
        });
        expect(tx.transactions).toHaveTransaction({ success: true });
    });

    it('rejects bid above budget', async () => {
        await coordinator.sendPostTask(poster.getSender(), {
            descriptionHash: DESC_HASH, requiredCapability: 1,
            workDeadlineDelta: 3600, payment: toNano('1'),
        });
        const tx = await coordinator.sendBidTask(agent1.getSender(), {
            taskId: 0n, amount: toNano('2'), deliveryTime: 1800, proposalHash: PROPOSAL_HASH,
        });
        expect(tx.transactions).toHaveTransaction({ success: false, exitCode: 2006 });
    });

    it('rejects duplicate bid from same agent', async () => {
        await coordinator.sendPostTask(poster.getSender(), {
            descriptionHash: DESC_HASH, requiredCapability: 1,
            workDeadlineDelta: 3600, payment: toNano('1'),
        });
        await coordinator.sendBidTask(agent1.getSender(), {
            taskId: 0n, amount: toNano('0.8'), deliveryTime: 1800, proposalHash: PROPOSAL_HASH,
        });
        const tx = await coordinator.sendBidTask(agent1.getSender(), {
            taskId: 0n, amount: toNano('0.7'), deliveryTime: 1800, proposalHash: PROPOSAL_HASH,
        });
        expect(tx.transactions).toHaveTransaction({ success: false, exitCode: 2009 });
    });

    it('accepts bid', async () => {
        await coordinator.sendPostTask(poster.getSender(), {
            descriptionHash: DESC_HASH, requiredCapability: 1,
            workDeadlineDelta: 3600, payment: toNano('1'),
        });
        await coordinator.sendBidTask(agent1.getSender(), {
            taskId: 0n, amount: toNano('0.8'), deliveryTime: 1800, proposalHash: PROPOSAL_HASH,
        });
        const tx = await coordinator.sendAcceptBid(poster.getSender(), {
            taskId: 0n, agent: agent1.address,
        });
        expect(tx.transactions).toHaveTransaction({ success: true });
    });

    it('rejects accept from non-poster', async () => {
        await coordinator.sendPostTask(poster.getSender(), {
            descriptionHash: DESC_HASH, requiredCapability: 1,
            workDeadlineDelta: 3600, payment: toNano('1'),
        });
        await coordinator.sendBidTask(agent1.getSender(), {
            taskId: 0n, amount: toNano('0.8'), deliveryTime: 1800, proposalHash: PROPOSAL_HASH,
        });
        const tx = await coordinator.sendAcceptBid(agent2.getSender(), {
            taskId: 0n, agent: agent1.address,
        });
        expect(tx.transactions).toHaveTransaction({ success: false, exitCode: 2004 });
    });

    it('full lifecycle: post → bid → accept → submit → verify', async () => {
        await coordinator.sendPostTask(poster.getSender(), {
            descriptionHash: DESC_HASH, requiredCapability: 1,
            workDeadlineDelta: 3600, payment: toNano('1'),
        });
        await coordinator.sendBidTask(agent1.getSender(), {
            taskId: 0n, amount: toNano('0.8'), deliveryTime: 1800, proposalHash: PROPOSAL_HASH,
        });
        await coordinator.sendAcceptBid(poster.getSender(), {
            taskId: 0n, agent: agent1.address,
        });
        const submit = await coordinator.sendSubmitResult(agent1.getSender(), {
            taskId: 0n, resultHash: RESULT_HASH,
        });
        expect(submit.transactions).toHaveTransaction({ success: true });

        const verify = await coordinator.sendVerifyResult(poster.getSender(), { taskId: 0n });
        expect(verify.transactions).toHaveTransaction({ success: true });
    });

    it('cancels task with no bids and refunds poster', async () => {
        const balanceBefore = await poster.getBalance();
        await coordinator.sendPostTask(poster.getSender(), {
            descriptionHash: DESC_HASH, requiredCapability: 1,
            workDeadlineDelta: 3600, payment: toNano('1'),
        });
        const tx = await coordinator.sendCancelTask(poster.getSender(), { taskId: 0n });
        expect(tx.transactions).toHaveTransaction({ success: true });
        // Poster should get refund — balance roughly same as before
        const balanceAfter = await poster.getBalance();
        expect(balanceAfter).toBeGreaterThan(balanceBefore - toNano('0.1'));
    });

    it('cannot cancel task that has bids', async () => {
        await coordinator.sendPostTask(poster.getSender(), {
            descriptionHash: DESC_HASH, requiredCapability: 1,
            workDeadlineDelta: 3600, payment: toNano('1'),
        });
        await coordinator.sendBidTask(agent1.getSender(), {
            taskId: 0n, amount: toNano('0.8'), deliveryTime: 1800, proposalHash: PROPOSAL_HASH,
        });
        const tx = await coordinator.sendCancelTask(poster.getSender(), { taskId: 0n });
        expect(tx.transactions).toHaveTransaction({ success: false, exitCode: 2009 });
    });

    it('rejects operations on non-existent task', async () => {
        const tx = await coordinator.sendCancelTask(poster.getSender(), { taskId: 999n });
        expect(tx.transactions).toHaveTransaction({ success: false, exitCode: 2001 });
    });

    it('two tasks can coexist independently', async () => {
        await coordinator.sendPostTask(poster.getSender(), {
            descriptionHash: DESC_HASH, requiredCapability: 1,
            workDeadlineDelta: 3600, payment: toNano('1'),
        });
        await coordinator.sendPostTask(poster.getSender(), {
            descriptionHash: DESC_HASH + 1n, requiredCapability: 2,
            workDeadlineDelta: 7200, payment: toNano('2'),
        });
        expect(await coordinator.getNextTaskId()).toBe(2n);
    });
});