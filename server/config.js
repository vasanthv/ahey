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

// Room topology. Small rooms are a peer-to-peer mesh; once a room outgrows
// MESH_MAX_PEERS it moves onto the mediasoup SFU, and it moves back to mesh once
// it has shrunk to MESH_RETURN_AT people (lower than the mesh cap on purpose, so
// a room hovering around the threshold does not flip topologies on every join).
const MESH_MAX_PEERS = Number(process.env.MESH_MAX_PEERS) || 4;
const SFU_MAX_PEERS = Number(process.env.SFU_MAX_PEERS) || 12;
const MESH_RETURN_AT = Number(process.env.MESH_RETURN_AT) || 3;
// How long a room must stay small before it is moved back to mesh.
const MESH_RETURN_DELAY_MS = Number(process.env.MESH_RETURN_DELAY_MS) || 10000;

module.exports = {
	NODE_ENV: process.env.NODE_ENV,
	PORT: process.env.PORT ?? 824,
	CORS_ORIGIN: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : ["http://localhost:824"],

	// TURN (coturn) integration
	TURN_HOST,
	TURN_URLS,
	TURN_SECRET: process.env.TURN_SECRET || "", // must match coturn static-auth-secret
	TURN_TTL: Number(process.env.TURN_TTL) || 86400, // credential lifetime in seconds

	MESH_MAX_PEERS,
	SFU_MAX_PEERS,
	MESH_RETURN_AT,
	MESH_RETURN_DELAY_MS,

	// mediasoup SFU. Each worker listens on one UDP+TCP port (SFU_PORT + worker
	// index), so docker-compose only has to publish a handful of ports.
	SFU_ANNOUNCED_IP: process.env.SFU_ANNOUNCED_IP || process.env.EXTERNAL_IP || "127.0.0.1",
	SFU_PORT: Number(process.env.SFU_PORT) || 44440,
	SFU_WORKERS: Number(process.env.SFU_WORKERS) || 0, // 0 = one per CPU core, capped at 4
};
