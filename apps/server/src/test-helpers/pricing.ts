const pricingUrl = "https://models.dev/api.json";
const catalogue = {
	openai: {
		models: {
			"gpt-4o": {
				id: "gpt-4o",
				name: "GPT-4o",
				cost: { input: 2.5, output: 10, cache_read: 1.25 },
			},
		},
	},
};

export function installPricingFixture(): () => void {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === "https://openrouter.ai/api/v1/models")
				return Response.json({
					data: [
						{
							id: "openai/gpt-4o",
							pricing: {
								prompt: "0.0000025",
								completion: "0.00001",
								input_cache_read: "0.00000125",
							},
						},
					],
				});
			return url === pricingUrl
				? Response.json(catalogue)
				: originalFetch(input, init);
		},
		{ preconnect: originalFetch.preconnect },
	);
	return () => {
		globalThis.fetch = originalFetch;
	};
}
