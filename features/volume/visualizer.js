/**
 * YouTube Viewport Volume Drag - Modern Visualizer HUD Component
 * Highly optimized for 60fps+ rendering, zero lag, and instant close support.
 */

class VolumeVisualizerHUD {
  constructor() {
    this.wrapper = null;
    this.fill = null;
    this.badge = null;
    this.iconBox = null;
    this.waveBars = [];
    this.hideTimeout = null;
    this.currentStyle = 'wave';
    this.numBars = 6;
    this.isMounted = false;

    // Cache to prevent redundant DOM updates
    this.lastSpeakerState = null;
    this.lastPercent = -1;
    this.lastMuted = null;
    this.lastX = -1;
    this.lastY = -1;
  }

  getSpeakerState(level, isMuted) {
    if (isMuted || level === 0) return 'muted';
    if (level < 0.34) return 'low';
    if (level < 0.67) return 'mid';
    return 'high';
  }

  getSpeakerSvg(state) {
    switch (state) {
      case 'muted':
        return `
          <svg viewBox="0 0 24 24">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <line x1="22" y1="9" x2="16" y2="15"/>
            <line x1="16" y1="9" x2="22" y2="15"/>
          </svg>
        `;
      case 'low':
        return `
          <svg viewBox="0 0 24 24">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15 9a5 5 0 0 1 0 6"/>
          </svg>
        `;
      case 'mid':
        return `
          <svg viewBox="0 0 24 24">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15 9a5 5 0 0 1 0 6"/>
            <path d="M18 7a8.5 8.5 0 0 1 0 10"/>
          </svg>
        `;
      case 'high':
      default:
        return `
          <svg viewBox="0 0 24 24">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15 9a5 5 0 0 1 0 6"/>
            <path d="M18 7a8.5 8.5 0 0 1 0 10"/>
            <path d="M21 5a12 12 0 0 1 0 14"/>
          </svg>
        `;
    }
  }

  createDOM() {
    if (this.wrapper && this.wrapper.parentElement) {
      return;
    }

    // Create wrapper element
    const wrapper = document.createElement('div');
    wrapper.className = `yt-vol-hud-wrapper ${this.currentStyle === 'minimal' ? 'yt-vol-style-minimal' : ''}`;
    wrapper.setAttribute('aria-hidden', 'true');

    // Create card container
    const card = document.createElement('div');
    card.className = 'yt-vol-hud-card';

    // Icon container
    const iconBox = document.createElement('div');
    iconBox.className = 'yt-vol-icon-box';
    iconBox.innerHTML = this.getSpeakerSvg('high');
    this.lastSpeakerState = 'high';

    // Body
    const body = document.createElement('div');
    body.className = 'yt-vol-body';

    // Header (waveform & percentage badge)
    const header = document.createElement('div');
    header.className = 'yt-vol-header';

    const waveform = document.createElement('div');
    waveform.className = 'yt-vol-waveform';
    this.waveBars = [];
    const baseWeights = [0.4, 0.75, 1.0, 0.65, 0.9, 0.5];
    for (let i = 0; i < this.numBars; i++) {
      const bar = document.createElement('div');
      bar.className = 'yt-vol-bar';
      bar.dataset.weight = baseWeights[i % baseWeights.length];
      waveform.appendChild(bar);
      this.waveBars.push(bar);
    }

    const badge = document.createElement('div');
    badge.className = 'yt-vol-badge';
    badge.textContent = '100%';

    header.appendChild(waveform);
    header.appendChild(badge);

    // Slider wrap & fill
    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'yt-vol-slider-wrap';

    const sliderFill = document.createElement('div');
    sliderFill.className = 'yt-vol-slider-fill';

    const sliderThumb = document.createElement('div');
    sliderThumb.className = 'yt-vol-slider-thumb';

    sliderFill.appendChild(sliderThumb);
    sliderWrap.appendChild(sliderFill);

    body.appendChild(header);
    body.appendChild(sliderWrap);

    card.appendChild(iconBox);
    card.appendChild(body);
    wrapper.appendChild(card);

    this.wrapper = wrapper;
    this.fill = sliderFill;
    this.badge = badge;
    this.iconBox = iconBox;
  }

  mount(targetContainer) {
    if (!targetContainer) return;
    this.createDOM();
    if (this.wrapper.parentElement !== targetContainer) {
      targetContainer.appendChild(this.wrapper);
      this.isMounted = true;
    }
  }

  setStyle(style) {
    this.currentStyle = style;
    if (this.wrapper) {
      if (style === 'minimal') {
        this.wrapper.classList.add('yt-vol-style-minimal');
      } else {
        this.wrapper.classList.remove('yt-vol-style-minimal');
      }
    }
  }

  show() {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    if (this.wrapper && !this.wrapper.classList.contains('yt-vol-visible')) {
      this.wrapper.classList.add('yt-vol-visible');
    }
  }

  setPosition(cursorX, cursorY, playerRect) {
    if (!this.wrapper || !playerRect || typeof cursorX !== 'number' || typeof cursorY !== 'number') {
      return;
    }

    const relX = cursorX - playerRect.left;
    const relY = cursorY - playerRect.top;

    const cardWidth = this.wrapper.offsetWidth || (this.currentStyle === 'minimal' ? 240 : 320);
    const cardHeight = this.wrapper.offsetHeight || 55;
    const halfWidth = cardWidth / 2;
    const gap = 16;

    const minX = halfWidth + 12;
    const maxX = Math.max(minX, playerRect.width - halfWidth - 12);
    const clampedX = Math.round(Math.max(minX, Math.min(maxX, relX)));

    const spaceAbove = relY - gap;
    const flipBelow = spaceAbove < cardHeight + 10;
    this.wrapper.classList.toggle('yt-vol-hud-below', flipBelow);

    let clampedY;
    if (flipBelow) {
      const maxY = Math.max(gap, playerRect.height - cardHeight - 10);
      clampedY = Math.round(Math.max(gap, Math.min(maxY, relY + gap)));
    } else {
      clampedY = Math.round(Math.max(cardHeight + 10, Math.min(playerRect.height - 10, relY - gap)));
    }

    if (clampedX !== this.lastX || clampedY !== this.lastY) {
      this.lastX = clampedX;
      this.lastY = clampedY;
      this.wrapper.style.left = `${clampedX}px`;
      this.wrapper.style.top = `${clampedY}px`;
    }
  }

  update(volumeFraction, isMuted, cursorX, cursorY, playerRect) {
    this.show();

    if (typeof cursorX === 'number' && typeof cursorY === 'number' && playerRect) {
      this.setPosition(cursorX, cursorY, playerRect);
    }

    const clampedVol = Math.max(0, Math.min(1, volumeFraction));
    const percent = Math.round(clampedVol * 100);
    const effectiveMuted = isMuted || percent === 0;

    // 1. Update Slider Fill
    if (this.fill) {
      this.fill.style.width = `${effectiveMuted ? 0 : percent}%`;
    }

    // 2. Update Icon (only when state changes)
    const speakerState = this.getSpeakerState(clampedVol, effectiveMuted);
    if (this.iconBox && speakerState !== this.lastSpeakerState) {
      this.lastSpeakerState = speakerState;
      this.iconBox.innerHTML = this.getSpeakerSvg(speakerState);
    }

    // 3. Update Badge Text (only when percent or muted state changes)
    if (this.badge && (percent !== this.lastPercent || effectiveMuted !== this.lastMuted)) {
      this.lastPercent = percent;
      this.lastMuted = effectiveMuted;
      if (effectiveMuted) {
        this.badge.textContent = 'Muted';
        this.badge.classList.add('is-muted');
      } else {
        this.badge.textContent = `${percent}%`;
        this.badge.classList.remove('is-muted');
      }
    }

    // 4. Update Waveform Equalizer Bars
    if (this.waveBars && this.waveBars.length > 0) {
      for (let i = 0; i < this.waveBars.length; i++) {
        const bar = this.waveBars[i];
        if (effectiveMuted) {
          bar.style.height = '3px';
          bar.style.opacity = '0.3';
        } else {
          const weight = parseFloat(bar.dataset.weight || '1.0');
          const baseHeight = 3;
          const maxHeight = 18;
          const targetHeight = Math.max(3, Math.round(baseHeight + (maxHeight - baseHeight) * clampedVol * weight));
          bar.style.height = `${targetHeight}px`;
          bar.style.opacity = `${(0.4 + 0.6 * clampedVol).toFixed(2)}`;
        }
      }
    }
  }

  hide(delay = 600) {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    const hideNow = () => {
      if (this.wrapper) {
        this.wrapper.classList.remove('yt-vol-visible', 'yt-vol-hud-below');
        this.lastX = -1;
        this.lastY = -1;
      }
    };

    if (delay === 0) {
      hideNow();
      return;
    }
    this.hideTimeout = setTimeout(() => {
      this.hideTimeout = null;
      hideNow();
    }, delay);
  }

  destroy() {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
    }
    if (this.wrapper && this.wrapper.parentElement) {
      this.wrapper.parentElement.removeChild(this.wrapper);
    }
    this.wrapper = null;
    this.isMounted = false;
  }
}

// Attach to window
window.VolumeVisualizerHUD = VolumeVisualizerHUD;
