const { uniqueNamesGenerator, colors, animals } = require("unique-names-generator");

/**
 * Checks whether a given string is a valid room name.
 *
 * A valid room name must:
 * - Be a string with a maximum length of 64 characters
 * - Contain only alphanumeric characters (a–z, A–Z, 0–9) and hyphens (-)
 * - Optionally begin with an "@", which marks the room as public
 *
 * @param {string} name - The room name to validate.
 * @returns {boolean} `true` if the name is valid; otherwise, `false`.
 */
function isValidRoomName(name) {
	const regex = /^@?[a-zA-Z0-9-]{1,63}$/;
	return typeof name === "string" && regex.test(name);
}

/**
 * Checks whether a room is public. Public rooms are identified by an "@" prefix
 * in their room name and are listed on the /public page.
 *
 * @param {string} name - The room name to check.
 * @returns {boolean} `true` if the room is public; otherwise, `false`.
 */
function isPublicRoomName(name) {
	return isValidRoomName(name) && name.startsWith("@");
}

/**
 * A throwaway id for a private room: 6 random base36 characters, the same shape
 * the home page generates. Padded because Math.random() can round down to a
 * string shorter than 6 characters.
 *
 * @returns {string} A random private room name.
 */
const randomRoomName = () => Math.random().toString(36).slice(2, 8).padEnd(6, "0");

/**
 * A sayable name for a public room, e.g. "crimson-mandrill". Colours and animals
 * are used rather than the bundled adjective list: adjectives are written for
 * general use and include words that read badly as an invitation to a
 * stranger's call, and picking a clean dictionary beats filtering a messy one.
 *
 * @returns {string} A random public room name, without the "@" prefix.
 */
const randomPublicRoomName = () => uniqueNamesGenerator({ dictionaries: [colors, animals], separator: "-", length: 2 });

/**
 * Draws names until one is free. The generators are random, not unique, so this
 * is what actually keeps a redirect from dropping a newcomer into a call that is
 * already in progress. Falls back to a numeric suffix if every draw collides.
 *
 * @param {() => string} generate - Produces a candidate name.
 * @param {(name: string) => boolean} isTaken - Whether that name is in use.
 * @returns {string} An unused room name.
 */
const unusedRoomName = (generate, isTaken) => {
	for (let attempt = 0; attempt < 10; attempt++) {
		const name = generate();
		if (!isTaken(name)) return name;
	}

	return `${generate()}-${Math.floor(Math.random() * 10000)}`;
};

module.exports = { isValidRoomName, isPublicRoomName, randomRoomName, randomPublicRoomName, unusedRoomName };
