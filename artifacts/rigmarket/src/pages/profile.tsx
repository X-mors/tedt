import { useGetMe, useUpgradeToOwner, useUpdateMe } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";

export default function ProfilePage() {
  const queryClient = useQueryClient();
  const { data: me, isLoading } = useGetMe();
  const { toast } = useToast();

  const [displayName, setDisplayName] = useState("");
  const [editing, setEditing] = useState(false);

  const updateMe = useUpdateMe({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries();
        setEditing(false);
        toast({ title: "Profile updated" });
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

  const roleBadgeVariant = me.role === "admin" ? "destructive" : me.role === "owner" ? "default" : "secondary";

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
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={updateMe.isPending}
                >
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
