const DOWNLOAD_URL_EXPIRES_SECONDS = 15 * 60;
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_DESCRIPTION_MODEL = "gpt-4.1-mini";
const OPENAI_MAX_OUTPUT_TOKENS = 900;
const OPENAI_RETRY_ATTEMPTS = 2;
const OPENAI_RETRY_DELAY_MS = 1000;

const IMAGE_SYSTEM_PROMPT =
	"Describe uploaded images for an app file tree. Write useful, concrete Markdown for a reader who cannot see the image. Cover the main subjects, any visible text, the colors, and the layout, and call out uncertainty. Keep the description under 300 words. Return raw Markdown without wrapping it in a code fence.";

/** @param {unknown} value */
function normalizeContentType(value) {
	return typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : null;
}

/** @param {unknown} value */
export function isSupportedImageContentType(value) {
	switch (normalizeContentType(value)) {
		case "image/jpeg":
		case "image/png":
		case "image/webp":
		case "image/gif":
			return true;
		default:
			return false;
	}
}

function skipped() {
	return new Response(null, {
		status: 204,
		headers: { "X-Bonobo-Skipped": "unsupported_content_type" },
	});
}

/** @param {unknown} body */
function json(body, status = 200) {
	return Response.json(body, { status });
}

/** @param {import("bonobo-plugin-sdk").Request} request */
async function readEvent(request) {
	try {
		return /** @type {import("bonobo-plugin-sdk").BonoboUploadCompletedEvent} */ (await request.json());
	} catch {
		return null;
	}
}

/** @param {import("bonobo-plugin-sdk").BonoboUploadCompletedEvent} event */
function getSource(event) {
	const source = event && typeof event === "object" ? event.source : null;
	if (
		!source ||
		typeof source !== "object" ||
		typeof source.fileNodeId !== "string" ||
		typeof source.name !== "string" ||
		typeof source.path !== "string"
	) {
		return null;
	}

	return source;
}

/**
 * @param {import("bonobo-plugin-sdk").BonoboEnv} env
 * @param {string} name
 */
async function requireSecret(env, name) {
	const value = await env.BONOBO.secrets.get(name);
	if (!value) {
		throw new Error(`${name} secret is not configured`);
	}
	return value;
}

/**
 * @param {string} text
 * @param {string} serviceName
 */
function parseJson(text, serviceName) {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${serviceName} returned invalid JSON`);
	}
}

/** @param {string} text */
function unwrapMarkdown(text) {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/iu);
	return fenced?.[1]?.trim() ?? trimmed;
}

/** @param {number} ms */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs JSON to one of the public Bonobo host APIs and returns the parsed response body.
 * @param {import("bonobo-plugin-sdk").BonoboEnv} env
 * @param {string} path
 * @param {unknown} body
 */
async function hostFetch(env, path, body) {
	const response = await fetch(`${env.BONOBO.host.apiOrigin}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.BONOBO.host.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(`Host API ${path} returned HTTP ${response.status}`);
	}
	return parseJson(await response.text(), `Host API ${path}`);
}

/**
 * @param {import("bonobo-plugin-sdk").BonoboEnv} env
 * @param {string} fileNodeId
 */
async function sourceDownloadUrl(env, fileNodeId) {
	const result = await hostFetch(env, "/api/v1/files/download-urls", {
		fileNodeIds: [fileNodeId],
		expiresInSeconds: DOWNLOAD_URL_EXPIRES_SECONDS,
	});
	const item = result?.items?.[0];
	if (!item || typeof item.url !== "string") {
		throw new Error("Source download URL is unavailable");
	}
	return item.url;
}

/** @param {number} status */
function shouldRetryStatus(status) {
	return status === 429 || status >= 500;
}

/**
 * @param {{ apiKey: string, sourceName: string, imageUrl: string }} args
 */
async function openaiDescribeImage(args) {
	let response = null;
	for (let attempt = 0; attempt < OPENAI_RETRY_ATTEMPTS; attempt += 1) {
		response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${args.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: OPENAI_DESCRIPTION_MODEL,
				max_completion_tokens: OPENAI_MAX_OUTPUT_TOKENS,
				messages: [
					{ role: "system", content: IMAGE_SYSTEM_PROMPT },
					{
						role: "user",
						content: [
							{
								type: "text",
								text: `Describe this uploaded image named ${args.sourceName}. Cover the main subjects, any visible text, the colors, and the layout.`,
							},
							{ type: "image_url", image_url: { url: args.imageUrl } },
						],
					},
				],
			}),
		});
		if (!shouldRetryStatus(response.status) || attempt === OPENAI_RETRY_ATTEMPTS - 1) {
			break;
		}
		await sleep(OPENAI_RETRY_DELAY_MS);
	}
	if (!response?.ok) {
		throw new Error(`OpenAI image description returned HTTP ${response?.status ?? "unknown"}`);
	}

	const payload = parseJson(await response.text(), "OpenAI image description");
	const content = payload?.choices?.[0]?.message?.content;
	if (typeof content !== "string" || content.trim().length === 0) {
		throw new Error("OpenAI image description returned no text");
	}
	return unwrapMarkdown(content);
}

/** @type {import("bonobo-plugin-sdk").BonoboPluginHandler} */
export default {
	async fetch(request, env) {
		const event = await readEvent(request);
		const source = event ? getSource(event) : null;
		if (!event || !source) {
			return json({ error: "Upload source is missing" }, 400);
		}
		if (!isSupportedImageContentType(source.contentType)) {
			return skipped();
		}

		const openaiKey = await requireSecret(env, "OPENAI_API_KEY");

		// Absolute sibling of the upload: /folder/photo.png -> /folder/photo.png.description.md.
		const path = `${source.path}.description.md`;
		// Create the output file empty right away — after the secret is known to exist, so a
		// missing secret still fails before any file appears — and let the user see where the
		// description will land while the model runs. The write below fills this same node in place.
		await hostFetch(env, "/api/v1/files/touch", { paths: [path] });

		const sourceUrl = await sourceDownloadUrl(env, source.fileNodeId);
		const description = await openaiDescribeImage({
			apiKey: openaiKey,
			sourceName: source.name,
			imageUrl: sourceUrl,
		});

		await hostFetch(env, "/api/v1/files/write", {
			path,
			content: `# Image description: ${source.name}\n\n${description}`,
			overwrite: "replace",
		});

		return json({ ok: true, files: [path] });
	},
};
