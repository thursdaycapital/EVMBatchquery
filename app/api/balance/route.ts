import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';

// EVM 链的公共 RPC 端点（无需 API KEY，使用多个备用端点）
const EVM_RPC_ENDPOINTS: Record<string, string[]> = {
  ETH: ['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth', 'https://ethereum.publicnode.com'],
  BSC: ['https://bsc-dataseed.binance.org', 'https://rpc.ankr.com/bsc', 'https://bsc.publicnode.com'],
  Polygon: ['https://polygon-rpc.com', 'https://rpc.ankr.com/polygon', 'https://polygon.llamarpc.com'],
  Arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://rpc.ankr.com/arbitrum', 'https://arbitrum.llamarpc.com'],
  Optimism: ['https://mainnet.optimism.io', 'https://rpc.ankr.com/optimism', 'https://optimism.llamarpc.com'],
  Base: ['https://mainnet.base.org', 'https://rpc.ankr.com/base', 'https://base.llamarpc.com'],
  Avalanche: ['https://api.avax.network/ext/bc/C/rpc', 'https://rpc.ankr.com/avalanche', 'https://avalanche.public-rpc.com'],
  Fantom: ['https://rpc.ftm.tools', 'https://rpc.ankr.com/fantom', 'https://fantom.publicnode.com'],
  zkSync: ['https://mainnet.era.zksync.io', 'https://zksync-era.blockpi.network/v1/rpc/public'],
  Linea: ['https://rpc.linea.build', 'https://linea.blockpi.network/v1/rpc/public'],
  Scroll: ['https://rpc.scroll.io', 'https://scroll.blockpi.network/v1/rpc/public'],
  Mantle: ['https://rpc.mantle.xyz', 'https://mantle.blockpi.network/v1/rpc/public'],
};

// Solana 公共 RPC 端点（使用多个备用端点）
const SOLANA_RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://rpc.ankr.com/solana',
  'https://solana.public-rpc.com',
];

// 查询超时时间（毫秒）
const QUERY_TIMEOUT = 10000; // 增加到10秒

// 最大并发数
const MAX_CONCURRENT = 30; // 降低并发数避免限流

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

// 并发控制函数（修复错误处理）
async function runWithConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: (T | undefined)[] = new Array(tasks.length);
  const executing: Promise<void>[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const taskIndex = i;
    
    const promise = task()
      .then((result) => {
        results[taskIndex] = result;
      })
      .catch((error) => {
        // 任务函数内部应该已经处理了错误，但如果还是抛出了，记录日志
        console.error(`Task ${taskIndex} unexpected error:`, error);
        // 不设置结果，让调用方处理 undefined
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

  // 等待所有任务完成（包括失败的）
  await Promise.allSettled(executing);
  // 过滤掉 undefined，但任务函数应该总是返回结果
  return results.filter((r): r is T => r !== undefined);
}

// 查询 EVM 链余额（带超时控制和重试机制）
async function getEVMBalance(chain: string, address: string): Promise<string> {
  const rpcUrls = EVM_RPC_ENDPOINTS[chain];
  if (!rpcUrls || rpcUrls.length === 0) {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  // 尝试每个 RPC 端点
  for (const rpcUrl of rpcUrls) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
        staticNetwork: true,
      });
      const balancePromise = provider.getBalance(address);
      const balance = await withTimeout(balancePromise, QUERY_TIMEOUT);
      // 转换为 ETH 单位（18 位小数）
      return ethers.formatEther(balance);
    } catch (error) {
      console.error(`Error fetching balance for ${chain} from ${rpcUrl}:`, error);
      // 继续尝试下一个端点
      continue;
    }
  }

  // 所有端点都失败
  throw new Error(`All RPC endpoints failed for ${chain}`);
}

// 查询 Solana 余额（带超时控制和重试机制）
async function getSolanaBalance(address: string): Promise<string> {
  // 尝试每个 RPC 端点
  for (const rpcUrl of SOLANA_RPC_ENDPOINTS) {
    try {
      const connection = new Connection(rpcUrl, 'confirmed');
      const publicKey = new PublicKey(address);
      const balancePromise = connection.getBalance(publicKey);
      const balance = await withTimeout(balancePromise, QUERY_TIMEOUT);
      // lamports 转换为 SOL（9 位小数）
      return (balance / 1e9).toString();
    } catch (error) {
      console.error(`Error fetching Solana balance from ${rpcUrl}:`, error);
      // 继续尝试下一个端点
      continue;
    }
  }

  // 所有端点都失败
  throw new Error('All Solana RPC endpoints failed');
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

    queryResults.forEach((result) => {
      // 确保结果存在且有效
      if (result && result.address && result.chain) {
        const balances = resultsMap.get(result.address) || {};
        balances[result.chain] = result.balance || 'Error';
        resultsMap.set(result.address, balances);
      }
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

