import { useGetMe, useUpgradeToOwner, useUpdateMe, useResetStratumToken } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { Copy, RefreshCw, Wifi } from "lucide-react";

export default function ProfilePage() {
  const queryClient = useQueryClient();
  const { data: me, isLoading } = useGetMe();
  const { toast } = useToast();

  const [displayName, setDisplayName] = useState("");
  const [editing, setEditing] = useState(false);
  const [stratumUsernameInput, setStratumUsernameInput] = useState("");
  const [editingStratumUsername, setEditingStratumUsername] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);

  const updateMe = useUpdateMe({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries();
        setEditing(false);
        setEditingStratumUsername(false);
        toast({ title: "Profile updated" });
      },
      onError: (err: Error) => {
        toast({ title: "Update failed", description: err.message, variant: "destructive" });
      },
    },
  });

  const resetToken = useResetStratumToken({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries();
        toast({ title: "Token regenerated", description: "Update your miner's password to the new token." });
      },
      onError: (err: Error) => {
        toast({ title: "Reset failed", description: err.message, variant: "destructive" });
      },
    },
  });

  const upgradeToOwner = useUpgradeToOwner({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries();
        toast({ title: "Account upgraded", description: "You can now list your mining rigs on the marketplace." });
      },
      onError: (err: Error) => {
        toast({ title: "Upgrade failed", description: err.message, variant: "destructive" });
      },
    },
  });

  if (isLoading || !me) {
    return <div className="p-8 text-center font-mono text-muted-foreground">LOADING_PROFILE...</div>;
  }

  const handleEdit = () => {
    setDisplayName(me.displayName);
    setEditing(true);
  };

  const handleSave = () => {
    if (!displayName.trim()) return;
    updateMe.mutate({ data: { displayName: displayName.trim() } });
  };

  const handleEditStratumUsername = () => {
    setStratumUsernameInput(me.stratumUsername ?? "");
    setEditingStratumUsername(true);
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

  const roleBadgeVariant = me.role === "admin" ? "destructive" : me.role === "owner" ? "default" : "secondary";

  const PROXY_HOST = "proxy.rigmarket.dev";
  const PROXY_PORT = "3333";

  const maskedToken = me.stratumToken
    ? "••••••••••••••••••••" + me.stratumToken.slice(-6)
    : null;

  return (
    <div className="max-w-2xl mx-auto px-4 py-10 space-y-6">
      <h1 className="text-2xl font-bold font-mono tracking-tight">Account Profile</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-mono">Identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground w-32">Role</span>
            <Badge variant={roleBadgeVariant} className="uppercase font-mono text-xs">
              {me.role}
            </Badge>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground w-32">Email</span>
            <span className="text-sm font-mono">{me.email}</span>
          </div>

          {editing ? (
            <div className="space-y-2">
              <Label htmlFor="displayName" className="text-sm text-muted-foreground">Display Name</Label>
              <div className="flex gap-2">
                <Input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={80}
                  className="font-mono"
                />
                <Button size="sm" onClick={handleSave} disabled={updateMe.isPending}>
                  {updateMe.isPending ? "Saving..." : "Save"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground w-32">Display Name</span>
              <span className="text-sm font-mono">{me.displayName}</span>
              <Button size="sm" variant="ghost" className="text-xs" onClick={handleEdit}>
                Edit
              </Button>
            </div>
          )}

          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground w-32">Member Since</span>
            <span className="text-sm font-mono text-muted-foreground">
              {new Date(me.createdAt).toLocaleDateString()}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-mono">Activity</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-muted-foreground uppercase font-mono">Rigs Listed</p>
            <p className="text-2xl font-bold font-mono mt-1">{me.rigCount}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase font-mono">Rentals Made</p>
            <p className="text-2xl font-bold font-mono mt-1">{me.rentalCount}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase font-mono">Balance</p>
            <p className="text-2xl font-bold font-mono mt-1">${me.balanceUsd.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase font-mono">Total Earned</p>
            <p className="text-2xl font-bold font-mono mt-1">${me.totalEarnedUsd.toFixed(2)}</p>
          </div>
        </CardContent>
      </Card>

      {/* Mining Connection Card */}
      <Card className="border-primary/30">
        <CardHeader>
          <CardTitle className="text-base font-mono flex items-center gap-2">
            <Wifi className="w-4 h-4" />
            Mining Connection
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-muted-foreground">
            Point your miner at the RigMarket proxy using the credentials below. Each rig you connect
            uses the format <span className="font-mono bg-muted px-1 rounded">{me.stratumUsername ?? "username"}.rigname</span> as
            the worker name.
          </p>

          {/* Connection Info */}
          <div className="space-y-3 bg-muted/40 rounded-lg p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground font-mono uppercase w-20">Host</span>
              <span className="text-sm font-mono flex-1">{PROXY_HOST}</span>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copyToClipboard(PROXY_HOST, "Host")}>
                <Copy className="w-3 h-3" />
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground font-mono uppercase w-20">Port</span>
              <span className="text-sm font-mono flex-1">{PROXY_PORT}</span>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copyToClipboard(PROXY_PORT, "Port")}>
                <Copy className="w-3 h-3" />
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground font-mono uppercase w-20">Worker</span>
              <span className="text-sm font-mono flex-1 text-primary">
                {me.stratumUsername ? `${me.stratumUsername}.rigname` : <em className="text-muted-foreground">set username below</em>}
              </span>
              {me.stratumUsername && (
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copyToClipboard(`${me.stratumUsername}.rigname`, "Worker format")}>
                  <Copy className="w-3 h-3" />
                </Button>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground font-mono uppercase w-20">Password</span>
              {me.stratumToken ? (
                <>
                  <button
                    className="text-sm font-mono flex-1 text-left text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    onClick={() => setTokenVisible((v) => !v)}
                    title="Click to reveal"
                  >
                    {tokenVisible ? me.stratumToken : maskedToken}
                  </button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copyToClipboard(me.stratumToken!, "Token")}>
                    <Copy className="w-3 h-3" />
                  </Button>
                </>
              ) : (
                <span className="text-sm font-mono flex-1 text-muted-foreground italic">—</span>
              )}
            </div>
          </div>

          {/* Stratum Username Setup */}
          <div className="space-y-2">
            <Label className="text-sm font-mono text-muted-foreground uppercase text-xs tracking-wider">
              Your Username
            </Label>
            {editingStratumUsername ? (
              <div className="flex gap-2">
                <Input
                  value={stratumUsernameInput}
                  onChange={(e) => setStratumUsernameInput(e.target.value.toLowerCase())}
                  placeholder="e.g. satoshi"
                  maxLength={24}
                  className="font-mono"
                />
                <Button size="sm" onClick={handleSaveStratumUsername} disabled={updateMe.isPending}>
                  {updateMe.isPending ? "Saving..." : "Save"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingStratumUsername(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono">
                  {me.stratumUsername ?? <em className="text-muted-foreground">Not set</em>}
                </span>
                <Button size="sm" variant="ghost" className="text-xs h-7" onClick={handleEditStratumUsername}>
                  {me.stratumUsername ? "Change" : "Set Username"}
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Lowercase letters, digits, hyphens only. 3–24 characters. Globally unique.
            </p>
          </div>

          {/* Token Reset */}
          <div className="flex items-center justify-between pt-1">
            <div>
              <p className="text-sm font-medium">Authentication Token</p>
              <p className="text-xs text-muted-foreground">Regenerating invalidates all current miner connections.</p>
            </div>
            <Button
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

      {me.role === "renter" && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="text-base font-mono">Become an Owner</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Upgrade your account to owner status so you can list your mining rigs on the marketplace
              and earn rental income. Admin-set prices and commission rates apply.
            </p>
            <Button
              onClick={() => upgradeToOwner.mutate()}
              disabled={upgradeToOwner.isPending}
              className="font-mono"
            >
              {upgradeToOwner.isPending ? "Upgrading..." : "Upgrade to Owner"}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
