import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { shadcn } from "@clerk/themes";
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { useSyncMe } from "@workspace/api-client-react";

import Home from "@/pages/home";
import Marketplace from "@/pages/marketplace";
import Algorithms from "@/pages/marketplace/algorithms";
import RigDetail from "@/pages/rigs/detail";
import NewRental from "@/pages/rentals/new";
import MyRentals from "@/pages/rentals";
import RentalCockpit from "@/pages/rentals/detail";
import LessorDashboard from "@/pages/lessor";
import RigForm from "@/pages/lessor/rigs/form";
import Wallet from "@/pages/wallet";
import AdminDashboard from "@/pages/admin";
import NotFound from "@/pages/not-found";

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(75 100% 35%)",
    colorForeground: "hsl(240 9% 4%)",
    colorMutedForeground: "hsl(240 5% 40%)",
    colorDanger: "hsl(0 84% 60%)",
    colorBackground: "hsl(0 0% 100%)",
    colorInput: "hsl(240 5% 84%)",
    colorInputForeground: "hsl(240 9% 4%)",
    colorNeutral: "hsl(240 5% 84%)",
    fontFamily: "'Inter', sans-serif",
    borderRadius: "0.25rem",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "bg-card rounded-md w-[440px] max-w-full overflow-hidden border",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-foreground font-bold font-mono tracking-tight",
    headerSubtitle: "text-muted-foreground",
    socialButtonsBlockButtonText: "text-foreground font-medium",
    formFieldLabel: "text-foreground font-medium text-sm",
    footerActionLink: "text-primary hover:text-primary/90",
    footerActionText: "text-muted-foreground",
    dividerText: "text-muted-foreground text-xs",
    identityPreviewEditButton: "text-primary hover:text-primary/90",
    formFieldSuccessText: "text-green-600",
    alertText: "text-destructive",
    logoBox: "mb-6 flex justify-center",
    logoImage: "h-12 object-contain",
    socialButtonsBlockButton: "border-input hover:bg-secondary",
    formButtonPrimary: "bg-primary text-primary-foreground hover:bg-primary/90 !shadow-none font-mono",
    formFieldInput: "bg-transparent border-input text-foreground placeholder:text-muted-foreground",
    footerAction: "bg-muted/50 p-4 border-t",
    dividerLine: "bg-border",
    alert: "bg-destructive/10 text-destructive border-destructive/20",
    otpCodeFieldInput: "border-input text-foreground",
    formFieldRow: "mb-4",
    main: "p-8",
  },
};

function SignInPage() {
  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClientInstance = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClientInstance.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClientInstance]);

  return null;
}

function AfterSignInSync() {
  const syncMe = useSyncMe();
  const syncedRef = useRef(false);

  useEffect(() => {
    if (!syncedRef.current) {
      syncedRef.current = true;
      syncMe.mutate();
    }
  }, [syncMe]);

  return null;
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/marketplace" />
      </Show>
      <Show when="signed-out">
        <Home />
      </Show>
    </>
  );
}

function ClerkProviderWithRoutes() {
  const [location, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Access terminal",
            subtitle: "Sign in to manage hashpower",
          },
        },
        signUp: {
          start: {
            title: "Initialize account",
            subtitle: "Start trading hashpower",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ClerkQueryClientCacheInvalidator />
          <Show when="signed-in">
            <AfterSignInSync />
          </Show>
          <Layout>
            <Switch>
              <Route path="/" component={HomeRedirect} />
              <Route path="/marketplace" component={Marketplace} />
              <Route path="/marketplace/algorithms" component={Algorithms} />
              <Route path="/rigs/:id" component={RigDetail} />
              <Route path="/rentals/new/:rigId" component={NewRental} />
              <Route path="/rentals" component={MyRentals} />
              <Route path="/rentals/:id" component={RentalCockpit} />
              <Route path="/lessor" component={LessorDashboard} />
              <Route path="/lessor/rigs/new" component={RigForm} />
              <Route path="/lessor/rigs/:id/edit" component={RigForm} />
              <Route path="/wallet" component={Wallet} />
              <Route path="/admin" component={AdminDashboard} />
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
              <Route component={NotFound} />
            </Switch>
          </Layout>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
