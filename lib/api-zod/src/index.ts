// Re-export the runtime Zod schemas from the generated api.ts.
// We intentionally do NOT re-export from `./generated/types` because Orval
// emits TypeScript interfaces there with names that collide with the inlined
// request-body Zod schemas in `api.ts` (e.g. `UpdateMeBody`). Server code
// uses the Zod schemas as the single source of truth and can derive types
// via `z.infer<typeof Schema>` when needed.
export * from "./generated/api";
