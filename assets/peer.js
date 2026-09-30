/* globals App, Sfu, io, ICE_SERVERS */
"use strict";

const SIGNALLING_SERVER = window.origin;
// ICE servers are now imported from ice-config.js
const VOLUME_THRESHOLD = 24;
const AUDIO_WINDOW_SIZE = 256;

let signalingSocket = null; /* our socket.io connection to our webserver */
window.signalingSocket = null; /* expose for global access */
let audioStreams = new Map(); // Holds audio stream related data for each stream

// How the server says this room moves media: "mesh" (peer-to-peer) or "sfu".
// It changes as people come and go, and the client follows (see applyRoomMode).
let roomMode = null;
let modeQueue = Promise.resolve(); // mode changes are applied one at a time
let meshReturn = null; // set while an SFU room is moving back to mesh: { timer }

const SFU_CONNECT_ATTEMPTS = 3;
// Going back to mesh: how long peers get to connect before we stop waiting, and
// how long to keep publishing to the SFU after the last mesh link is up.
const MESH_RETURN_TIMEOUT_MS = 15000;
const SFU_LINGER_MS = 1500;

// Utility functions
const createPeerConnection = () => new RTCPeerConnection({ iceServers: ICE_SERVERS });

const setupPeerConnectionHandlers = (peerConnection, peer_id) => {
	peerConnection.onicecandidate = (event) => {
		if (event.candidate) {
			signalingSocket.emit("relayICECandidate", {
				peer_id,
				ice_candidate: {
					sdpMLineIndex: event.candidate.sdpMLineIndex,
					candidate: event.candidate.candidate,
				},
			});
		}
	};

	peerConnection.ontrack = (event) => {
		const stream = event.streams[0];
		const peer = App.peers[peer_id];
		if (!peer) return;

		if (peer.handover) {
			// The peer is still on screen via the SFU; switch once this link is up.
			peer.meshStream = stream;
			tryMeshHandover(peer_id);
		} else {
			attachPeerStream(peer_id, stream);
		}
	};

	peerConnection.onconnectionstatechange = () => {
		if (peerConnection.connectionState === "connected") tryMeshHandover(peer_id);
	};
};

// Rank video codecs H.264 first (Safari only supports H.264), VP8 next as a
// fallback for peers built without H.264 support.
const codecRank = (codec) => {
	const mimeType = codec.mimeType.toLowerCase();
	if (mimeType === "video/h264") return 0;
	if (mimeType === "video/vp8") return 1;
	return 2;
};

const addLocalTracksToPeer = (peerConnection) => {
	if (App.localMediaStream) {
		App.localMediaStream.getTracks().forEach((track) => {
			const sender = peerConnection.addTrack(track, App.localMediaStream);
			// Set codec preferences for video tracks if supported
			if (track.kind === "video" && window.RTCRtpSender && RTCRtpSender.getCapabilities) {
				const codecs = RTCRtpSender.getCapabilities("video").codecs;
				const transceiver = peerConnection.getTransceivers().find((t) => t.sender === sender);
				if (transceiver && transceiver.setCodecPreferences && codecs.length) {
					transceiver.setCodecPreferences([...codecs].sort((a, b) => codecRank(a) - codecRank(b)));
				}
			}
		});
	}
};

const setupOfferCreation = (peerConnection, peer_id) => {
	peerConnection.onnegotiationneeded = () => {
		peerConnection
			.createOffer()
			.then((localDescription) => {
				peerConnection
					.setLocalDescription(localDescription)
					.then(() => {
						signalingSocket.emit("relaySessionDescription", {
							peer_id: peer_id,
							session_description: localDescription,
						});
					})
					.catch((error) => console.log("Offer setLocalDescription failed!", error));
			})
			.catch((error) => console.log("Error sending offer: ", error));
	};
};

const handleSessionDescription = (config) => {
	const peer_id = config.peer_id;
	const peer = App.peers[peer_id]?.["rtc"];
	if (!peer) return;
	const remoteDescription = config.session_description;

	const desc = new RTCSessionDescription(remoteDescription);
	peer.setRemoteDescription(
		desc,
		() => {
			if (remoteDescription.type == "offer") {
				peer.createAnswer(
					(localDescription) => {
						peer.setLocalDescription(
							localDescription,
							() =>
								signalingSocket.emit("relaySessionDescription", {
									peer_id,
									session_description: localDescription,
								}),
							() => console.log("Answer setLocalDescription failed!")
						);
					},
					(error) => console.log("Error creating answer: ", error)
				);
			}
		},
		(error) => console.log("setRemoteDescription error: ", error)
	);
};

const handleIceCandidate = (config) => {
	const peer = App.peers[config.peer_id]?.["rtc"];
	if (!peer) return;
	const iceCandidate = config.ice_candidate;
	peer.addIceCandidate(new RTCIceCandidate(iceCandidate)).catch((error) => {
		console.log("Error addIceCandidate", error);
	});
};

const cleanupPeer = (peer_id) => {
	if (peer_id in App.peers && App.peers[peer_id]["rtc"]) {
		App.peers[peer_id]["rtc"].close();
	}
	delete App.peers[peer_id];
	removeAudioStream(peer_id);
	Sfu.dropPeer(peer_id);
	maybeFinishMeshReturn();
};

const cleanupAllPeers = () => {
	Object.keys(App.peers).forEach((peer_id) => {
		if (App.peers[peer_id]["rtc"]) App.peers[peer_id]["rtc"].close();
		removeAudioStream(peer_id);
	});
	App.peers = {};
	App.cleanupScreenShare();

	Sfu.close();
	if (meshReturn) clearTimeout(meshReturn.timer);
	meshReturn = null;
	roomMode = null;
	modeQueue = Promise.resolve();
	App.topology = null;
};

// Shows a stream for a peer, whichever transport it came from. Safe to call again
// as more tracks arrive on the same stream.
const attachPeerStream = (peer_id, stream) => {
	const peer = App.peers[peer_id];
	if (!peer || !stream) return;

	if (peer.stream !== stream) {
		removeAudioStream(peer_id);
		peer.stream = stream;
	}
	if (!audioStreams.has(peer_id) && stream.getAudioTracks().length > 0) {
		handleAudioStream(stream, peer_id);
	}
};

// ---------------------------------------------------------------------------
// Topology. The server decides per room whether media flows peer-to-peer (mesh)
// or through the SFU, and tells everyone with `roomMode`. Both directions of the
// switch build the new path first and only drop the old one once it is carrying
// media, so a tile never goes black.
// ---------------------------------------------------------------------------

const joinSfu = async () => {
	for (let attempt = 1; attempt <= SFU_CONNECT_ATTEMPTS; attempt++) {
		try {
			await Sfu.connect(App.roomId, App.localMediaStream, {
				onStream: (peer_id, stream) => {
					// A peer that is still on the mesh keeps its mesh stream until the
					// SFU path is complete (onPeerReady).
					const peer = App.peers[peer_id];
					if (peer && !peer.rtc) attachPeerStream(peer_id, stream);
				},
				onPeerReady: (peer_id, stream) => {
					const peer = App.peers[peer_id];
					if (roomMode !== "sfu" || !peer || !peer.rtc || !stream || peer.viewOnSfu) return;
					attachPeerStream(peer_id, stream);
					peer.viewOnSfu = true;
					Sfu.notifyConsumed(peer_id);
					closeMeshAfterHandover(peer_id);
				},
				onPeerConsumed: (peer_id) => {
					const peer = App.peers[peer_id];
					if (!peer) return;
					peer.viewedOnSfuByPeer = true;
					closeMeshAfterHandover(peer_id);
				},
			});
			return;
		} catch (error) {
			console.error("Could not join the SFU (attempt " + attempt + ")", error);
			if (roomMode !== "sfu") return;
			if (attempt < SFU_CONNECT_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
		}
	}
	App.setToast("Could not connect to the media server. Some participants may not appear.");
};

// A mesh link carries media both ways, so it can only go once both ends show each
// other from the SFU. Closing it when just we are ready would freeze their view of us.
const closeMeshAfterHandover = (peer_id) => {
	const peer = App.peers[peer_id];
	if (roomMode !== "sfu" || !peer || !peer.rtc || !peer.viewOnSfu || !peer.viewedOnSfuByPeer) return;
	peer.rtc.close();
	peer.rtc = null;
};

const tryMeshHandover = (peer_id) => {
	const peer = App.peers[peer_id];
	if (!peer || !peer.handover || !peer.meshStream || !peer.rtc) return;
	if (peer.rtc.connectionState !== "connected") return;

	attachPeerStream(peer_id, peer.meshStream);
	peer.handover = false;
	peer.meshStream = null;
	Sfu.dropPeer(peer_id);
	maybeFinishMeshReturn();
};

const finishMeshReturn = () => {
	if (!meshReturn) return;
	clearTimeout(meshReturn.timer);
	meshReturn = null;

	Object.values(App.peers).forEach((peer) => (peer.handover = false));
	// Others may still be reading our SFU stream for a moment; let them finish.
	setTimeout(() => {
		if (roomMode === "mesh") Sfu.close();
	}, SFU_LINGER_MS);
};

const maybeFinishMeshReturn = () => {
	if (meshReturn && Object.values(App.peers).every((peer) => !peer.handover)) finishMeshReturn();
};

const applyRoomMode = async (mode) => {
	if (mode === roomMode) return;
	const previous = roomMode;
	roomMode = mode;
	App.topology = mode;

	if (mode === "sfu") {
		if (meshReturn) finishMeshReturn();
		await joinSfu();
	} else if (previous === "sfu") {
		// The server follows this with an addPeer per participant, which builds the
		// mesh links; peers are handed over as those links come up.
		meshReturn = { timer: setTimeout(finishMeshReturn, MESH_RETURN_TIMEOUT_MS) };
		maybeFinishMeshReturn();
	}
};

const joinChatRoom = (room, userData) => signalingSocket.emit("join", { room, userData });

window.initiateCall = () => {
	App.userAgent = navigator.userAgent;
	signalingSocket = io(SIGNALLING_SERVER);
	window.signalingSocket = signalingSocket; /* expose for global access */

	signalingSocket.on("connect", () => {
		App.peerId = signalingSocket.id;
		const userData = { peerName: App.name, userAgent: App.userAgent };

		if (App.localMediaStream) {
			joinChatRoom(App.roomId, userData);
		} else {
			setupLocalMedia(() => joinChatRoom(App.roomId, userData));
		}
	});

	signalingSocket.on("disconnect", cleanupAllPeers);

	Sfu.bind(signalingSocket);

	signalingSocket.on("roomMode", (config) => {
		modeQueue = modeQueue.then(() => applyRoomMode(config.mode)).catch((error) => console.error(error));
	});

	signalingSocket.on("addPeer", (config) => {
		const peer_id = config.peer_id;
		const existing = App.peers[peer_id];
		if (existing && existing.rtc) return;

		// The peer is always registered, so it has a name and a tile; it only gets a
		// peer connection when the room is on the mesh. On the SFU its media is
		// attached as it is consumed.
		App.peers[peer_id] = { ...existing, data: config.room[peer_id].userData };
		if (config.mode !== "mesh") {
			const sfuStream = Sfu.streamFor(peer_id);
			if (sfuStream) attachPeerStream(peer_id, sfuStream);
			return;
		}

		const peerConnection = createPeerConnection();
		App.peers[peer_id]["rtc"] = peerConnection;
		// Coming back from the SFU: keep showing the SFU stream until this link is up.
		App.peers[peer_id]["handover"] = Boolean(Sfu.streamFor(peer_id));
		App.peers[peer_id]["viewOnSfu"] = false;
		App.peers[peer_id]["viewedOnSfuByPeer"] = false;

		setupPeerConnectionHandlers(peerConnection, peer_id);
		addLocalTracksToPeer(peerConnection);

		if (config.should_create_offer) {
			setupOfferCreation(peerConnection, peer_id);
		}
	});

	signalingSocket.on("roomFull", (config) => App.handleRoomFull(config.maxPeers));

	signalingSocket.on("roomMessage", (message) => App.handleIncomingRoomMessage(message));
	signalingSocket.on("sessionDescription", handleSessionDescription);
	signalingSocket.on("iceCandidate", handleIceCandidate);
	signalingSocket.on("removePeer", (config) => cleanupPeer(config.peer_id));
};

function setupLocalMedia(callback) {
	if (App.localMediaStream != null) {
		if (callback) callback();
		return;
	}

	// Build constraints based on settings
	const constraints = {
		audio: App.audioEnabled ? (App.selectedAudioDeviceId ? { deviceId: App.selectedAudioDeviceId } : true) : false,
		video: App.videoEnabled ? (App.selectedVideoDeviceId ? { deviceId: App.selectedVideoDeviceId } : true) : false,
	};

	navigator.mediaDevices
		.getUserMedia(constraints)
		.then((stream) => {
			App.localMediaStream = stream;

			if (callback) callback();
		})
		.catch((error) => {
			console.error(error);
			App.setToast("Unable to get microphone access.");
		});
}

function handleAudioStream(stream, peerId) {
	// Is peer talking analyser from https://www.linkedin.com/pulse/webrtc-active-speaker-detection-nilesh-gawande/
	const audioContext = new AudioContext();
	const mediaStreamSource = audioContext.createMediaStreamSource(stream);
	const analyserNode = audioContext.createAnalyser();
	analyserNode.fftSize = AUDIO_WINDOW_SIZE;
	mediaStreamSource.connect(analyserNode);
	const bufferLength = analyserNode.frequencyBinCount;
	const dataArray = new Uint8Array(bufferLength);
	const entry = { stream, analyserNode, audioContext, stopped: false };

	function processAudio() {
		// A peer's stream can be swapped (mesh <-> SFU), which retires this analyser.
		if (entry.stopped) return;
		analyserNode.getByteFrequencyData(dataArray);
		const averageVolume = dataArray.reduce((acc, val) => acc + val, 0) / bufferLength;
		App.setTalkingPeer(peerId, averageVolume > VOLUME_THRESHOLD);
		requestAnimationFrame(processAudio);
	}

	processAudio();
	audioStreams.set(peerId, entry);
}

function removeAudioStream(peerId) {
	const streamData = audioStreams.get(peerId);
	if (streamData) {
		streamData.stopped = true;
		streamData.stream.getTracks().forEach((track) => track.stop());
		streamData.analyserNode.disconnect();
		streamData.audioContext.close().catch(() => {});
		audioStreams.delete(peerId);
	}
}
