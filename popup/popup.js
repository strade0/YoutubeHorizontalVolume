/**
 * YouTube Viewport Volume Drag - Popup Logic
 */

document.addEventListener('DOMContentLoaded', () => {
  const enabledToggle = document.getElementById('enabled-toggle');
  const sensitivitySlider = document.getElementById('sensitivity-slider');
  const sensitivityValue = document.getElementById('sensitivity-value');
  const triggerSelect = document.getElementById('trigger-select');
  const styleSelect = document.getElementById('style-select');
  const previewWaves = document.getElementById('preview-waves');

  // Default values
  const defaults = {
    enabled: true,
    sensitivity: 60,
    dragTrigger: 'left',
    hudStyle: 'wave'
  };

  // Update UI with values
  function updateUI(settings) {
    if (enabledToggle) enabledToggle.checked = settings.enabled;
    if (sensitivitySlider) sensitivitySlider.value = settings.sensitivity;
    if (sensitivityValue) sensitivityValue.textContent = `${settings.sensitivity}%`;
    if (triggerSelect) triggerSelect.value = settings.dragTrigger;
    if (styleSelect) styleSelect.value = settings.hudStyle;
    updatePreview(settings.hudStyle);
  }

  // Update HUD Live Preview
  function updatePreview(style) {
    if (previewWaves) {
      if (style === 'minimal') {
        previewWaves.style.display = 'none';
      } else {
        previewWaves.style.display = 'flex';
      }
    }
  }

  // Load from chrome.storage.sync
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(defaults, (items) => {
      updateUI(items);
    });
  } else {
    updateUI(defaults);
  }

  // Save changes helper
  function saveSettings(key, value) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ [key]: value });
    }
  }

  // Event Listeners
  enabledToggle.addEventListener('change', (e) => {
    saveSettings('enabled', e.target.checked);
  });

  sensitivitySlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    sensitivityValue.textContent = `${val}%`;
    saveSettings('sensitivity', val);
  });

  triggerSelect.addEventListener('change', (e) => {
    saveSettings('dragTrigger', e.target.value);
  });

  styleSelect.addEventListener('change', (e) => {
    const style = e.target.value;
    updatePreview(style);
    saveSettings('hudStyle', style);
  });
});
