import { Suspense } from "react";
import DashboardLayoutClient from "./DashboardLayoutClient";

export const dynamic = "force-dynamic";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense fallback={<main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>}>
      <DashboardLayoutClient>{children}</DashboardLayoutClient>
    </Suspense>
  );
}