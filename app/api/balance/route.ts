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

// 链名到 CoinGecko 代币 ID 的映射
const CHAIN_TO_COINGECKO_ID: Record<string, string> = {
  ETH: 'ethereum',
  BSC: 'binancecoin',
  Polygon: 'matic-network',
  Arbitrum: 'ethereum', // Arbitrum 使用 ETH
  Optimism: 'ethereum', // Optimism 使用 ETH
  Base: 'ethereum', // Base 使用 ETH
  Avalanche: 'avalanche-2',
  Fantom: 'fantom',
  zkSync: 'ethereum', // zkSync 使用 ETH
  Linea: 'ethereum', // Linea 使用 ETH
  Scroll: 'ethereum', // Scroll 使用 ETH
  Mantle: 'mantle',
  Solana: 'solana',
};

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
  totalBalance: string; // 所有链的余额总和（美元）
  totalBalanceUSD: string; // 美元总价值
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

// 获取代币价格（使用 CoinGecko API，免费无需 API KEY）
async function getTokenPrice(chainName: string): Promise<number> {
  const coinId = CHAIN_TO_COINGECKO_ID[chainName];
  if (!coinId) {
    console.warn(`No price data for chain: ${chainName}`);
    return 0;
  }

  try {
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
      {
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status}`);
    }

    const data: any = await response.json();
    return data[coinId]?.usd || 0;
  } catch (error) {
    console.error(`Error fetching price for ${chainName}:`, error);
    return 0; // 价格获取失败返回0，不影响其他查询
  }
}

// 批量获取所有代币价格
async function getTokenPrices(chains: string[]): Promise<Record<string, number>> {
  const uniqueCoinIds = new Set<string>();
  chains.forEach((chain) => {
    const coinId = CHAIN_TO_COINGECKO_ID[chain];
    if (coinId) {
      uniqueCoinIds.add(coinId);
    }
  });

  const coinIdsArray = Array.from(uniqueCoinIds);
  if (coinIdsArray.length === 0) {
    return {};
  }

  try {
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinIdsArray.join(',')}&vs_currencies=usd`,
      {
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status}`);
    }

    const data: any = await response.json();
    const prices: Record<string, number> = {};

    // 将 coinId 映射回链名
    chains.forEach((chain) => {
      const coinId = CHAIN_TO_COINGECKO_ID[chain];
      if (coinId && data[coinId]) {
        prices[chain] = data[coinId]?.usd || 0;
      } else {
        prices[chain] = 0;
      }
    });

    return prices;
  } catch (error) {
    console.error('Error fetching token prices:', error);
    // 返回空对象，所有价格设为0
    const prices: Record<string, number> = {};
    chains.forEach((chain) => {
      prices[chain] = 0;
    });
    return prices;
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

    queryResults.forEach((result) => {
      // 确保结果存在且有效
      if (result && result.address && result.chain) {
        const balances = resultsMap.get(result.address) || {};
        balances[result.chain] = result.balance || 'Error';
        resultsMap.set(result.address, balances);
      }
    });

    // 获取所有代币的价格
    const prices = await getTokenPrices(chainsToQuery);

    // 转换为数组格式，保持地址顺序，并计算总余额（美元）
    const results: BalanceResponse[] = addresses.map((address) => {
      const balances = resultsMap.get(address) || {};
      
      // 计算所有链的美元总价值
      let totalBalanceUSD = 0;
      Object.entries(balances).forEach(([chain, balance]) => {
        if (balance !== 'Error' && balance !== 'N/A') {
          const numBalance = parseFloat(balance);
          if (!isNaN(numBalance)) {
            const price = prices[chain] || 0;
            totalBalanceUSD += numBalance * price;
          }
        }
      });

      return {
        address,
        balances,
        totalBalance: totalBalanceUSD.toFixed(2), // 美元总价值
        totalBalanceUSD: totalBalanceUSD.toFixed(2),
      };
    });

    return NextResponse.json({ results, chains: chainsToQuery, prices });
  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

