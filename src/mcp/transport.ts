import type * as http from "node:http";
import type { McpToolDefinition, McpToolResult } from "./server";

interface SseClient {
	id: string;
	res: http.ServerResponse;
}

export class McpTransport {
	private clients: SseClient[] = [];
	private clientId = 0;

	constructor(private toolRegistry: Map<string, McpToolDefinition>) {}

	handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

		if (url.pathname === "/sse" && req.method === "GET") {
			this.handleSse(req, res);
		} else if (url.pathname === "/message" && req.method === "POST") {
			this.handleMessage(req, res).catch(() => {});
		} else if (url.pathname === "/health" && req.method === "GET") {
			res.writeHead(200).end("ok");
		} else {
			res.writeHead(404).end("not found");
		}
	}

	private handleSse(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
	): void {
		const id = String(++this.clientId);
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write(": connected\n\n");

		const client: SseClient = { id, res };
		this.clients.push(client);

		// Send endpoint event so the client knows where to POST
		this.sendEvent(res, "endpoint", `/message?sessionId=${id}`);

		_req.on("close", () => {
			this.clients = this.clients.filter((c) => c.id !== id);
		});
	}

	private async handleMessage(
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<void> {
		const body = await readBody(req);
		let message: {
			jsonrpc: string;
			id?: number;
			method: string;
			params?: Record<string, unknown>;
		};

		try {
			message = JSON.parse(body);
		} catch {
			res
				.writeHead(400)
				.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: { code: -32700, message: "Parse error" },
					}),
				);
			return;
		}

		const response = await this.handleJsonRpc(message);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(response));
	}

	private async handleJsonRpc(msg: {
		jsonrpc: string;
		id?: number;
		method: string;
		params?: Record<string, unknown>;
	}): Promise<unknown> {
		switch (msg.method) {
			case "initialize":
				return {
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						protocolVersion: "2024-11-05",
						capabilities: { tools: {} },
						serverInfo: { name: "codepi-vscode", version: "0.1.0" },
					},
				};

			case "tools/list":
				return {
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						tools: Array.from(this.toolRegistry.values()).map((t) => ({
							name: t.name,
							description: t.description,
							inputSchema: t.inputSchema,
						})),
					},
				};

			case "tools/call": {
				const { name, arguments: args } = (msg.params ?? {}) as {
					name?: string;
					arguments?: Record<string, unknown>;
				};
				const tool = name ? this.toolRegistry.get(name) : undefined;
				if (!tool) {
					return {
						jsonrpc: "2.0",
						id: msg.id,
						error: { code: -32601, message: `Tool not found: ${name}` },
					};
				}
				try {
					const result = await tool.handler(args ?? {});
					return { jsonrpc: "2.0", id: msg.id, result };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						jsonrpc: "2.0",
						id: msg.id,
						result: {
							content: [{ type: "text", text: message }],
							isError: true,
						},
					};
				}
			}

			case "notifications/initialized":
				return { jsonrpc: "2.0", id: msg.id, result: {} };

			default:
				return {
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32601, message: `Method not found: ${msg.method}` },
				};
		}
	}

	private sendEvent(
		res: http.ServerResponse,
		event: string,
		data: string,
	): void {
		res.write(`event: ${event}\ndata: ${data}\n\n`);
	}

	sendNotification(method: string, params: Record<string, unknown>): void {
		const data = JSON.stringify({ jsonrpc: "2.0", method, params });
		for (const client of this.clients) {
			this.sendEvent(client.res, "message", data);
		}
	}
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}
