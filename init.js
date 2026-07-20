// Import required modules
const socketIO = require("socket.io"); // For real-time WebSocket communication
const express = require("express"); // Web framework for Node.js
const path = require("path"); // Utility for handling file and directory paths
const http = require("http"); // Node.js HTTP server
const app = express(); // Create an Express application

// Import configuration and signalling server logic
const config = require("./server/config");
const signallingServer = require("./server/signalling-server");
const routes = require("./server/routes");
const turn = require("./server/turn");

// Get PORT from env variable else assign 3000 for development
const PORT = config.PORT || 824;
const server = http.createServer(app); // Create HTTP server with Express app

// Set EJS as the view engine for rendering templates
app.set("view engine", "ejs");

// Dynamically serve ICE server config with freshly-minted TURN credentials.
// Registered before express.static so it overrides the static assets/ice-config.js.
app.get("/ice-config.js", (req, res) => {
	res.type("application/javascript");
	res.set("Cache-Control", "no-store");
	res.send(`window.ICE_SERVERS = ${JSON.stringify(turn.getIceServers())};`);
});

// Serve static files from Vue, assets, and www directories
app.use(express.static(path.join(__dirname, "node_modules/vue/dist/")));
app.use(express.static(path.join(__dirname, "assets/icons")));
app.use(express.static(path.join(__dirname, "assets"), { maxAge: 0 })); // No cache for www

// Initialize Socket.IO and attach signalling server logic
const io = socketIO(server, {
	cors: {
		origin: config.CORS_ORIGIN,
		methods: ["GET", "POST"],
		credentials: true,
	},
});
io.sockets.on("connection", signallingServer);

app.use("/", routes);

// Start the server and log status
server.listen(PORT, null, () => {
	console.log("Ahey server started");
	console.log({ port: PORT, node_version: process.versions.node });
});
