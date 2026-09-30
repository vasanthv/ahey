/* globals mediasoupClient, ICE_SERVERS */
"use strict";

/**
 * Browser side of the mediasoup SFU, used while the room is too big for a mesh.
 * It talks to the server over the existing signalling socket (events `sfu*`).
 *
 * peer.js owns the topology decision and the hand-over between mesh and SFU;
 * this module only knows how to join the SFU, publish the local tracks, consume
 * everyone else's, and leave again.
 */

const SFU_REQUEST_TIMEOUT_MS = 10000;

// Three simulcast layers. The SFU forwards the one that suits each receiver, so a
// weak connection in the room does not drag everyone else's quality down.
const SIMULCAST_ENCODINGS = [
	{ rid: "r0", maxBitrate: 150000, scaleResolutionDownBy: 4, scalabilityMode: "S1T3" },
	{ rid: "r1", maxBitrate: 500000, scaleResolutionDownBy: 2, scalabilityMode: "S1T3" },
	{ rid: "r2", maxBitrate: 1200000, scalabilityMode: "S1T3" },
];

const Sfu = (() => {
	let active = false; // connect() has been called and close() has not
	let connected = false; // joined, published and consumed what was there
	let room = null;
	let device = null;
	let sendTransport = null;
	let recvTransport = null;
	let hooks = {};
	let publishing = Promise.resolve();

	const producers = new Map(); // "audio" | "video" -> producer
	const consumers = new Map(); // consumer id -> { consumer, peer_id, producerId }
	const streams = new Map(); // peer_id -> MediaStream of that peer's consumed tracks
	const consuming = new Map(); // producer id -> promise, so a producer is consumed once
	const pending = new Map(); // peer_id -> Set of in-flight consume promises
	const ready = new Set(); // peers that have finished publishing to the SFU

	const request = (event, data = {}) =>
		new Promise((resolve, reject) => {
			const socket = window.signalingSocket;
			if (!socket || !socket.connected) return reject(new Error("Signalling socket is not connected"));

			const timer = setTimeout(() => reject(new Error(event + " timed out")), SFU_REQUEST_TIMEOUT_MS);
			socket.emit(event, { room, ...data }, (response) => {
				clearTimeout(timer);
				if (response && response.ok) resolve(response);
				else reject(new Error((response && response.error) || event + " failed"));
			});
		});

	const createTransport = async (direction) => {
		const params = await request("sfuCreateTransport", { direction });
		const options = {
			id: params.id,
			iceParameters: params.iceParameters,
			iceCandidates: params.iceCandidates,
			dtlsParameters: params.dtlsParameters,
			iceServers: ICE_SERVERS,
		};
		const transport =
			direction === "send" ? device.createSendTransport(options) : device.createRecvTransport(options);

		transport.on("connect", ({ dtlsParameters }, callback, errback) => {
			request("sfuConnectTransport", { transportId: transport.id, dtlsParameters }).then(() => callback(), errback);
		});

		if (direction === "send") {
			transport.on("produce", ({ kind, rtpParameters }, callback, errback) => {
				request("sfuProduce", { transportId: transport.id, kind, rtpParameters }).then(
					({ id }) => callback({ id }),
					errback
				);
			});
		}

		transport.on("connectionstatechange", (state) => {
			if (state !== "failed" || !active) return;
			// A network change or brief outage: renegotiate ICE on the same transport.
			request("sfuRestartIce", { transportId: transport.id })
				.then(({ iceParameters }) => transport.restartIce({ iceParameters }))
				.catch((error) => console.error("SFU ICE restart failed", error));
		});

		return transport;
	};

	const produceTrack = async (track) => {
		if (!sendTransport || producers.has(track.kind)) return;

		const options = {
			track,
			// Closing a producer must not stop the camera; the mesh (or the next
			// SFU session) is still using the same track.
			stopTracks: false,
			disableTrackOnPause: false,
		};
		if (track.kind === "video") {
			options.encodings = SIMULCAST_ENCODINGS;
			options.codecOptions = { videoGoogleStartBitrate: 1000 };
		}

		const producer = await sendTransport.produce(options);
		producers.set(track.kind, producer);
		producer.on("transportclose", () => producers.delete(track.kind));
	};

	const consume = ({ producerId }) => {
		if (consuming.has(producerId)) return consuming.get(producerId);

		const task = (async () => {
			const data = await request("sfuConsume", { producerId });
			const consumer = await recvTransport.consume({
				id: data.id,
				producerId: data.producerId,
				kind: data.kind,
				rtpParameters: data.rtpParameters,
			});

			if (!active) return consumer.close();

			const peer_id = data.peer_id;
			consumers.set(consumer.id, { consumer, peer_id, producerId });

			let stream = streams.get(peer_id);
			if (!stream) {
				stream = new MediaStream();
				streams.set(peer_id, stream);
			}
			stream.addTrack(consumer.track);

			await request("sfuResumeConsumer", { consumerId: consumer.id });
			if (hooks.onStream) hooks.onStream(peer_id, stream);
		})();

		consuming.set(producerId, task);
		task.catch(() => consuming.delete(producerId));
		return task;
	};

	// Track the consume under its peer, so a peer is only reported ready once
	// everything it publishes has been consumed.
	const consumeFor = (info) => {
		const task = consume(info);
		if (!pending.has(info.peer_id)) pending.set(info.peer_id, new Set());
		pending.get(info.peer_id).add(task);
		const done = () => pending.get(info.peer_id)?.delete(task);
		task.then(done, done);
		return task;
	};

	const settle = async (peer_id) => {
		if (!connected) return; // connect() settles every ready peer when it is done
		await Promise.allSettled([...(pending.get(peer_id) ?? [])]);
		if (active && ready.has(peer_id) && hooks.onPeerReady) hooks.onPeerReady(peer_id, streams.get(peer_id));
	};

	const markReady = (peer_id) => {
		ready.add(peer_id);
		settle(peer_id);
	};

	const closeConsumer = (consumerId, { notifyServer }) => {
		const entry = consumers.get(consumerId);
		if (!entry) return;
		consumers.delete(consumerId);
		consuming.delete(entry.producerId);
		entry.consumer.close();

		const stream = streams.get(entry.peer_id);
		if (stream) stream.removeTrack(entry.consumer.track);
		if (notifyServer) request("sfuCloseConsumer", { consumerId }).catch(() => {});
	};

	const close = () => {
		if (!active) return;
		const leftRoom = room;
		active = false;
		connected = false;

		producers.forEach((producer) => producer.close());
		consumers.forEach(({ consumer }) => consumer.close());
		if (sendTransport) sendTransport.close();
		if (recvTransport) recvTransport.close();

		producers.clear();
		consumers.clear();
		streams.clear();
		consuming.clear();
		pending.clear();
		ready.clear();
		sendTransport = recvTransport = device = null;

		const socket = window.signalingSocket;
		if (socket && socket.connected) socket.emit("sfuLeave", { room: leftRoom }, () => {});
		room = null;
	};

	return {
		get active() {
			return active;
		},

		/** Registers the server events. Call once per signalling socket. */
		bind(socket) {
			socket.on("sfuNewProducer", (info) => {
				// Before the receive transport exists, sfuGetProducers will list it.
				if (active && recvTransport) consumeFor(info).catch((error) => console.error("SFU consume failed", error));
			});
			socket.on("sfuPeerReady", ({ peer_id }) => {
				if (active) markReady(peer_id);
			});
			socket.on("sfuConsumerClosed", ({ consumerId }) => {
				if (active) closeConsumer(consumerId, { notifyServer: false });
			});
			socket.on("sfuPeerConsumed", ({ peer_id }) => {
				if (active && hooks.onPeerConsumed) hooks.onPeerConsumed(peer_id);
			});
		},

		/**
		 * Joins the room's SFU, publishes the local tracks and consumes what is
		 * already there.
		 * @param callbacks.onStream(peer_id, stream) a peer's stream gained a track
		 * @param callbacks.onPeerReady(peer_id, stream) a peer's media is all flowing through the SFU
		 * @param callbacks.onPeerConsumed(peer_id) a peer now shows our media from the SFU
		 */
		async connect(roomId, localStream, callbacks) {
			if (active) return;
			active = true;
			room = roomId;
			hooks = callbacks ?? {};

			try {
				const { rtpCapabilities } = await request("sfuGetRouterCaps");
				device = new mediasoupClient.Device();
				await device.load({ routerRtpCapabilities: rtpCapabilities });
				await request("sfuSetRtpCapabilities", { rtpCapabilities: device.rtpCapabilities });

				sendTransport = await createTransport("send");
				recvTransport = await createTransport("recv");

				// Tracks swapped in while we publish wait for this to finish.
				publishing = Promise.all((localStream ? localStream.getTracks() : []).map(produceTrack));
				await publishing;

				const { producers: existing, ready: readyPeers } = await request("sfuGetProducers");
				await Promise.allSettled(existing.map(consumeFor));
				readyPeers.forEach((peer_id) => ready.add(peer_id));

				await request("sfuPublished");
				connected = true;
				ready.forEach(settle);
			} catch (error) {
				close();
				throw error;
			}
		},

		/** Tell a peer we now show their media from the SFU (see onPeerConsumed). */
		notifyConsumed(peer_id) {
			request("sfuConsumedPeer", { peer_id }).catch((error) => console.error("SFU notify failed", error));
		},

		/** The stream of a peer's tracks as consumed from the SFU, if any. */
		streamFor: (peer_id) => streams.get(peer_id),

		/** Stop consuming one peer (it has moved back to the mesh, or left). */
		dropPeer(peer_id) {
			consumers.forEach((entry, consumerId) => {
				if (entry.peer_id === peer_id) closeConsumer(consumerId, { notifyServer: true });
			});
			streams.delete(peer_id);
			pending.delete(peer_id);
			ready.delete(peer_id);
		},

		/** Swap what we publish, e.g. camera switch, mute, screen share. */
		async replaceTrack(kind, track, addIfMissing = true) {
			if (!active) return;
			await publishing.catch(() => {});
			const producer = producers.get(kind);
			if (producer) await producer.replaceTrack({ track });
			else if (addIfMissing) await produceTrack(track);
		},

		close,
	};
})();

window.Sfu = Sfu;
