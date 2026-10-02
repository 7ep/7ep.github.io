/**
 * Front end for the OrrLoco site.
 *
 * Nothing here reads a stored data file. The home page asks the rink's booking
 * system (DaySmart) for the schedule every time it opens, and the GameSheet page
 * frames GameSheet itself, so neither needs anyone to upload anything.
 */
(function () {
	"use strict";

	/*
	 * The one thing that still changes by hand, once a season. A browser cannot look
	 * up GameSheet's current season (it blocks anything but a person), so the ids live
	 * here. Season and team are in the address of the team's page on gamesheetstats.com:
	 *   https://gamesheetstats.com/seasons/<season>/teams/<team>/schedule
	 * The division id appears after picking the division on GameSheet's Players page:
	 *   https://gamesheetstats.com/seasons/<season>/players?filter[division]=<division>
	 */
	var GAMESHEET = { season: 15835, team: 553606, division: 86203, divisionName: "D3 League" };

	/* DaySmart is looked up by team name instead, so a new season needs no edit. */
	var DAYSMART = {
		api: "https://api.daysmartrecreation.com/v1/",
		company: "ashburn",
		team: "Orr LoCo",
		site: "https://apps.daysmartrecreation.com/dash/x/#/online/ashburn"
	};

	var TEAM = "Orr LoCo";
	var TZ = "America/New_York";
	var UPCOMING_SHOWN = 6;

	var gsTeam = "https://gamesheetstats.com/seasons/" + GAMESHEET.season + "/teams/" + GAMESHEET.team;
	var gsSeason = "https://gamesheetstats.com/seasons/" + GAMESHEET.season;
	var gsDivision = "?filter[division]=" + GAMESHEET.division;

	var $ = function (sel, root) { return (root || document).querySelector(sel); };
	var $$ = function (sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); };

	function esc(s) {
		return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
		});
	}

	/* Rendered in the rink's timezone, so 7:10 PM at Ashburn reads 7:10 PM anywhere. */
	function fmtDate(d, withTime) {
		var opts = { weekday: "short", month: "short", day: "numeric", timeZone: TZ };
		if (withTime) {
			opts.hour = "numeric";
			opts.minute = "2-digit";
			opts.timeZoneName = "short";
		}
		return d.toLocaleString("en-US", opts);
	}

	function fmtDay(d) {
		return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
	}

	function fmtTime(d) {
		return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: TZ });
	}

	/* ---------- DaySmart schedule ---------- */

	function daysmart(path) {
		var url = DAYSMART.api + path + (path.indexOf("?") < 0 ? "?" : "&") + "company=" + DAYSMART.company;
		return fetch(url).then(function (r) {
			if (!r.ok) { throw new Error("DaySmart responded " + r.status); }
			return r.json();
		});
	}

	/**
	 * Every game for the current Orr LoCo team, soonest first.
	 *
	 * DaySmart makes a new team record each season, and next season's record can
	 * exist before this one ends, so the newest two records are both read and merged
	 * rather than trusting whichever was created last.
	 */
	function loadGames() {
		/* Without a date filter DaySmart only returns games within about 90 days of today,
		   which hides the back half of a season. Asking for everything from yesterday on
		   (in rink time, so a late game still in progress is not dropped) returns the rest. */
		var since = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() - 86400000));
		return daysmart("teams?filter%5Bname%5D=" + encodeURIComponent(DAYSMART.team))
			.then(function (res) {
				var teams = (res.data || []).slice().sort(function (a, b) {
					return a.attributes.start_date < b.attributes.start_date ? 1 : -1;
				}).slice(0, 2);
				if (!teams.length) { throw new Error("no DaySmart team named " + DAYSMART.team); }
				return Promise.all(teams.map(function (t) {
					return daysmart("teams/" + t.id + "/events?include=resource,homeTeam,visitingTeam" +
						"&filter%5Bstart_date__gte%5D=" + since)
						.then(function (ev) { return { teamId: t.id, ev: ev }; });
				}));
			})
			.then(function (sets) {
				var games = [], seen = {};
				sets.forEach(function (set) {
					var names = {};
					(set.ev.included || []).forEach(function (x) {
						names[x.type + ":" + x.id] = String(x.attributes.name || "").trim();
					});
					(set.ev.data || []).forEach(function (e) {
						var a = e.attributes;
						if (a.event_type_id !== "g" || seen[e.id]) { return; }
						seen[e.id] = true;
						var home = String(a.hteam_id) === String(set.teamId);
						games.push({
							id: e.id,
							teamId: set.teamId,
							// start_gmt is UTC without a zone marker; start is rink-local time.
							when: new Date(a.start_gmt + "Z"),
							end: new Date(a.end_gmt + "Z"),
							home: home,
							opponent: names["teams:" + (home ? a.vteam_id : a.hteam_id)] || "Opponent TBD",
							rink: names["resources:" + a.resource_id] || "Ashburn Ice House",
							label: a.desc || (a.sub_type === "playoff" ? "Playoff" : "Regular season")
						});
					});
				});
				games.sort(function (a, b) { return a.when - b.when; });
				return { games: games, newestTeamId: sets[0].teamId };
			});
	}

	/* ---------- countdown ---------- */

	function tick(when) {
		var e = $("#countdown");
		if (!e) { return; }
		var ms = when - new Date();
		if (ms <= 0) {
			e.innerHTML = '<div><span class="n">Game time</span><span class="u">Good luck</span></div>';
			return;
		}
		var s = Math.floor(ms / 1000);
		e.innerHTML = [
			[Math.floor(s / 86400), "Days"],
			[Math.floor(s / 3600) % 24, "Hours"],
			[Math.floor(s / 60) % 60, "Min"],
			[s % 60, "Sec"]
		].map(function (p) {
			return '<div><span class="n">' + p[0] + '</span><span class="u">' + p[1] + "</span></div>";
		}).join("");
	}

	/* ---------- pages ---------- */

	var pages = {};

	pages.home = function () {
		var next = $("#next-game"), list = $("#upcoming");

		loadGames().then(function (r) {
			var now = new Date();
			// A game stays "next" until it ends, so the card doesn't flip mid-game.
			var ahead = r.games.filter(function (g) { return g.end > now; });

			var dashTeam = ahead.length ? ahead[0].teamId : r.newestTeamId;
			$$("[data-dash-team]").forEach(function (a) { a.href = DAYSMART.site + "/teams/" + dashTeam; });

			if (!ahead.length) {
				next.innerHTML = '<p class="loading">No upcoming games are posted yet. ' +
					'Past results are on the <a href="live.html">GameSheet</a> page.</p>';
				list.innerHTML = '<p class="loading">Nothing scheduled yet &mdash; games appear here as soon as the rink posts them.</p>';
				return;
			}

			var g = ahead[0];
			next.innerHTML =
				'<span class="badge gold">' + esc(g.label) + "</span>" +
				'<div class="matchup"><div class="side">' + esc(TEAM) + "</div>" +
				'<div class="vs">' + (g.home ? "vs" : "at") + "</div>" +
				'<div class="side">' + esc(g.opponent) + "</div></div>" +
				'<p class="game-meta">' + esc(fmtDate(g.when, true)) + " &middot; " + esc(g.rink) + "</p>" +
				'<div class="countdown" id="countdown"></div>';
			tick(g.when);
			setInterval(function () { tick(g.when); }, 1000);

			// A list, not a table: day and time stack in a narrow column, so every game fits
			// a phone screen instead of pushing the opponent off the right-hand edge.
			var rest = ahead.slice(1, 1 + UPCOMING_SHOWN);
			list.innerHTML = rest.length
				? '<ul class="fixtures">' + rest.map(function (x) {
					return "<li>" +
						'<div class="when"><span class="day">' + esc(fmtDay(x.when)) + "</span>" +
						'<span class="time">' + esc(fmtTime(x.when)) + "</span></div>" +
						'<div class="what"><span class="opp"><span class="ha">' + (x.home ? "vs" : "at") + "</span> " +
						esc(x.opponent) + "</span>" +
						'<span class="where">' + esc(x.rink) + "</span></div></li>";
				}).join("") + "</ul>"
				: '<p class="loading">No other games posted yet &mdash; they appear here as soon as the rink posts them.</p>';
		}).catch(function () {
			next.innerHTML = '<p class="loading">Could not reach the rink&rsquo;s schedule just now. ' +
				'The <a href="live.html">GameSheet</a> page has the full schedule.</p>';
			list.innerHTML = "";
		});
	};

	/*
	 * GameSheet's own pages, framed. A cross-origin frame cannot report whether it
	 * rendered: if GameSheet's security check fires, that page refuses to load inside
	 * another site and the panel stays blank, which is why the Open on GameSheet link
	 * is always visible rather than shown only on failure.
	 */
	pages.live = function () {
		var views = [
			{ key: "schedule", label: "Schedule", url: gsTeam + "/schedule" },
			{ key: "standings", label: "Standings", url: gsTeam + "/standings" },
			{ key: "roster", label: "Roster", url: gsTeam + "/roster" },
			{ key: "overview", label: "Overview", url: gsTeam },
			// GameSheet has no per-team stats address (it 404s), so these open the league pages
			// pre-filtered to our division. The filter can still be changed inside the frame.
			{ key: "scoring", label: "League scoring", url: gsSeason + "/players" + gsDivision, note: GAMESHEET.divisionName },
			{ key: "goalies", label: "League goalies", url: gsSeason + "/goalies" + gsDivision, note: GAMESHEET.divisionName }
		];

		var frame = document.createElement("iframe");
		frame.referrerPolicy = "strict-origin-when-cross-origin";
		$("#live-frame").appendChild(frame);

		function show(key) {
			var v = views.find(function (x) { return x.key === key; }) || views[0];
			frame.src = v.url;
			frame.title = "GameSheet: " + v.label;
			$("#live-open").href = v.url;
			$("#live-caption").textContent = "Live from GameSheet · " + v.label + (v.note ? " · " + v.note : "");
			$$("#live-tabs .chip").forEach(function (b) {
				var on = b.dataset.view === v.key;
				b.classList.toggle("on", on);
				b.setAttribute("aria-pressed", String(on));
			});
			// Keep the choice in the address so a view can be linked to directly.
			if (location.hash !== "#" + v.key) { history.replaceState(null, "", "#" + v.key); }
		}

		$("#live-tabs").innerHTML = views.map(function (v) {
			return '<button type="button" class="chip" data-view="' + v.key + '" aria-pressed="false">' + esc(v.label) + "</button>";
		}).join("");
		$$("#live-tabs .chip").forEach(function (b) {
			b.addEventListener("click", function () { show(b.dataset.view); });
		});

		// Back/forward and edited links change only the hash, which does not reload the
		// page. show() itself uses replaceState, which does not fire hashchange, so no loop.
		window.addEventListener("hashchange", function () { show(location.hash.slice(1)); });
		show(location.hash.slice(1));
	};

	/* ---------- boot ---------- */

	/* "/", "/index.html", "index.html" and an address typed without ".html" all name the
	   same page, so the right tab lights up however the address was written. */
	function pageName(path) {
		return (path.split("/").pop() || "index").toLowerCase().replace(/\.html$/, "") || "index";
	}

	var here = pageName(location.pathname);
	$$(".nav-links a").forEach(function (a) {
		if (pageName(a.getAttribute("href")) === here) {
			a.classList.add("active");
			a.setAttribute("aria-current", "page");
		}
	});

	$$("[data-gs-team]").forEach(function (a) { a.href = gsTeam + "/schedule"; });

	var page = document.body.dataset.page;
	if (pages[page]) { pages[page](); }
})();
