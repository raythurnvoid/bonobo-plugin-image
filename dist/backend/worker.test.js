import { describe, expect, it, vi } from "vitest";

import worker, { isSupportedImageContentType, openaiDescribeImageRequest } from "./worker.js";

function uploadRequest(source) {
	return new Request("https://plugin.test/event", {
		method: "POST",
		body: JSON.stringify({ event: "files.upload.completed", source }),
	});
}

function stubEnv(overrides = {}) {
	return {
		BONOBO: {
			secrets: {
				get: overrides.secretGet ?? vi.fn(async () => "sk-test"),
			},
			files: {
				source: {
					temporaryUrl: overrides.temporaryUrl ?? vi.fn(async () => ({ url: "https://r2.test/photo.png?signed=1" })),
				},
				writeMarkdown: overrides.writeMarkdown ?? vi.fn(async () => ({ ok: true })),
			},
			outbound: {
				fetch:
					overrides.outboundFetch ??
					vi.fn(async () => ({
						status: 200,
						ok: true,
						headers: { "Content-Type": "application/json" },
						bodyText: JSON.stringify({ choices: [{ message: { content: "A red bicycle leaning on a wall." } }] }),
					})),
			},
		},
	};
}

describe("isSupportedImageContentType", () => {
	it("accepts the four supported image content types and rejects others", () => {
		expect(isSupportedImageContentType("image/jpeg")).toBe(true);
		expect(isSupportedImageContentType("image/png; charset=binary")).toBe(true);
		expect(isSupportedImageContentType("image/webp")).toBe(true);
		expect(isSupportedImageContentType("image/gif")).toBe(true);
		expect(isSupportedImageContentType("application/pdf")).toBe(false);
		expect(isSupportedImageContentType(null)).toBe(false);
	});
});

describe("openaiDescribeImageRequest", () => {
	it("builds a gpt-4.1-mini chat completion request pointing at the image URL", () => {
		const request = openaiDescribeImageRequest({
			apiKey: "sk-test",
			sourceName: "photo.png",
			imageUrl: "https://r2.test/photo.png?signed=1",
		});

		expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
		expect(request.method).toBe("POST");
		expect(request.headers.Authorization).toBe("Bearer sk-test");
		expect(request.headers["Content-Type"]).toBe("application/json");
		expect(request.responseType).toBe("text");

		const body = JSON.parse(request.bodyText);
		expect(body.model).toBe("gpt-4.1-mini");
		expect(body.messages[0].role).toBe("system");
		expect(body.messages[1].role).toBe("user");
		expect(body.messages[1].content).toEqual([
			{ type: "text", text: expect.stringContaining("photo.png") },
			{ type: "image_url", image_url: { url: "https://r2.test/photo.png?signed=1" } },
		]);
	});
});

describe("worker.fetch", () => {
	it("skips uploads with unsupported content types without host calls", async () => {
		const env = stubEnv();

		const response = await worker.fetch(uploadRequest({ name: "report.pdf", contentType: "application/pdf" }), env);

		expect(response.status).toBe(204);
		expect(response.headers.get("X-Bonobo-Skipped")).toBe("unsupported_content_type");
		expect(env.BONOBO.secrets.get).not.toHaveBeenCalled();
		expect(env.BONOBO.outbound.fetch).not.toHaveBeenCalled();
		expect(env.BONOBO.files.writeMarkdown).not.toHaveBeenCalled();
	});

	it("fails without writing when the OPENAI_API_KEY secret is missing", async () => {
		const env = stubEnv({ secretGet: vi.fn(async () => null) });

		await expect(worker.fetch(uploadRequest({ name: "photo.png", contentType: "image/png" }), env)).rejects.toThrow(
			"OPENAI_API_KEY secret is not configured",
		);
		expect(env.BONOBO.files.writeMarkdown).not.toHaveBeenCalled();
	});

	it("retries once on OpenAI 500 and then fails with the status only", async () => {
		const env = stubEnv({
			outboundFetch: vi.fn(async () => ({ status: 500, ok: false, headers: {}, bodyText: "internal error" })),
		});

		await expect(worker.fetch(uploadRequest({ name: "photo.png", contentType: "image/png" }), env)).rejects.toThrow(
			"OpenAI image description returned HTTP 500",
		);
		expect(env.BONOBO.outbound.fetch).toHaveBeenCalledTimes(2);
		expect(env.BONOBO.files.writeMarkdown).not.toHaveBeenCalled();
	});

	it("writes the description Markdown next to the upload on success", async () => {
		const env = stubEnv();

		const response = await worker.fetch(uploadRequest({ name: "photo.png", contentType: "image/png" }), env);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, files: ["photo.png.description.md"] });
		expect(env.BONOBO.files.writeMarkdown).toHaveBeenCalledWith({
			path: "photo.png.description.md",
			markdown: "# Image description: photo.png\n\nA red bicycle leaning on a wall.",
			overwrite: "replace",
		});
	});
});
