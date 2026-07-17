import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { isSupportedImageContentType } from "./dist/backend/worker.js";

const HOST_API_ORIGIN = "https://host.test";
const ACTIVITIES_START_API = `${HOST_API_ORIGIN}/api/v1/activities/start`;
const DOWNLOAD_URL_API = `${HOST_API_ORIGIN}/api/v1/files/download-urls`;
const FILES_TOUCH_API = `${HOST_API_ORIGIN}/api/v1/files/touch`;
const FILES_WRITE_API = `${HOST_API_ORIGIN}/api/v1/files/write`;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const SIGNED_SOURCE_URL = "https://r2.test/photo.png?signed=1";

/** @param {{ name: string, contentType: string }} source */
function uploadRequest(source) {
	return new Request("https://plugin.test/event", {
		method: "POST",
		body: JSON.stringify({
			event: "files.upload.completed",
			pluginRunId: "run-1",
			source: {
				fileNodeId: "node-1",
				assetId: "asset-1",
				path: `/uploads/${source.name}`,
				size: 1234,
				...source,
			},
		}),
	});
}

/** @param {{ secretGet?: () => Promise<string | null> }} [overrides] */
function stubEnv(overrides = {}) {
	return {
		BONOBO: {
			secrets: {
				get: overrides.secretGet ?? vi.fn(async () => "sk-test"),
			},
			host: { apiOrigin: HOST_API_ORIGIN, token: "run-token" },
		},
	};
}

/** @param {RequestInit} init */
function capturedCall(init) {
	return {
		headers: /** @type {Record<string, string>} */ (init.headers),
		body: JSON.parse(String(init.body)),
	};
}

/** @param {{ openai?: () => Response }} [overrides] */
function stubFetch(overrides = {}) {
	/** @type {ReturnType<typeof capturedCall>[]} */
	const activityCalls = [];
	/** @type {ReturnType<typeof capturedCall>[]} */
	const downloadUrlCalls = [];
	/** @type {ReturnType<typeof capturedCall>[]} */
	const touchCalls = [];
	/** @type {ReturnType<typeof capturedCall>[]} */
	const writeCalls = [];
	/** @type {ReturnType<typeof capturedCall>[]} */
	const openaiCalls = [];
	const fetchMock = vi.fn(async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
		if (url === ACTIVITIES_START_API) {
			activityCalls.push(capturedCall(init));
			return Response.json({ activityId: "activity-1" });
		}
		if (url === FILES_TOUCH_API) {
			const call = capturedCall(init);
			touchCalls.push(call);
			return Response.json({
				files: call.body.paths.map((/** @type {string} */ path) => ({ path, nodeId: "node-2", created: true })),
			});
		}
		if (url === DOWNLOAD_URL_API) {
			downloadUrlCalls.push(capturedCall(init));
			return Response.json({
				items: [{ fileNodeId: "node-1", url: SIGNED_SOURCE_URL, expiresAt: Date.now() + 900_000 }],
				errors: [],
				truncated: false,
			});
		}
		if (url === FILES_WRITE_API) {
			const call = capturedCall(init);
			writeCalls.push(call);
			return Response.json({ path: call.body.path, nodeId: "node-2", contentType: "text/markdown;charset=utf-8" });
		}
		if (url === OPENAI_URL) {
			openaiCalls.push(capturedCall(init));
			return overrides.openai
				? overrides.openai()
				: Response.json({ choices: [{ message: { content: "A red bicycle leaning on a wall." } }] });
		}
		throw new Error(`Unexpected fetch URL: ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, activityCalls, downloadUrlCalls, touchCalls, writeCalls, openaiCalls };
}

/**
 * @param {Request} request
 * @param {ReturnType<typeof stubEnv>} env
 */
async function runWorker(request, env) {
	if (!worker.fetch) {
		throw new Error("worker.fetch is not defined");
	}
	return worker.fetch(/** @type {any} */ (request), env, /** @type {any} */ (null));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

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

describe("worker.fetch", () => {
	it("skips uploads with unsupported content types without host calls", async () => {
		const { fetchMock } = stubFetch();
		const env = stubEnv();

		const response = await runWorker(uploadRequest({ name: "report.pdf", contentType: "application/pdf" }), env);

		expect(response.status).toBe(204);
		expect(response.headers.get("X-Bonobo-Skipped")).toBe("unsupported_content_type");
		expect(env.BONOBO.secrets.get).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fails without writing when the OPENAI_API_KEY secret is missing", async () => {
		const { activityCalls, touchCalls, writeCalls } = stubFetch();
		const env = stubEnv({ secretGet: vi.fn(async () => null) });

		await expect(runWorker(uploadRequest({ name: "photo.png", contentType: "image/png" }), env)).rejects.toThrow(
			"OPENAI_API_KEY secret is not configured",
		);
		// The activity starts before the secret reads so the failure shows in the feed,
		// but no file may appear.
		expect(activityCalls).toHaveLength(1);
		expect(touchCalls).toHaveLength(0);
		expect(writeCalls).toHaveLength(0);
	});

	it("retries once on OpenAI 500 and then fails with the status only", async () => {
		const { writeCalls, openaiCalls } = stubFetch({
			openai: () => new Response("internal error", { status: 500 }),
		});
		const env = stubEnv();

		await expect(runWorker(uploadRequest({ name: "photo.png", contentType: "image/png" }), env)).rejects.toThrow(
			"OpenAI image description returned HTTP 500",
		);
		expect(openaiCalls).toHaveLength(2);
		expect(writeCalls).toHaveLength(0);
	});

	it("requests the source download URL, describes it with OpenAI, and writes the sibling description", async () => {
		const { activityCalls, downloadUrlCalls, touchCalls, writeCalls, openaiCalls } = stubFetch();
		const env = stubEnv();

		const response = await runWorker(uploadRequest({ name: "photo.png", contentType: "image/png" }), env);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, files: ["/uploads/photo.png.description.md"] });

		expect(activityCalls).toHaveLength(1);
		expect(activityCalls[0].headers.Authorization).toBe("Bearer run-token");
		expect(activityCalls[0].body).toEqual({ title: "Describing photo.png", timeoutMs: 2 * 60 * 1000 });

		expect(touchCalls).toHaveLength(1);
		expect(touchCalls[0].body).toEqual({ paths: ["/uploads/photo.png.description.md"] });

		expect(downloadUrlCalls).toHaveLength(1);
		expect(downloadUrlCalls[0].headers.Authorization).toBe("Bearer run-token");
		expect(downloadUrlCalls[0].body).toEqual({ fileNodeIds: ["node-1"], expiresInSeconds: 900 });

		expect(openaiCalls).toHaveLength(1);
		expect(openaiCalls[0].headers.Authorization).toBe("Bearer sk-test");
		expect(openaiCalls[0].headers["Content-Type"]).toBe("application/json");
		expect(openaiCalls[0].body.model).toBe("gpt-4.1-mini");
		expect(openaiCalls[0].body.messages[0].role).toBe("system");
		expect(openaiCalls[0].body.messages[1].role).toBe("user");
		expect(openaiCalls[0].body.messages[1].content).toEqual([
			{ type: "text", text: expect.stringContaining("photo.png") },
			{ type: "image_url", image_url: { url: SIGNED_SOURCE_URL } },
		]);

		expect(writeCalls).toHaveLength(1);
		expect(writeCalls[0].headers.Authorization).toBe("Bearer run-token");
		expect(writeCalls[0].body).toEqual({
			path: "/uploads/photo.png.description.md",
			content: "# Image description: photo.png\n\nA red bicycle leaning on a wall.",
			overwrite: "replace",
		});
	});
});
