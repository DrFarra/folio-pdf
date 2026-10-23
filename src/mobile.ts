import { useEffect, useState } from 'react';
import { isDesktop, isMobile, isNative, isAndroid, isIOS } from './platform';
import { invoke } from '@tauri-apps/api/core';

// A phone keeps its touch controls when rotated; a narrow mouse-driven desktop
// window keeps keyboard and zoom controls directly available. The Windows and
// macOS app always keeps the desktop layout: a 2-in-1 in tablet mode still needs
// its tabs and the frameless window's controls.
const PHONE_QUERY = '(max-width: 1024px) and (pointer: coarse)';

export type DeviceLayout = 'phone' | 'tablet' | 'desktop';
export function deviceLayout(): DeviceLayout {
  if (isMobile) {
    // The short screen edge keeps a rotated phone in phone mode. Window width
    // separately accommodates split screen and resizable Android windows.
    const shortest = Math.min(screen.width, screen.height);
    return shortest >= 600 && innerWidth >= 600 ? 'tablet' : 'phone';
  }
  return !isDesktop && matchMedia(PHONE_QUERY).matches ? 'phone' : 'desktop';
}

export function useDeviceLayout() {
  const [layout, setLayout] = useState(deviceLayout);
  useEffect(() => {
    const media = matchMedia(PHONE_QUERY),
      update = () => setLayout(deviceLayout());
    window.addEventListener('resize', update);
    media.addEventListener('change', update);
    screen.orientation?.addEventListener('change', update);
    return () => {
      window.removeEventListener('resize', update);
      media.removeEventListener('change', update);
      screen.orientation?.removeEventListener('change', update);
    };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.layout = layout;
    // Present flags read "true" for code that compares dataset values.
    for (const [name, on] of [
      ['tablet', layout === 'tablet'],
      ['phone', layout === 'phone'],
      ['touch', layout !== 'desktop'],
    ] as const) {
      if (on) root.dataset[name] = 'true';
      else delete root.dataset[name];
    }
    const viewport = window.visualViewport;
    const update = () => {
      root.style.setProperty('--visible-height', `${viewport?.height ?? innerHeight}px`);
      root.style.setProperty('--visible-top', `${viewport?.offsetTop ?? 0}px`);
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, [layout]);
  useEffect(() => {
    // A sideways iPhone reports the island's safe area on both sides; the action column only needs it
    // on the island's side. Turned left (90), the island is on the left. Upright, the last side is kept,
    // so turning the same way again starts at the right width; while the phone turns, the side is
    // followed frame by frame, since iOS may update it after the resize.
    if (!isIOS) return;
    const root = document.documentElement,
      landscape = matchMedia('(orientation: landscape)'),
      update = () => {
        const turn = Number(window.orientation);
        if (turn === 90) root.dataset.island = 'left';
        else if (turn === -90) root.dataset.island = 'right';
      };
    let frames = 0,
      frame = 0;
    const follow = () => {
      update();
      frame = --frames > 0 ? requestAnimationFrame(follow) : 0;
    };
    const watch = () => {
      update();
      frames = 60;
      if (!frame) frame = requestAnimationFrame(follow);
    };
    update();
    landscape.addEventListener('change', watch);
    window.addEventListener('orientationchange', watch);
    window.addEventListener('resize', watch);
    return () => {
      cancelAnimationFrame(frame);
      landscape.removeEventListener('change', watch);
      window.removeEventListener('orientationchange', watch);
      window.removeEventListener('resize', watch);
    };
  }, []);
  useEffect(() => {
    if (!isNative || !isAndroid) return;
    let alive = true,
      request = 0;
    const update = () => {
      const current = ++request;
      void invoke<{ bottom: number }>('android_safe_area')
        .then(insets => {
          if (alive && current === request && Number.isFinite(insets.bottom))
            document.documentElement.style.setProperty('--native-safe-bottom', `${Math.max(0, insets.bottom)}px`);
        })
        .catch(() => {});
    };
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.addEventListener('folio:system-bars-changed', update);
    return () => {
      alive = false;
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.removeEventListener('folio:system-bars-changed', update);
    };
  }, []);
  return layout;
}

export function visibleBounds() {
  const viewport = window.visualViewport,
    styles = getComputedStyle(document.documentElement);
  const safe = (edge: string) => parseFloat(styles.getPropertyValue(`--phone-safe-${edge}`)) || 0;
  const left = (viewport?.offsetLeft || 0) + safe('left'),
    top = (viewport?.offsetTop || 0) + safe('top');
  return {
    left,
    top,
    right: (viewport?.offsetLeft || 0) + (viewport?.width || innerWidth) - safe('right'),
    bottom: (viewport?.offsetTop || 0) + (viewport?.height || innerHeight) - safe('bottom'),
  };
}
