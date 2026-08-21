/**
 * YouTube Viewport Volume Drag - Content Script
 * Robust persistent volume memory, zero startup burst, full native slider support,
 * keyboard shortcuts synchronization, race-free HUD lifecycle, and normalization-proof master volume.
 */

(function () {
  'use strict';

  const VOLUME_STORAGE_KEYS = new Set([
    'yt_extension_saved_volume',
    'yt_extension_saved_muted',
    'yt_tab_volume',
    'yt_tab_muted',
    'yt-player-volume'
  ]);

  // Block cross-tab storage broadcast so other open tabs stay independent
  window.addEventListener('storage', (e) => {
    if (e.key && VOLUME_STORAGE_KEYS.has(e.key)) {
      e.stopImmediatePropagation();
    }
  }, true);

  const config = {
    enabled: true,
    dragTrigger: 'left', // 'left', 'right', 'shift-left', 'alt-left'
    sensitivity: 60,     // 60% of player width for 0% to 100% volume
    hudStyle: 'wave'     // 'wave' or 'minimal'
  };

  let hud = null;
  let activePlayer = null;
  let activeVideo = null;
  let isPointerDown = false;
  let isDragging = false;
  let fastForwardLocked = false;
  let activePointerId = null;
  let captureEl = null;

  let pointerDownTime = 0;
  let startX = 0;
  let startY = 0;
  let initialVolume = 1.0;
  let savedPlaybackRate = 1.0;
  let cachedPlayerRect = null;
  let cachedSpanWidth = 600;

  let tabDesiredVolume = null;
  let tabDesiredMuted = false;

  let rAFScheduled = false;
  let pendingVolume = 1.0;
  let pendingCursorX = 0;
  let pendingCursorY = 0;

  let suppressNextClick = false;
  let suppressNextContextMenu = false;
  let suppressClickTimer = null;
  let suppressContextTimer = null;
  let hudEnsureTimer = null;

  const DRAG_THRESHOLD_PX = 6;
  const FAST_FORWARD_THRESHOLD_MS = 400;
  const DEFAULT_SLIDER_HANDLE_MAX = 40;

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

  function toFiniteVolume(value, fallback = null) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
  }

  try {
    const extSaved = localStorage.getItem('yt_extension_saved_volume');
    if (extSaved !== null) {
      tabDesiredVolume = toFiniteVolume(extSaved, null);
      tabDesiredMuted = localStorage.getItem('yt_extension_saved_muted') === 'true';
    } else {
      const savedTabVol = sessionStorage.getItem('yt_tab_volume');
      if (savedTabVol !== null) {
        tabDesiredVolume = toFiniteVolume(savedTabVol, null);
        tabDesiredMuted = sessionStorage.getItem('yt_tab_muted') === 'true';
      } else {
        const ytStorage = localStorage.getItem('yt-player-volume');
        if (ytStorage) {
          const parsed = JSON.parse(ytStorage);
          const innerData = typeof parsed.data === 'string' ? JSON.parse(parsed.data) : parsed.data;
          if (innerData && typeof innerData.volume === 'number' && Number.isFinite(innerData.volume)) {
            tabDesiredVolume = toFiniteVolume(innerData.volume / 100, null);
            tabDesiredMuted = !!innerData.muted;
          }
        }
      }
    }
  } catch (e) {}

  function persistVolume(volumeFraction, isMuted) {
    const clamped = toFiniteVolume(volumeFraction, null);
    if (clamped === null) return;

    const intVol = Math.round(clamped * 100);
    const muted = !!(isMuted || intVol === 0);
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

  if (tabDesiredVolume !== null) {
    persistVolume(tabDesiredVolume, tabDesiredMuted);
  }

  function syncWithMainWorldPlayer(intVol, isMuted) {
    if (!Number.isFinite(intVol)) return;
    try {
      window.dispatchEvent(new CustomEvent('yt-vol-sync-player', {
        detail: {
          volume: intVol,
          isMuted: isMuted
        }
      }));
    } catch (e) {}
  }

  window.addEventListener('yt-player-volume-changed', (e) => {
    if (!e || !e.detail || isDragging) return;

    const { volume, isMuted } = e.detail;
    if (typeof volume === 'number' && Number.isFinite(volume)) {
      const volFraction = toFiniteVolume(volume / 100, null);
      if (volFraction === null) return;
      persistVolume(volFraction, !!isMuted);
      syncNativeSliderUI(volFraction, tabDesiredMuted);
    }
  });

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

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') {
        for (const [key, change] of Object.entries(changes)) {
          if (change.newValue !== undefined) {
            config[key] = change.newValue;
          }
        }
        if (hud) {
          hud.setStyle(config.hudStyle);
        }
      }
    });
  }

  function getPlayerElements() {
    const moviePlayer = document.getElementById('movie_player');
    if (moviePlayer && !isInlinePreview(moviePlayer)) {
      const video = moviePlayer.querySelector('video');
      if (video) return { player: moviePlayer, video };
    }

    const primaryContainer = document.querySelector('ytd-watch-flexy, ytd-watch-grid, #shorts-player, ytd-shorts, ytd-miniplayer');
    if (primaryContainer) {
      const player = primaryContainer.querySelector('.html5-video-player') || primaryContainer;
      const video = primaryContainer.querySelector('video');
      if (player && video && !isInlinePreview(player) && !isInlinePreview(video)) {
        return { player, video };
      }
    }

    const player = document.querySelector('.html5-video-player:not(#inline-preview-player)');
    if (player && !isInlinePreview(player)) {
      const video = player.querySelector('video');
      if (video && !isInlinePreview(video)) {
        return { player, video };
      }
    }

    return { player: null, video: null };
  }

  function releasePointerCapture() {
    if (captureEl && activePointerId !== null) {
      try {
        if (!captureEl.hasPointerCapture || captureEl.hasPointerCapture(activePointerId)) {
          captureEl.releasePointerCapture(activePointerId);
        }
      } catch (e) {}
    }
    captureEl = null;
  }

  function setDraggingClass(on) {
    document.body.classList.toggle('yt-vol-dragging-active', on);
    if (activePlayer) activePlayer.classList.toggle('yt-vol-dragging-active', on);
  }

  function ensureHUD() {
    const { player, video } = getPlayerElements();
    if (!player || !video) {
      if (activeVideo) {
        activeVideo.removeEventListener('ratechange', onRateChange);
        activeVideo = null;
      }
      activePlayer = null;
      return false;
    }

    if (activeVideo !== video) {
      if (activeVideo) {
        activeVideo.removeEventListener('ratechange', onRateChange);
      }
      activeVideo = video;
      activeVideo.addEventListener('ratechange', onRateChange, { passive: true });

      if (tabDesiredVolume !== null) {
        const intVol = Math.round(tabDesiredVolume * 100);
        syncWithMainWorldPlayer(intVol, tabDesiredMuted);
        syncNativeSliderUI(tabDesiredVolume, tabDesiredMuted);
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

  function scheduleEnsureHUD() {
    if (hudEnsureTimer != null) return;
    hudEnsureTimer = setTimeout(() => {
      hudEnsureTimer = null;
      ensureHUD();
    }, 150);
  }

  function cancelYouTubeSpeedmaster() {
    if (activeVideo && Number.isFinite(savedPlaybackRate)) {
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

  function onRateChange() {
    if (isDragging && activeVideo && Number.isFinite(savedPlaybackRate)) {
      if (activeVideo.playbackRate !== savedPlaybackRate) {
        activeVideo.playbackRate = savedPlaybackRate;
        cancelYouTubeSpeedmaster();
      }
    }
  }

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

  function matchesTrigger(e) {
    switch (config.dragTrigger) {
      case 'left':
        return e.button === 0 && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
      case 'right':
        return e.button === 2;
      case 'shift-left':
        return e.button === 0 && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
      case 'alt-left':
        return e.button === 0 && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey;
      default:
        return e.button === 0 && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
    }
  }

  function getSliderHandleMax() {
    if (!activePlayer) return DEFAULT_SLIDER_HANDLE_MAX;
    const slider = activePlayer.querySelector('.ytp-volume-slider');
    if (!slider) return DEFAULT_SLIDER_HANDLE_MAX;
    const handle = slider.querySelector('.ytp-volume-slider-handle');
    const sliderWidth = slider.clientWidth || slider.offsetWidth;
    if (!sliderWidth) return DEFAULT_SLIDER_HANDLE_MAX;
    const handleWidth = handle ? (handle.offsetWidth || 0) : 0;
    const maxLimit = sliderWidth - handleWidth;
    return maxLimit > 0 ? maxLimit : DEFAULT_SLIDER_HANDLE_MAX;
  }

  function syncNativeSliderUI(volumeFraction, isMuted) {
    if (!activePlayer) return;

    const clamped = toFiniteVolume(volumeFraction, 0);
    const percent = Math.round(clamped * 100);
    const effectiveMuted = isMuted || percent === 0;

    const panel = activePlayer.querySelector('.ytp-volume-panel');
    if (panel) {
      panel.setAttribute('aria-valuenow', effectiveMuted ? '0' : String(percent));
      panel.setAttribute('aria-valuetext', effectiveMuted ? '0% volume' : `${percent}% volume`);
    }

    const handle = activePlayer.querySelector('.ytp-volume-slider-handle');
    if (handle) {
      const maxLimit = getSliderHandleMax();
      const handlePos = effectiveMuted ? 0 : Math.max(0, Math.min(maxLimit, clamped * maxLimit));
      handle.style.left = `${handlePos.toFixed(1)}px`;
    }

    const muteBtn = activePlayer.querySelector('.ytp-mute-button');
    if (muteBtn) {
      muteBtn.setAttribute('title', effectiveMuted ? 'Unmute (m)' : 'Mute (m)');
      muteBtn.setAttribute('aria-label', effectiveMuted ? 'Unmute' : 'Mute');
    }
  }

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

  function scheduleVolumeUpdate() {
    if (rAFScheduled) return;
    rAFScheduled = true;

    requestAnimationFrame(() => {
      rAFScheduled = false;
      if (!activePlayer) return;

      const clamped = toFiniteVolume(pendingVolume, null);
      if (clamped === null) return;

      const intVol = Math.round(clamped * 100);
      const isMuted = clamped === 0;

      tabDesiredVolume = clamped;
      tabDesiredMuted = isMuted;

      if (isDragging) {
        cachedPlayerRect = activePlayer.getBoundingClientRect();
      }

      syncWithMainWorldPlayer(intVol, isMuted);
      syncNativeSliderUI(clamped, isMuted);

      if (hud && cachedPlayerRect && isDragging) {
        hud.update(clamped, isMuted, pendingCursorX, pendingCursorY, cachedPlayerRect);
      }
    });
  }

  function beginVolumeDrag() {
    isDragging = true;
    setDraggingClass(true);
    cancelYouTubeSpeedmaster();

    if (captureEl && activePointerId !== null && captureEl.setPointerCapture) {
      try {
        captureEl.setPointerCapture(activePointerId);
      } catch (e) {}
    }
  }

  function armClickSuppression() {
    suppressNextClick = true;
    if (suppressClickTimer) clearTimeout(suppressClickTimer);
    suppressClickTimer = setTimeout(() => {
      suppressNextClick = false;
      suppressClickTimer = null;
    }, 120);
  }

  function armContextMenuSuppression() {
    suppressNextContextMenu = true;
    if (suppressContextTimer) clearTimeout(suppressContextTimer);
    suppressContextTimer = setTimeout(() => {
      suppressNextContextMenu = false;
      suppressContextTimer = null;
    }, 120);
  }

  function finishGesture(e, { fromLostCapture } = {}) {
    if (!isPointerDown && !isDragging) {
      fastForwardLocked = false;
      activePointerId = null;
      return;
    }

    const wasDragging = isDragging;
    isPointerDown = false;
    isDragging = false;
    fastForwardLocked = false;

    if (wasDragging) {
      armClickSuppression();
      if (config.dragTrigger === 'right' || (e && e.button === 2)) {
        armContextMenuSuppression();
      }

      if (e && e.cancelable) {
        e.preventDefault();
      }
      if (e) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }

      const clamped = toFiniteVolume(pendingVolume, tabDesiredVolume);
      if (clamped !== null) {
        const intVol = Math.round(clamped * 100);
        const isMuted = clamped === 0;
        persistVolume(clamped, isMuted);
        syncWithMainWorldPlayer(intVol, isMuted);
        syncNativeSliderUI(clamped, isMuted);
      }

      cancelYouTubeSpeedmaster();
      releaseNativeSlider();
      setDraggingClass(false);

      if (hud) {
        hud.hide(650);
      }
    } else {
      if (hud) {
        hud.hide(0);
      }
    }

    if (!fromLostCapture) {
      releasePointerCapture();
    } else {
      captureEl = null;
    }
    activePointerId = null;
  }

  function onTabInactive() {
    if (isDragging || isPointerDown) {
      finishGesture(null);
    } else {
      isPointerDown = false;
      fastForwardLocked = false;
      activePointerId = null;
      if (hud) hud.hide(0);
      releaseNativeSlider();
    }
  }

  function onPointerDown(e) {
    if (!e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;

    if (e.target && e.target.closest && e.target.closest('.ytp-volume-control, .ytp-volume-panel, .ytp-volume-slider, .ytp-mute-button')) {
      return;
    }

    if (!config.enabled) return;
    if (isInlinePreview(e.target)) return;

    const { player, video } = getPlayerElements();
    if (!player || !video) return;
    if (!player.contains(e.target)) return;
    if (isInteractiveElement(e.target)) return;
    if (!matchesTrigger(e)) return;

    ensureHUD();
    isPointerDown = true;
    isDragging = false;
    fastForwardLocked = false;
    activePointerId = e.pointerId;
    captureEl = player;
    pointerDownTime = performance.now();

    startX = e.clientX;
    startY = e.clientY;

    if (tabDesiredVolume !== null) {
      initialVolume = tabDesiredMuted ? 0 : tabDesiredVolume;
    } else {
      initialVolume = video.muted ? 0 : toFiniteVolume(video.volume, 1);
    }
    pendingVolume = initialVolume;

    const rate = video.playbackRate;
    savedPlaybackRate = Number.isFinite(rate) && rate > 0 ? rate : 1.0;

    cachedPlayerRect = player.getBoundingClientRect();
    const playerWidth = cachedPlayerRect.width > 0 ? cachedPlayerRect.width : window.innerWidth;
    const sensitivityRatio = Math.max(0.1, config.sensitivity / 100);
    cachedSpanWidth = playerWidth * sensitivityRatio;
  }

  function onPointerMove(e) {
    if (!isPointerDown || !activePlayer || fastForwardLocked) return;
    if (activePointerId !== null && e.pointerId !== activePointerId) return;

    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    const distance = Math.hypot(deltaX, deltaY);
    const elapsed = performance.now() - pointerDownTime;

    if (!isDragging) {
      // Lock only for YouTube's long-press 2x, not for a user-chosen playback speed.
      const speedmasterActive = activePlayer.classList.contains('ytp-speedmaster-active');
      const speedmasterJustStarted = activeVideo &&
        Number.isFinite(savedPlaybackRate) &&
        activeVideo.playbackRate > savedPlaybackRate + 0.05 &&
        speedmasterActive;

      if ((elapsed > FAST_FORWARD_THRESHOLD_MS && distance <= DRAG_THRESHOLD_PX) || speedmasterJustStarted) {
        fastForwardLocked = true;
        return;
      }

      if (distance > DRAG_THRESHOLD_PX) {
        beginVolumeDrag();
      } else {
        return;
      }
    }

    if (activeVideo && Number.isFinite(savedPlaybackRate) && activeVideo.playbackRate !== savedPlaybackRate) {
      activeVideo.playbackRate = savedPlaybackRate;
      cancelYouTubeSpeedmaster();
    }

    const volumeDelta = deltaX / cachedSpanWidth;
    const rawVolume = initialVolume + volumeDelta;

    if (rawVolume > 1.0) {
      initialVolume = 1.0;
      startX = e.clientX;
      pendingVolume = 1.0;
    } else if (rawVolume < 0.0) {
      initialVolume = 0.0;
      startX = e.clientX;
      pendingVolume = 0.0;
    } else {
      pendingVolume = rawVolume;
    }

    pendingCursorX = e.clientX;
    pendingCursorY = e.clientY;

    scheduleVolumeUpdate();

    if (e.cancelable) {
      e.preventDefault();
    }
    e.stopPropagation();
  }

  function onPointerUp(e) {
    if (!isPointerDown && !isDragging) return;
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    // Our speedmaster abort synthesizes pointercancel; only the browser's
    // trusted cancel (tab switch, OS gesture, etc.) should end the drag.
    if (e.type === 'pointercancel' && e.isTrusted === false) return;
    finishGesture(e);
  }

  function onLostPointerCapture(e) {
    if (!isPointerDown && !isDragging) return;
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    finishGesture(e, { fromLostCapture: true });
  }

  // Pointerup does not cancel compatibility mouseup. YouTube play/pause listens
  // to mouseup/click on the video; vertical drags often release over the play
  // button or the video surface, which would toggle playback without this.
  function onCompatMouseUp(e) {
    if (!suppressNextClick) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onClickCapture(e) {
    if (suppressNextClick) {
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
      suppressNextClick = false;
      if (suppressClickTimer) {
        clearTimeout(suppressClickTimer);
        suppressClickTimer = null;
      }
    }
  }

  function onContextMenuCapture(e) {
    const blockForRightDrag = config.dragTrigger === 'right' && (isPointerDown || isDragging);
    if (suppressNextContextMenu || isDragging || blockForRightDrag) {
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
      if (suppressNextContextMenu) {
        suppressNextContextMenu = false;
        if (suppressContextTimer) {
          clearTimeout(suppressContextTimer);
          suppressContextTimer = null;
        }
      }
    }
  }

  function clampNativeSliderHandle() {
    if (!activePlayer) return;
    const handle = activePlayer.querySelector('.ytp-volume-slider-handle');
    if (handle && handle.style && handle.style.left) {
      const leftVal = parseFloat(handle.style.left);
      const maxLimit = getSliderHandleMax();
      if (Number.isFinite(leftVal) && leftVal > maxLimit) {
        handle.style.left = `${maxLimit.toFixed(1)}px`;
      }
    }
  }

  function init() {
    loadConfig();

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, { passive: false, capture: true });
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    window.addEventListener('lostpointercapture', onLostPointerCapture, true);
    window.addEventListener('mouseup', onCompatMouseUp, true);
    window.addEventListener('click', onClickCapture, true);
    window.addEventListener('auxclick', onClickCapture, true);
    window.addEventListener('contextmenu', onContextMenuCapture, true);

    window.addEventListener('pointermove', clampNativeSliderHandle, { passive: true, capture: true });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        onTabInactive();
      }
    });

    window.addEventListener('yt-navigate-finish', () => {
      setTimeout(ensureHUD, 100);
    });
    window.addEventListener('spfdone', () => {
      setTimeout(ensureHUD, 100);
    });

    window.addEventListener('resize', () => {
      if (activePlayer) {
        cachedPlayerRect = activePlayer.getBoundingClientRect();
      }
    }, { passive: true });

    const observer = new MutationObserver(() => {
      scheduleEnsureHUD();
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
