import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DomainError } from "@lomi/db";

const STATUS: Record<DomainError["code"], number> = { not_found: 404, conflict: 409, invalid: 400 };

/** One mapping from domain/validation errors to HTTP. Routes just throw. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(STATUS[err.code]).send({ error: err.code, message: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: "invalid", message: err.issues.map((i) => i.message).join("; ") });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.status(status).send({ error: "error", message: (err as Error).message });
  });
}
