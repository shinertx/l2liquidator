"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = require("dotenv");
const path_1 = __importDefault(require("path"));
const viem_1 = require("viem");
const accounts_1 = require("viem/accounts");
(0, dotenv_1.config)();
(0, dotenv_1.config)({ path: path_1.default.resolve(__dirname, '../../.env') });
function expand(value) {
    if (!value)
        return value;
    return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '');
}
const configs = [
    {
        label: 'Arbitrum',
        rpc: expand(process.env.RPC_ARB),
        pk: process.env.WALLET_PK_ARB,
        expectedChainId: Number(process.env.CHAIN_ID_ARB ?? 42161),
    },
    {
        label: 'Optimism',
        rpc: expand(process.env.RPC_OP),
        pk: process.env.WALLET_PK_OP,
        expectedChainId: Number(process.env.CHAIN_ID_OP ?? 10),
    },
];
async function main() {
    for (const cfg of configs) {
        if (!cfg.rpc) {
            console.warn(`[${cfg.label}] missing RPC URL`);
            continue;
        }
        if (!cfg.pk) {
            console.warn(`[${cfg.label}] missing private key`);
            continue;
        }
        const account = (0, accounts_1.privateKeyToAccount)(cfg.pk);
        const client = (0, viem_1.createPublicClient)({ transport: (0, viem_1.http)(cfg.rpc) });
        try {
            const chainId = await client.getChainId();
            const balance = await client.getBalance({ address: account.address });
            const match = cfg.expectedChainId ? chainId === cfg.expectedChainId : true;
            const status = match ? 'ok' : `chain-mismatch (expected ${cfg.expectedChainId}, got ${chainId})`;
            console.log(`\n[${cfg.label}] ${status}`);
            console.log(`  address: ${account.address}`);
            console.log(`  balance: ${(0, viem_1.formatEther)(balance)} native`);
        }
        catch (err) {
            console.error(`\n[${cfg.label}] failed:`, err.message);
        }
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
