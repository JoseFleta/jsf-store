"use client";

import Link from "next/link";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div style={{ fontFamily: "system-ui", minHeight: "100vh" }}>
      <nav
        style={{
          display: "flex",
          gap: 16,
          padding: 16,
          borderBottom: "1px solid #ddd",
        }}
      >
        <Link href="/dashboard/products">Productos</Link>
        <Link href="/dashboard/purchases">Compras</Link>
        <Link href="/dashboard/sales">Ventas</Link>
        <Link href="/dashboard/stock">Stock</Link>
      </nav>

      <main style={{ padding: 24 }}>{children}</main>
    </div>
  );
}
