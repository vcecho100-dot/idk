# 🧊 Model AI

Paste in a picture, get a 3D model. A tiny test app: no installs, no accounts.

It cuts the object out of its background, turns it into a 3D shape in the picture's colors, and **guesses the hidden back side** by mirroring the front.

> **Test version:** there's no real AI yet, so the back side is a simple guess (a mirror of the front). It works best with one object on a plain background: logos, drawings, stickers, emoji.

## How to use
1. **Paste an image** with **Ctrl+V**, drag one onto the window, or click **Choose image…** (or try one of the samples).
2. Pick a style:
   - 🎈 **Puffy**: rounded like a balloon or plushie
   - 🍪 **Flat cutout**: like a cookie or sticker
   - ⛰️ **Relief**: brighter parts stick out more
3. Adjust **Thickness**. If the background isn't removed right, move the slider under **Remove background**.
4. Drag to spin it, scroll to zoom.
5. Click **💾 Save .obj** to download the model (with colors). Open it in Blender, Windows 3D Viewer, Godot, etc.

## ⬇ Download (Windows app)

**[Download ModelAI.exe](https://github.com/vcecho100-dot/idk/releases/latest/download/ModelAI.exe)**, then double-click it to run. No install needed.

If Windows says "Windows protected your PC", click **More info → Run anyway** (the app isn't code-signed).

Prefer the browser version? **[Download the .zip](https://github.com/vcecho100-dot/idk/archive/refs/heads/main.zip)**, unzip it, and open `index.html` (needs internet the first time to load the 3D engine).

## 📲 Install as an app
Open **https://vcecho100-dot.github.io/idk/** in Chrome or Edge and click **⬇ Install app** (or the install icon in the address bar). On a phone, use **Add to Home screen**.
