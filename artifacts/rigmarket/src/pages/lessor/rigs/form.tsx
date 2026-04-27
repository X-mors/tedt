import { useState, useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { useCreateRig, useUpdateMyRig, useGetRig, useListAlgorithms, getListMyRigsQueryKey, getGetRigQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";

export default function RigForm() {
  const { id } = useParams<{ id: string }>();
  const isEditing = !!id;
  const rigId = parseInt(id || "0");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: algorithms } = useListAlgorithms();
  const { data: rig, isLoading: rigLoading } = useGetRig(rigId, { query: { enabled: isEditing } });

  const createRig = useCreateRig();
  const updateRig = useUpdateMyRig();

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    algorithmId: "",
    hashrate: "",
    minRentalHours: "1",
    maxRentalHours: "24",
    region: "",
    status: "available"
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
        status: rig.status
      });
    }
  }, [isEditing, rig]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const data = {
      name: formData.name,
      description: formData.description,
      algorithmId: parseInt(formData.algorithmId),
      hashrate: parseFloat(formData.hashrate),
      minRentalHours: parseInt(formData.minRentalHours),
      maxRentalHours: parseInt(formData.maxRentalHours),
      region: formData.region,
      status: formData.status as "available" | "rented" | "offline"
    };

    if (isEditing) {
      updateRig.mutate({ id: rigId, data }, {
        onSuccess: () => {
          toast({ title: "Rig Updated", description: "Changes saved successfully." });
          queryClient.invalidateQueries({ queryKey: getGetRigQueryKey(rigId) });
          queryClient.invalidateQueries({ queryKey: getListMyRigsQueryKey() });
          setLocation("/lessor");
        },
        onError: (err) => {
          toast({ title: "Update Failed", description: err.message, variant: "destructive" });
        }
      });
    } else {
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

  if (isEditing && rigLoading) return <div className="p-8 text-center font-mono">LOADING_CONFIG...</div>;

  return (
    <div className="container py-8 px-4 max-w-2xl mx-auto space-y-6">
      <Button variant="ghost" className="mb-2 text-muted-foreground hover:text-foreground font-mono text-xs px-0" onClick={() => setLocation("/lessor")}>
        <ArrowLeft className="w-4 h-4 mr-2" /> BACK_TO_INVENTORY
      </Button>

      <div>
        <h1 className="text-3xl font-bold tracking-tight">{isEditing ? "Configure Rig" : "Initialize New Rig"}</h1>
        <p className="text-muted-foreground">List your hardware on the open marketplace</p>
      </div>

      <form onSubmit={handleSubmit}>
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
                onChange={e => setFormData({...formData, name: e.target.value})}
              />
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="algorithm">Algorithm</Label>
                <Select value={formData.algorithmId} onValueChange={v => setFormData({...formData, algorithmId: v})}>
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
                    onChange={e => setFormData({...formData, hashrate: e.target.value})}
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
                  onChange={e => setFormData({...formData, minRentalHours: e.target.value})}
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
                  onChange={e => setFormData({...formData, maxRentalHours: e.target.value})}
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
                  onChange={e => setFormData({...formData, region: e.target.value})}
                />
              </div>
              {isEditing && (
                <div className="space-y-2">
                  <Label htmlFor="status">Status</Label>
                  <Select value={formData.status} onValueChange={v => setFormData({...formData, status: v})}>
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
                onChange={e => setFormData({...formData, description: e.target.value})}
              />
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
