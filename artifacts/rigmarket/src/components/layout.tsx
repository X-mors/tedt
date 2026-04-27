import { Link, useLocation } from "wouter";
import { Show, useUser, useClerk } from "@clerk/react";
import { Wallet, LogOut, LayoutDashboard, Server, BarChart3, ShieldAlert } from "lucide-react";
import { useGetMe } from "@workspace/api-client-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { user } = useUser();
  const { signOut } = useClerk();
  // Cast: orval-generated `query` options demand a full UseQueryOptions including queryKey,
  // but the wrapper supplies queryKey internally. A Partial-ish override is the simplest fix.
  const { data: me } = useGetMe({ query: { enabled: !!user } as never });

  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const stripBase = (path: string) =>
    basePath && path.startsWith(basePath)
      ? path.slice(basePath.length) || "/"
      : path;

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-50 w-full border-b bg-card/50 backdrop-blur">
        <div className="container flex h-14 items-center px-4">
          <Link href="/" className="flex items-center gap-2 mr-6 text-primary">
            <Server className="h-5 w-5" />
            <span className="font-bold tracking-tight">RigMarket</span>
          </Link>

          <nav className="flex items-center gap-6 text-sm font-medium flex-1">
            <Link
              href="/marketplace"
              className={`transition-colors hover:text-foreground/80 ${
                location.startsWith("/marketplace") ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              Marketplace
            </Link>

            <Show when="signed-in">
              <Link
                href="/rentals"
                className={`transition-colors hover:text-foreground/80 ${
                  location.startsWith("/rentals") ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                My Rentals
              </Link>
              
              {me?.role === "owner" || me?.role === "admin" || (me?.rigCount ?? 0) > 0 ? (
                <Link
                  href="/lessor"
                  className={`transition-colors hover:text-foreground/80 ${
                    location.startsWith("/lessor") ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  My Rigs
                </Link>
              ) : null}

              {me?.role === "admin" && (
                <Link
                  href="/admin"
                  className={`transition-colors hover:text-foreground/80 ${
                    location.startsWith("/admin") ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  Admin
                </Link>
              )}
            </Show>

            <div className="flex items-center gap-4">
              <Show when="signed-in">
                {me && (
                  <Link href="/wallet" className="flex items-center gap-2 px-3 py-1.5 bg-secondary text-secondary-foreground rounded-full text-xs font-mono font-medium hover:bg-secondary/80 transition-colors">
                    <Wallet className="h-3 w-3" />
                    ${me.balanceUsd.toFixed(2)}
                  </Link>
                )}
                <button
                  onClick={() => signOut(() => setLocation("/"))}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  title="Sign Out"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </Show>
              <Show when="signed-out">
                <Link href="/sign-in" className="text-sm font-medium text-muted-foreground hover:text-foreground">
                  Sign In
                </Link>
                <Link href="/sign-up" className="text-sm font-medium bg-primary text-primary-foreground px-4 py-1.5 rounded hover:bg-primary/90 transition-colors">
                  Sign Up
                </Link>
              </Show>
            </div>
          </nav>
        </div>
      </header>
      <main className="flex-1 flex flex-col">
        {children}
      </main>
    </div>
  );
}
