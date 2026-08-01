import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerErrorHandler } from "./errors.js";

describe("API error handler", () => {
  it("returns a safe error envelope for an empty JSON request", async () => {
    const app = Fastify();
    registerErrorHandler(app);
    app.post("/test", () => ({ ok: true }));

    const response = await app.inject({
      method: "POST",
      url: "/test",
      headers: { "content-type": "application/json" },
      payload: "",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "EMPTY_JSON_BODY",
        message: "The request body is missing. Refresh the page and try again.",
      },
    });

    await app.close();
  });
});
