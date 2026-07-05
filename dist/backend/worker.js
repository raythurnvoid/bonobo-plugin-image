const TEMPORARY_URL_EXPIRES_SECONDS = 15 * 60;
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_DESCRIPTION_MODEL = "gpt-4.1-mini";
const OPENAI_MAX_OUTPUT_TOKENS = 900;
const OPENAI_RETRY_ATTEMPTS = 2;
const OPENAI_RETRY_DELAY_MS = 1000;

const IMAGE_SYSTEM_PROMPT =
	"Describe uploaded images for an app file tree. Write useful, concrete Markdown for a reader who cannot see the image. Cover the main subjects, any visible text, the colors, and the layout, and call out uncertainty. Return raw Markdown without wrapping it in a code fence.";

function normalizeContentType(value) {
	return typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : null;
}

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

function json(body, status = 200) {
	return Response.json(body, { status });
}

async function readEvent(request) {
	try {
		return await request.json();
	} catch {
		return null;
	}
}

function getSource(event) {
	const source = event && typeof event === "object" ? event.source : null;
	if (!source || typeof source !== "object" || typeof source.name !== "string") {
		return null;
	}

	return source;
}

async function requireSecret(env, name) {
	const value = await env.BONOBO.secrets.get(name);
	if (!value) {
		throw new Error(`${name} secret is not configured`);
	}
	return value;
}

function parseJson(text, serviceName) {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${serviceName} returned invalid JSON`);
	}
}

function unwrapMarkdown(text) {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/iu);
	return fenced?.[1]?.trim() ?? trimmed;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sourceTemporaryUrl(env) {
	const result = await env.BONOBO.files.source.temporaryUrl({
		expiresInSeconds: TEMPORARY_URL_EXPIRES_SECONDS,
	});
	if (!result || typeof result.url !== "string") {
		throw new Error("Source temporary URL is unavailable");
	}
	return result.url;
}

export function openaiDescribeImageRequest(args) {
	return {
		url: OPENAI_CHAT_COMPLETIONS_URL,
		method: "POST",
		headers: {
			Authorization: `Bearer ${args.apiKey}`,
			"Content-Type": "application/json",
		},
		bodyText: JSON.stringify({
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
		responseType: "text",
	};
}

function shouldRetryStatus(status) {
	return status === 429 || (typeof status === "number" && status >= 500);
}

export async function openaiDescribeImage(env, args) {
	const request = openaiDescribeImageRequest(args);
	let response = null;
	for (let attempt = 0; attempt < OPENAI_RETRY_ATTEMPTS; attempt += 1) {
		response = await env.BONOBO.outbound.fetch(request);
		if (!shouldRetryStatus(response?.status) || attempt === OPENAI_RETRY_ATTEMPTS - 1) {
			break;
		}
		await sleep(OPENAI_RETRY_DELAY_MS);
	}
	if (!response?.ok) {
		throw new Error(`OpenAI image description returned HTTP ${response?.status ?? "unknown"}`);
	}

	const payload = parseJson(response.bodyText ?? "", "OpenAI image description");
	const content = payload?.choices?.[0]?.message?.content;
	if (typeof content !== "string" || content.trim().length === 0) {
		throw new Error("OpenAI image description returned no text");
	}
	return unwrapMarkdown(content);
}

export default {
	async fetch(request, env) {
		const event = await readEvent(request);
		const source = getSource(event);
		if (!source) {
			return json({ error: "Upload source is missing" }, 400);
		}
		if (!isSupportedImageContentType(source.contentType)) {
			return skipped();
		}

		const openaiKey = await requireSecret(env, "OPENAI_API_KEY");
		const sourceUrl = await sourceTemporaryUrl(env);
		const description = await openaiDescribeImage(env, {
			apiKey: openaiKey,
			sourceName: source.name,
			imageUrl: sourceUrl,
		});

		const path = `${source.name}.description.md`;
		await env.BONOBO.files.writeMarkdown({
			path,
			markdown: `# Image description: ${source.name}\n\n${description}`,
			overwrite: "replace",
		});

		return json({ ok: true, files: [path] });
	},
};
