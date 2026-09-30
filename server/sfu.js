/**
 * mediasoup SFU, used by rooms that have outgrown the peer-to-peer mesh.
 *
 * The SFU lives in the same process as the signalling server and is driven
 * entirely over the existing socket.io connection (events prefixed `sfu`), so
 * the browser never needs a second signalling channel. Workers are only started
 * the first time a room needs them, so mesh-only deployments never pay for them
 * (and the app still boots where the mediasoup worker binary is unavailable).
 *
 * One router per room. Each participant gets a send and a receive transport,
 * publishes at most one audio and one video producer, and consumes everybody
 * else's producers.
 */

const os = require("os");
const mediasoup = require("mediasoup");
const config = require("./config");
const { isValidRoomName } = require("./utils");

const MEDIA_CODECS = [
	{ kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
	{ kind: "video", mimeType: "video/VP8", clockRate: 90000, parameters: { "x-google-start-bitrate": 1000 } },
	{
		kind: "video",
		mimeType: "video/H264",
		clockRate: 90000,
		parameters: {
			"packetization-mode": 1,
			"profile-level-id": "42e01f",
			"level-asymmetry-allowed": 1,
			"x-google-start-bitrate": 1000,
		},
	},
];

// A client has no business sending more than this. Simulcast tops out near 1.2 Mbps.
const MAX_INCOMING_BITRATE = 3000000;

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// An error whose message is safe to show the client. Anything else is logged and
// reported as a generic failure.
class SfuError extends Error {}

let workersPromise = null;

const startWorkers = () => {
	if (!workersPromise) {
		workersPromise = (async () => {
			const count = config.SFU_WORKERS || Math.min(os.cpus().length, 4);
			const started = [];

			for (let i = 0; i < count; i++) {
				const worker = await mediasoup.createWorker({ logLevel: "warn" });
				worker.on("died", () => {
					// Every call routed through this worker is gone. Exit and let the
					// container restart policy bring a clean process back.
					console.error("mediasoup worker died, exiting in 2 seconds [pid=%d]", worker.pid);
					setTimeout(() => process.exit(1), 2000);
				});

				const port = config.SFU_PORT + i;
				const webRtcServer = await worker.createWebRtcServer({
					listenInfos: ["udp", "tcp"].map((protocol) => ({
						protocol,
						ip: "0.0.0.0",
						announcedAddress: config.SFU_ANNOUNCED_IP,
						port,
					})),
				});

				started.push({ worker, webRtcServer, rooms: 0 });
			}

			console.log("mediasoup started workers=" + count + " announced=" + config.SFU_ANNOUNCED_IP);
			return started;
		})().catch((err) => {
			// Allow a later room to try again instead of caching the failure.
			workersPromise = null;
			throw err;
		});
	}
	return workersPromise;
};

// room -> { router, worker, peers: Set<socket id>, ready: Promise }
const routers = Object.create(null);
// socket id -> session
const sessions = Object.create(null);

const getRouterEntry = async (room) => {
	if (!has(routers, room)) {
		const entry = { router: null, worker: null, peers: new Set(), ready: null };
		routers[room] = entry;

		entry.ready = (async () => {
			const workers = await startWorkers();
			// Least-loaded worker, by number of rooms.
			entry.worker = workers.reduce((best, w) => (w.rooms < best.rooms ? w : best));
			entry.worker.rooms++;
			entry.router = await entry.worker.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
		})();

		entry.ready.catch(() => {
			if (entry.worker) entry.worker.rooms--;
			if (routers[room] === entry) delete routers[room];
		});
	}

	const entry = routers[room];
	await entry.ready;
	return entry;
};

const closeRouterEntry = (room) => {
	const entry = routers[room];
	if (!entry) return;
	delete routers[room];
	if (entry.router) entry.router.close();
	if (entry.worker) entry.worker.rooms--;
};

const closePeer = (socketId) => {
	const session = sessions[socketId];
	if (!session) return;
	delete sessions[socketId];

	// Closing a transport closes its producers and consumers. Other participants'
	// consumers of our producers see `producerclose` and tell their clients.
	session.transports.forEach((transport) => transport.close());

	const entry = routers[session.room];
	if (entry) {
		entry.peers.delete(socketId);
		if (entry.peers.size === 0) closeRouterEntry(session.room);
	}
	console.log("sfu left room=" + session.room + " peers=" + (entry ? entry.peers.size : 0));
};

/** Number of participants currently connected to a room's SFU. */
const peerCount = (room) => (has(routers, room) ? routers[room].peers.size : 0);

/** Drop everything held for a room, e.g. once its last participant has left. */
const closeRoom = (room) => {
	const entry = routers[room];
	if (!entry) return;
	[...entry.peers].forEach(closePeer);
	closeRouterEntry(room);
};

const otherSessions = (session) =>
	[...routers[session.room].peers].filter((id) => id !== session.socket.id).map((id) => sessions[id]);

/**
 * Registers the SFU events for one socket.
 * @param {object} socket socket.io socket
 * @param {{ isMember: (room: string) => boolean, roomMode: (room: string) => string }} ctx
 */
const attach = (socket, ctx) => {
	// Wraps a handler so a client always gets an answer, and validation failures
	// are reported rather than thrown.
	const handle = (event, fn) =>
		socket.on(event, async (payload, ack) => {
			if (typeof ack !== "function") return;
			try {
				ack({ ok: true, ...(await fn(payload && typeof payload === "object" ? payload : {})) });
			} catch (err) {
				if (!(err instanceof SfuError)) console.error("sfu " + event + " failed:", err);
				ack({ error: err instanceof SfuError ? err.message : "SFU error" });
			}
		});

	const requireSession = (payload) => {
		const session = sessions[socket.id];
		if (!session || session.room !== payload.room) throw new SfuError("No SFU session");
		return session;
	};

	const requireTransport = (session, id) => {
		for (const transport of session.transports.values()) {
			if (transport.id === id) return transport;
		}
		throw new SfuError("Unknown transport");
	};

	handle("sfuGetRouterCaps", async ({ room }) => {
		if (!isValidRoomName(room) || !ctx.isMember(room)) throw new SfuError("Not in room");
		if (!has(routers, room) && ctx.roomMode(room) !== "sfu") throw new SfuError("Room is not using the SFU");

		const existing = sessions[socket.id];
		if (existing && existing.room !== room) throw new SfuError("Already using the SFU in another room");
		if (existing) return { rtpCapabilities: routers[room].router.rtpCapabilities };

		const entry = await getRouterEntry(room);
		// A session could have been opened while the router was being created.
		if (sessions[socket.id]) throw new SfuError("Already connected");
		if (routers[room] !== entry) throw new SfuError("Room closed");

		entry.peers.add(socket.id);
		sessions[socket.id] = {
			room,
			socket,
			rtpCapabilities: null,
			transports: new Map(), // "send" | "recv" -> transport
			producers: new Map(), // "audio" | "video" -> producer
			consumers: new Map(), // consumer id -> consumer
			consumedProducerIds: new Set(),
			published: false,
		};
		console.log("sfu joined room=" + room + " peers=" + entry.peers.size);

		return { rtpCapabilities: entry.router.rtpCapabilities };
	});

	handle("sfuSetRtpCapabilities", async (payload) => {
		const session = requireSession(payload);
		if (!payload.rtpCapabilities || typeof payload.rtpCapabilities !== "object") {
			throw new SfuError("Invalid RTP capabilities");
		}
		session.rtpCapabilities = payload.rtpCapabilities;
		return {};
	});

	handle("sfuCreateTransport", async (payload) => {
		const session = requireSession(payload);
		const direction = payload.direction;
		if (direction !== "send" && direction !== "recv") throw new SfuError("Invalid direction");
		if (session.transports.has(direction)) throw new SfuError("Transport already exists");

		const entry = routers[session.room];
		const transport = await entry.router.createWebRtcTransport({
			webRtcServer: entry.worker.webRtcServer,
			enableUdp: true,
			enableTcp: true,
			preferUdp: true,
			initialAvailableOutgoingBitrate: 1000000,
		});

		if (sessions[socket.id] !== session) {
			transport.close();
			throw new SfuError("Session closed");
		}

		if (direction === "send") {
			await transport.setMaxIncomingBitrate(MAX_INCOMING_BITRATE).catch(() => {});
		}
		session.transports.set(direction, transport);

		return {
			id: transport.id,
			iceParameters: transport.iceParameters,
			iceCandidates: transport.iceCandidates,
			dtlsParameters: transport.dtlsParameters,
		};
	});

	handle("sfuConnectTransport", async (payload) => {
		const session = requireSession(payload);
		const transport = requireTransport(session, payload.transportId);
		await transport.connect({ dtlsParameters: payload.dtlsParameters });
		return {};
	});

	handle("sfuProduce", async (payload) => {
		const session = requireSession(payload);
		const { kind, rtpParameters } = payload;
		if (kind !== "audio" && kind !== "video") throw new SfuError("Invalid kind");
		if (session.producers.has(kind)) throw new SfuError("Already producing " + kind);

		const transport = requireTransport(session, payload.transportId);
		if (transport !== session.transports.get("send")) throw new SfuError("Not a send transport");

		const producer = await transport.produce({ kind, rtpParameters, appData: { peer_id: socket.id } });
		if (sessions[socket.id] !== session) {
			producer.close();
			throw new SfuError("Session closed");
		}

		session.producers.set(kind, producer);
		producer.on("transportclose", () => session.producers.delete(kind));

		otherSessions(session).forEach((other) =>
			other.socket.emit("sfuNewProducer", { peer_id: socket.id, producerId: producer.id, kind })
		);

		return { id: producer.id };
	});

	// Everything a newly connected client needs to start consuming.
	handle("sfuGetProducers", async (payload) => {
		const session = requireSession(payload);
		const producers = [];
		const ready = [];

		otherSessions(session).forEach((other) => {
			if (other.published) ready.push(other.socket.id);
			other.producers.forEach((producer, kind) =>
				producers.push({ peer_id: other.socket.id, producerId: producer.id, kind })
			);
		});

		return { producers, ready };
	});

	handle("sfuConsume", async (payload) => {
		const session = requireSession(payload);
		const { producerId } = payload;
		const recvTransport = session.transports.get("recv");

		if (typeof producerId !== "string") throw new SfuError("Invalid producer");
		if (!session.rtpCapabilities) throw new SfuError("RTP capabilities not set");
		if (!recvTransport) throw new SfuError("No receive transport");
		if (session.consumedProducerIds.has(producerId)) throw new SfuError("Already consuming this producer");

		const owner = otherSessions(session).find((other) =>
			[...other.producers.values()].some((producer) => producer.id === producerId)
		);
		if (!owner) throw new SfuError("Unknown producer");

		const entry = routers[session.room];
		if (!entry.router.canConsume({ producerId, rtpCapabilities: session.rtpCapabilities })) {
			throw new SfuError("Cannot consume this producer");
		}

		session.consumedProducerIds.add(producerId);
		let consumer;
		try {
			consumer = await recvTransport.consume({ producerId, rtpCapabilities: session.rtpCapabilities, paused: true });
		} catch (err) {
			session.consumedProducerIds.delete(producerId);
			throw err;
		}

		session.consumers.set(consumer.id, consumer);
		const closed = () => {
			session.consumers.delete(consumer.id);
			session.consumedProducerIds.delete(producerId);
			socket.emit("sfuConsumerClosed", { consumerId: consumer.id, peer_id: owner.socket.id });
		};
		consumer.on("transportclose", () => {
			session.consumers.delete(consumer.id);
			session.consumedProducerIds.delete(producerId);
		});
		consumer.on("producerclose", closed);
		consumer.observer.on("close", () => {
			session.consumers.delete(consumer.id);
			session.consumedProducerIds.delete(producerId);
		});

		// Bigger rooms get a smaller simulcast layer, which is what keeps the
		// download of a 12-person room sane.
		if (consumer.kind === "video" && consumer.type !== "simple") {
			const peers = entry.peers.size;
			const spatialLayer = peers > 8 ? 0 : peers > 5 ? 1 : 2;
			await consumer.setPreferredLayers({ spatialLayer, temporalLayer: 2 }).catch(() => {});
		}

		return {
			id: consumer.id,
			producerId,
			kind: consumer.kind,
			rtpParameters: consumer.rtpParameters,
			peer_id: owner.socket.id,
		};
	});

	handle("sfuResumeConsumer", async (payload) => {
		const session = requireSession(payload);
		const consumer = session.consumers.get(payload.consumerId);
		if (!consumer) throw new SfuError("Unknown consumer");
		await consumer.resume();
		return {};
	});

	// A client that has moved a peer back onto the mesh stops consuming it here,
	// otherwise the SFU would keep forwarding that peer's media to it.
	handle("sfuCloseConsumer", async (payload) => {
		const session = requireSession(payload);
		const consumer = session.consumers.get(payload.consumerId);
		if (consumer) consumer.close();
		return {};
	});

	handle("sfuRestartIce", async (payload) => {
		const session = requireSession(payload);
		const transport = requireTransport(session, payload.transportId);
		return { iceParameters: await transport.restartIce() };
	});

	// The client has published everything it is going to publish, so peers that
	// are still on the mesh can hand this participant over to the SFU.
	handle("sfuPublished", async (payload) => {
		const session = requireSession(payload);
		session.published = true;
		otherSessions(session).forEach((other) => other.socket.emit("sfuPeerReady", { peer_id: socket.id }));
		return {};
	});

	// Tells another participant that we now show their media from the SFU, so
	// they may drop the mesh connection between us once they do the same.
	handle("sfuConsumedPeer", async (payload) => {
		const session = requireSession(payload);
		const target = sessions[payload.peer_id];
		if (target && target.room === session.room) target.socket.emit("sfuPeerConsumed", { peer_id: socket.id });
		return {};
	});

	handle("sfuLeave", async (payload) => {
		requireSession(payload);
		closePeer(socket.id);
		return {};
	});
};

module.exports = { attach, closePeer, closeRoom, peerCount };
