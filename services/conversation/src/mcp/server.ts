/**
 * Remote MCP server for Claude and ChatGPT (Streamable HTTP, stateless).
 *
 * Endpoints:
 *   POST /mcp                Authorization: Bearer <employee token>   (Claude: add the header in the connector)
 *   POST /mcp/t/<token>      token in the path                        (ChatGPT: connectors can't send custom headers)
 *
 * Tools: request_purchase, get_request_status, get_card. Same backend as SMS (RequestService), so
 * the policy engine sees identical requests whichever agent asked. Claude/ChatGPT do their own
 * negotiating with the user; this server only submits and reports.
 */
import express, { type Request, type Response, type Router } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { CABIN_CLASSES, ContractError, type Decision } from "../contract/schemas.ts";
import type { EventBus } from "../bus.ts";
import type { EnrolledAgent, Enrollment } from "../enrollment.ts";
import type { Logger } from "../logger.ts";
import { validateSubmitInput } from "../negotiator/brain.ts";
import { describeCard, maskCardNumbers, money, renderDecision, renderGatewayFailure, type RenderOptions } from "../negotiator/render.ts";
import { gatewayFailure } from "../gateway/client.ts";
import { NotYourRequestError, type RequestService } from "../requests.ts";
import type { StateStore } from "../state.ts";

export interface McpDeps {
  enrollment: Enrollment;
  requests: RequestService;
  state: StateStore;
  bus: EventBus;
  log: Logger;
  merchantCategories: string[];
  render: RenderOptions;
  serverVersion: string;
}

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function decisionPayload(d: Decision): Record<string, unknown> {
  return {
    request_id: d.request_id,
    status: d.status,
    reason: d.reason,
    counteroffer: d.counteroffer,
    escalation: d.escalation,
    mandate_id: d.mandate_id,
    card: d.card,
    policy_trace: d.policy_trace,
    verification: d.verification,
  };
}

// Plain statements of fact. Instructions belong in the tool schema, not in tool results, where
// a client's prompt-injection checks would (rightly) scrutinize them.
function nextStep(d: Decision): string {
  switch (d.status) {
    case "approved":
      return "Approved by the policy engine. The single-use card for this request is available from get_card.";
    case "counter":
      return "Not approved as requested. The counteroffer field holds a within-policy alternative, which can be requested as a new purchase that references this request_id.";
    case "escalated":
      return "Waiting for a manager's decision. get_request_status returns the outcome.";
    case "denied":
      return "Denied by the policy engine. No card was issued.";
  }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function buildMcpServer(agent: EnrolledAgent, deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: "permission-slip", version: deps.serverVersion },
    {
      instructions: `Company spend approvals for ${agent.employee.name}. Before spending company money, call request_purchase. Only the company's policy engine can approve; follow the returned status exactly.`,
    },
  );
  const emit = (dir: "in" | "out", text: string, requestId?: string) =>
    deps.bus.emitAgent(
      dir === "in" ? "agent.message.in" : "agent.message.out",
      { agent_id: agent.agent_id, agent_kind: agent.kind, agent_label: agent.label, channel: "mcp", employee_id: agent.employee.employee_id, employee_name: agent.employee.name, text: maskCardNumbers(text) },
      requestId,
    );

  server.registerTool(
    "request_purchase",
    {
      title: "Request approval for a company purchase",
      description:
        "Ask the company's policy engine to approve a purchase before buying. Returns approved (with a single-use card locked to this purchase), counter (a compliant alternative), escalated (waiting on a manager) or denied. Flights need cabin_class, origin and destination (3-letter airport codes); hotels need nights. The decision comes from deterministic company policy and can't be argued with.",
      inputSchema: {
        merchant: z.string().min(1).max(200).describe("Who is being paid, e.g. 'United Airlines'."),
        merchant_category: z.enum(deps.merchantCategories as [string, ...string[]]).describe("Purchase category."),
        amount_usd: z.number().positive().max(100_000).describe("Total in US dollars, e.g. 480."),
        description: z.string().min(1).max(1000).describe("What is being bought, e.g. 'PHL to SFO, economy, Tue Nov 17'."),
        justification: z.string().min(1).max(1000).describe("Business reason, in the user's words."),
        meeting: z.string().max(200).optional().describe("Meeting this is for, e.g. 'Acme'."),
        event: z.string().max(200).optional().describe("Conference or event this is for, e.g. 'AI Engineer Summit'."),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date of the meeting or event, YYYY-MM-DD."),
        cabin_class: z.enum(CABIN_CLASSES).optional().describe("Flights: economy, premium_economy, business or first."),
        origin: z.string().regex(/^[A-Z]{3}$/).optional().describe("Flights: departure airport code, e.g. PHL."),
        destination: z.string().regex(/^[A-Z]{3}$/).optional().describe("Flights: arrival airport code, e.g. SFO."),
        depart_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Travel start date, YYYY-MM-DD."),
        return_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Travel end date, YYYY-MM-DD."),
        nights: z.number().int().min(1).optional().describe("Hotels: number of nights."),
        parent_request_id: z.string().regex(/^req_[A-Za-z0-9_-]+$/).optional().describe("Only when accepting a counteroffer: the countered request's id. Use the counteroffer's merchant, category, amount, description and travel fields, and keep the original justification and claims. Keep every field factual."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args): Promise<ToolResult> => {
      const travel = Object.fromEntries(
        Object.entries({ cabin_class: args.cabin_class, origin: args.origin, destination: args.destination, depart_date: args.depart_date, return_date: args.return_date, nights: args.nights }).filter(([, v]) => v !== undefined),
      );
      const input = {
        merchant: args.merchant,
        merchant_category: args.merchant_category,
        amount_usd: args.amount_usd,
        description: args.description,
        justification: args.justification,
        ...(Object.keys(travel).length ? { travel } : {}),
        claims: { ...(args.meeting ? { meeting: args.meeting } : {}), ...(args.event ? { event: args.event } : {}), ...(args.date ? { date: args.date } : {}) },
        ...(args.parent_request_id ? { parent_request_id: args.parent_request_id } : {}),
      };
      const checked = validateSubmitInput(input, deps.merchantCategories);
      if (!checked.ok) return errorResult(`Invalid request: ${checked.error}`);
      const summary = `request_purchase: ${input.merchant}, ${money(input.amount_usd)}, ${input.description}. Reason: ${input.justification}`;
      emit("in", summary);
      try {
        const { request, decision } = await deps.requests.submit(agent, checked.value, [{ role: "personal_agent", text: summary }]);
        const text = `${renderDecision(decision, deps.render)}\n\nNext step: ${nextStep(decision)}\nRequest ID: ${request.request_id}`;
        emit("out", renderDecision(decision, deps.render), request.request_id);
        return { content: [{ type: "text", text }], structuredContent: decisionPayload(decision) };
      } catch (err) {
        deps.log.error("mcp: request_purchase failed", { agent_id: agent.agent_id, error: (err as Error).message });
        return errorResult(
          err instanceof ContractError
            ? `The approval system rejected the request format: ${err.message}`
            : renderGatewayFailure(gatewayFailure(err)),
        );
      }
    },
  );

  server.registerTool(
    "get_request_status",
    {
      title: "Check a purchase request",
      description: "Get the latest status of a purchase request you made, e.g. after an escalation.",
      inputSchema: { request_id: z.string().regex(/^req_/).describe("The req_… id returned by request_purchase.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ request_id }): Promise<ToolResult> => {
      try {
        const decision = await deps.requests.status(agent, request_id);
        return { content: [{ type: "text", text: `${renderDecision(decision, deps.render)}\n\nNext step: ${nextStep(decision)}` }], structuredContent: decisionPayload(decision) };
      } catch (err) {
        if (err instanceof NotYourRequestError || gatewayFailure(err) === "not_found") return errorResult("No request with that ID for this employee.");
        return errorResult(renderGatewayFailure(gatewayFailure(err)));
      }
    },
  );

  server.registerTool(
    "get_card",
    {
      title: "Get the card for an approved request",
      description: "Return the single-use card issued for an approved request, with the number, expiry and CVC needed to check out (sandbox card). Only works once the request is approved.",
      inputSchema: { request_id: z.string().regex(/^req_/).describe("The req_… id of an approved request.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ request_id }): Promise<ToolResult> => {
      try {
        const decision = await deps.requests.status(agent, request_id);
        if (decision.status !== "approved" || !decision.card) {
          return errorResult(`No card: this request is ${decision.status}. ${decision.reason}`.trim());
        }
        const details = await deps.requests.cardDetails(agent, request_id, decision);
        emit("out", maskCardNumbers(`get_card: ${describeCard(decision.card, details, deps.render)}`), request_id);
        return {
          content: [{ type: "text", text: `${describeCard(decision.card, details, deps.render)}\nUse it only for this purchase.` }],
          structuredContent: {
            request_id,
            mandate_id: decision.mandate_id,
            card: details ?? decision.card,
            checkout_url: deps.render.demoMerchantUrl ?? null,
          },
        };
      } catch (err) {
        if (err instanceof NotYourRequestError || gatewayFailure(err) === "not_found") return errorResult("No request with that ID for this employee.");
        return errorResult(renderGatewayFailure(gatewayFailure(err)));
      }
    },
  );

  return server;
}

function bearer(req: Request): string | undefined {
  const h = req.header("authorization");
  const m = h?.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim();
}

export function mcpRouter(deps: McpDeps): Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  const handle = async (req: Request, res: Response, token: string | undefined) => {
    const agent = deps.enrollment.findMcpToken(token);
    if (!agent || agent.channel !== "mcp") {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing or unknown employee token" }, id: null });
      return;
    }
    const server = buildMcpServer(agent, deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      deps.log.error("mcp: request failed", { error: (err as Error).message });
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  };

  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: use POST)" }, id: null });
  };

  router.post("/", (req, res) => void handle(req, res, bearer(req)));
  router.post("/t/:token", (req, res) => void handle(req, res, String(req.params.token)));
  router.get(["/", "/t/:token"], notAllowed);
  router.delete(["/", "/t/:token"], notAllowed);
  return router;
}
