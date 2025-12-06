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

// Blockscout API 端点（用于获取所有代币余额）
const BLOCKSCOUT_APIS: Record<string, string> = {
  ETH: 'https://eth.blockscout.com/api',
  BSC: 'https://bsc.blockscout.com/api',
  Polygon: 'https://polygon.blockscout.com/api',
  Arbitrum: 'https://arbitrum.blockscout.com/api',
  Optimism: 'https://optimism.blockscout.com/api',
  Base: 'https://base.blockscout.com/api',
  Avalanche: 'https://avalanche.blockscout.com/api',
  Fantom: 'https://fantom.blockscout.com/api',
  zkSync: '', // zkSync 没有 Blockscout
  Linea: 'https://linea.blockscout.com/api',
  Scroll: 'https://scroll.blockscout.com/api',
  Mantle: 'https://mantle.blockscout.com/api',
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

interface TokenBalance {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  balance: string;
  decimals: number;
  value: string; // 美元价值
}

interface BalanceResponse {
  address: string;
  tokens: TokenBalance[]; // 所有代币列表
  totalBalance: string; // 所有代币的美元总价值
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

// 查询 EVM 链的所有代币余额（包括原生代币和 ERC-20）
async function getEVMAllTokens(chain: string, address: string): Promise<TokenBalance[]> {
  const tokens: TokenBalance[] = [];
  
  // 1. 查询原生代币余额
  const rpcUrls = EVM_RPC_ENDPOINTS[chain];
  if (rpcUrls && rpcUrls.length > 0) {
    for (const rpcUrl of rpcUrls) {
      try {
        const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
          staticNetwork: true,
        });
        const balancePromise = provider.getBalance(address);
        const balance = await withTimeout(balancePromise, QUERY_TIMEOUT);
        const balanceFormatted = ethers.formatEther(balance);
        
        if (parseFloat(balanceFormatted) > 0) {
          tokens.push({
            tokenAddress: 'native',
            tokenSymbol: chain === 'ETH' ? 'ETH' : chain,
            tokenName: chain === 'ETH' ? 'Ethereum' : `${chain} Native Token`,
            balance: balanceFormatted,
            decimals: 18,
            value: '0', // 稍后计算
          });
        }
        break; // 成功获取原生代币余额后退出
      } catch (error) {
        console.error(`Error fetching native balance for ${chain}:`, error);
        continue;
      }
    }
  }

  // 2. 查询 ERC-20 代币余额（使用 Blockscout API）
  const blockscoutApi = BLOCKSCOUT_APIS[chain];
  if (blockscoutApi) {
    try {
      const response = await fetch(
        `${blockscoutApi}?module=account&action=tokenlist&address=${address}`,
        {
          headers: { 'Accept': 'application/json' },
        }
      );
      
      if (response.ok) {
        const data: any = await response.json();
        if (data.status === '1' && data.result && Array.isArray(data.result)) {
          data.result.forEach((token: any) => {
            if (token.balance && parseFloat(token.balance) > 0) {
              const decimals = parseInt(token.token_decimals || '18', 10);
              const balance = ethers.formatUnits(token.balance, decimals);
              
              tokens.push({
                tokenAddress: token.contract_address || token.token_address,
                tokenSymbol: token.symbol || 'UNKNOWN',
                tokenName: token.name || 'Unknown Token',
                balance: balance,
                decimals: decimals,
                value: '0', // 稍后计算
              });
            }
          });
        }
      }
    } catch (error) {
      console.error(`Error fetching tokens from Blockscout for ${chain}:`, error);
    }
  }

  // 3. 对于没有 Blockscout 的链（如 zkSync），使用 RPC 查询（简化版，只查询原生代币）
  // 注意：完整实现需要查询 Transfer 事件，这里先简化处理

  return tokens;
}

// 查询 Solana 的所有代币余额（包括 SOL 和 SPL 代币）
async function getSolanaAllTokens(address: string): Promise<TokenBalance[]> {
  const tokens: TokenBalance[] = [];
  
  // 尝试每个 RPC 端点
  for (const rpcUrl of SOLANA_RPC_ENDPOINTS) {
    try {
      const connection = new Connection(rpcUrl, 'confirmed');
      const publicKey = new PublicKey(address);
      
      // 1. 查询 SOL 余额
      const balancePromise = connection.getBalance(publicKey);
      const balance = await withTimeout(balancePromise, QUERY_TIMEOUT);
      const solBalance = (balance / 1e9).toString();
      
      if (parseFloat(solBalance) > 0) {
        tokens.push({
          tokenAddress: 'native',
          tokenSymbol: 'SOL',
          tokenName: 'Solana',
          balance: solBalance,
          decimals: 9,
          value: '0',
        });
      }
      
      // 2. 查询所有 SPL 代币余额
      const tokenAccountsPromise = connection.getParsedTokenAccountsByOwner(publicKey, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      });
      const tokenAccounts = await withTimeout(tokenAccountsPromise, QUERY_TIMEOUT);
      
      tokenAccounts.value.forEach((accountInfo) => {
        const parsedInfo = accountInfo.account.data.parsed?.info;
        if (parsedInfo && parsedInfo.tokenAmount) {
          const amount = parsedInfo.tokenAmount.uiAmount;
          if (amount && amount > 0) {
            tokens.push({
              tokenAddress: parsedInfo.mint || 'unknown',
              tokenSymbol: parsedInfo.tokenAmount.symbol || 'UNKNOWN',
              tokenName: parsedInfo.tokenAmount.symbol || 'Unknown Token',
              balance: amount.toString(),
              decimals: parsedInfo.tokenAmount.decimals || 9,
              value: '0',
            });
          }
        }
      });
      
      break; // 成功获取后退出
    } catch (error) {
      console.error(`Error fetching Solana tokens from ${rpcUrl}:`, error);
      continue;
    }
  }

  return tokens;
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

// 根据代币符号或地址获取价格（使用 CoinGecko API）
async function getTokenPriceBySymbol(symbol: string, tokenAddress?: string): Promise<number> {
  // 首先尝试通过符号匹配
  const symbolUpper = symbol.toUpperCase();
  
  // 常见代币符号到 CoinGecko ID 的映射
  const symbolToCoinId: Record<string, string> = {
    'ETH': 'ethereum',
    'WETH': 'ethereum',
    'BNB': 'binancecoin',
    'WBNB': 'binancecoin',
    'MATIC': 'matic-network',
    'WMATIC': 'matic-network',
    'ARB': 'arbitrum',
    'OP': 'optimism',
    'AVAX': 'avalanche-2',
    'WAVAX': 'avalanche-2',
    'FTM': 'fantom',
    'WFTM': 'fantom',
    'SOL': 'solana',
    'USDT': 'tether',
    'USDC': 'usd-coin',
    'DAI': 'dai',
    'MNT': 'mantle',
    'WBTC': 'wrapped-bitcoin',
    'BTC': 'bitcoin',
  };

  let coinId = symbolToCoinId[symbolUpper];
  
  // 如果没有找到，尝试使用符号搜索（简化版，实际应该使用搜索 API）
  if (!coinId) {
    // 对于未知代币，返回 0（表示没有价格数据）
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
      return 0;
    }

    const data: any = await response.json();
    return data[coinId]?.usd || 0;
  } catch (error) {
    console.error(`Error fetching price for ${symbol}:`, error);
    return 0;
  }
}

// 批量获取代币价格（优化版）
async function getTokenPricesBatch(tokens: TokenBalance[]): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  const uniqueSymbols = new Set<string>();
  
  tokens.forEach((token) => {
    uniqueSymbols.add(token.tokenSymbol.toUpperCase());
  });

  // 批量查询价格
  const symbolToCoinId: Record<string, string> = {
    'ETH': 'ethereum',
    'WETH': 'ethereum',
    'BNB': 'binancecoin',
    'WBNB': 'binancecoin',
    'MATIC': 'matic-network',
    'WMATIC': 'matic-network',
    'ARB': 'arbitrum',
    'OP': 'optimism',
    'AVAX': 'avalanche-2',
    'WAVAX': 'avalanche-2',
    'FTM': 'fantom',
    'WFTM': 'fantom',
    'SOL': 'solana',
    'USDT': 'tether',
    'USDC': 'usd-coin',
    'DAI': 'dai',
    'MNT': 'mantle',
    'WBTC': 'wrapped-bitcoin',
    'BTC': 'bitcoin',
  };

  const coinIds = Array.from(uniqueSymbols)
    .map(symbol => symbolToCoinId[symbol])
    .filter(id => id !== undefined) as string[];

  if (coinIds.length === 0) {
    return prices;
  }

  try {
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinIds.join(',')}&vs_currencies=usd`,
      {
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (response.ok) {
      const data: any = await response.json();
      
      // 创建反向映射
      const coinIdToSymbol: Record<string, string> = {};
      Object.entries(symbolToCoinId).forEach(([symbol, coinId]) => {
        coinIdToSymbol[coinId] = symbol;
      });

      Object.entries(data).forEach(([coinId, priceData]: [string, any]) => {
        const symbol = coinIdToSymbol[coinId];
        if (symbol) {
          prices[symbol] = priceData.usd || 0;
        }
      });
    }
  } catch (error) {
    console.error('Error fetching token prices batch:', error);
  }

  return prices;
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

    // 创建所有地址和所有链的查询任务（查询所有代币）
    const allQueryTasks = addresses.flatMap((address) =>
      chainsToQuery.map(
        (chainName) => async () => {
          try {
            let tokens: TokenBalance[] = [];
            if (chainName === 'Solana') {
              tokens = await getSolanaAllTokens(address);
            } else {
              tokens = await getEVMAllTokens(chainName, address);
            }
            return { address, chain: chainName, tokens };
          } catch (error) {
            console.error(`Error fetching tokens for ${address} on ${chainName}:`, error);
            return { address, chain: chainName, tokens: [] };
          }
        }
      )
    );

    // 使用并发控制执行所有查询
    const queryResults = await runWithConcurrencyLimit(
      allQueryTasks,
      MAX_CONCURRENT
    );

    // 收集所有代币
    const allTokens: TokenBalance[] = [];
    queryResults.forEach((result) => {
      if (result && result.tokens) {
        allTokens.push(...result.tokens);
      }
    });

    // 批量获取所有代币的价格
    const prices = await getTokenPricesBatch(allTokens);

    // 计算每个代币的美元价值
    allTokens.forEach((token) => {
      const price = prices[token.tokenSymbol.toUpperCase()] || 0;
      const balanceNum = parseFloat(token.balance);
      token.value = (balanceNum * price).toFixed(2);
    });

    // 按地址组织结果
    const resultsMap = new Map<string, TokenBalance[]>();
    addresses.forEach((address) => {
      resultsMap.set(address, []);
    });

    queryResults.forEach((result) => {
      if (result && result.address && result.tokens) {
        const existingTokens = resultsMap.get(result.address) || [];
        // 为代币添加价格信息
        result.tokens.forEach((token) => {
          const price = prices[token.tokenSymbol.toUpperCase()] || 0;
          const balanceNum = parseFloat(token.balance);
          token.value = (balanceNum * price).toFixed(2);
        });
        existingTokens.push(...result.tokens);
        resultsMap.set(result.address, existingTokens);
      }
    });

    // 转换为数组格式，保持地址顺序，并计算总余额（美元）
    const results: BalanceResponse[] = addresses.map((address) => {
      const tokens = resultsMap.get(address) || [];
      
      // 只保留在 CoinGecko 上有价格的代币
      const tokensWithPrice = tokens.filter(token => {
        const price = prices[token.tokenSymbol.toUpperCase()] || 0;
        return price > 0;
      });
      
      // 计算所有代币的美元总价值
      let totalBalanceUSD = 0;
      tokensWithPrice.forEach((token) => {
        const value = parseFloat(token.value || '0');
        if (!isNaN(value)) {
          totalBalanceUSD += value;
        }
      });

      return {
        address,
        tokens: tokensWithPrice,
        totalBalance: totalBalanceUSD.toFixed(2), // 美元总价值
        totalBalanceUSD: totalBalanceUSD.toFixed(2),
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

