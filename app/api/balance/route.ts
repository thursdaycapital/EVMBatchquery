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
  addresses: string[];
}

interface BalanceResponse {
  address: string;
  balance: string;
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
    const { chain, addresses } = body;

    if (!chain || !addresses || !Array.isArray(addresses) || addresses.length === 0) {
      return NextResponse.json(
        { error: 'Invalid request. Chain and addresses array are required.' },
        { status: 400 }
      );
    }

    const results: BalanceResponse[] = [];

    // 批量查询余额
    if (chain === 'Solana') {
      // Solana 查询
      const promises = addresses.map(async (address) => {
        try {
          const balance = await getSolanaBalance(address);
          return { address, balance };
        } catch (error) {
          return { address, balance: 'Error' };
        }
      });
      const solanaResults = await Promise.all(promises);
      results.push(...solanaResults);
    } else {
      // EVM 链查询
      const promises = addresses.map(async (address) => {
        try {
          const balance = await getEVMBalance(chain, address);
          return { address, balance };
        } catch (error) {
          return { address, balance: 'Error' };
        }
      });
      const evmResults = await Promise.all(promises);
      results.push(...evmResults);
    }

    return NextResponse.json(results);
  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

