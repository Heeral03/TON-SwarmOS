import { toNano, Address } from '@ton/core';
import { SwarmCoordinator } from '../wrappers/SwarmCoordinator';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const deployer = provider.sender().address!;

    if (!process.env.REGISTRY_ADDRESS)   throw new Error('Set REGISTRY_ADDRESS in .env first');
    if (!process.env.REPUTATION_ADDRESS) throw new Error('Set REPUTATION_ADDRESS in .env first');

    const coordinator = provider.open(
        SwarmCoordinator.createFromConfig(
            {
                owner:             deployer,
                registryAddress:   Address.parse(process.env.REGISTRY_ADDRESS),
                reputationAddress: Address.parse(process.env.REPUTATION_ADDRESS),
            },
            await compile('SwarmCoordinator'),
        )
    );

    await coordinator.sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(coordinator.address);

    console.log('✅ SwarmCoordinator:', coordinator.address.toString());
    console.log('COORDINATOR_ADDRESS=' + coordinator.address.toString());
}