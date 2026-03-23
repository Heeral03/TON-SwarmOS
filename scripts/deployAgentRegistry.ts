import { toNano } from '@ton/core';
import { AgentRegistry } from '../wrappers/AgentRegistry';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const deployer = provider.sender().address!;

    const registry = provider.open(
        AgentRegistry.createFromConfig({ owner: deployer }, await compile('AgentRegistry'))
    );

    await registry.sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(registry.address);

    console.log('✅ AgentRegistry:', registry.address.toString());
    console.log('REGISTRY_ADDRESS=' + registry.address.toString());
}