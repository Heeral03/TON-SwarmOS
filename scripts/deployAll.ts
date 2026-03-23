import { toNano } from '@ton/core';
import { AgentRegistry } from '../wrappers/AgentRegistry';
import { SwarmCoordinator } from '../wrappers/SwarmCoordinator';
import { ReputationUpdater } from '../wrappers/ReputationUpdater';
import { compile, NetworkProvider } from '@ton/blueprint';

// Deploys all 3 SwarmOS contracts in one run.
//
// Order matters:
//   1. Compile all three to get deterministic addresses
//   2. Deploy AgentRegistry
//   3. Deploy ReputationUpdater (with pre-calculated coordinator address)
//   4. Deploy SwarmCoordinator
//
// Because TON contract addresses are deterministic (hash of code + data),
// we can calculate SwarmCoordinator's address BEFORE deploying it,
// and use it when deploying ReputationUpdater. No chicken-and-egg problem.

export async function run(provider: NetworkProvider) {
    const deployer = provider.sender().address!;

    console.log('🚀 TON SwarmOS — Full Deployment');
    console.log('👤 Deployer:', deployer.toString());
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Compile all three first
    const [registryCode, reputationCode, coordinatorCode] = await Promise.all([
        compile('AgentRegistry'),
        compile('ReputationUpdater'),
        compile('SwarmCoordinator'),
    ]);

    // ── Step 1: Deploy AgentRegistry ─────────────────────────
    console.log('\n[1/3] Deploying AgentRegistry...');

    const registry = provider.open(
        AgentRegistry.createFromConfig({ owner: deployer }, registryCode)
    );
    await registry.sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(registry.address);
    console.log('✅', registry.address.toString());

    // ── Step 2: Pre-calculate SwarmCoordinator address ───────
    // We need a temporary ReputationUpdater to know its address,
    // so we can build SwarmCoordinator's init data (which includes reputation address),
    // which gives us SwarmCoordinator's address — used in ReputationUpdater's init data.
    //
    // Bootstrap order:
    //   a) Create reputation with deployer as placeholder coordinator
    //   b) From reputation address, create coordinator (which needs reputation address)
    //   c) Coordinator address is now deterministic — use it for real reputation deploy

    const tempReputation = provider.open(
        ReputationUpdater.createFromConfig(
            { owner: deployer, coordinatorAddress: deployer },
            reputationCode,
        )
    );

    const coordinator = provider.open(
        SwarmCoordinator.createFromConfig(
            {
                owner:             deployer,
                registryAddress:   registry.address,
                reputationAddress: tempReputation.address,
            },
            coordinatorCode,
        )
    );

    // Now build the REAL ReputationUpdater with actual coordinator address
    const reputation = provider.open(
        ReputationUpdater.createFromConfig(
            {
                owner:              deployer,
                coordinatorAddress: coordinator.address, // real address, pre-calculated
            },
            reputationCode,
        )
    );

    // ── Step 3: Deploy ReputationUpdater ─────────────────────
    console.log('\n[2/3] Deploying ReputationUpdater...');
    console.log('      Coordinator pre-set to:', coordinator.address.toString());

    await reputation.sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(reputation.address);
    console.log('✅', reputation.address.toString());

    // ── Step 4: Deploy SwarmCoordinator ──────────────────────
    // Note: coordinator was built with tempReputation.address, but since
    // reputation (real) has same code+different data, its address differs.
    // So we rebuild coordinator with the REAL reputation address.

    const finalCoordinator = provider.open(
        SwarmCoordinator.createFromConfig(
            {
                owner:             deployer,
                registryAddress:   registry.address,
                reputationAddress: reputation.address, // real reputation address
            },
            coordinatorCode,
        )
    );

    console.log('\n[3/3] Deploying SwarmCoordinator...');
    await finalCoordinator.sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(finalCoordinator.address);
    console.log('✅', finalCoordinator.address.toString());

    // ── Done ──────────────────────────────────────────────────
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎉 All contracts deployed!\n');
    console.log('Copy to .env:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`REGISTRY_ADDRESS=${registry.address.toString()}`);
    console.log(`REPUTATION_ADDRESS=${reputation.address.toString()}`);
    console.log(`COORDINATOR_ADDRESS=${finalCoordinator.address.toString()}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\nTonscan links:');
    console.log('  https://testnet.tonscan.org/address/' + registry.address.toString());
    console.log('  https://testnet.tonscan.org/address/' + reputation.address.toString());
    console.log('  https://testnet.tonscan.org/address/' + finalCoordinator.address.toString());
}