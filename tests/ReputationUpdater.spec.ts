import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import {
    ReputationUpdater,
    BADGE_FIRST_TASK, BADGE_TEN_TASKS, BADGE_PIONEER,
} from '../wrappers/ReputationUpdater';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';

describe('ReputationUpdater', () => {
    let code:        any;
    let chain:       Blockchain;
    let deployer:    SandboxContract<TreasuryContract>;
    let coordinator: SandboxContract<TreasuryContract>;
    let agent1:      SandboxContract<TreasuryContract>;
    let agent2:      SandboxContract<TreasuryContract>;
    let reputation:  SandboxContract<ReputationUpdater>;

    beforeAll(async () => { code = await compile('ReputationUpdater'); });

    beforeEach(async () => {
        chain       = await Blockchain.create();
        deployer    = await chain.treasury('deployer');
        coordinator = await chain.treasury('coordinator');
        agent1      = await chain.treasury('agent1');
        agent2      = await chain.treasury('agent2');

        reputation = chain.openContract(
            ReputationUpdater.createFromConfig({
                owner:              deployer.address,
                coordinatorAddress: coordinator.address,
            }, code)
        );
        await reputation.sendDeploy(deployer.getSender(), toNano('0.1'));
    });

    it('starts with 0 agents', async () => {
        expect(await reputation.getAgentCount()).toBe(0);
    });

    it('returns 500 (initial score) for unknown agent', async () => {
        expect(await reputation.getScore(agent1.address)).toBe(500);
    });

    it('returns 0 badges for unknown agent', async () => {
        expect(await reputation.getBadges(agent1.address)).toBe(0);
    });

    it('increases score by 10 for small task success (<1 TON)', async () => {
        await reputation.sendTaskCompleted(coordinator.getSender(), {
            agent: agent1.address, success: 1, taskValue: toNano('0.5'),
        });
        expect(await reputation.getScore(agent1.address)).toBe(510);
    });

    it('increases score by 20 for medium task success (1–10 TON)', async () => {
        await reputation.sendTaskCompleted(coordinator.getSender(), {
            agent: agent1.address, success: 1, taskValue: toNano('5'),
        });
        expect(await reputation.getScore(agent1.address)).toBe(520);
    });

    it('increases score by 40 for large task success (>10 TON)', async () => {
        await reputation.sendTaskCompleted(coordinator.getSender(), {
            agent: agent1.address, success: 1, taskValue: toNano('15'),
        });
        expect(await reputation.getScore(agent1.address)).toBe(540);
    });

    it('decreases score by 50 on failure', async () => {
        await reputation.sendTaskCompleted(coordinator.getSender(), {
            agent: agent1.address, success: 0, taskValue: toNano('5'),
        });
        expect(await reputation.getScore(agent1.address)).toBe(450);
    });

    it('clamps score to 0', async () => {
        for (let i = 0; i < 10; i++) {
            await reputation.sendTaskCompleted(coordinator.getSender(), {
                agent: agent2.address, success: 0, taskValue: toNano('1'),
            });
        }
        expect(await reputation.getScore(agent2.address)).toBe(0);
    });

    it('clamps score to 1000 max', async () => {
        for (let i = 0; i < 15; i++) {
            await reputation.sendTaskCompleted(coordinator.getSender(), {
                agent: agent1.address, success: 1, taskValue: toNano('15'),
            });
        }
        expect(await reputation.getScore(agent1.address)).toBeLessThanOrEqual(1000);
    });

    it('awards BADGE_FIRST_TASK after first completion', async () => {
        await reputation.sendTaskCompleted(coordinator.getSender(), {
            agent: agent1.address, success: 1, taskValue: toNano('1'),
        });
        const badges = await reputation.getBadges(agent1.address);
        expect(badges & BADGE_FIRST_TASK).toBe(BADGE_FIRST_TASK);
    });

    it('awards BADGE_PIONEER to new agents', async () => {
        await reputation.sendTaskCompleted(coordinator.getSender(), {
            agent: agent1.address, success: 1, taskValue: toNano('1'),
        });
        const badges = await reputation.getBadges(agent1.address);
        expect(badges & BADGE_PIONEER).toBe(BADGE_PIONEER);
    });

    it('awards BADGE_TEN_TASKS after 10 completions', async () => {
        for (let i = 0; i < 10; i++) {
            await reputation.sendTaskCompleted(coordinator.getSender(), {
                agent: agent1.address, success: 1, taskValue: toNano('0.5'),
            });
        }
        const badges = await reputation.getBadges(agent1.address);
        expect(badges & BADGE_TEN_TASKS).toBe(BADGE_TEN_TASKS);
    });

    it('isTrusted returns true for score above threshold', async () => {
        await reputation.sendTaskCompleted(coordinator.getSender(), {
            agent: agent1.address, success: 1, taskValue: toNano('5'),
        });
        expect(await reputation.isTrusted(agent1.address, 400)).toBe(true);
    });

    it('isTrusted returns false for unknown agent vs high threshold', async () => {
        expect(await reputation.isTrusted(agent2.address, 600)).toBe(false);
    });

    it('rejects TaskCompleted from non-coordinator', async () => {
        const attacker = await chain.treasury('attacker');
        const tx = await reputation.sendTaskCompleted(attacker.getSender(), {
            agent: agent1.address, success: 1, taskValue: toNano('1'),
        });
        expect(tx.transactions).toHaveTransaction({
            from: attacker.address, to: reputation.address,
            success: false, exitCode: 3001,
        });
    });

    it('counts each unique agent once', async () => {
        await reputation.sendTaskCompleted(coordinator.getSender(), {
            agent: agent1.address, success: 1, taskValue: toNano('1'),
        });
        await reputation.sendTaskCompleted(coordinator.getSender(), {
            agent: agent1.address, success: 1, taskValue: toNano('1'),
        });
        await reputation.sendTaskCompleted(coordinator.getSender(), {
            agent: agent2.address, success: 1, taskValue: toNano('1'),
        });
        expect(await reputation.getAgentCount()).toBe(2);
    });
});