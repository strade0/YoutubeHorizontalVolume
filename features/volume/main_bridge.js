/**
 * YouTube Viewport Volume Drag - Main World Bridge
 * Executes in world: "MAIN" (100% CSP compliant, zero inline script violations).
 * Directly interfaces with YouTube's player API to manage true master volume,
 * bypassing video element loudness normalization feedback loops.
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

  let attachedPlayer = null;
  let attachedVideo = null;
  let isInternalBridgeChange = false;
  let bridgeChangeGen = 0;

  window.addEventListener('storage', (e) => {
    if (e.key && VOLUME_STORAGE_KEYS.has(e.key)) {
      e.stopImmediatePropagation();
    }
  }, true);

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

  function getPlayer() {
    const moviePlayer = document.getElementById('movie_player');
    if (moviePlayer && !isInlinePreview(moviePlayer)) {
      return moviePlayer;
    }
    const watchPlayer = document.querySelector(
      'ytd-watch-flexy .html5-video-player, ytd-watch-grid .html5-video-player, #shorts-player, ytd-miniplayer .html5-video-player'
    );
    if (watchPlayer && !isInlinePreview(watchPlayer)) {
      return watchPlayer;
    }
    return null;
  }

  function toFiniteIntVolume(value) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function onPlayerVolumeChange() {
    if (isInternalBridgeChange) return;

    try {
      const player = getPlayer();
      if (!player || typeof player.getVolume !== 'function') return;

      const vol = player.getVolume();
      if (!Number.isFinite(vol)) return;
      const isMuted = typeof player.isMuted === 'function' ? player.isMuted() : false;

      window.dispatchEvent(new CustomEvent('yt-player-volume-changed', {
        detail: {
          volume: vol,
          isMuted: isMuted
        }
      }));
    } catch (e) {}
  }

  function setupPlayerListeners() {
    const player = getPlayer();
    if (!player) return;

    if (attachedPlayer !== player) {
      if (attachedPlayer && typeof attachedPlayer.removeEventListener === 'function') {
        try {
          attachedPlayer.removeEventListener('onVolumeChange', onPlayerVolumeChange);
        } catch (e) {}
      }
      attachedPlayer = player;
      if (typeof player.addEventListener === 'function') {
        try {
          player.addEventListener('onVolumeChange', onPlayerVolumeChange);
        } catch (e) {}
      }
    }

    const video = player.querySelector ? player.querySelector('video') : null;
    if (video && attachedVideo !== video) {
      if (attachedVideo) {
        attachedVideo.removeEventListener('volumechange', onPlayerVolumeChange);
      }
      attachedVideo = video;
      video.addEventListener('volumechange', onPlayerVolumeChange, { passive: true });
    }
  }

  function releaseInternalLock(gen) {
    if (gen === bridgeChangeGen) {
      isInternalBridgeChange = false;
    }
  }

  function setYouTubePlayerVolume(volume, isMuted) {
    const intVol = toFiniteIntVolume(volume);
    if (intVol === null) return;

    try {
      const player = getPlayer();
      if (player && typeof player.setVolume === 'function') {
        const gen = ++bridgeChangeGen;
        isInternalBridgeChange = true;
        try {
          player.setVolume(intVol);
          if (isMuted || intVol === 0) {
            if (typeof player.mute === 'function') player.mute();
          } else if (typeof player.isMuted === 'function' && player.isMuted()) {
            if (typeof player.unMute === 'function') player.unMute();
          }
        } catch (inner) {
          releaseInternalLock(gen);
          return;
        }
        // Wait two frames so YouTube's own volumechange is still treated as internal.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => releaseInternalLock(gen));
        });
      }
    } catch (e) {
      isInternalBridgeChange = false;
    }
  }

  function applySavedVolumeOnStartup() {
    try {
      setupPlayerListeners();
      const saved = localStorage.getItem('yt_extension_saved_volume');
      if (saved !== null) {
        const vol = parseFloat(saved);
        if (!Number.isFinite(vol)) return;
        const isMuted = localStorage.getItem('yt_extension_saved_muted') === 'true';
        const intVol = Math.round(Math.max(0, Math.min(1, vol)) * 100);
        setYouTubePlayerVolume(intVol, isMuted);
      }
    } catch (e) {}
  }

  let attempts = 0;
  const initInterval = setInterval(() => {
    attempts++;
    setupPlayerListeners();
    const player = getPlayer();
    if (player && typeof player.setVolume === 'function') {
      applySavedVolumeOnStartup();
      clearInterval(initInterval);
    }
    if (attempts > 50) {
      clearInterval(initInterval);
    }
  }, 100);

  window.addEventListener('yt-vol-sync-player', (e) => {
    if (!e || !e.detail) return;
    const { volume, isMuted } = e.detail;
    if (typeof volume === 'number' && Number.isFinite(volume)) {
      setYouTubePlayerVolume(volume, !!isMuted);
    }
  }, { passive: true });

  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(applySavedVolumeOnStartup, 100);
  }, { passive: true });
})();
