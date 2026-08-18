window.__ModuleLoader__.load({
	id: "dsh-screenshot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region styles
		const CSS = [
			".dsh-screenshot-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s ease,color .15s ease}",
			".dsh-screenshot-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-screenshot-btn:disabled{opacity:.4;cursor:default}",
			".dsh-screenshot-btn svg{width:16px;height:16px}",
			".dsh-screenshot-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.5);cursor:crosshair}",
			".dsh-screenshot-frame{position:fixed;pointer-events:none;z-index:99998;max-width:none}",
			".dsh-screenshot-rect{position:fixed;border:2px solid #fff;box-shadow:0 0 0 9999px rgba(0,0,0,0.5);pointer-events:none}",
			".dsh-screenshot-hint{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:16px;font-family:inherit;pointer-events:none;text-align:center;white-space:nowrap}",
			".dsh-screenshot-loading{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:14px;font-family:inherit;pointer-events:none;background:rgba(0,0,0,0.6);padding:12px 24px;border-radius:8px;z-index:99999}"
		].join("\n");
		const TAG_ID = "dsh-screenshot/styles.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", TAG_ID);
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region locale
		const NS = "screenshot";
		const zh = {
			button: "截图",
			hint: "拖拽选择截图区域 · ESC 取消",
			loading: "正在截图…",
			error: "截图失败，请重试",
			unsupported: "当前浏览器不支持屏幕截图",
			shareHint: "点击后请在浏览器窗口中选择要共享的屏幕区域"
		};
		const en = {
			button: "Screenshot",
			hint: "Drag to select area · ESC to cancel",
			loading: "Capturing…",
			error: "Screenshot failed, please retry",
			unsupported: "Screen capture not supported in this browser",
			shareHint: "Choose what to share in the browser dialog"
		};
		//#endregion

		//#region Browser-side rectangle selection on a static frame
		/**
		 * Show a full-screen overlay with the captured screenshot and let the
		 * user drag a rectangle to crop.  Returns a File (PNG) or null when
		 * cancelled.  Coordinates are mapped from viewport space to the
		 * image's natural pixel space so multi-monitor captures (where the
		 * image is wider/taller than the viewport) crop correctly.
		 */
		function selectRegion(imageUrl) {
			return new Promise((resolve, reject) => {
				let overlay = null, frame = null, rect = null, hint = null;
				let startX = 0, startY = 0, currentX = 0, currentY = 0, dragging = false;

				function cleanup() {
					[overlay, frame, rect, hint].forEach((el) => el && el.remove());
					document.removeEventListener("keydown", onKeyDown);
					document.removeEventListener("mouseup", onUp);
					document.removeEventListener("mousemove", onMove);
				}

				function onKeyDown(e) {
					if (e.key === "Escape") { cleanup(); resolve(null); }
				}

				function showHint(text) {
					if (hint) hint.remove();
					hint = document.createElement("div");
					hint.className = "dsh-screenshot-hint";
					hint.textContent = text;
					document.body.appendChild(hint);
				}

				function onDown(e) {
					if (!overlay) return;
					dragging = true;
					startX = e.clientX; startY = e.clientY;
					currentX = startX; currentY = startY;
					if (!rect) {
						rect = document.createElement("div");
						rect.className = "dsh-screenshot-rect";
						document.body.appendChild(rect);
					}
					updateRect();
				}

				function onMove(e) {
					if (!dragging) return;
					currentX = e.clientX; currentY = e.clientY;
					updateRect();
				}

				function onUp(e) {
					if (!dragging) return;
					dragging = false;
					const x1 = Math.min(startX, currentX), y1 = Math.min(startY, currentY);
					const x2 = Math.max(startX, currentX), y2 = Math.max(startY, currentY);
					const w = x2 - x1, h = y2 - y1;
					if (w < 10 || h < 10) { cleanup(); resolve(null); return; }

					frame.complete ? crop() : (frame.onload = crop);
				}

				function crop() {
					// Map viewport coordinates → image natural coordinates.
					// The frame is displayed at viewport size via object-fit:fill,
					// so the scale factor is naturalSize / viewportSize.
					const vw = window.innerWidth || document.documentElement.clientWidth;
					const vh = window.innerHeight || document.documentElement.clientHeight;
					const sx = frame.naturalWidth / vw;
					const sy = frame.naturalHeight / vh;
					const ix1 = x1 * sx, iy1 = y1 * sy;
					const iw = w * sx, ih = h * sy;
					// Guard against sub-pixel crops rounding to zero.
					const cw = Math.max(1, Math.round(iw));
					const ch = Math.max(1, Math.round(ih));

					const canvas = document.createElement("canvas");
					canvas.width = cw; canvas.height = ch;
					const ctx = canvas.getContext("2d");
					ctx.drawImage(frame, ix1, iy1, iw, ih, 0, 0, cw, ch);
					canvas.toBlob((blob) => {
						if (!blob) { cleanup(); reject(new Error("canvas toBlob failed")); return; }
						cleanup();
						resolve(new File([blob], "screenshot.png", { type: "image/png" }));
					}, "image/png");
				}

				function updateRect() {
					if (!rect) return;
					const x1 = Math.min(startX, currentX), y1 = Math.min(startY, currentY);
					const x2 = Math.max(startX, currentX), y2 = Math.max(startY, currentY);
					rect.style.left = x1 + "px";
					rect.style.top = y1 + "px";
					rect.style.width = (x2 - x1) + "px";
					rect.style.height = (y2 - y1) + "px";
				}

				frame = document.createElement("img");
				frame.src = imageUrl;
				frame.className = "dsh-screenshot-frame";
				frame.style.cssText = "position:fixed;left:0;top:0;width:100%;height:100%;object-fit:fill;z-index:99998;pointer-events:none";
				document.body.appendChild(frame);

				overlay = document.createElement("div");
				overlay.className = "dsh-screenshot-overlay";
				document.body.appendChild(overlay);

				showHint("拖拽选择截图区域 · ESC 取消");
				overlay.addEventListener("mousedown", onDown);
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
				document.addEventListener("keydown", onKeyDown);
			});
		}
		//#endregion

		//#region Screen capture via Node.js backend (no browser APIs)
		/**
		 * Ask the host (Node.js) to capture the screen(s) via screenshot.ps1
		 * and return the PNG as a data URL.  This replaces the former
		 * navigator.mediaDevices.getDisplayMedia approach — no browser
		 * dialog, no user screen-sharing permission, works behind the
		 * Electron/CEF shell where getDisplayMedia is unavailable.
		 */
		function captureScreenRegion() {
			return new Promise((resolve, reject) => {
				let loading = document.createElement("div");
				loading.className = "dsh-screenshot-loading";
				loading.textContent = "正在截图…";
				document.body.appendChild(loading);

				fetch("/dsh-screenshot/capture", { cache: "no-store" })
					.then(async (res) => {
						if (!res.ok) {
							const data = await res.json().catch(() => ({}));
							throw new Error(data.error || "HTTP " + res.status);
						}
						return res.json();
					})
					.then(async (data) => {
						if (!data || !data.image) {
							throw new Error("no image data in capture response");
						}
						const file = await selectRegion(data.image);
						resolve(file);
					})
					.catch((err) => {
						console.error("[dsh-screenshot] capture failed:", err);
						reject(err);
					})
					.finally(() => {
						loading.remove();
					});
			});
		}
		//#endregion

		//#region ScreenshotButton
		function ScreenshotButton({ t }) {
			const [busy, setBusy] = react.useState(false);

			const onClick = async () => {
				if (busy) return;
				setBusy(true);
				try {
					const file = await captureScreenRegion();
					if (file) {
						const event = new CustomEvent("dsh-screenshot-captured", {
							detail: { file }, bubbles: true
						});
						document.dispatchEvent(event);
					}
				} catch (err) {
					console.error("[dsh-screenshot] capture failed:", err);
				} finally {
					setBusy(false);
				}
			};

			return react.createElement("button", {
				className: "dsh-screenshot-btn",
				onClick: onClick, disabled: busy,
				title: t("button"), "aria-label": t("button")
			}, react.createElement("svg", {
				viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": true
			}, react.createElement("path", {
				d: "M1 1h12v10H1V1zm1 1v8h10V2H2zm2 9h8v2H3v-2z",
				fill: "currentColor"
			})));
		}
		//#endregion

		//#region apply
		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-screenshot: dictionaries");

			document.addEventListener("dsh-screenshot-captured", async (e) => {
				const file = e.detail?.file;
				if (!file) return;
				try {
					const conversation = ctx.get("conversation");
					if (!conversation) { console.error("[dsh-screenshot] conversation service not available"); return; }
					const sessions = ctx.sessions;
					const currentSession = sessions?.current;
					const sessionId = currentSession?.id;
					if (!sessionId) { console.error("[dsh-screenshot] no active session"); return; }
					const shell = conversation.input?.shell?.(sessionId);
					if (!shell) { console.error("[dsh-screenshot] shell not available"); return; }
					const images = await conversation.createDraftImages([file]);
					if (images && images.length > 0) shell.addImages(images.map((img) => img.id));
				} catch (err) {
					console.error("[dsh-screenshot] failed to add image to draft:", err);
				}
			});

			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "screenshot",
				order: 10,
				locale: NS
			}, ScreenshotButton));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});