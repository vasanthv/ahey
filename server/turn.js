// TURN / ICE server helpers
// Generates time-limited (REST) credentials for a self-hosted coturn server.
//
// coturn is run with `use-auth-secret` + a shared `static-auth-secret`.
// The browser never sees the secret: the app mints a short-lived
// username/password pair that coturn can verify via HMAC.
//
//   username = <unix-expiry-timestamp>
//   password = base64( HMAC_SHA1( secret, username ) )
//
// See: https://github.com/coturn/coturn/blob/master/README.turnserver (use-auth-secret)

const crypto = require("crypto");
const config = require("./config");

// Public STUN servers used for candidate discovery (cheap, no relay).
const STUN_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];

/**
 * Generate a time-limited TURN credential pair for the given shared secret.
 * @param {string} secret - coturn static-auth-secret
 * @param {number} ttl - lifetime in seconds
 */
function generateTurnCredentials(secret, ttl) {
	const expiry = Math.floor(Date.now() / 1000) + ttl;
	const username = String(expiry);
	const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
	return { username, credential };
}

/**
 * Build the full ICE server list served to the browser.
 * Falls back to STUN-only when no TURN secret is configured (e.g. local dev).
 */
function getIceServers() {
	const servers = [...STUN_SERVERS];

	if (config.TURN_SECRET && config.TURN_URLS.length) {
		const { username, credential } = generateTurnCredentials(config.TURN_SECRET, config.TURN_TTL);
		for (const url of config.TURN_URLS) {
			servers.push({ urls: url, username, credential });
		}
	}

	return servers;
}

module.exports = { getIceServers, generateTurnCredentials };
