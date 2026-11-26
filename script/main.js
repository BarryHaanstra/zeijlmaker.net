/*
 * Avondrood: the tangram boat riding the swell at dusk, the low sun right
 * behind its sails.
 *
 * Everything is drawn with Canvas 2D on one canvas: no libraries, no
 * network requests. The sea is a stack of flat wave layers, like cut paper,
 * each sliding at its own speed. The boat sits on one of those layers and
 * takes its height and tilt from that layer's surface, so it really rides
 * the waves; the layer is drawn over it, hiding the hull below the waterline.
 */
(function () {
	'use strict';

	// Boat outline (viewBox 0 0 778 911)
	var BOAT = new Path2D('M377.113 188.562V0L565.673 188.562H377.113L777.099 588.556L455.208 910.441H266.661L78.1067 721.888H377.113V681.891H0L377.113 304.78V188.562Z');
	var BOAT_H = 911;
	var PIVOT_X = 410;    // the point the boat rocks around, in boat units:
	var WATERLINE = 840;  // roughly the middle of the hull, at the waterline
	var BOAT_COLOR = '#1a171b';
	var MAX_DPR = 2;

	var SKY = [[0, '#141833'], [0.35, '#3b2f55'], [0.72, '#a65a6a'], [0.9, '#e88f6c'], [1, '#f6b67e']];
	var SUN = '#ffd9a0';
	var CLOUD = 'rgba(110,58,92,0.55)';

	// Sea layers, back to front. at: top edge, 0 = horizon, 1 = bottom of the
	// screen. amp and len: wave height and length, in thousandths of the
	// screen height. period: seconds per wavelength. glitter: colour of the
	// sun's reflection on this layer (none on the nearest).
	var LAYERS = [
		{ at: 0,     amp: 3,  len: 400,  period: 4,   color: '#b0656a', glitter: '#ffd9a0' },
		{ at: 0.1,   amp: 6,  len: 520,  period: 6,   color: '#8a4f63', glitter: '#ffcf94' },
		{ at: 0.25,  amp: 10, len: 700,  period: 8,   color: '#68405b', glitter: '#f4b884' },
		{ at: 0.4,   amp: 14, len: 900,  period: 10,  color: '#4a3352', glitter: '#e9a67a' },
		{ at: 0.625, amp: 20, len: 1100, period: 13,  color: '#332844', glitter: '#d89272' },
		{ at: 0.825, amp: 24, len: 1300, period: 16,  color: '#221d36', glitter: null }
	];
	var BOAT_LAYER = 3; // the boat is drawn just before this layer

	var canvas, ctx, width, height, dpr, overscan;
	var L = {}; // layout, see layout()
	var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
	var t0 = 0;

	function seeded(seed) {
		return function () {
			seed = (seed * 16807) % 2147483647;
			return (seed - 1) / 2147483646;
		};
	}

	// Fixed details (same on every visit): wave phases, stars, clouds
	var R = seeded(19);
	LAYERS.forEach(function (layer) {
		layer.ph = R() * Math.PI * 2;
		layer.ph2 = R() * Math.PI * 2;
	});

	var STARS = [];
	for (var si = 0; si < 80; si++) {
		var sy = R() * R(); // more near the top
		STARS.push({ x: R(), y: sy, r: 0.5 + R() * 1.1, a: 0.2 + 0.6 * (1 - sy) * R(), tw: R() < 0.4 ? 0.8 + R() * 2 : 0, ph: R() * 6.3 });
	}

	// Thin cloud bars across the sun: x0..x1 and y in sun radii from its
	// centre, thickness in sun radii, drift in sun radii per second
	var CLOUDS = [
		{ x0: -1.48, x1: 0.65, y: -0.52, th: 0.07, v: 0.012 },
		{ x0: 0.17, x1: 1.87, y: -0.74, th: 0.043, v: 0.018 },
		{ x0: -2.43, x1: -0.96, y: -0.26, th: 0.035, v: 0.009 }
	];

	// ---------- The sea ----------

	// Height of a layer's surface at screen x, time t
	function surface(layer, x, t) {
		var th = Math.PI * 2 * ((x - L.cx) / layer.lenPx - t / layer.period) + layer.ph;
		var chop = Math.PI * 2 * ((x - L.cx) / (layer.lenPx * 0.43) + t / (layer.period * 0.7)) + layer.ph2;
		return layer.y + layer.ampPx * (0.75 * Math.sin(th) + 0.25 * Math.sin(2 * th + layer.ph2) + 0.12 * Math.sin(chop));
	}

	function fillLayer(layer, t) {
		var step = 6;
		ctx.beginPath();
		ctx.moveTo(0, surface(layer, 0, t));
		for (var x = step; x < width + step; x += step) ctx.lineTo(Math.min(x, width), surface(layer, Math.min(x, width), t));
		ctx.lineTo(width, height);
		ctx.lineTo(0, height);
		ctx.closePath();
		ctx.fillStyle = layer.color;
		ctx.fill();
	}

	// The sun's reflection on a layer: a soft bright edge along the wave top,
	// and flecks of light in the band below it that come and go
	function newFleck(f) {
		f.u = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; // -1..1, mostly near the middle
		f.v = 0.1 + Math.random() * 0.75;
		f.l = 0.5 + Math.random();
		return f;
	}

	LAYERS.forEach(function (layer, j) {
		layer.flecks = [];
		if (!layer.glitter) return;
		for (var k = 0; k < 12 + j * 2; k++) {
			var f = newFleck({});
			f.speed = 1 / (1.2 + Math.random() * 2.4); // cycles per second
			f.off = Math.random();
			f.cycle = -1;
			layer.flecks.push(f);
		}
	});

	function drawGlitter(layer, j, t, still) {
		if (!layer.glitter) return;
		var hw = L.sunR * (0.55 + 0.35 * j); // half width of the light path
		var x0 = L.sunX - hw, x1 = L.sunX + hw;

		// Bright edge
		var g = ctx.createLinearGradient(x0, 0, x1, 0);
		g.addColorStop(0, 'rgba(255,217,160,0)');
		g.addColorStop(0.5, 'rgba(255,217,160,' + (0.45 - j * 0.07) + ')');
		g.addColorStop(1, 'rgba(255,217,160,0)');
		ctx.beginPath();
		for (var x = x0; x <= x1; x += 6) {
			var y = surface(layer, x, t);
			if (x === x0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
		}
		ctx.strokeStyle = g;
		ctx.lineWidth = L.u * (1.5 + j);
		ctx.lineCap = 'round';
		ctx.stroke();

		// Flecks
		var next = LAYERS[j + 1];
		var gap = (next ? next.y : L.bottom) - layer.y;
		var depth = j / (LAYERS.length - 1);
		ctx.fillStyle = layer.glitter;
		for (var k = 0; k < layer.flecks.length; k++) {
			var f = layer.flecks[k];
			var p = still ? f.off : t * f.speed + f.off;
			var cycle = Math.floor(p);
			if (!still && cycle !== f.cycle) {
				if (f.cycle !== -1) newFleck(f);
				f.cycle = cycle;
			}
			var a = Math.sin((p - cycle) * Math.PI) * (0.95 - 0.12 * j) * (1 - Math.abs(f.u));
			if (a <= 0.02) continue;
			var fx = L.sunX + f.u * hw;
			var len = L.u * (8 + 16 * depth) * f.l * 1.5;
			var fh = L.u * (2 + 2 * depth);
			var fy = surface(layer, fx, t) + f.v * gap * 0.85;
			ctx.globalAlpha = a;
			ctx.fillRect(fx - len / 2, fy, len, fh);
		}
		ctx.globalAlpha = 1;
	}

	// ---------- The boat ----------

	// Height and tilt come from the boat's layer, sampled under bow and stern
	function drawBoat(t) {
		var layer = LAYERS[BOAT_LAYER];
		var dx = L.boatS * 0.25;
		var yl = surface(layer, L.cx - dx, t), yr = surface(layer, L.cx + dx, t);
		var angle = Math.atan2(yr - yl, 2 * dx) * 0.9;
		ctx.save();
		ctx.translate(L.cx, (yl + yr) / 2);
		ctx.rotate(angle);
		ctx.scale(L.boatS / BOAT_H, L.boatS / BOAT_H);
		ctx.translate(-PIVOT_X, -WATERLINE);
		ctx.fillStyle = BOAT_COLOR;
		ctx.fill(BOAT);
		ctx.restore();
	}

	// ---------- The sky ----------

	var skyCanvas = document.createElement('canvas');
	var skyCtx = skyCanvas.getContext('2d');

	// Sky gradient, halo and sun: they don't move, so drawn once per resize
	function buildSky() {
		skyCanvas.width = canvas.width;
		skyCanvas.height = canvas.height;
		var c = skyCtx;
		c.setTransform(dpr, 0, 0, dpr, 0, 0);

		var sky = c.createLinearGradient(0, overscan, 0, L.horizon);
		SKY.forEach(function (s) { sky.addColorStop(s[0], s[1]); });
		c.fillStyle = sky;
		c.fillRect(0, 0, width, L.horizon + 2);

		var halo = c.createRadialGradient(L.sunX, L.sunY, 0, L.sunX, L.sunY, L.sunR * 2.7);
		halo.addColorStop(0, 'rgba(255,217,160,0.55)');
		halo.addColorStop(1, 'rgba(255,217,160,0)');
		c.fillStyle = halo;
		c.fillRect(0, 0, width, L.horizon + 2);

		c.beginPath();
		c.arc(L.sunX, L.sunY, L.sunR, 0, Math.PI * 2);
		c.fillStyle = SUN;
		c.fill();
	}

	function drawStars(t, still) {
		var count = Math.min(STARS.length, Math.round(width * L.visibleH / 20000));
		var band = L.visibleH * 0.32;
		ctx.fillStyle = '#fff1e0';
		for (var i = 0; i < count; i++) {
			var s = STARS[i];
			var a = s.a;
			if (s.tw && !still) a *= 0.6 + 0.4 * Math.sin(t * s.tw + s.ph);
			ctx.globalAlpha = a;
			ctx.beginPath();
			ctx.arc(s.x * width, overscan * 0.3 + s.y * (band + overscan * 0.7), s.r, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.globalAlpha = 1;
	}

	function drawClouds(t) {
		var r = L.sunR;
		ctx.strokeStyle = CLOUD;
		ctx.lineCap = 'round';
		CLOUDS.forEach(function (c) {
			var len = (c.x1 - c.x0) * r;
			var span = width + len + 2 * r;
			// Drift right, wrapping around once fully off screen
			var x = L.sunX + c.x0 * r + t * c.v * r + len + r;
			x = ((x % span) + span) % span - len - r;
			ctx.lineWidth = c.th * r;
			ctx.beginPath();
			ctx.moveTo(x, L.sunY + c.y * r);
			ctx.lineTo(x + len, L.sunY + c.y * r);
			ctx.stroke();
		});
	}

	// ---------- Scene ----------

	// Where everything goes, from the visible area (inside the overscan)
	function layout() {
		var visibleH = height - 2 * overscan;
		var u = visibleH / 1000;
		var bottom = overscan + visibleH;
		var horizon = overscan + visibleH * 0.6;
		// Boat height: half the screen, narrower on portrait phones
		var boatS = Math.min(visibleH * 0.5, width * 0.62 * BOAT_H / 778);
		L = {
			visibleH: visibleH, u: u, bottom: bottom, horizon: horizon,
			cx: width / 2, boatS: boatS,
			sunR: boatS * 0.44, sunX: width / 2 + boatS * 0.11, sunY: horizon - u * 10
		};
		LAYERS.forEach(function (layer) {
			layer.y = horizon + (bottom - horizon) * layer.at;
			layer.ampPx = layer.amp * u;
			layer.lenPx = layer.len * u;
		});
	}

	function draw(t) {
		var still = reduceMotion.matches;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.globalAlpha = 1;

		ctx.drawImage(skyCanvas, 0, 0, width, height);
		drawStars(t, still);
		drawClouds(t);

		for (var j = 0; j < LAYERS.length; j++) {
			if (j === BOAT_LAYER) drawBoat(t);
			fillLayer(LAYERS[j], t);
			drawGlitter(LAYERS[j], j, t, still);
		}
	}

	// ---------- Setup ----------

	function resize() {
		dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
		overscan = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--overscan')) || 0;
		// Use the canvas's CSS size: on iOS that is the large viewport (under
		// the browser bars), while innerHeight stops short of them
		width = canvas.clientWidth;
		height = canvas.clientHeight;
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
		layout();
		buildSky();
	}

	function now() {
		return reduceMotion.matches ? 0 : (performance.now() - t0) / 1000;
	}

	function frame() {
		draw(now());
		if (!reduceMotion.matches) requestAnimationFrame(frame);
	}

	function init() {
		canvas = document.getElementById('scene');
		ctx = canvas.getContext('2d');

		resize();
		t0 = performance.now();
		draw(0);
		requestAnimationFrame(frame);

		// Scroll past the top overscan, so iOS Safari draws the page under its
		// bars (see --overscan in style.css). Users can't scroll the page.
		history.scrollRestoration = 'manual';
		function scrollPastOverscan() {
			window.scrollTo(0, overscan);
		}
		scrollPastOverscan();
		window.addEventListener('load', scrollPastOverscan);

		// Redraw whenever the canvas changes size (window resize, rotation).
		// Resizing clears the canvas, so always redraw.
		new ResizeObserver(function () {
			resize();
			draw(now());
			scrollPastOverscan();
		}).observe(canvas);

		// Restart the loop if the user turns reduced motion off
		reduceMotion.addEventListener('change', function () {
			if (!reduceMotion.matches) requestAnimationFrame(frame);
			else draw(0);
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
