import { TonClient, Address } from '@ton/ton';

const client = new TonClient({
    endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC'
});

const REGISTRY = 'EQAHc9UjDJ89VNLgv3oBlLvEKEftbUQYPoYBNPi-jXhYEnDA';

try {
    console.log('🔍 Testing TON Testnet connection...');
    const result = await client.runMethod(Address.parse(REGISTRY), 'getAgentCount');
    console.log('✅ Connection successful!');
    console.log('✅ Agents registered:', result.stack.readNumber());
} catch (e) {
    console.error('❌ Connection failed:', e.message);
    if (e.response) {
        console.error('   Status:', e.response.status);
    }
}
