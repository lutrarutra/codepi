import * as http from "node:http";

interface McpToolSchema {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export async function discoverMcpTools(port: number): Promise<McpToolSchema[]> {
	const initRes = await postJson(port, {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "codepi", version: "0.1.0" },
		},
	});
	if (initRes.error) {
		throw new Error(`MCP initialize failed: ${JSON.stringify(initRes.error)}`);
	}

	await postJson(port, {
		jsonrpc: "2.0",
		method: "notifications/initialized",
		params: {},
	});

	const listRes = await postJson(port, {
		jsonrpc: "2.0",
		id: 2,
		method: "tools/list",
		params: {},
	});
	if (listRes.error) {
		throw new Error(`MCP tools/list failed: ${JSON.stringify(listRes.error)}`);
	}
	return (listRes.result as { tools: McpToolSchema[] }).tools;
}

export async function callMcpTool(
	port: number,
	name: string,
	args: Record<string, unknown>,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}> {
	const res = await postJson(port, {
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: { name, arguments: args },
	});
	if (res.error) {
		return {
			content: [{ type: "text", text: res.error.message }],
			isError: true,
		};
	}
	return res.result as {
		content: Array<{ type: "text"; text: string }>;
		isError?: boolean;
	};
}

interface JsonRpcResponse {
	result?: unknown;
	error?: { code: number; message: string };
}

function postJson(port: number, body: unknown): Promise<JsonRpcResponse> {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port: String(port),
				path: "/message",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(Buffer.byteLength(data)),
				},
			},
			(res) => {
				let buf = "";
				res.on("data", (chunk: Buffer) => {
					buf += chunk.toString();
				});
				res.on("end", () => {
					try {
						resolve(JSON.parse(buf));
					} catch (e) {
						reject(e);
					}
				});
			},
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}
