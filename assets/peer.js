/* globals App, io, ICE_SERVERS */
"use strict";

const SIGNALLING_SERVER = window.origin;
// ICE servers are now imported from ice-config.js
const VOLUME_THRESHOLD = 24;
const AUDIO_WINDOW_SIZE = 256;

let signalingSocket = null; /* our socket.io connection to our webserver */
window.signalingSocket = null; /* expose for global access */
let audioStreams = new Map(); // Holds audio stream related data for each stream

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
		App.peers[peer_id]["stream"] = stream;

		// Only handle audio stream if it contains audio tracks and not already handled
		if (stream.getAudioTracks().length > 0 && !audioStreams.has(peer_id)) {
			handleAudioStream(stream, peer_id);
		}
	};

	peerConnection.ondatachannel = (event) => {
		event.channel.onmessage = (msg) => {
			try {
				App.handleIncomingDataChannelMessage(JSON.parse(msg.data));
			} catch (err) {
				console.log(err);
			}
		};
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
	const peer = App.peers[peer_id]["rtc"];
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
	const peer = App.peers[config.peer_id]["rtc"];
	const iceCandidate = config.ice_candidate;
	peer.addIceCandidate(new RTCIceCandidate(iceCandidate)).catch((error) => {
		console.log("Error addIceCandidate", error);
	});
};

const cleanupPeer = (peer_id) => {
	if (peer_id in App.peers) {
		App.peers[peer_id]["rtc"].close();
	}
	delete App.dataChannels[peer_id];
	delete App.peers[peer_id];
	removeAudioStream(peer_id);
};

const cleanupAllPeers = () => {
	Object.keys(App.peers).forEach((peer_id) => {
		App.peers[peer_id]["rtc"].close();
	});
	App.peers = {};
	App.cleanupScreenShare();
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

	signalingSocket.on("addPeer", (config) => {
		const peer_id = config.peer_id;
		if (peer_id in App.peers) return;

		const peerConnection = createPeerConnection();
		App.peers[peer_id] = { ...App.peers[peer_id], data: config.room[peer_id].userData };
		App.peers[peer_id]["rtc"] = peerConnection;

		setupPeerConnectionHandlers(peerConnection, peer_id);
		addLocalTracksToPeer(peerConnection);
		App.dataChannels[peer_id] = peerConnection.createDataChannel("ot__data_channel");

		if (config.should_create_offer) {
			setupOfferCreation(peerConnection, peer_id);
		}
	});

	signalingSocket.on("roomFull", (config) => App.handleRoomFull(config.maxPeers));

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

	function processAudio() {
		analyserNode.getByteFrequencyData(dataArray);
		const averageVolume = dataArray.reduce((acc, val) => acc + val, 0) / bufferLength;
		App.setTalkingPeer(peerId, averageVolume > VOLUME_THRESHOLD);
		requestAnimationFrame(processAudio);
	}

	processAudio();
	audioStreams.set(peerId, { stream, analyserNode });
}

function removeAudioStream(peerId) {
	const streamData = audioStreams.get(peerId);
	if (streamData) {
		streamData.stream.getTracks().forEach((track) => track.stop());
		streamData.analyserNode.disconnect();
		audioStreams.delete(peerId);
	}
}
