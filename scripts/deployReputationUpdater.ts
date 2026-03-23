import { toNano, Address } from '@ton/core';
import { ReputationUpdater } from '../wrappers/ReputationUpdater';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const deployer = provider.sender().address!;

    if (!process.env.COORDINATOR_ADDRESS) {
        throw new Error('Set COORDINATOR_ADDRESS in .env first');
    }

    const reputation = provider.open(
        ReputationUpdater.createFromConfig(
            {
                owner:              deployer,
                coordinatorAddress: Address.parse(process.env.COORDINATOR_ADDRESS),
            },
            await compile('ReputationUpdater'),
        )
    );

    await reputation.sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(reputation.address);

    console.log('✅ ReputationUpdater:', reputation.address.toString());
    console.log('REPUTATION_ADDRESS=' + reputation.address.toString());
}