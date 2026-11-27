import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocumentList } from "./DocumentList";
import { DocumentView } from "./DocumentView";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, retry: 1 } },
});

/** Two screens don't need a router library: #/ and #/documents/:id[?v=N]. */
function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const m = hash.match(/^#\/documents\/([^?]+)(?:\?v=(\d+))?/);
  return m ? { id: decodeURIComponent(m[1]!), version: m[2] ? Number(m[2]) : undefined } : null;
}

function App() {
  const route = useHashRoute();
  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">
          Document review
        </a>
      </header>
      <main>{route ? <DocumentView id={route.id} version={route.version} /> : <DocumentList />}</main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
