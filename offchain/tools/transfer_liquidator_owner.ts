import '../infra/env';
import { chainById, loadConfig, liquidatorForChain } from '../infra/config';
import { privateKeyForChain } from '../infra/accounts';
import { log } from '../infra/logger';
import { Address, Hex, TransactionReceipt, bytesToHex, createPublicClient, createWalletClient, encodeFunctionData, hexToBytes, http, parseAbi, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base, optimism, polygon, type Chain } from 'viem/chains';
import { formatUnits } from 'viem/utils';

const SAFE_ABI = parseAbi([
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address payable refundReceiver,bytes signatures) returns (bool success)',
]);

const LIQUIDATOR_ABI = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function transferOwnership(address newOwner)',
  'function acceptOwnership()',
]);

const CHAINS: Record<number, Chain> = {
  [arbitrum.id]: arbitrum,
  [optimism.id]: optimism,
  [base.id]: base,
  [polygon.id]: polygon,
};

type Args = {
  chainId: number;
  safeAddress: Address;
  contract: Address;
  ownerPk: `0x${string}`;
  rpcUrl: string;
};

type TransferResult = {
  chainId: number;
  owner: Address;
  safe: Address;
  pending: Address;
  txHashes: string[];
};

function parseArgs(): { chainId: number } {
  const idx = process.argv.findIndex((arg) => arg === '--chain' || arg === '--chain-id');
  if (idx >= 0 && process.argv[idx + 1]) {
    return { chainId: Number(process.argv[idx + 1]) };
  }

  const chainEq = process.argv.find((arg) => arg.startsWith('--chain='));
  if (chainEq) {
    const [, value] = chainEq.split('=');
    return { chainId: Number(value) };
  }

  return { chainId: polygon.id };
}

function safeAddressForChain(chainName: string): Address | undefined {
  const upper = chainName.toUpperCase();
  const primary = process.env[`SAFE_ADDRESS_${upper}`];
  if (primary) return primary as Address;

  switch (upper) {
    case 'ARBITRUM':
      return process.env.SAFE_ADDRESS_ARB as Address | undefined;
    case 'OPTIMISM':
    case 'OP':
      return process.env.SAFE_ADDRESS_OP as Address | undefined;
    case 'BASE':
      return process.env.SAFE_ADDRESS_BASE as Address | undefined;
    case 'POLYGON':
      return process.env.SAFE_ADDRESS_POLYGON as Address | undefined;
    default:
      return undefined;
  }
}

async function waitReceipt(client: ReturnType<typeof createPublicClient>, hash: Hex): Promise<TransactionReceipt> {
  return client.waitForTransactionReceipt({ hash });
}

async function ensureOwnership({ chainId, safeAddress, contract, ownerPk, rpcUrl }: Args): Promise<TransferResult> {
  const chainDef = CHAINS[chainId];
  if (!chainDef) throw new Error(`Unsupported chainId ${chainId}`);

  const account = privateKeyToAccount(ownerPk);
  const wallet = createWalletClient({ account, chain: chainDef, transport: http(rpcUrl) });
  const client = createPublicClient({ chain: chainDef, transport: http(rpcUrl) });
  const dryRun = process.argv.includes('--dry-run');

  const owner = (await client.readContract({ address: contract, abi: LIQUIDATOR_ABI, functionName: 'owner' })) as Address;
  let pending: Address = zeroAddress;
  try {
    pending = (await client.readContract({
      address: contract,
      abi: LIQUIDATOR_ABI,
      functionName: 'pendingOwner',
    })) as Address;
  } catch (err) {
    log.warn({ chainId, err: (err as Error).message }, 'pending-owner-read-failed');
  }

  const txHashes: string[] = [];
  if (owner.toLowerCase() === safeAddress.toLowerCase()) {
    log.info({ chainId, owner }, 'liquidator-owner-ok');
    return { chainId, owner, safe: safeAddress, pending, txHashes };
  }

  if (pending.toLowerCase() !== safeAddress.toLowerCase()) {
    if (dryRun) {
      log.info({ chainId, contract, safeAddress }, 'transfer-ownership-skip-dry-run');
    } else {
      log.info({ chainId, contract, safeAddress }, 'transfer-ownership-start');
      const hash = await wallet.writeContract({
        abi: LIQUIDATOR_ABI,
        address: contract,
        functionName: 'transferOwnership',
        args: [safeAddress],
        account,
        chain: chainDef,
      });
      txHashes.push(hash);
      await waitReceipt(client, hash);
      log.info({ chainId, hash }, 'transfer-ownership-ok');
    }
  }

  const safeTxGas = 150000n;
  const baseGas = 0n;
  const gasPrice = 0n;
  const value = 0n;
  const operation = 0;
  const gasToken = zeroAddress;
  const refundReceiver = zeroAddress;

  const callData = encodeFunctionData({ abi: LIQUIDATOR_ABI, functionName: 'acceptOwnership' });
  const safeNonce = (await client.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: 'nonce' })) as bigint;
  const safeTxHash = (await client.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: 'getTransactionHash',
    args: [
      contract,
      value,
      callData,
      operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      safeNonce,
    ],
  })) as Hex;
  const rawSig = await wallet.signMessage({ message: { raw: safeTxHash } });
  const sigBytes = hexToBytes(rawSig);
  sigBytes[64] = (sigBytes[64] ?? 0) + 4; // mark as eth_sign signature per Safe spec
  const signature = bytesToHex(sigBytes);

  if (dryRun) {
    log.info({ chainId, callData, safeTxHash, signature }, 'ownership-dry-run');
    return {
      chainId,
      owner,
      safe: safeAddress,
      pending,
      txHashes,
    };
  }

  log.info({ chainId, safeNonce: Number(safeNonce) }, 'safe-exec-start');
  const execHash = await wallet.writeContract({
    abi: SAFE_ABI,
    address: safeAddress,
    functionName: 'execTransaction',
    args: [
      contract,
      value,
      callData,
      operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      signature as Hex,
    ],
    account,
    chain: chainDef,
    gas: 400000n,
  });
  txHashes.push(execHash);
  const receipt = await waitReceipt(client, execHash);
  log.info({ chainId, hash: execHash, gasUsed: formatUnits(receipt.gasUsed, 0) }, 'safe-exec-ok');

  const newOwner = (await client.readContract({ address: contract, abi: LIQUIDATOR_ABI, functionName: 'owner' })) as Address;
  let newPending: Address = zeroAddress;
  try {
    newPending = (await client.readContract({
      address: contract,
      abi: LIQUIDATOR_ABI,
      functionName: 'pendingOwner',
    })) as Address;
  } catch (err) {
    log.warn({ chainId, err: (err as Error).message }, 'pending-owner-read-failed');
  }

  return { chainId, owner: newOwner, safe: safeAddress, pending: newPending, txHashes };
}

async function main() {
  const { chainId } = parseArgs();
  const cfg = loadConfig();
  const chainCfg = chainById(cfg, chainId);
  if (!chainCfg) throw new Error(`Chain ${chainId} not found in config`);

  const contract = liquidatorForChain(cfg, chainId);
  if (!contract) throw new Error(`No liquidator contract for chain ${chainId}`);

  const safe = safeAddressForChain(chainCfg.name);
  if (!safe) throw new Error(`Missing SAFE_ADDRESS for ${chainCfg.name}`);

  const pk = privateKeyForChain(chainCfg);
  if (!pk) throw new Error(`Missing private key for ${chainCfg.name}`);

  const result = await ensureOwnership({
    chainId,
    safeAddress: safe,
    contract,
    ownerPk: pk,
    rpcUrl: chainCfg.rpc,
  });

  log.info({ chainId, owner: result.owner, pending: result.pending, txHashes: result.txHashes }, 'ensure-ownership-result');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
