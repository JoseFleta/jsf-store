"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "../../lib/supabaseBrowser";

export default function StoreHomeRedirect() {
  const supabase = supabaseBrowser();
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user) router.replace("/view/login");
      else router.replace("/view/dashboard");
    })();
  }, [router, supabase]);

  return null;
}