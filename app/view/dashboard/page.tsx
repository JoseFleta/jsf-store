import { redirect } from "next/navigation";

export default function DashboardPage() {
  redirect("/view/dashboard/products");
}
