---
name: dsh-computer-use
description: Computer-use workflow with dsh-screenshot. Use when the user asks to capture the screen, interact with the desktop (click, type, scroll), open URLs, or read image files. Instructs the model to use dsh-screenshot tools (screenshot, read_image_and_show, mouse_click, etc.) instead of directly invoking PowerShell scripts.
---

# Computer Use with dsh-screenshot

This skill governs how to use the `dsh-screenshot` plugin tools for desktop capture and interaction. Always prefer the plugin's model-facing tools over raw PowerShell execution.

## Tools available

| Tool | Purpose |
| --- | --- |
| `screenshot` | Capture the full screen as an image. Returns the image so you can see the current state. |
| `read_image_and_show` | Read a PNG/JPEG/WebP/GIF file, return the image to you, AND show a clickable thumbnail with zoomable lightbox in the conversation. Use this instead of `read_image` when you want the user to see the image visually. |
| `mouse_click` | Click at screen coordinates (x, y). |
| `mouse_move` | Move the mouse cursor to (x, y) without clicking. |
| `type_text` | Type text at the current cursor position. |
| `key_press` | Press a key or key combination. |
| `scroll` | Scroll the mouse wheel. |
| `open_url` | Open a URL in the default browser. |

## Mandatory rules

1. **Never invoke `screenshot.ps1` directly.** Do not use the `pwsh` tool to run `screenshot.ps1` or any other script in the `dsh-screenshot` plugin directory. The `screenshot` tool already handles capture, DPI awareness, and image delivery — calling the script yourself bypasses the plugin's attachment pipeline and produces no thumbnail in the conversation.

2. **Use `read_image_and_show` instead of `read_image`.** When you need to read an image file and want the user to see it, call `read_image_and_show`. The core `read_image` tool returns the image to you but does **not** render a thumbnail in the conversation UI — the image is injected as an opaque context block that the UI displays as JSON, not as a clickable image. `read_image_and_show` produces the same model-facing output but injects the image as a user-sourced message, which the UI renders as a thumbnail with click-to-zoom lightbox.

3. **Workflow order.** Take a screenshot first → analyze what you see → decide the next action → execute it → take another screenshot to verify. Screen coordinates are 0-based from the top-left corner of the primary display.

## Image display

When you call `screenshot` or `read_image_and_show`, the image automatically appears as a thumbnail in the conversation. The user can click it to open a full-screen lightbox with zoom. You also receive the image natively in your context so you can analyze it.

## Coordinate system

- Coordinates are 0-based from the top-left of the primary display.
- On high-DPI displays (e.g. 200% scaling), the logical resolution differs from physical pixels. The `screenshot` tool captures at full physical resolution (e.g. 2880×1800 on a 1440×900 logical display). Coordinates you receive from the image are in physical pixels — use them directly with `mouse_click` and `mouse_move`.