import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { reviewValue, type Db } from "@lomi/db";

const reviewBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), note: z.string().max(2000).nullish(), reviewer: z.string().max(200).nullish() }),
  z.object({
    action: z.literal("correct"),
    value: z.string().min(1).max(2000),
    note: z.string().max(2000).nullish(),
    reviewer: z.string().max(200).nullish(),
  }),
]);

/** Review routes: approve or correct one extracted value (append-only). */
export function valueRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.post<{ Params: { id: string } }>("/values/:id/review", async (req) => {
    const body = reviewBody.parse(req.body);
    const { value, review } = await reviewValue(deps.db, req.params.id, {
      action: body.action,
      value: body.action === "correct" ? body.value : null,
      note: body.note,
      reviewer: body.reviewer,
    });
    return { value: { id: value.id, reviewState: value.reviewState }, review };
  });
}
