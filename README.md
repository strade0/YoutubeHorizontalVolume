# YouTube Viewport Volume Drag 🎵

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-Chromium%20(Chrome%20%7C%20Edge%20%7C%20Brave)-green.svg)]()
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-brightgreen.svg)]()

> A sleek, high-performance Chrome Extension (Manifest V3) that lets you adjust YouTube video volume by dragging your mouse horizontally across the video viewport with smooth low-sensitivity controls and a modern frosted-glass visualizer HUD.

---

## ✨ Features

- 🎚️ **Smooth Low-Sensitivity Scrubbing**:
  - Dragging across ~60% of the video player smoothly adjusts volume from 0% (Mute) to 100% (Max).
  - Fully adjustable sensitivity (30% to 100% of viewport width) in the extension popup.
- 🎨 **Modern Frosted-Glass Visualizer HUD**:
  - Centered directly **20px above your cursor** with real-time tracking and smart edge clamping.
  - Animated audio equalizer waveform bars that dynamically scale with volume.
  - Minimal progress track with glowing fill and exact percentage badge (`0%`–`100%` or `Muted`).
  - Dynamic speaker icon that transitions across Muted, Low, Medium, and High audio states.
- ⚡ **Zero Initial Volume Blast (`run_at: "document_start"`)**:
  - Pre-playback volume injection ensures newly loaded videos start directly at your saved volume with zero startup bursts.
- 🔒 **Tab-Isolated Volume Memory**:
  - Cross-tab storage broadcast interception guarantees that adjusting volume on one tab never interferes with other open YouTube tabs.
- ⏩ **Native Fast-Forward Compatibility**:
  - Holding down to fast-forward (2x speed hold for $\ge 400\text{ms}$) automatically locks out the volume slider, allowing you to fast-forward uninterrupted for as long as you want.
  - Quick clicks and slides immediately engage smooth volume scrubbing.
- 🔄 **Full Native Volume Slider Parity**:
  - Seamlessly adjust volume by dragging across the viewport **or** by clicking and dragging YouTube's native bottom-bar volume slider.
  - Volume persists across page reloads (`F5`) and video navigations.
- 🔇 **Instant Tab Switch Cleanup**:
  - Switching away from a tab or blurring the window instantly closes and releases all slider states.

---

## 📂 Repository Structure

```
YoutubeViewport/
├── manifest.json            # Manifest V3 specification
├── LICENSE                  # MIT License
├── README.md                # Documentation & install guide
├── .gitignore               # Standard ignore rules
├── content/
│   ├── main_bridge.js       # Main-world bridge (world: "MAIN", 100% CSP compliant)
│   ├── visualizer.js        # Modern HUD & dynamic waveform visualizer component
│   ├── content.js           # Core drag engine, audio controller & event coordinator
│   └── styles.css           # Glassmorphism, smooth animations, and HUD styling
├── popup/
│   ├── popup.html           # Settings UI (Drag triggers, sensitivity, themes)
│   ├── popup.css            # Dark glassmorphic popup styling
│   └── popup.js             # Chrome storage sync logic
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## 🚀 Installation Guide

1. Clone or download this repository:
   ```bash
   git clone https://github.com/your-username/youtube-viewport-volume-drag.git
   ```
2. Open **Google Chrome** (or any Chromium browser like Brave, Edge, Opera).
3. Navigate to `chrome://extensions/` in your address bar.
4. Enable the **Developer mode** toggle in the top-right corner.
5. Click the **Load unpacked** button in the top-left corner.
6. Select the `YoutubeViewport` folder.
7. Open any video on [YouTube](https://www.youtube.com) and start dragging to adjust your audio!

---

## ⚙️ Configuration Options

Click the extension icon in your browser toolbar to open the settings popup:

| Setting | Description | Default |
| :--- | :--- | :--- |
| **Master Toggle** | Enable or disable the extension. | `ON` |
| **Sensitivity** | Drag distance required for 0%–100% volume (30% to 100% of player width). | `60%` |
| **Drag Trigger** | Choose between Smart Left-Click, Right-Click, Shift+Left, or Alt+Left drag. | `Smart Left-Click` |
| **HUD Style** | Choose between **Waveform Equalizer + Slider** or **Minimal Pill Slider**. | `Waveform` |

---

## 🛡️ Privacy & Permissions

This extension is 100% client-side, open source, and privacy-respecting:
- **No data collection**: Zero telemetry, zero tracking, zero external network requests.
- **Minimal permissions**: Requires only `storage` (to save your preferences locally) and host permissions for `*://*.youtube.com/*`.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
