'use client';

import { useState } from 'react';

const EVM_CHAINS = [
  'ETH',
  'BSC',
  'Polygon',
  'Arbitrum',
  'Optimism',
  'Base',
  'Avalanche',
  'Fantom',
  'zkSync',
  'Linea',
  'Scroll',
  'Mantle',
];

const CHAINS = ['All EVM Chains', ...EVM_CHAINS, 'Solana'];

interface BalanceResult {
  address: string;
  balances: Record<string, string>;
}

interface ApiResponse {
  results: BalanceResult[];
  chains: string[];
}

export default function Home() {
  const [selectedChain, setSelectedChain] = useState<string>('All EVM Chains');
  const [addresses, setAddresses] = useState<string>('');
  const [results, setResults] = useState<BalanceResult[]>([]);
  const [queriedChains, setQueriedChains] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const handleQuery = async () => {
    if (!addresses.trim()) {
      setError('请输入至少一个地址');
      return;
    }

    const addressList = addresses
      .split('\n')
      .map((addr) => addr.trim())
      .filter((addr) => addr.length > 0);

    if (addressList.length === 0) {
      setError('请输入至少一个有效地址');
      return;
    }

    setLoading(true);
    setError('');
    setResults([]);

    try {
      const response = await fetch('/api/balance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chain: selectedChain,
          addresses: addressList,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '查询失败');
      }

      const data: ApiResponse = await response.json();
      setResults(data.results);
      setQueriedChains(data.chains);
    } catch (err) {
      setError(err instanceof Error ? err.message : '查询失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const getBalanceUnit = (chain: string) => {
    if (chain === 'Solana') {
      return 'SOL';
    }
    return chain === 'ETH' ? 'ETH' : chain;
  };

  return (
    <div className="container">
      <h1>EVM & Solana 余额查询工具</h1>

      <div className="form-section">
        <div className="form-group">
          <label htmlFor="chain">选择链：</label>
          <select
            id="chain"
            value={selectedChain}
            onChange={(e) => setSelectedChain(e.target.value)}
            className="select-input"
          >
            {CHAINS.map((chain) => (
              <option key={chain} value={chain}>
                {chain}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="addresses">输入地址（每行一个）：</label>
          <textarea
            id="addresses"
            value={addresses}
            onChange={(e) => setAddresses(e.target.value)}
            placeholder="0x1234567890123456789012345678901234567890&#10;0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
            className="textarea-input"
            rows={8}
          />
        </div>

        <button
          onClick={handleQuery}
          disabled={loading}
          className="query-button"
        >
          {loading ? '查询中...' : '查询余额'}
        </button>

        {error && <div className="error-message">{error}</div>}
      </div>

      {results.length > 0 && (
        <div className="results-section">
          <h2>查询结果</h2>
          <div className="results-table">
            <table>
              <thead>
                <tr>
                  <th className="address-header">地址</th>
                  {queriedChains.map((chain) => (
                    <th key={chain} className="chain-header">
                      {chain} ({getBalanceUnit(chain)})
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map((result, index) => (
                  <tr key={index}>
                    <td className="address-cell">{result.address}</td>
                    {queriedChains.map((chain) => {
                      const balance = result.balances[chain] || 'N/A';
                      return (
                        <td key={chain} className="balance-cell">
                          {balance === 'Error'
                            ? '查询失败'
                            : balance === 'N/A'
                            ? '-'
                            : parseFloat(balance).toLocaleString('en-US', {
                                maximumFractionDigits: 8,
                              })}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <style jsx>{`
        .container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 2rem;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
            'Helvetica Neue', Arial, sans-serif;
        }

        h1 {
          text-align: center;
          color: #333;
          margin-bottom: 2rem;
        }

        .form-section {
          background: #f9f9f9;
          padding: 2rem;
          border-radius: 8px;
          margin-bottom: 2rem;
        }

        .form-group {
          margin-bottom: 1.5rem;
        }

        label {
          display: block;
          margin-bottom: 0.5rem;
          font-weight: 600;
          color: #555;
        }

        .select-input {
          width: 100%;
          padding: 0.75rem;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 1rem;
          background: white;
        }

        .textarea-input {
          width: 100%;
          padding: 0.75rem;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 0.9rem;
          font-family: 'Courier New', monospace;
          resize: vertical;
        }

        .query-button {
          width: 100%;
          padding: 1rem;
          background: #0070f3;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.2s;
        }

        .query-button:hover:not(:disabled) {
          background: #0051cc;
        }

        .query-button:disabled {
          background: #ccc;
          cursor: not-allowed;
        }

        .error-message {
          margin-top: 1rem;
          padding: 1rem;
          background: #fee;
          color: #c33;
          border-radius: 4px;
          border: 1px solid #fcc;
        }

        .results-section {
          background: white;
          padding: 2rem;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }

        .results-section h2 {
          margin-top: 0;
          color: #333;
        }

        .results-table {
          overflow-x: auto;
        }

        table {
          width: 100%;
          border-collapse: collapse;
        }

        thead {
          background: #f5f5f5;
        }

        th,
        td {
          padding: 1rem;
          text-align: left;
          border-bottom: 1px solid #ddd;
        }

        th {
          font-weight: 600;
          color: #555;
        }

        .address-header {
          position: sticky;
          left: 0;
          background: #f5f5f5;
          z-index: 1;
        }

        .chain-header {
          white-space: nowrap;
          min-width: 120px;
        }

        .address-cell {
          font-family: 'Courier New', monospace;
          font-size: 0.9rem;
          word-break: break-all;
          position: sticky;
          left: 0;
          background: white;
          z-index: 1;
        }

        tbody tr:hover .address-cell {
          background: #f9f9f9;
        }

        .balance-cell {
          font-weight: 600;
          color: #0070f3;
          text-align: right;
          white-space: nowrap;
        }

        tbody tr:hover {
          background: #f9f9f9;
        }
      `}</style>
    </div>
  );
}

