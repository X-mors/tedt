import { useState, useEffect } from "react";
import { useLocation, useParams } from "wouter";
import {
  useCreateRig,
  useUpdateMyRig,
  useGetMyRig,
  useListAlgorithms,
  useGetMe,
  useUpdateMe,
  useResetStratumToken,
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
import { ArrowLeft, Copy, RefreshCw, Waves, Wifi } from "lucide-react";

function maskToken(token: string): string {
  return "••••••••••••••••••••" + token.slice(-6);
}

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

  const createRig = useCreateRig();
  const updateRig = useUpdateMyRig();

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

  const resetToken = useResetStratumToken({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        toast({ title: "Token regenerated", description: "Update your miner's password to the new token." });
      },
      onError: (err: Error) => {
        toast({ title: "Reset failed", description: err.message, variant: "destructive" });
      },
    },
  });

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    algorithmId: "",
    hashrate: "",
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
        minRentalHours: rig.minRentalHours.toString(),
        maxRentalHours: rig.maxRentalHours.toString(),
        region: rig.region,
        status: rig.status,
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

    if (isEditing) {
      const data = {
        name: formData.name,
        description: formData.description,
        hashrate: parseFloat(formData.hashrate),
        minRentalHours: parseInt(formData.minRentalHours),
        maxRentalHours: parseInt(formData.maxRentalHours),
        region: formData.region,
        status: formData.status as "available" | "rented" | "offline",
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

        {/* Mining Connection — edit mode only */}
        {isEditing && rig && (
          <Card className="bg-card/50 border-primary/30">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Wifi className="w-4 h-4 text-primary" />
                Mining Connection
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <p className="text-sm text-muted-foreground">
                Point your miner at the RigMarket proxy with the credentials below.
                The worker is unique to this rig.
              </p>

              {/* Connection rows */}
              <div className="space-y-3 bg-muted/40 rounded-lg p-4">
                {[
                  { label: "Host", value: parsedUrl?.host ?? "" },
                  { label: "Port", value: parsedUrl?.port ?? "3333" },
                  { label: "Worker", value: rig.ownerWorker ?? "", highlight: true },
                  { label: "Password", value: rig.ownerPassword ?? "", masked: true },
                ].map(({ label, value, highlight, masked }) => (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground font-mono uppercase w-20">{label}</span>
                    <span className={`text-sm font-mono flex-1 ${highlight ? "text-primary" : ""} ${masked ? "text-muted-foreground select-none" : ""}`}>
                      {masked && value ? maskToken(value) : (value || <em className="text-muted-foreground">—</em>)}
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
                ))}
              </div>

              {/* Stratum Username */}
              <div className="space-y-2 border-t border-border/50 pt-4">
                <Label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                  Mining Username
                </Label>
                {editingStratumUsername ? (
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
                    <span className="text-sm font-mono">
                      {me?.stratumUsername ?? <em className="text-muted-foreground">Not set</em>}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-xs h-7"
                      onClick={() => {
                        setStratumUsernameInput(me?.stratumUsername ?? "");
                        setEditingStratumUsername(true);
                      }}
                    >
                      {me?.stratumUsername ? "Change" : "Set Username"}
                    </Button>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Lowercase letters, digits, hyphens only · 3–24 chars · globally unique.
                  With a username set, you can also use <span className="font-mono bg-muted px-1 rounded">{me?.stratumUsername ?? "username"}.{rig.stratumName ?? "rigname"}</span> as the worker.
                </p>
              </div>

              {/* Token reset */}
              <div className="flex items-center justify-between border-t border-border/50 pt-4">
                <div>
                  <p className="text-sm font-medium">Authentication Token</p>
                  <p className="text-xs text-muted-foreground">Regenerating invalidates all active miner connections.</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="gap-1.5 font-mono text-xs"
                  onClick={() => {
                    if (confirm("Regenerate token? All connected miners will need to re-authenticate.")) {
                      resetToken.mutate();
                    }
                  }}
                  disabled={resetToken.isPending}
                >
                  <RefreshCw className="w-3 h-3" />
                  {resetToken.isPending ? "Regenerating..." : "Regenerate"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

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
                <Select value={formData.algorithmId} onValueChange={v => set("algorithmId", v)} disabled={isEditing}>
                  <SelectTrigger className="bg-background font-mono text-sm" id="algorithm">
                    <SelectValue placeholder="Select algorithm" />
                  </SelectTrigger>
                  <SelectContent>
                    {algorithms?.map(a => (
                      <SelectItem key={a.id} value={a.id.toString()}>{a.name} ({a.unit})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                  <Select value={formData.status} onValueChange={v => set("status", v)}>
                    <SelectTrigger className="bg-background font-mono text-sm" id="status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="available">Available (Listed)</SelectItem>
                      <SelectItem value="offline">Offline (Hidden)</SelectItem>
                    </SelectContent>
                  </Select>
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
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              When your rig is connected but not currently rented, the proxy will forward your miner's
              hashrate to this personal pool so your hardware is never idle.
              Leave empty to keep the miner idle between rentals.
            </p>

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
                  onChange={e => set("fallbackPoolUser", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fallbackPassword">Password</Label>
                <Input
                  id="fallbackPassword"
                  className="bg-background font-mono text-sm"
                  placeholder="x"
                  value={formData.fallbackPoolPassword}
                  onChange={e => set("fallbackPoolPassword", e.target.value)}
                />
              </div>
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
