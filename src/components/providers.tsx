"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Toaster } from "@/components/ui/sonner";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000,
            retry: 1,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster
        position="bottom-right"
        toastOptions={{
          className:
            "border-white/10 bg-[#11100e]/95 text-white shadow-2xl shadow-black/40 backdrop-blur-xl",
          classNames: {
            description: "text-white/55",
            actionButton: "bg-white text-black",
            cancelButton: "bg-white/10 text-white",
          },
        }}
      />
    </QueryClientProvider>
  );
}
