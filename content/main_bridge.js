/**
 * YouTube Viewport Volume Drag - Main World Bridge
 * Executes in world: "MAIN" (100% CSP compliant, zero inline script violations).
 * Directly interfaces with YouTube's player API to sync server and internal state.
 */

(function () {
  'use strict';

  function getPlayer() {
    return document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  }

  function setYouTubePlayerVolume(volume, isMuted) {
    try {
      const player = getPlayer();
      if (player && typeof player.setVolume === 'function') {
        player.setVolume(volume);
        if (isMuted) {
          if (typeof player.mute === 'function') player.mute();
        } else {
          if (typeof player.isMuted === 'function' && player.isMuted()) {
            if (typeof player.unMute === 'function') player.unMute();
          }
        }
      }
    } catch (e) {
      // Fallback silently
    }
  }

  function applySavedVolumeOnStartup() {
    try {
      const saved = localStorage.getItem('yt_extension_saved_volume');
      if (saved !== null) {
        const vol = parseFloat(saved);
        const isMuted = localStorage.getItem('yt_extension_saved_muted') === 'true';
        const intVol = Math.round(vol * 100);
        setYouTubePlayerVolume(intVol, isMuted);
      }
    } catch (e) {}
  }

  // Poll for player initialization at startup
  let attempts = 0;
  const initInterval = setInterval(() => {
    attempts++;
    const player = getPlayer();
    if (player && typeof player.setVolume === 'function') {
      applySavedVolumeOnStartup();
      clearInterval(initInterval);
    }
    if (attempts > 50) {
      clearInterval(initInterval);
    }
  }, 100);

  // Listen for sync events dispatched from the content script
  window.addEventListener('yt-vol-sync-player', (e) => {
    if (!e || !e.detail) return;
    const { volume, isMuted } = e.detail;
    if (typeof volume === 'number') {
      setYouTubePlayerVolume(volume, !!isMuted);
    }
  }, { passive: true });

  // Re-apply on YouTube SPA navigations
  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(applySavedVolumeOnStartup, 100);
  }, { passive: true });
})();
