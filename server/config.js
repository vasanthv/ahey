// Public hostname that serves the app AND the TURN server (turns://<host>:5349).
const TURN_HOST = process.env.TURN_HOST || process.env.DOMAIN || "localhost";

// TURN endpoints advertised to the browser. Override with a comma-separated
// TURN_URLS env var, otherwise derive sensible defaults from TURN_HOST.
const TURN_URLS = process.env.TURN_URLS
	? process.env.TURN_URLS.split(",").map((u) => u.trim())
	: [
			`turn:${TURN_HOST}:3478?transport=udp`,
			`turn:${TURN_HOST}:3478?transport=tcp`,
			`turns:${TURN_HOST}:5349?transport=tcp`,
	  ];

module.exports = {
	NODE_ENV: process.env.NODE_ENV,
	PORT: process.env.PORT ?? 824,
	CORS_ORIGIN: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : ["http://localhost:824"],

	// TURN (coturn) integration
	TURN_HOST,
	TURN_URLS,
	TURN_SECRET: process.env.TURN_SECRET || "", // must match coturn static-auth-secret
	TURN_TTL: Number(process.env.TURN_TTL) || 86400, // credential lifetime in seconds
};
