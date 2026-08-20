/**
 * YouTube Viewport Volume Drag - Content Script
 * Robust persistent volume memory, zero startup burst, full native slider support,
 * keyboard shortcuts synchronization, race-free HUD lifecycle, and reliable reload persistence.
 */

(function () {
  'use strict';

  // 1. Block cross-tab storage broadcast so other open tabs stay independent
  window.addEventListener('storage', (e) => {
    if (e.key && (e.key.includes('volume') || e.key.includes('muted') || e.key === 'yt-player-volume')) {
      e.stopImmediatePropagation();
    }
  }, true);

  // Configuration defaults
  const config = {
    enabled: true,
    dragTrigger: 'left', // 'left', 'right', 'shift-left', 'alt-left'
    sensitivity: 60,     // 60% of player width for 0% to 100% volume
    hudStyle: 'wave'     // 'wave' or 'minimal'
  };

  // State
  let hud = null;
  let activePlayer = null;
  let activeVideo = null;
  let isPointerDown = false;
  let isDragging = false;
  let fastForwardLocked = false;
  let isUserInteractingWithNativeSlider = false;
  let isInternalVolumeChange = false;
  let lastUserVolumeInteractionTime = 0;

  let mouseDownTime = 0;
  let startX = 0;
  let startY = 0;
  let initialVolume = 1.0;
  let savedPlaybackRate = 1.0;
  let cachedPlayerRect = null;
  let cachedSpanWidth = 600;

  // Persistent desired volume state
  let tabDesiredVolume = null;
  let tabDesiredMuted = false;

  // Animation frame state
  let rAFScheduled = false;
  let pendingVolume = 1.0;
  let pendingCursorX = 0;
  let pendingCursorY = 0;

  // Click & Context Menu suppression
  let suppressNextClick = false;
  let suppressNextContextMenu = false;
  const DRAG_THRESHOLD_PX = 6;
  const FAST_FORWARD_THRESHOLD_MS = 400;

  // Helper to identify YouTube thumbnail hover preview players vs main player
  function isInlinePreview(el) {
    if (!el) return false;
    try {
      if (el.closest) {
        if (el.closest('ytd-inline-preview-renderer, #inline-preview-player, .inline-preview-player, [is-inline-preview]')) {
          return true;
        }
      }
      if (el.id === 'inline-preview-player' || (el.classList && el.classList.contains('inline-preview-player'))) {
        return true;
      }
    } catch (e) {}
    return false;
  }

  // 2. Early load of saved volume from extension persistent storage
  try {
    const extSaved = localStorage.getItem('yt_extension_saved_volume');
    if (extSaved !== null) {
      tabDesiredVolume = parseFloat(extSaved);
      tabDesiredMuted = localStorage.getItem('yt_extension_saved_muted') === 'true';
    } else {
      const savedTabVol = sessionStorage.getItem('yt_tab_volume');
      if (savedTabVol !== null) {
        tabDesiredVolume = parseFloat(savedTabVol);
        tabDesiredMuted = sessionStorage.getItem('yt_tab_muted') === 'true';
      } else {
        const ytStorage = localStorage.getItem('yt-player-volume');
        if (ytStorage) {
          const parsed = JSON.parse(ytStorage);
          const innerData = typeof parsed.data === 'string' ? JSON.parse(parsed.data) : parsed.data;
          if (innerData && typeof innerData.volume === 'number') {
            tabDesiredVolume = innerData.volume / 100;
            tabDesiredMuted = !!innerData.muted;
          }
        }
      }
    }
  } catch (e) {}

  // Persist volume to YouTube's exact localStorage schema & extension storage
  function persistVolume(volumeFraction, isMuted) {
    const clamped = Math.max(0, Math.min(1, volumeFraction));
    const intVol = Math.round(clamped * 100);
    const muted = isMuted || intVol === 0;
    const now = Date.now();
    const oneYear = 365 * 24 * 60 * 60 * 1000;

    tabDesiredVolume = clamped;
    tabDesiredMuted = muted;

    try {
      localStorage.setItem('yt_extension_saved_volume', String(clamped));
      localStorage.setItem('yt_extension_saved_muted', String(muted));
      sessionStorage.setItem('yt_tab_volume', String(clamped));
      sessionStorage.setItem('yt_tab_muted', String(muted));
    } catch (e) {}

    try {
      const payload = {
        data: JSON.stringify({
          volume: intVol,
          muted: muted
        }),
        creation: now,
        expiration: now + oneYear
      };
      localStorage.setItem('yt-player-volume', JSON.stringify(payload));
    } catch (e) {}
  }

  // Sync early storage at document_start
  if (tabDesiredVolume !== null) {
    persistVolume(tabDesiredVolume, tabDesiredMuted);
  }

  // Dispatch sync event to main_bridge.js (running in world: "MAIN", 100% CSP compliant)
  function syncWithMainWorldPlayer(intVol, isMuted) {
    try {
      window.dispatchEvent(new CustomEvent('yt-vol-sync-player', {
        detail: {
          volume: intVol,
          isMuted: isMuted
        }
      }));
    } catch (e) {}
  }

  // Apply early volume to any newly created primary video element before playback begins
  function applyEarlyVolumeToVideo(video) {
    if (!video || tabDesiredVolume === null || isInlinePreview(video)) return;
    try {
      isInternalVolumeChange = true;
      video.volume = tabDesiredVolume;
      video.muted = tabDesiredMuted;
      isInternalVolumeChange = false;
    } catch (e) {}
  }

  // Capture video initialization before first audio frame outputs (excluding thumbnail previews)
  document.addEventListener('play', (e) => {
    if (e.target && e.target.tagName === 'VIDEO' && !isInlinePreview(e.target)) {
      applyEarlyVolumeToVideo(e.target);
    }
  }, true);

  document.addEventListener('loadedmetadata', (e) => {
    if (e.target && e.target.tagName === 'VIDEO' && !isInlinePreview(e.target)) {
      applyEarlyVolumeToVideo(e.target);
    }
  }, true);

  // Load configuration from chrome storage
  function loadConfig() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(config, (items) => {
        if (items) {
          Object.assign(config, items);
          if (hud) {
            hud.setStyle(config.hudStyle);
          }
        }
      });
    }
  }

  // Listen for configuration changes
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') {
        for (const [key, change] of Object.entries(changes)) {
          config[key] = change.newValue;
        }
        if (hud) {
          hud.setStyle(config.hudStyle);
        }
      }
    });
  }

  // Find player and video elements (restricted to primary watch player, shorts, or miniplayer)
  function getPlayerElements() {
    // 1. Check for primary movie_player
    const moviePlayer = document.getElementById('movie_player');
    if (moviePlayer && !isInlinePreview(moviePlayer)) {
      const video = moviePlayer.querySelector('video');
      if (video) return { player: moviePlayer, video };
    }

    // 2. Check for watch flexy / shorts / miniplayer
    const primaryContainer = document.querySelector('ytd-watch-flexy, ytd-watch-grid, #shorts-player, ytd-shorts, ytd-miniplayer');
    if (primaryContainer) {
      const player = primaryContainer.querySelector('.html5-video-player') || primaryContainer;
      const video = primaryContainer.querySelector('video');
      if (player && video && !isInlinePreview(player) && !isInlinePreview(video)) {
        return { player, video };
      }
    }

    // 3. Fallback: only standard video player if NOT inside inline preview
    const player = document.querySelector('.html5-video-player:not(#inline-preview-player)');
    if (player && !isInlinePreview(player)) {
      const video = player.querySelector('video');
      if (video && !isInlinePreview(video)) {
        return { player, video };
      }
    }

    return { player: null, video: null };
  }

  // Ensure HUD and listeners are attached
  function ensureHUD() {
    const { player, video } = getPlayerElements();
    if (!player || !video) {
      if (activeVideo) {
        activeVideo.removeEventListener('ratechange', onRateChange);
        activeVideo.removeEventListener('volumechange', onVideoVolumeChange);
        activeVideo = null;
      }
      activePlayer = null;
      return false;
    }

    if (activeVideo !== video) {
      if (activeVideo) {
        activeVideo.removeEventListener('ratechange', onRateChange);
        activeVideo.removeEventListener('volumechange', onVideoVolumeChange);
      }
      activeVideo = video;
      activeVideo.addEventListener('ratechange', onRateChange, { passive: true });
      activeVideo.addEventListener('volumechange', onVideoVolumeChange, { passive: true });

      // Apply initial volume immediately
      if (tabDesiredVolume !== null) {
        applyHardwareVolume(tabDesiredVolume, tabDesiredMuted);
      } else {
        tabDesiredVolume = activeVideo.muted ? 0 : activeVideo.volume;
        tabDesiredMuted = activeVideo.muted;
      }
    }

    activePlayer = player;

    if (!hud) {
      if (window.VolumeVisualizerHUD) {
        hud = new window.VolumeVisualizerHUD();
        hud.setStyle(config.hudStyle);
        hud.mount(player);
      }
    } else {
      hud.mount(player);
    }

    return true;
  }

  // Handle native volume changes
  function onVideoVolumeChange() {
    if (isInternalVolumeChange || isDragging || !activeVideo) return;

    const isUserInteraction = isUserInteractingWithNativeSlider ||
                             ((performance.now() - lastUserVolumeInteractionTime) < 1500);

    if (isUserInteraction) {
      // User is manually adjusting volume (via slider, arrow keys, or keyboard shortcuts) -> Save new volume!
      persistVolume(activeVideo.volume, activeVideo.muted);
      syncNativeSliderUI(activeVideo.volume, activeVideo.muted);
      syncWithMainWorldPlayer(Math.round(activeVideo.volume * 100), activeVideo.muted);
    } else if (tabDesiredVolume !== null) {
      // YouTube attempted an automatic background reset (e.g. ad transition) -> Re-enforce user volume!
      const diff = Math.abs(activeVideo.volume - tabDesiredVolume);
      if (diff > 0.02 || activeVideo.muted !== tabDesiredMuted) {
        isInternalVolumeChange = true;
        activeVideo.volume = tabDesiredVolume;
        activeVideo.muted = tabDesiredMuted;
        syncNativeSliderUI(tabDesiredVolume, tabDesiredMuted);
        isInternalVolumeChange = false;
      }
    }
  }

  // Abort YouTube's 2x speedmaster hold when volume drag begins
  function cancelYouTubeSpeedmaster() {
    if (activeVideo && savedPlaybackRate) {
      if (activeVideo.playbackRate !== savedPlaybackRate) {
        activeVideo.playbackRate = savedPlaybackRate;
      }
    }
    if (activePlayer) {
      try {
        const cancelEvt = new PointerEvent('pointercancel', {
          bubbles: true,
          cancelable: true,
          pointerType: 'mouse'
        });
        activePlayer.dispatchEvent(cancelEvt);
      } catch (err) {}

      const overlay = activePlayer.querySelector('.ytp-speedmaster-overlay');
      if (overlay) {
        overlay.style.display = 'none';
      }
      activePlayer.classList.remove('ytp-speedmaster-active');
    }
  }

  // Prevent playback rate change during active volume dragging
  function onRateChange() {
    if (isDragging && activeVideo && savedPlaybackRate) {
      if (activeVideo.playbackRate !== savedPlaybackRate) {
        activeVideo.playbackRate = savedPlaybackRate;
        cancelYouTubeSpeedmaster();
      }
    }
  }

  // Check if clicked element is an interactive control
  function isInteractiveElement(target) {
    if (!target) return false;

    const excludedSelectors = [
      '.ytp-chrome-bottom',
      '.ytp-chrome-top',
      '.ytp-popup',
      '.ytp-settings-menu',
      '.ytp-contextmenu',
      '.ytp-caption-window-container',
      '.ytp-cards-teaser',
      '.ytp-ad-overlay-container',
      '.ytp-suggested-action',
      '.ytp-subtitles-player-content',
      '.ytp-live-badge',
      '.ytp-live-sync-button',
      '.ytp-volume-control',
      '.ytp-volume-panel',
      '.ytp-volume-slider',
      '.ytp-mute-button',
      'button',
      'a',
      'input',
      'select',
      'textarea',
      'ytd-menu-renderer'
    ];

    for (const selector of excludedSelectors) {
      if (target.closest && target.closest(selector)) {
        return true;
      }
    }

    return false;
  }

  // Match event against configured trigger
  function matchesTrigger(e) {
    switch (config.dragTrigger) {
      case 'left':
        return e.button === 0 && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
      case 'right':
        return e.button === 2;
      case 'shift-left':
        return e.button === 0 && e.shiftKey;
      case 'alt-left':
        return e.button === 0 && e.altKey;
      default:
        return e.button === 0;
    }
  }

  // Apply volume cleanly to hardware and sync native slider visual state
  function applyHardwareVolume(volumeFraction, isMuted) {
    const clamped = Math.max(0, Math.min(1, volumeFraction));
    const effectiveMuted = isMuted || clamped === 0;

    persistVolume(clamped, effectiveMuted);

    if (activeVideo) {
      isInternalVolumeChange = true;
      activeVideo.volume = clamped;
      activeVideo.muted = effectiveMuted;
      isInternalVolumeChange = false;
    }

    syncNativeSliderUI(clamped, effectiveMuted);
  }

  // Synchronize native slider UI elements visually without synthetic event spam
  function syncNativeSliderUI(volumeFraction, isMuted) {
    if (!activePlayer) return;

    const percent = Math.round(volumeFraction * 100);
    const effectiveMuted = isMuted || percent === 0;

    // 1. Update aria attributes on .ytp-volume-panel
    const panel = activePlayer.querySelector('.ytp-volume-panel');
    if (panel) {
      panel.setAttribute('aria-valuenow', effectiveMuted ? '0' : String(percent));
      panel.setAttribute('aria-valuetext', effectiveMuted ? '0% volume' : `${percent}% volume`);
    }

    // 2. Update .ytp-volume-slider-handle position
    const slider = activePlayer.querySelector('.ytp-volume-slider');
    const handle = activePlayer.querySelector('.ytp-volume-slider-handle');
    if (handle) {
      const sliderWidth = (slider && slider.clientWidth > 0) ? slider.clientWidth : 40;
      const handlePos = effectiveMuted ? 0 : (volumeFraction * sliderWidth);
      handle.style.left = `${handlePos.toFixed(1)}px`;
    }

    // 3. Update mute button state
    const muteBtn = activePlayer.querySelector('.ytp-mute-button');
    if (muteBtn) {
      muteBtn.setAttribute('title', effectiveMuted ? 'Unmute (m)' : 'Mute (m)');
      muteBtn.setAttribute('aria-label', effectiveMuted ? 'Unmute' : 'Mute');
    }
  }

  // Ensure native slider is completely released and closed
  function releaseNativeSlider() {
    if (!activePlayer) return;
    const panel = activePlayer.querySelector('.ytp-volume-panel');
    if (panel) {
      panel.classList.remove('ytp-volume-panel-expanded');
      panel.blur();
    }
    const slider = activePlayer.querySelector('.ytp-volume-slider');
    if (slider) {
      slider.blur();
    }
  }

  // Apply volume updates in sync with display refresh rate (rAF)
  function scheduleVolumeUpdate() {
    if (rAFScheduled) return;
    rAFScheduled = true;

    requestAnimationFrame(() => {
      rAFScheduled = false;
      if (!activeVideo) return;

      const clamped = Math.max(0, Math.min(1, pendingVolume));

      // Direct audio assignment + visual update
      applyHardwareVolume(clamped, clamped === 0);

      // Update floating HUD ONLY if still actively dragging!
      if (hud && cachedPlayerRect && isDragging) {
        hud.update(clamped, clamped === 0, pendingCursorX, pendingCursorY, cachedPlayerRect);
      }
    });
  }

  // Handle Tab Inactivity / Switch / Blur
  function onTabInactive() {
    if (isDragging) {
      isDragging = false;
      isPointerDown = false;
      document.body.classList.remove('yt-vol-dragging-active');
      if (activePlayer) activePlayer.classList.remove('yt-vol-dragging-active');

      if (tabDesiredVolume !== null) {
        const intVol = Math.round(tabDesiredVolume * 100);
        persistVolume(tabDesiredVolume, tabDesiredMuted);
        syncWithMainWorldPlayer(intVol, tabDesiredMuted);
      }
    }

    isPointerDown = false;
    fastForwardLocked = false;

    // Immediately hide HUD with zero delay
    if (hud) {
      hud.hide(0);
    }

    // Close and release native slider
    releaseNativeSlider();
  }

  // Global listeners to track native slider and keyboard interactions
  function onGlobalPointerDown(e) {
    if (e.target && e.target.closest && e.target.closest('.ytp-volume-control, .ytp-volume-panel, .ytp-volume-slider, .ytp-mute-button')) {
      isUserInteractingWithNativeSlider = true;
      lastUserVolumeInteractionTime = performance.now();
    }
  }

  function onGlobalPointerUp() {
    setTimeout(() => {
      isUserInteractingWithNativeSlider = false;
    }, 300);
  }

  function isTypingInInput(target) {
    if (!target) return false;
    return (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable ||
      (target.getAttribute && target.getAttribute('role') === 'textbox')
    );
  }

  function onKeyDown(e) {
    if (isTypingInInput(e.target)) return;

    if (
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'm' ||
      e.key === 'M' ||
      e.key === 'AudioVolumeUp' ||
      e.key === 'AudioVolumeDown' ||
      e.key === 'AudioVolumeMute'
    ) {
      lastUserVolumeInteractionTime = performance.now();
    }
  }

  function onWheel(e) {
    if (activePlayer && activePlayer.contains(e.target)) {
      lastUserVolumeInteractionTime = performance.now();
    }
  }

  // Mouse Down Handler
  function onMouseDown(e) {
    if (e.target && e.target.closest && e.target.closest('.ytp-volume-control, .ytp-volume-panel, .ytp-volume-slider, .ytp-mute-button')) {
      isUserInteractingWithNativeSlider = true;
      lastUserVolumeInteractionTime = performance.now();
      return;
    }

    if (!config.enabled) return;
    if (isInlinePreview(e.target)) return;

    const { player, video } = getPlayerElements();
    if (!player || !video) return;

    // Check if clicked inside player
    if (!player.contains(e.target)) return;

    // Ignore clicks on controls/buttons
    if (isInteractiveElement(e.target)) return;

    // Check if matches the configured trigger
    if (!matchesTrigger(e)) return;

    ensureHUD();
    isPointerDown = true;
    isDragging = false;
    fastForwardLocked = false;
    mouseDownTime = performance.now();

    startX = e.clientX;
    startY = e.clientY;
    initialVolume = video.muted ? 0 : video.volume;
    savedPlaybackRate = video.playbackRate || 1.0;

    // Cache player geometry ONCE on mousedown
    cachedPlayerRect = player.getBoundingClientRect();
    const playerWidth = cachedPlayerRect.width > 0 ? cachedPlayerRect.width : window.innerWidth;
    const sensitivityRatio = Math.max(0.1, config.sensitivity / 100);
    cachedSpanWidth = playerWidth * sensitivityRatio;
  }

  // Mouse Move Handler
  function onMouseMove(e) {
    if (!isPointerDown || !activePlayer || !activeVideo || fastForwardLocked) return;

    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    const distance = Math.hypot(deltaX, deltaY);
    const elapsed = performance.now() - mouseDownTime;

    if (!isDragging) {
      // 1. Fast-forward lock check (>= 400ms or 2x speed active)
      if (elapsed > FAST_FORWARD_THRESHOLD_MS || activeVideo.playbackRate > 1.2 || activePlayer.classList.contains('ytp-speedmaster-active')) {
        fastForwardLocked = true;
        return;
      }

      // 2. Initiate volume drag
      if (distance > DRAG_THRESHOLD_PX) {
        isDragging = true;
        document.body.classList.add('yt-vol-dragging-active');
        if (activePlayer) activePlayer.classList.add('yt-vol-dragging-active');
        cancelYouTubeSpeedmaster();
      } else {
        return;
      }
    }

    // Guard against YouTube activating 2x speed during active volume drag
    if (activeVideo.playbackRate !== savedPlaybackRate) {
      activeVideo.playbackRate = savedPlaybackRate;
      cancelYouTubeSpeedmaster();
    }

    // Compute new volume
    const volumeDelta = deltaX / cachedSpanWidth;
    pendingVolume = Math.max(0, Math.min(1, initialVolume + volumeDelta));
    pendingCursorX = e.clientX;
    pendingCursorY = e.clientY;

    // Schedule 60fps update
    scheduleVolumeUpdate();

    // Prevent text selection
    e.preventDefault();
  }

  // Mouse Up Handler
  function onMouseUp(e) {
    if (!isPointerDown && !isDragging) return;

    const wasDragging = isDragging;
    isPointerDown = false;
    isDragging = false;

    if (wasDragging) {
      suppressNextClick = true;
      if (config.dragTrigger === 'right' || (e && e.button === 2)) {
        suppressNextContextMenu = true;
      }

      // 1. Apply hardware volume
      applyHardwareVolume(pendingVolume, pendingVolume === 0);

      // 2. Persist volume to YouTube's schema & extension storage
      persistVolume(pendingVolume, pendingVolume === 0);

      // 3. Dispatch to main_bridge.js (world: MAIN) for server sync
      const intVol = Math.round(pendingVolume * 100);
      syncWithMainWorldPlayer(intVol, pendingVolume === 0);

      cancelYouTubeSpeedmaster();
      releaseNativeSlider();

      document.body.classList.remove('yt-vol-dragging-active');
      if (activePlayer) activePlayer.classList.remove('yt-vol-dragging-active');

      if (hud) {
        hud.hide(650);
      }
    } else {
      if (hud) {
        hud.hide(0);
      }
    }

    fastForwardLocked = false;
  }

  // Click Interception (Capture Phase)
  function onClickCapture(e) {
    if (suppressNextClick) {
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
      suppressNextClick = false;
    }
  }

  // Context Menu Interception for Right-Click drag (Capture Phase)
  function onContextMenuCapture(e) {
    if (suppressNextContextMenu) {
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
      suppressNextContextMenu = false;
    }
  }

  // Initialize event listeners
  function init() {
    loadConfig();

    // Global window listeners with capture
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mousemove', onMouseMove, { passive: false, capture: true });
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('click', onClickCapture, true);
    window.addEventListener('contextmenu', onContextMenuCapture, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('wheel', onWheel, { passive: true, capture: true });

    // Native slider interaction tracking listeners
    window.addEventListener('pointerdown', onGlobalPointerDown, true);
    window.addEventListener('pointerup', onGlobalPointerUp, true);
    window.addEventListener('touchstart', onGlobalPointerDown, { passive: true, capture: true });
    window.addEventListener('touchend', onGlobalPointerUp, { passive: true, capture: true });

    // Tab Switch & Visibility Change Listeners
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        onTabInactive();
      }
    });
    window.addEventListener('blur', onTabInactive);

    // Dynamic SPA Navigation handling
    window.addEventListener('yt-navigate-finish', () => {
      setTimeout(ensureHUD, 100);
    });
    window.addEventListener('spfdone', () => {
      setTimeout(ensureHUD, 100);
    });

    // Resize listener to invalidate cached geometry
    window.addEventListener('resize', () => {
      if (activePlayer) {
        cachedPlayerRect = activePlayer.getBoundingClientRect();
      }
    }, { passive: true });

    // Early MutationObserver to catch video initialization (excluding inline thumbnail previews)
    const observer = new MutationObserver(() => {
      const { video } = getPlayerElements();
      if (video && !video.__ytVolEarlyInit && !isInlinePreview(video)) {
        video.__ytVolEarlyInit = true;
        applyEarlyVolumeToVideo(video);
      }
      ensureHUD();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    ensureHUD();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
