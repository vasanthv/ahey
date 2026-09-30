/**
 * A simple signalling server implementation using socket.io.
 * This socket connection is used a signalling server as WebRTC does not support discovery of other peers.
 * It also carries chat and name changes, and decides each room's media topology:
 * a peer-to-peer mesh while the room is small, the mediasoup SFU (server/sfu.js)
 * once it is not. User's audio and video never use this socket.
 */

const { MESH_MAX_PEERS, SFU_MAX_PEERS, MESH_RETURN_AT, MESH_RETURN_DELAY_MS } = require("./config");
const sfu = require("./sfu");
const { isValidRoomName } = require("./utils");

// Keys in these maps come from untrusted clients. Null-prototype objects keep a
// key like "__proto__" from resolving to Object.prototype (prototype pollution).
const rooms = Object.create(null);
const sockets = Object.create(null);
const peers = Object.create(null);

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// A mesh has everyone connect to everyone else, so each extra peer costs every
// other peer another upload and download stream. Four is where that stays
// workable; past it the room moves to the SFU, which caps out at SFU_MAX_PEERS.
// (Limits live in config.js.)

const MAX_CHAT_LENGTH = 320;
const MAX_NAME_LENGTH = 50;

// room -> { mode: "mesh" | "sfu", returnTimer }. Only exists while the room has peers.
const roomStates = Object.create(null);

const peerCount = (room) => (has(peers, room) ? Object.keys(peers[room]).length : 0);
const modeOf = (room) => (has(roomStates, room) ? roomStates[room].mode : "mesh");

const emitToRoom = (room, event, payload, exceptId) => {
	for (const id in rooms[room] ?? {}) {
		if (id !== exceptId) rooms[room][id].emit(event, payload);
	}
};

/**
 * Tells every peer to build its mesh connections again, after a room has gone
 * back from the SFU. Each pair is told once from each side; the peer with the
 * lower socket id makes the offer.
 */
const rebuildMesh = (room) => {
	for (const a in rooms[room]) {
		for (const b in rooms[room]) {
			if (a === b) continue;
			rooms[room][a].emit("addPeer", { peer_id: b, should_create_offer: a < b, room: peers[room], mode: "mesh" });
		}
	}
};

// Move a room back to mesh once it has been small for a while, so peers
// coming and going around the threshold do not bounce it between topologies.
const scheduleMeshReturn = (room) => {
	const state = roomStates[room];
	if (!state || state.mode !== "sfu" || state.returnTimer) return;

	state.returnTimer = setTimeout(() => {
		state.returnTimer = null;
		if (roomStates[room] !== state || state.mode !== "sfu") return;
		if (peerCount(room) > MESH_RETURN_AT) return;

		state.mode = "mesh";
		console.log("room=" + room + " mode=mesh peers=" + peerCount(room));
		emitToRoom(room, "roomMode", { mode: "mesh" });
		rebuildMesh(room);
	}, MESH_RETURN_DELAY_MS);
};

const cancelMeshReturn = (room) => {
	const state = roomStates[room];
	if (state && state.returnTimer) {
		clearTimeout(state.returnTimer);
		state.returnTimer = null;
	}
};

const signallingServer = (socket) => {
	// The rooms this socket has joined. Kept here rather than on the socket:
	// socket.io defines its own read-only `socket.rooms` getter.
	const joinedRooms = Object.create(null);

	sockets[socket.id] = socket;

	socket.on("disconnect", () => {
		for (const room in joinedRooms) {
			part(room);
		}
		sfu.closePeer(socket.id);
		delete sockets[socket.id];
	});

	socket.on("join", (joinConfig) => {
		const room = joinConfig?.room;

		// Reject malformed room names. This mirrors the HTTP route's validation
		// and keeps unbounded/hostile keys out of the room maps.
		if (!isValidRoomName(room)) return;

		// Already Joined
		if (has(joinedRooms, room)) return;

		// Turn away anyone past the cap, and tell them why.
		if (peerCount(room) >= SFU_MAX_PEERS) {
			return socket.emit("roomFull", { room, maxPeers: SFU_MAX_PEERS });
		}

		if (!has(rooms, room)) rooms[room] = Object.create(null);

		if (!has(peers, room)) peers[room] = Object.create(null);

		if (!has(roomStates, room)) roomStates[room] = { mode: "mesh", returnTimer: null };
		const state = roomStates[room];

		// Only these two fields are ever used, and both come from the client.
		peers[room][socket.id] = {
			userData: {
				peerName: String(joinConfig.userData?.peerName ?? "").slice(0, MAX_NAME_LENGTH),
				userAgent: String(joinConfig.userData?.userAgent ?? "").slice(0, 300),
			},
		};

		const numPeers = peerCount(room);

		if (state.mode === "mesh" && numPeers > MESH_MAX_PEERS) {
			// The mesh is full: everyone, the newcomer included, moves to the SFU.
			state.mode = "sfu";
			console.log("room=" + room + " mode=sfu peers=" + numPeers);
			emitToRoom(room, "roomMode", { mode: "sfu" });
		} else if (state.mode === "sfu" && numPeers > MESH_RETURN_AT) {
			cancelMeshReturn(room);
		}

		// Before any addPeer, so the newcomer knows whether those peers get a
		// mesh connection or arrive through the SFU.
		socket.emit("roomMode", { mode: state.mode });

		for (const id in rooms[room]) {
			rooms[room][id].emit("addPeer", {
				peer_id: socket.id,
				should_create_offer: false,
				room: peers[room],
				mode: state.mode,
			});
			socket.emit("addPeer", { peer_id: id, should_create_offer: true, room: peers[room], mode: state.mode });
		}

		rooms[room][socket.id] = socket;
		joinedRooms[room] = room;

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
			cancelMeshReturn(room);
			delete roomStates[room];
			delete peers[room];
			delete rooms[room];
			sfu.closeRoom(room);
		} else if (modeOf(room) === "sfu" && remainingPeers <= MESH_RETURN_AT) {
			scheduleMeshReturn(room);
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

	// Chat and name changes. They ride the signalling socket rather than
	// WebRTC data channels, so they behave the same whichever topology the room is
	// on, and keep working while it switches. The server stamps the sender's name
	// and the time, so neither can be spoofed.
	socket.on("roomMessage", (message) => {
		const room = message?.room;
		const text = message?.message;

		if (!isValidRoomName(room) || !has(joinedRooms, room)) return;
		if (typeof text !== "string" || !has(peers, room) || !has(peers[room], socket.id)) return;

		const sender = peers[room][socket.id];
		let body;

		switch (message.type) {
			case "chat":
				body = text.slice(0, MAX_CHAT_LENGTH);
				break;
			case "peerName":
				body = text.slice(0, MAX_NAME_LENGTH);
				if (body.trim()) sender.userData.peerName = body;
				break;
			default:
				return;
		}
		if (!body.trim()) return;

		emitToRoom(
			room,
			"roomMessage",
			{ type: message.type, peerId: socket.id, name: sender.userData.peerName, message: body, date: new Date().toISOString() },
			socket.id
		);
	});

	sfu.attach(socket, { isMember: (room) => has(joinedRooms, room), roomMode: modeOf });

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
 * Whether a room currently has anyone in it. Used by the /random redirect so a
 * newcomer is never dropped into a call that is already in progress.
 */
const isRoomLive = (room) => has(peers, room) && Object.keys(peers[room]).length > 0;

module.exports = { signallingServer, isRoomLive };
