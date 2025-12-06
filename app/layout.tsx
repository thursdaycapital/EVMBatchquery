import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'EVM & Solana Balance Checker',
  description: '批量查询 EVM 链和 Solana 地址余额',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}

