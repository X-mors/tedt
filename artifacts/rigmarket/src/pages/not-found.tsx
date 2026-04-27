import { Link } from "wouter";
import { ServerCrash } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <ServerCrash className="h-16 w-16 text-muted-foreground mb-6 opacity-50" />
      <h1 className="text-4xl font-bold font-mono tracking-tight mb-2 text-primary">404_NOT_FOUND</h1>
      <p className="text-muted-foreground max-w-md mb-8 text-lg">
        The requested resource is offline or does not exist in the current sector.
      </p>
      <Link href="/">
        <Button className="font-mono text-sm bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-8">
          RETURN_TO_BASE
        </Button>
      </Link>
    </div>
  );
}
