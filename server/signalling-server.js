/**
 * A simple signalling server implementation using socket.io.
 * This socket connection is used a signalling server as WebRTC does not support discovery of other peers.
 * User's audio, video or chat messages does not use this socket.
 */

const { isValidRoomName, isPublicRoomName } = require("./utils");

// Keys in these maps come from untrusted clients. Null-prototype objects keep a
// key like "__proto__" from resolving to Object.prototype (prototype pollution).
const rooms = Object.create(null);
const sockets = Object.create(null);
const peers = Object.create(null);

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Everyone connects to everyone else, so each extra peer costs every other peer
// another upload and download stream. Four is where that stays workable.
const MAX_PEERS_PER_ROOM = 4;

const signallingServer = (socket) => {
	// The rooms this socket has joined. Kept here rather than on the socket:
	// socket.io defines its own read-only `socket.rooms` getter.
	const joinedRooms = Object.create(null);

	sockets[socket.id] = socket;

	socket.on("disconnect", () => {
		for (const room in joinedRooms) {
			part(room);
		}
		delete sockets[socket.id];
	});

	socket.on("join", (config) => {
		const room = config?.room;

		// Reject malformed room names. This mirrors the HTTP route's validation
		// and keeps unbounded/hostile keys out of the room maps.
		if (!isValidRoomName(room)) return;

		// Already Joined
		if (has(joinedRooms, room)) return;

		// Turn away anyone past the cap, and tell them why.
		if (has(peers, room) && Object.keys(peers[room]).length >= MAX_PEERS_PER_ROOM) {
			return socket.emit("roomFull", { room, maxPeers: MAX_PEERS_PER_ROOM });
		}

		if (!has(rooms, room)) rooms[room] = Object.create(null);

		if (!has(peers, room)) peers[room] = Object.create(null);

		peers[room][socket.id] = { userData: config.userData };

		for (const id in rooms[room]) {
			rooms[room][id].emit("addPeer", {
				peer_id: socket.id,
				should_create_offer: false,
				room: peers[room],
			});
			socket.emit("addPeer", { peer_id: id, should_create_offer: true, room: peers[room] });
		}

		rooms[room][socket.id] = socket;
		joinedRooms[room] = room;

		const numPeers = Object.keys(peers[room]).length;
		console.log("joined room=" + room + " peers=" + numPeers);
	});

	socket.on("updateUserData", (config) => {
		const room = config?.room;
		const key = config?.key;

		// Only a member of the room may update data, and only its own entry.
		if (!isValidRoomName(room) || !has(joinedRooms, room)) return;
		if (!has(peers, room) || !has(peers[room], socket.id)) return;
		// Never let a client write prototype-mutating keys.
		if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype") return;

		peers[room][socket.id].userData[key] = config.value;
	});

	const part = (room) => {
		// Socket not in room
		if (!has(joinedRooms, room)) return;

		delete joinedRooms[room];
		if (has(rooms, room)) delete rooms[room][socket.id];
		if (has(peers, room)) delete peers[room][socket.id];

		const remainingPeers = has(peers, room) ? Object.keys(peers[room]).length : 0;
		console.log("left room=" + room + " peers=" + remainingPeers);

		for (const id in rooms[room] ?? {}) {
			rooms[room][id].emit("removePeer", { peer_id: socket.id });
			socket.emit("removePeer", { peer_id: id });
		}

		if (remainingPeers === 0) {
			// last peer disconnected from the room
			delete peers[room];
			delete rooms[room];
		}
	};

	// Relay is only permitted between peers that share a room, so a client
	// cannot push offers/candidates at arbitrary sockets on the server.
	const sharesRoomWith = (peerId) => {
		for (const room in joinedRooms) {
			if (has(rooms, room) && has(rooms[room], peerId)) return true;
		}
		return false;
	};

	socket.on("relayICECandidate", (config) => {
		const peer_id = config?.peer_id;

		if (typeof peer_id !== "string" || !has(sockets, peer_id)) return;
		if (!sharesRoomWith(peer_id)) return;

		sockets[peer_id].emit("iceCandidate", { peer_id: socket.id, ice_candidate: config.ice_candidate });
	});

	socket.on("relaySessionDescription", (config) => {
		const peer_id = config?.peer_id;

		if (typeof peer_id !== "string" || !has(sockets, peer_id)) return;
		if (!sharesRoomWith(peer_id)) return;

		sockets[peer_id].emit("sessionDescription", {
			peer_id: socket.id,
			session_description: config.session_description,
		});
	});
};

/**
 * Lists the public rooms (room names prefixed with "@") that currently have at
 * least one peer in them, busiest first. Only the room name and the peer count
 * are exposed - never the peers themselves.
 */
const getPublicRooms = () =>
	Object.keys(peers)
		.filter(isPublicRoomName)
		.map((room) => ({ room, peerCount: Object.keys(peers[room]).length }))
		.filter(({ peerCount }) => peerCount > 0)
		.sort((a, b) => b.peerCount - a.peerCount || a.room.localeCompare(b.room));

/**
 * Whether a room currently has anyone in it. Used by the /random redirects so a
 * newcomer is never dropped into a call that is already in progress.
 */
const isRoomLive = (room) => has(peers, room) && Object.keys(peers[room]).length > 0;

module.exports = { signallingServer, getPublicRooms, isRoomLive };
