import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';

// EVM 链的公共 RPC 端点（无需 API KEY，使用更快的端点）
const EVM_RPC_ENDPOINTS: Record<string, string> = {
  ETH: 'https://rpc.ankr.com/eth',
  BSC: 'https://rpc.ankr.com/bsc',
  Polygon: 'https://rpc.ankr.com/polygon',
  Arbitrum: 'https://rpc.ankr.com/arbitrum',
  Optimism: 'https://rpc.ankr.com/optimism',
  Base: 'https://rpc.ankr.com/base',
  Avalanche: 'https://rpc.ankr.com/avalanche',
  Fantom: 'https://rpc.ankr.com/fantom',
  zkSync: 'https://mainnet.era.zksync.io',
  Linea: 'https://rpc.linea.build',
  Scroll: 'https://rpc.scroll.io',
  Mantle: 'https://rpc.mantle.xyz',
};

// Solana 公共 RPC 端点（使用更快的端点）
const SOLANA_RPC = 'https://rpc.ankr.com/solana';

// 查询超时时间（毫秒）
const QUERY_TIMEOUT = 5000;

// 最大并发数
const MAX_CONCURRENT = 50;

interface BalanceRequest {
  chain: string;
  chains?: string[]; // 支持多链查询
  addresses: string[];
}

interface BalanceResponse {
  address: string;
  balances: Record<string, string>; // 每个链的余额
  totalBalance: string; // 所有链的余额总和
}

// 带超时的 Promise 包装器
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Query timeout')), timeoutMs)
    ),
  ]);
}

// 并发控制函数（使用更简单的实现）
async function runWithConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: T[] = [];
  const executing: Promise<void>[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const promise = task()
      .then((result) => {
        results[i] = result;
      })
      .catch((error) => {
        console.error(`Task ${i} error:`, error);
        throw error;
      })
      .finally(() => {
        const index = executing.indexOf(promise);
        if (index > -1) {
          executing.splice(index, 1);
        }
      });

    executing.push(promise);

    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

// 查询 EVM 链余额（带超时控制）
async function getEVMBalance(chain: string, address: string): Promise<string> {
  const rpcUrl = EVM_RPC_ENDPOINTS[chain];
  if (!rpcUrl) {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
      staticNetwork: true,
    });
    const balancePromise = provider.getBalance(address);
    const balance = await withTimeout(balancePromise, QUERY_TIMEOUT);
    // 转换为 ETH 单位（18 位小数）
    return ethers.formatEther(balance);
  } catch (error) {
    console.error(`Error fetching balance for ${chain}:`, error);
    throw error;
  }
}

// 查询 Solana 余额（带超时控制）
async function getSolanaBalance(address: string): Promise<string> {
  try {
    const connection = new Connection(SOLANA_RPC, 'confirmed');
    const publicKey = new PublicKey(address);
    const balancePromise = connection.getBalance(publicKey);
    const balance = await withTimeout(balancePromise, QUERY_TIMEOUT);
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

    // 创建所有地址和所有链的查询任务（使用函数包装以便并发控制）
    const allQueryTasks = addresses.flatMap((address) =>
      chainsToQuery.map(
        (chainName) => async () => {
          try {
            let balance: string;
            if (chainName === 'Solana') {
              balance = await getSolanaBalance(address);
            } else {
              balance = await getEVMBalance(chainName, address);
            }
            return { address, chain: chainName, balance };
          } catch (error) {
            return { address, chain: chainName, balance: 'Error' };
          }
        }
      )
    );

    // 使用并发控制执行所有查询
    const queryResults = await runWithConcurrencyLimit(
      allQueryTasks,
      MAX_CONCURRENT
    );

    // 按地址组织结果
    const resultsMap = new Map<string, Record<string, string>>();
    addresses.forEach((address) => {
      resultsMap.set(address, {});
    });

    queryResults.forEach(({ address, chain, balance }) => {
      const balances = resultsMap.get(address) || {};
      balances[chain] = balance;
      resultsMap.set(address, balances);
    });

    // 转换为数组格式，保持地址顺序，并计算总余额
    const results: BalanceResponse[] = addresses.map((address) => {
      const balances = resultsMap.get(address) || {};
      
      // 计算所有链的余额总和
      let totalBalance = 0;
      Object.values(balances).forEach((balance) => {
        if (balance !== 'Error' && balance !== 'N/A') {
          const numBalance = parseFloat(balance);
          if (!isNaN(numBalance)) {
            totalBalance += numBalance;
          }
        }
      });

      return {
        address,
        balances,
        totalBalance: totalBalance.toFixed(8),
      };
    });

    return NextResponse.json({ results, chains: chainsToQuery });
  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

