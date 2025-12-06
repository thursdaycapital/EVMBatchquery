import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';

// EVM 链的公共 RPC 端点（无需 API KEY）
const EVM_RPC_ENDPOINTS: Record<string, string> = {
  ETH: 'https://eth.llamarpc.com',
  BSC: 'https://bsc-dataseed.binance.org',
  Polygon: 'https://polygon-rpc.com',
  Arbitrum: 'https://arb1.arbitrum.io/rpc',
  Optimism: 'https://mainnet.optimism.io',
  Base: 'https://mainnet.base.org',
  Avalanche: 'https://api.avax.network/ext/bc/C/rpc',
  Fantom: 'https://rpc.ftm.tools',
  zkSync: 'https://mainnet.era.zksync.io',
  Linea: 'https://rpc.linea.build',
  Scroll: 'https://rpc.scroll.io',
  Mantle: 'https://rpc.mantle.xyz',
};

// Solana 公共 RPC 端点
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

interface BalanceRequest {
  chain: string;
  chains?: string[]; // 支持多链查询
  addresses: string[];
}

interface BalanceResponse {
  address: string;
  balances: Record<string, string>; // 每个链的余额
}

// 查询 EVM 链余额
async function getEVMBalance(chain: string, address: string): Promise<string> {
  const rpcUrl = EVM_RPC_ENDPOINTS[chain];
  if (!rpcUrl) {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const balance = await provider.getBalance(address);
    // 转换为 ETH 单位（18 位小数）
    return ethers.formatEther(balance);
  } catch (error) {
    console.error(`Error fetching balance for ${chain}:`, error);
    throw error;
  }
}

// 查询 Solana 余额
async function getSolanaBalance(address: string): Promise<string> {
  try {
    const connection = new Connection(SOLANA_RPC, 'confirmed');
    const publicKey = new PublicKey(address);
    const balance = await connection.getBalance(publicKey);
    // lamports 转换为 SOL（9 位小数）
    return (balance / 1e9).toString();
  } catch (error) {
    console.error('Error fetching Solana balance:', error);
    throw error;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: BalanceRequest = await request.json();
    const { chain, chains, addresses } = body;

    if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
      return NextResponse.json(
        { error: 'Invalid request. Addresses array is required.' },
        { status: 400 }
      );
    }

    // 确定要查询的链列表
    let chainsToQuery: string[] = [];
    if (chains && chains.length > 0) {
      chainsToQuery = chains;
    } else if (chain === 'All EVM Chains') {
      // 查询所有 EVM 链
      chainsToQuery = Object.keys(EVM_RPC_ENDPOINTS);
    } else if (chain === 'Solana') {
      chainsToQuery = ['Solana'];
    } else {
      chainsToQuery = [chain];
    }

    const results: BalanceResponse[] = [];

    // 对每个地址查询所有链的余额
    for (const address of addresses) {
      const balances: Record<string, string> = {};

      // 并行查询所有链
      const chainPromises = chainsToQuery.map(async (chainName) => {
        try {
          if (chainName === 'Solana') {
            const balance = await getSolanaBalance(address);
            return { chain: chainName, balance };
          } else {
            const balance = await getEVMBalance(chainName, address);
            return { chain: chainName, balance };
          }
        } catch (error) {
          return { chain: chainName, balance: 'Error' };
        }
      });

      const chainResults = await Promise.all(chainPromises);
      chainResults.forEach(({ chain, balance }) => {
        balances[chain] = balance;
      });

      results.push({ address, balances });
    }

    return NextResponse.json({ results, chains: chainsToQuery });
  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

