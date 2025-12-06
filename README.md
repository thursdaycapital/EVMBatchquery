# EVM & Solana Balance Checker

批量查询 EVM 链和 Solana 地址余额的工具。

## 功能特性

- ✅ 支持批量查询所有 EVM 链的主链余额（无需 API KEY）
- ✅ 支持查询 Solana 地址余额（lamports → SOL）
- ✅ 支持以下链：
  - ETH
  - BSC
  - Polygon
  - Arbitrum
  - Optimism
  - Base
  - Avalanche
  - Fantom
  - zkSync
  - Linea
  - Scroll
  - Mantle
  - Solana

## 安装

```bash
npm install
```

## 运行

开发模式：

```bash
npm run dev
```

生产构建：

```bash
npm run build
npm start
```

## 使用说明

1. 选择要查询的链
2. 在文本框中输入地址，每行一个
3. 点击"查询余额"按钮
4. 查看结果表格中的余额信息

## 技术栈

- Next.js 14
- React 18
- TypeScript
- Ethers.js (EVM 链)
- @solana/web3.js (Solana)

