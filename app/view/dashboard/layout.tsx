"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "../../../lib/supabaseBrowser";

type StoreRow = {
  store_id: string;
  stores: { name: string } | { name: string }[] | null;
};

type StoreOption = {
  id: string;
  name: string;
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const supabase = supabaseBrowser();
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [loadingStores, setLoadingStores] = useState(true);

  const selectedStoreId = searchParams.get("store") || "";
  const isActivePath = (path: string) => pathname === path || pathname.startsWith(`${path}/`);
  const navItemClass = (active: boolean) =>
    active
      ? "rounded-full bg-indigo-100 px-3 py-1 text-indigo-800 shadow-sm ring-1 ring-indigo-200"
      : "rounded-full px-3 py-1 transition hover:bg-indigo-50 hover:text-indigo-700";

  const storeAwareHref = useMemo(() => {
    const build = (path: string) => {
      if (!selectedStoreId) return path;
      return `${path}?store=${encodeURIComponent(selectedStoreId)}`;
    };
    return {
      home: build("/view/dashboard"),
      products: build("/view/dashboard/products"),
      purchases: build("/view/dashboard/purchases"),
      sales: build("/view/dashboard/sales"),
      stock: build("/view/dashboard/stock"),
      settings: build("/view/dashboard/settings"),
    };
  }, [selectedStoreId]);

  const selectedStoreName = useMemo(() => {
    return stores.find((store) => store.id === selectedStoreId)?.name || "Store";
  }, [stores, selectedStoreId]);

  const selectedStoreInitials = useMemo(() => {
    const parts = selectedStoreName
      .trim()
      .split(/\s+/)
      .map((part) => part.replace(/[^A-Za-z0-9]/g, ""))
      .filter((part) => part.length > 0);
    if (parts.length === 0) return "S";
    return parts.map((part) => part[0].toUpperCase()).join("");
  }, [selectedStoreName]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/view/login");
  };

  useEffect(() => {
    let cancelled = false;

    const loadStores = async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (cancelled) return;

      if (!userRes.user) {
        router.push("/view/login");
        return;
      }

      const { data, error } = await supabase
        .from("store_memberships")
        .select("store_id, stores(name)")
        .eq("user_id", userRes.user.id);

      if (cancelled) return;

      if (error) {
        setLoadingStores(false);
        return;
      }

      const options = (data as StoreRow[]).map((row) => {
        const relation = row.stores;
        const storeName = Array.isArray(relation) ? relation[0]?.name : relation?.name;
        return { id: row.store_id, name: storeName || "Store" };
      });

      setStores(options);
      setLoadingStores(false);

      const hasSelectedStore = options.some((store) => store.id === selectedStoreId);
      if (options.length > 0 && !hasSelectedStore) {
        const params = new URLSearchParams(searchParams.toString());
        params.set("store", options[0].id);
        router.replace(`${pathname}?${params.toString()}`);
      }
    };

    loadStores();
    return () => {
      cancelled = true;
    };
  }, [pathname, router, searchParams, selectedStoreId, supabase]);

  const handleStoreChange = (storeId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("store", storeId);
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <nav className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-4">
          <div className="flex flex-wrap items-center gap-3 text-sm font-medium text-slate-700">
            <Link
              href={storeAwareHref.home}
              className={
                isActivePath("/view/dashboard") && !isActivePath("/view/dashboard/products") && !isActivePath("/view/dashboard/purchases") && !isActivePath("/view/dashboard/sales") && !isActivePath("/view/dashboard/stock") && !isActivePath("/view/dashboard/settings")
                  ? "rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold tracking-wide text-indigo-800 shadow-sm ring-1 ring-indigo-200"
                  : "rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold tracking-wide text-indigo-700 transition hover:bg-indigo-100"
              }
            >
              {selectedStoreInitials} Management
            </Link>
            <Link
              href={storeAwareHref.products}
              className={navItemClass(isActivePath("/view/dashboard/products"))}
            >
              Products
            </Link>
            <Link
              href={storeAwareHref.purchases}
              className={navItemClass(isActivePath("/view/dashboard/purchases"))}
            >
              Purchases
            </Link>
            <Link
              href={storeAwareHref.sales}
              className={navItemClass(isActivePath("/view/dashboard/sales"))}
            >
              Sales
            </Link>
            <Link
              href={storeAwareHref.stock}
              className={navItemClass(isActivePath("/view/dashboard/stock"))}
            >
              Stock
            </Link>
            <Link
              href={storeAwareHref.settings}
              className={navItemClass(isActivePath("/view/dashboard/settings"))}
            >
              Settings
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Store</label>
              <select
                className="ml-2 rounded-xl border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700"
                value={selectedStoreId}
                onChange={(e) => handleStoreChange(e.target.value)}
                disabled={loadingStores || stores.length === 0}
              >
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={handleLogout}
              className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-indigo-200 hover:text-indigo-700 hover:shadow-md"
              type="button"
            >
              Log out
            </button>
          </div>
        </div>
      </nav>

      <main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}

