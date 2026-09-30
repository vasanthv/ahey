# Veenew

## A free, p2p, group video call app for the web. No signups. No downloads. Works in all major browsers.

Veenew is built on WebRTC, enabling video, audio, and text communication. Small calls (up to 4 people) use a mesh topology, where each participant connects directly to every other participant. There is no central server handling the media streams, which keeps things private and low-latency. When a fifth person joins, the room switches automatically and without dropping the call to a [mediasoup](https://mediasoup.org) SFU, where each participant uploads once and the server forwards the streams, which scales to 12 people. When the room shrinks back to 3 or fewer people, it returns to mesh. Chat travels over the signalling WebSocket, so it works the same on either topology.

### Key Features

- **No Sign-up Required:** Join or create video calls instantly without accounts or passwords.
- **Peer-to-Peer WebRTC:** Low-latency direct streaming between participants.
- **Unique Room URLs:** Easily shareable links like `domain/room-id`.
- **Embed Anywhere:** Embed calls on any website or app using an `<iframe>`.
- **Free and Browser-Based:** 100% free, runs in modern browsers with no downloads.

---

### Contributions

Please refer <a href="https://github.com/vasanthv/veenew/blob/main/markdowns/CONTRIBUTIONS.md">CONTRIBUTIONS.md</a> for more info.

### LICENSE

<a href="https://github.com/vasanthv/veenew/blob/main/LICENSE">MIT License</a>
