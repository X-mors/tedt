import { useState, useEffect } from "react";
import { useLocation, useParams, Link } from "wouter";
import {
  useCreateRig,
  useUpdateMyRig,
  useGetMyRig,
  useListAlgorithms,
  useGetMe,
  useUpdateMe,
  useTestPoolConnection,
  useListMyPools,
  getListMyRigsQueryKey,
  getGetMyRigQueryKey,
  getGetRigQueryKey,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, Waves, Wifi, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { SaveAsPoolButton } from "@/components/save-as-pool-button";

function parseStratumUrl(url: string): { host: string; port: string } {
  try {
    const withoutScheme = url.replace(/^stratum\+tcp:\/\//, "");
    const [host, port] = withoutScheme.split(":");
    return { host: host ?? url, port: port ?? "3333" };
  } catch {
    return { host: url, port: "3333" };
  }
}

export default function RigForm() {
  const { id } = useParams<{ id: string }>();
  const isEditing = !!id;
  const rigId = parseInt(id || "0");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: algorithms } = useListAlgorithms();
  const { data: rig, isLoading: rigLoading } = useGetMyRig(rigId);
  const { data: me } = useGetMe();
  const { data: savedPools } = useListMyPools();

  const createRig = useCreateRig();
  const updateRig = useUpdateMyRig();
  const testPool = useTestPoolConnection();
  const [poolTestResult, setPoolTestResult] = useState<{
    success: boolean;
    authFailed: boolean;
    message: string;
    latencyMs: number | null;
  } | null>(null);

  const [stratumUsernameInput, setStratumUsernameInput] = useState("");
  const [editingStratumUsername, setEditingStratumUsername] = useState(false);

  const updateMe = useUpdateMe({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        setEditingStratumUsername(false);
        toast({ title: "Mining username saved" });
      },
      onError: (err: Error) => {
        toast({ title: "Update failed", description: err.message, variant: "destructive" });
      },
    },
  });

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    algorithmId: "",
    hashrate: "",
    pricePerUnitPerDay: "",
    minRentalHours: "1",
    maxRentalHours: "24",
    region: "",
    status: "available",
    fallbackPoolHost: "",
    fallbackPoolPort: "",
    fallbackPoolUser: "",
    fallbackPoolPassword: "x",
  });

  useEffect(() => {
    if (isEditing && rig) {
      setFormData({
        name: rig.name,
        description: rig.description,
        algorithmId: rig.algorithmId.toString(),
        hashrate: rig.hashrate.toString(),
        pricePerUnitPerDay:
          rig.pricePerUnitPerDay != null ? rig.pricePerUnitPerDay.toString() : "",
        minRentalHours: rig.minRentalHours.toString(),
        maxRentalHours: rig.maxRentalHours.toString(),
        region: rig.region,
        status: rig.status || "available",
        fallbackPoolHost: rig.fallbackPoolHost ?? "",
        fallbackPoolPort: rig.fallbackPoolPort?.toString() ?? "",
        fallbackPoolUser: rig.fallbackPoolUser ?? "",
        fallbackPoolPassword: rig.fallbackPoolPassword ?? "x",
      });
    }
  }, [isEditing, rig]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const fallbackHost = formData.fallbackPoolHost.trim();
    const fallbackPort = formData.fallbackPoolPort ? parseInt(formData.fallbackPoolPort) : undefined;

    const customPriceTrim = formData.pricePerUnitPerDay.trim();
    const customPrice =
      customPriceTrim === "" ? null : parseFloat(customPriceTrim);

    if (isEditing) {
      const validStatuses = ["available", "paused"] as const;
      const data = {
        name: formData.name || undefined,
        description: formData.description,
        hashrate: parseFloat(formData.hashrate),
        pricePerUnitPerDay:
          customPrice == null || isNaN(customPrice) ? null : customPrice,
        minRentalHours: parseInt(formData.minRentalHours),
        maxRentalHours: parseInt(formData.maxRentalHours),
        ...(formData.region && { region: formData.region }),
        ...(formData.status && validStatuses.includes(formData.status as typeof validStatuses[number]) && {
          status: formData.status as typeof validStatuses[number],
        }),
        fallbackPoolHost: fallbackHost,
        ...(fallbackPort !== undefined && !isNaN(fallbackPort) && { fallbackPoolPort: fallbackPort }),
        fallbackPoolUser: formData.fallbackPoolUser.trim(),
        fallbackPoolPassword: formData.fallbackPoolPassword || "x",
      };
      updateRig.mutate({ id: rigId, data }, {
        onSuccess: () => {
          toast({ title: "Rig Updated", description: "Changes saved successfully." });
          queryClient.invalidateQueries({ queryKey: getGetMyRigQueryKey(rigId) });
          queryClient.invalidateQueries({ queryKey: getGetRigQueryKey(rigId) });
          queryClient.invalidateQueries({ queryKey: getListMyRigsQueryKey() });
          setLocation("/lessor");
        },
        onError: (err) => {
          toast({ title: "Update Failed", description: err.message, variant: "destructive" });
        }
      });
    } else {
      const data = {
        name: formData.name,
        description: formData.description,
        algorithmId: parseInt(formData.algorithmId),
        hashrate: parseFloat(formData.hashrate),
        ...(customPrice != null && !isNaN(customPrice) && customPrice > 0 && {
          pricePerUnitPerDay: customPrice,
        }),
        minRentalHours: parseInt(formData.minRentalHours),
        maxRentalHours: parseInt(formData.maxRentalHours),
        region: formData.region,
        ...(fallbackHost && { fallbackPoolHost: fallbackHost }),
        ...(fallbackPort !== undefined && !isNaN(fallbackPort) && { fallbackPoolPort: fallbackPort }),
        ...(formData.fallbackPoolUser.trim() && { fallbackPoolUser: formData.fallbackPoolUser.trim() }),
        ...(formData.fallbackPoolPassword && { fallbackPoolPassword: formData.fallbackPoolPassword }),
      };
      createRig.mutate({ data }, {
        onSuccess: () => {
          toast({ title: "Rig Created", description: "Your rig is now listed on the marketplace." });
          queryClient.invalidateQueries({ queryKey: getListMyRigsQueryKey() });
          setLocation("/lessor");
        },
        onError: (err) => {
          toast({ title: "Creation Failed", description: err.message, variant: "destructive" });
        }
      });
    }
  };

  const handleSaveStratumUsername = () => {
    const slug = stratumUsernameInput.trim().toLowerCase();
    if (!/^[a-z0-9-]{3,24}$/.test(slug)) {
      toast({
        title: "Invalid username",
        description: "3–24 characters, lowercase letters, digits, and hyphens only.",
        variant: "destructive",
      });
      return;
    }
    updateMe.mutate({ data: { stratumUsername: slug } });
  };

  const handleTestFallbackPool = () => {
    const host = formData.fallbackPoolHost.trim();
    const port = formData.fallbackPoolPort.trim();
    const worker = formData.fallbackPoolUser.trim();
    if (!host || !port || !worker) {
      toast({ title: "Fill in pool host, port, and worker first", variant: "destructive" });
      return;
    }
    setPoolTestResult(null);
    const selectedAlgo = algorithms?.find(
      (a) => a.id.toString() === formData.algorithmId,
    );
    testPool.mutate(
      {
        data: {
          poolUrl: `stratum+tcp://${host}:${port}`,
          poolWorker: worker,
          poolPassword: formData.fallbackPoolPassword || "x",
          algorithmSlug: selectedAlgo?.slug ?? undefined,
        },
      },
      {
        onSuccess: (result) => setPoolTestResult(result),
        onError: (err) => setPoolTestResult({ success: false, authFailed: false, message: err.message, latencyMs: null }),
      },
    );
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      toast({ title: `${label} copied` });
    });
  };

  const set = (field: string, value: string) => setFormData(prev => ({ ...prev, [field]: value }));

  if (isEditing && rigLoading) return <div className="p-8 text-center font-mono">LOADING_CONFIG...</div>;

  const parsedUrl = rig?.ownerStratumUrl ? parseStratumUrl(rig.ownerStratumUrl) : null;

  return (
    <div className="container py-8 px-4 max-w-2xl mx-auto space-y-6">
      <Button variant="ghost" className="mb-2 text-muted-foreground hover:text-foreground font-mono text-xs px-0" onClick={() => setLocation("/lessor")}>
        <ArrowLeft className="w-4 h-4 mr-2" /> BACK_TO_INVENTORY
      </Button>

      <div>
        <h1 className="text-3xl font-bold tracking-tight">{isEditing ? "Configure Rig" : "Initialize New Rig"}</h1>
        <p className="text-muted-foreground">List your hardware on the open marketplace</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">

        {/* Mining Connection */}
        <Card className="bg-card/50 border-primary/30">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Wifi className="w-4 h-4 text-primary" />
              Mining Connection
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="text-sm text-muted-foreground">
              Point your miner at the RigMarket proxy using the credentials below.
              {isEditing
                ? " Use any password you like — the proxy authenticates by username only."
                : " After saving, you'll get a unique worker name for this rig. Use any password (e.g. x)."}
            </p>

            {/* Connection rows */}
            <div className="space-y-3 bg-muted/40 rounded-lg p-4">
              {(() => {
                const proxyHost = parsedUrl?.host ?? "livehashrate.com";
                const selectedAlgoSlug = algorithms?.find(a => a.id.toString() === formData.algorithmId)?.slug;
                const proxyPort = parsedUrl?.port ?? (selectedAlgoSlug === "sha256" ? "3334" : "3333");
                const rigName = formData.name.trim().toLowerCase().replace(/\s+/g, "-") || "rigname";
                const worker = isEditing && rig
                  ? (rig.ownerWorker ?? "")
                  : (me?.stratumUsername ? `${me.stratumUsername}.${rigName}` : "");
                return [
                  { label: "Host", value: proxyHost, highlight: false, placeholder: "" },
                  { label: "Port", value: proxyPort, highlight: false, placeholder: "" },
                  { label: "Worker", value: worker, highlight: true, placeholder: "set username below" },
                  { label: "Password", value: "", highlight: false, placeholder: "any value (e.g. x)" },
                ].map(({ label, value, highlight, placeholder }) => (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground font-mono uppercase w-20">{label}</span>
                    <span className={`text-sm font-mono flex-1 ${highlight && value ? "text-primary" : ""}`}>
                      {value
                        ? value
                        : <em className="text-muted-foreground not-italic opacity-60">{placeholder || "—"}</em>
                      }
                    </span>
                    {value && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => copyToClipboard(value, label)}
                      >
                        <Copy className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                ));
              })()}
            </div>

            {/* Stratum Username */}
            <div className="space-y-2 border-t border-border/50 pt-4">
              <Label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                Mining Username
              </Label>
              {me?.stratumUsername ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono text-primary">{me.stratumUsername}</span>
                  <span className="text-xs text-muted-foreground">(permanent — cannot be changed)</span>
                </div>
              ) : editingStratumUsername ? (
                <div className="flex gap-2">
                  <Input
                    value={stratumUsernameInput}
                    onChange={(e) => setStratumUsernameInput(e.target.value.toLowerCase())}
                    placeholder="e.g. satoshi"
                    maxLength={24}
                    className="font-mono bg-background"
                  />
                  <Button type="button" size="sm" onClick={handleSaveStratumUsername} disabled={updateMe.isPending}>
                    {updateMe.isPending ? "Saving..." : "Save"}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditingStratumUsername(false)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <em className="text-sm text-muted-foreground">Not set yet</em>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-xs h-7"
                    onClick={() => {
                      setStratumUsernameInput("");
                      setEditingStratumUsername(true);
                    }}
                  >
                    Set Username
                  </Button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Lowercase letters, digits, hyphens only · 3–24 chars · globally unique · permanent.
              </p>
            </div>

          </CardContent>
        </Card>

        {/* Hardware Specs */}
        <Card className="bg-card/50 border-border/50">
          <CardHeader>
            <CardTitle className="text-lg">Hardware Specifications</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">System Designation (Name)</Label>
              <Input
                id="name"
                required
                className="bg-background font-mono text-sm"
                placeholder="e.g. Antminer S19 Pro - Rack A4"
                value={formData.name}
                onChange={e => set("name", e.target.value)}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="algorithm">Algorithm</Label>
                {isEditing ? (
                  <div className="flex items-center h-9 rounded-md border border-input bg-muted px-3 font-mono text-sm text-muted-foreground">
                    {algorithms?.find(a => a.id.toString() === formData.algorithmId)?.name
                      ? `${algorithms!.find(a => a.id.toString() === formData.algorithmId)!.name} (${algorithms!.find(a => a.id.toString() === formData.algorithmId)!.unit})`
                      : (formData.algorithmId ? `Algorithm #${formData.algorithmId}` : "—")}
                    <span className="ml-auto text-xs opacity-50">fixed</span>
                  </div>
                ) : (
                  <Select value={formData.algorithmId} onValueChange={v => set("algorithmId", v)}>
                    <SelectTrigger className="bg-background font-mono text-sm" id="algorithm">
                      <SelectValue placeholder="Select algorithm" />
                    </SelectTrigger>
                    <SelectContent>
                      {algorithms?.map(a => (
                        <SelectItem key={a.id} value={a.id.toString()}>{a.name} ({a.unit})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="hashrate">Advertised Hashrate</Label>
                <div className="relative">
                  <Input
                    id="hashrate"
                    type="number"
                    step="0.01"
                    required
                    className="bg-background font-mono text-sm pr-16"
                    placeholder="110.00"
                    value={formData.hashrate}
                    onChange={e => set("hashrate", e.target.value)}
                  />
                  <div className="absolute right-3 top-2.5 text-xs text-muted-foreground font-mono uppercase">
                    {algorithms?.find(a => a.id.toString() === formData.algorithmId)?.unit || 'UNIT'}
                  </div>
                </div>
              </div>
            </div>

            {/* Owner-set price override */}
            {(() => {
              const algo = algorithms?.find(a => a.id.toString() === formData.algorithmId);
              const unit = algo?.unit || "UNIT";
              const defaultPerDay = algo
                ? (Number(algo.basePricePerUnitPerHour) * 24).toFixed(4)
                : null;
              return (
                <div className="space-y-2">
                  <Label htmlFor="pricePerUnitPerDay">
                    Price per {unit} / 24h <span className="text-muted-foreground font-normal">(optional)</span>
                  </Label>
                  <div className="relative">
                    <div className="absolute left-3 top-2.5 text-xs text-muted-foreground font-mono">$</div>
                    <Input
                      id="pricePerUnitPerDay"
                      type="number"
                      step="0.0001"
                      min="0"
                      className="bg-background font-mono text-sm pl-7 pr-28"
                      placeholder={defaultPerDay ? `default ${defaultPerDay}` : "e.g. 0.05"}
                      value={formData.pricePerUnitPerDay}
                      onChange={e => set("pricePerUnitPerDay", e.target.value)}
                    />
                    <div className="absolute right-3 top-2.5 text-xs text-muted-foreground font-mono uppercase">
                      / {unit} / 24h
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Set your own rental rate. Leave empty to use the platform default
                    {defaultPerDay ? ` (~$${defaultPerDay} per ${unit} per 24h)` : ""}.
                    Renters see this price plus the service fee. Existing rentals keep their original rate.
                  </p>
                </div>
              );
            })()}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="minHours">Min Duration (Hours)</Label>
                <Input
                  id="minHours"
                  type="number"
                  min="1"
                  required
                  className="bg-background font-mono text-sm"
                  value={formData.minRentalHours}
                  onChange={e => set("minRentalHours", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxHours">Max Duration (Hours)</Label>
                <Input
                  id="maxHours"
                  type="number"
                  min="1"
                  required
                  className="bg-background font-mono text-sm"
                  value={formData.maxRentalHours}
                  onChange={e => set("maxRentalHours", e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="region">Physical Region</Label>
                <Input
                  id="region"
                  required
                  className="bg-background font-mono text-sm"
                  placeholder="e.g. US-East, EU-Central"
                  value={formData.region}
                  onChange={e => set("region", e.target.value)}
                />
              </div>
              {isEditing && (
                <div className="space-y-2">
                  <Label htmlFor="status">Status</Label>
                  <Select
                    value={
                      formData.status === "available" || formData.status === "paused"
                        ? formData.status
                        : "available"
                    }
                    onValueChange={v => set("status", v)}
                  >
                    <SelectTrigger className="bg-background font-mono text-sm" id="status">
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="available">Available (Listed in marketplace)</SelectItem>
                      <SelectItem value="paused">Paused (Hidden — maintenance / not for rent)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    "Offline" and "Rented" are managed automatically by the
                    system — pick "Paused" to hide the rig manually.
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Details / Terms</Label>
              <Textarea
                id="description"
                className="bg-background min-h-[100px] text-sm"
                placeholder="Details about hardware stability, connection reliability, etc."
                value={formData.description}
                onChange={e => set("description", e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Fallback Pool */}
        <Card className="bg-card/50 border-border/50">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Waves className="w-4 h-4 text-muted-foreground" />
              Fallback Pool <span className="text-sm font-normal text-muted-foreground ml-1">(optional)</span>
              {/* Live pool connection status — only visible when rig is online and in fallback mode */}
              {isEditing && rig?.isOnline && rig.hasFallbackPool && rig.fallbackPoolConnected === true && (
                <span className="ml-auto flex items-center gap-1.5 text-xs font-normal text-green-500">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Connected
                </span>
              )}
              {isEditing && rig?.isOnline && rig.hasFallbackPool && rig.fallbackPoolAuthFailed === true && (
                <span className="ml-auto flex items-center gap-1.5 text-xs font-normal text-red-500">
                  <XCircle className="w-3.5 h-3.5" /> Pool rejected credentials
                </span>
              )}
              {isEditing && rig?.isOnline && rig.hasFallbackPool && rig.fallbackPoolConnected === false && rig.fallbackPoolAuthFailed === false && (
                <span className="ml-auto flex items-center gap-1.5 text-xs font-normal text-yellow-500">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Connecting...
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              When your rig is connected but not currently rented, the proxy will forward your miner's
              hashrate to this personal pool so your hardware is never idle.
              Leave empty to keep the miner idle between rentals.
            </p>
            {isEditing && rig?.isOnline && rig.hasFallbackPool && rig.fallbackPoolAuthFailed === true && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-500">
                <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <p className="text-xs">Your pool is rejecting the worker credentials. Check the worker name and password below, then save.</p>
              </div>
            )}
            {isEditing && rig?.isOnline && rig.hasFallbackPool && rig.fallbackPoolConnected === true && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-green-500/10 border border-green-500/20 text-green-500">
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                <p className="text-xs">Pool connection verified — your miner's hashrate is being forwarded successfully.</p>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Use a Saved Pool</Label>
                <Link
                  href="/pools"
                  className="text-xs text-primary hover:underline font-mono"
                >
                  Manage saved pools →
                </Link>
              </div>
              {savedPools && savedPools.length > 0 ? (
                <Select
                  value=""
                  onValueChange={(value) => {
                    const p = savedPools.find((x) => String(x.id) === value);
                    if (!p) return;
                    const { host, port } = parseStratumUrl(p.poolUrl);
                    setFormData((prev) => ({
                      ...prev,
                      fallbackPoolHost: host,
                      fallbackPoolPort: port,
                      fallbackPoolUser: p.worker,
                      fallbackPoolPassword: p.password || "x",
                    }));
                    setPoolTestResult(null);
                  }}
                >
                  <SelectTrigger className="font-mono text-sm bg-background">
                    <SelectValue placeholder="Pick from your saved pools…" />
                  </SelectTrigger>
                  <SelectContent>
                    {savedPools.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  No saved pools yet. Add one to reuse it on every rig.
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="fallbackHost">Pool Host</Label>
                <Input
                  id="fallbackHost"
                  className="bg-background font-mono text-sm"
                  placeholder="stratum.pool.example.com"
                  value={formData.fallbackPoolHost}
                  onChange={e => set("fallbackPoolHost", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fallbackPort">Port</Label>
                <Input
                  id="fallbackPort"
                  type="number"
                  min="1"
                  max="65535"
                  className="bg-background font-mono text-sm"
                  placeholder="3333"
                  value={formData.fallbackPoolPort}
                  onChange={e => set("fallbackPoolPort", e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="fallbackUser">Worker / Username</Label>
                <Input
                  id="fallbackUser"
                  className="bg-background font-mono text-sm"
                  placeholder="your_wallet.worker1"
                  value={formData.fallbackPoolUser}
                  onChange={e => { set("fallbackPoolUser", e.target.value); setPoolTestResult(null); }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fallbackPassword">Password</Label>
                <Input
                  id="fallbackPassword"
                  className="bg-background font-mono text-sm"
                  placeholder="x"
                  value={formData.fallbackPoolPassword}
                  onChange={e => { set("fallbackPoolPassword", e.target.value); setPoolTestResult(null); }}
                />
              </div>
            </div>

            {/* Test connection button + result */}
            <div className="flex items-center gap-3 flex-wrap">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="font-mono text-xs gap-2"
                onClick={handleTestFallbackPool}
                disabled={testPool.isPending}
              >
                {testPool.isPending
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Testing...</>
                  : <><Waves className="w-3.5 h-3.5" /> Test Connection</>
                }
              </Button>

              <SaveAsPoolButton
                poolUrl={
                  formData.fallbackPoolHost && formData.fallbackPoolPort
                    ? `stratum+tcp://${formData.fallbackPoolHost}:${formData.fallbackPoolPort}`
                    : ""
                }
                worker={formData.fallbackPoolUser}
                password={formData.fallbackPoolPassword}
              />

              {poolTestResult && (
                <div className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-md border ${
                  poolTestResult.success
                    ? "text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/20"
                    : "text-red-500 bg-red-500/10 border-red-500/20"
                }`}>
                  {poolTestResult.success
                    ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    : <XCircle className="w-3.5 h-3.5 shrink-0" />
                  }
                  <span>{poolTestResult.message}</span>
                </div>
              )}
            </div>
          </CardContent>
          <CardFooter className="flex justify-end gap-2 border-t border-border/50 pt-4">
            <Button type="button" variant="outline" className="font-mono text-xs" onClick={() => setLocation("/lessor")}>
              ABORT
            </Button>
            <Button type="submit" className="font-mono text-xs bg-primary text-primary-foreground hover:bg-primary/90" disabled={createRig.isPending || updateRig.isPending}>
              {createRig.isPending || updateRig.isPending ? "PROCESSING..." : isEditing ? "SAVE_CONFIG" : "INITIALIZE"}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </div>
  );
}
