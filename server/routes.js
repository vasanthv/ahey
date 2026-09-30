const { isValidRoomName, randomRoomName, unusedRoomName } = require("./utils");
const { isRoomLive } = require("./signalling-server");

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
