"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "../../lib/supabaseBrowser";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const supabase = supabaseBrowser();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <nav className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-4">
          <div className="flex flex-wrap items-center gap-3 text-sm font-medium text-slate-700">
            <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-indigo-700">
              Stock SaaS
            </span>
            <Link
              href="/dashboard/products"
              className="rounded-full px-3 py-1 transition hover:bg-indigo-50 hover:text-indigo-700"
            >
              Productos
            </Link>
            <Link
              href="/dashboard/purchases"
              className="rounded-full px-3 py-1 transition hover:bg-indigo-50 hover:text-indigo-700"
            >
              Compras
            </Link>
            <Link
              href="/dashboard/sales"
              className="rounded-full px-3 py-1 transition hover:bg-indigo-50 hover:text-indigo-700"
            >
              Ventas
            </Link>
            <Link
              href="/dashboard/stock"
              className="rounded-full px-3 py-1 transition hover:bg-indigo-50 hover:text-indigo-700"
            >
              Stock
            </Link>
          </div>
          <button
            onClick={handleLogout}
            className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-indigo-200 hover:text-indigo-700 hover:shadow-md"
            type="button"
          >
            Cerrar sesión
          </button>
        </div>
      </nav>

      <main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}