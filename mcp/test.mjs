import { TonClient, Address } from '@ton/ton';

const client = new TonClient({
    endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
    apiKey: '93e025f3b8d2a771dbce39d9641e2b607110c5db3b7d1dc6c82990a210f60c06'
});

const REGISTRY    = 'EQAHc9UjDJ89VNLgv3oBlLvEKEftbUQYPoYBNPi-jXhYEnDA';
const COORDINATOR = 'EQDyYG3hJV4C2blRGl3kt0m7eYJvDEuwNLmpI4LWhubr88w7';
const REPUTATION  = 'EQBET0s93LJ_5AfLqMQsfMzTdEMJz9HA6jkFccQeZkIiCPOn';

console.log('🔍 TON SwarmOS — Live Contract Stats\n');

const r1 = await client.runMethod(Address.parse(REGISTRY), 'getAgentCount');
console.log('✅ Agents registered:', r1.stack.readNumber());

const r2 = await client.runMethod(Address.parse(COORDINATOR), 'getNextTaskId');
console.log('✅ Tasks posted:', r2.stack.readBigNumber().toString());

const r3 = await client.runMethod(Address.parse(REPUTATION), 'getAgentCount');
console.log('✅ Agents with reputation:', r3.stack.readNumber());

console.log('\n📍 Live on testnet:');
console.log('https://testnet.tonscan.org/address/' + REGISTRY);