const { isValidRoomName, randomRoomName, randomPublicRoomName, unusedRoomName } = require("./utils");
const { getPublicRooms, isRoomLive } = require("./signalling-server");

const router = require("express").Router();

const STATIC_VIEWS = {
	privacy: "Privacy policy",
	terms: "Terms of service",
};

// Route: Home page
router.get("/", (req, res) => res.render("index", { page: "index", title: "A free video chat for the web." }));

// Route: Bounce to a fresh, empty private room.
router.get("/random", (req, res) => {
	const room = unusedRoomName(randomRoomName, isRoomLive);
	res.redirect(`/${room}`);
});

// Route: Bounce to a fresh, empty public room with a name worth saying out loud.
router.get("/@random", (req, res) => {
	const room = unusedRoomName(randomPublicRoomName, (name) => isRoomLive(`@${name}`));
	res.redirect(`/@${room}`);
});

// Route: Public rooms page. Rooms whose id starts with "@" are discoverable here.
router.get("/public", (req, res) =>
	res.render("public", { page: "public", title: "Public rooms", rooms: getPublicRooms() })
);

// Route: Public rooms as JSON, used by the /public page to keep the list fresh.
router.get("/public.json", (req, res) => {
	res.set("Cache-Control", "no-store");
	res.json({ rooms: getPublicRooms() });
});

// MIddleware: Static views (terms, privacy, etc.)
router.use("/:view", (req, res, next) => {
	const view = req.params.view;
	if (STATIC_VIEWS[view]) {
		return res.render(view, { page: view, title: STATIC_VIEWS[view] });
	}
	next();
});

// Route: Room page (dynamic)
router.get("/:room", (req, res) => {
	const room = req.params.room;
	if (!isValidRoomName(room)) {
		return res.status(400).render("invalid", { page: "invalid-room", title: "Invalid room" });
	}

	res.render("room", { page: "room", title: room });
});

// Route: Catch-all for 404 errors
router.use(["/*", "/404"], (req, res) => res.status(404).render("404", { page: "404", title: "Page not found" }));

module.exports = router;
