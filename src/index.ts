import { Hono } from "hono";
import { investigate } from "./investigator";
import { checkSafety } from "./safety";
import { validateAnalyzeRequest } from "./validate";

type AppEnv = { Variables: { ticket_id?: string } };
const app = new Hono<AppEnv>();

// Per-request log of method+path+duration+ticket_id. We never log body contents
// because they may carry sensitive customer details.
app.use("*", async (c, next) => {
  const t0 = Date.now();
  await next();
  const ms = Date.now() - t0;
  // Skip noisy probes.
  if (c.req.path === "/health" || c.req.path === "/") return;
  const ticket = c.get("ticket_id");
  console.log(JSON.stringify({ evt: "request", method: c.req.method, path: c.req.path, ms, ticket }));
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/", (c) => c.text("QueueStorm investigator service. POST /analyze-ticket"));

app.post("/analyze-ticket", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Malformed JSON in request body." }, 400);
  }

  const validation = validateAnalyzeRequest(body);
  if (!validation.ok) {
    return c.json({ error: validation.error }, validation.status);
  }
  const req = validation.value;
  c.set("ticket_id", req.ticket_id);

  let response;
  try {
    response = investigate(req);
  } catch (err) {
    console.error("investigate_failed", { ticket: req.ticket_id, err: String(err) });
    return c.json({ error: "Internal error while analyzing the ticket." }, 500);
  }

  // Defense in depth: re-scan generated customer-facing text. The investigator
  // templates already avoid prohibited language; this is a regression net.
  const replyCheck = checkSafety(response.customer_reply);
  const actionCheck = checkSafety(response.recommended_next_action);
  if (!replyCheck.clean || !actionCheck.clean) {
    console.error("safety_post_check_failed", {
      ticket: req.ticket_id,
      reply: replyCheck.issues,
      action: actionCheck.issues,
    });
    return c.json(
      {
        error: "Internal safety check failed. Case flagged for manual review.",
        safety_issues: [...replyCheck.issues, ...actionCheck.issues],
      },
      500
    );
  }

  return c.json(response);
});

app.onError((err, c) => {
  console.error("unhandled", String(err));
  return c.json({ error: "Internal error." }, 500);
});

app.notFound((c) => c.json({ error: "Not found." }, 404));

// PORT must be provided via the environment (e.g. `.env`). We deliberately
// avoid a baked-in default so misconfiguration fails loudly at startup instead
// of silently binding to a different port in different environments.
const portRaw = Bun.env.PORT;
if (portRaw === undefined || portRaw === "") {
  console.error("Missing required env var 'PORT'. Set PORT in your environment (e.g. via .env) and restart.");
  process.exit(1);
}
const port = Number(portRaw);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Invalid env var 'PORT': ${JSON.stringify(portRaw)}. Must be an integer in 1..65535.`);
  process.exit(1);
}
console.log(`investigator listening on :${port}`);

export default {
  port,
  fetch: app.fetch,
};