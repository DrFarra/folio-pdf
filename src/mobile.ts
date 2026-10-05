import { useEffect, useState } from 'react';
import { isMobile, isNative, isAndroid } from './platform';
import { invoke } from '@tauri-apps/api/core';

// A phone keeps its touch controls when rotated; a narrow mouse-driven desktop
// window keeps keyboard and zoom controls directly available.
const PHONE_QUERY = '(max-width: 1024px) and (pointer: coarse)';

export type DeviceLayout = 'phone' | 'tablet' | 'desktop';
export function deviceLayout(): DeviceLayout {
  if (isMobile) {
    // The short screen edge keeps a rotated phone in phone mode. Window width
    // separately accommodates split screen and resizable Android windows.
    const shortest = Math.min(screen.width, screen.height);
    return shortest >= 600 && innerWidth >= 600 ? 'tablet' : 'phone';
  }
  return matchMedia(PHONE_QUERY).matches ? 'phone' : 'desktop';
}

export function useDeviceLayout() {
  const [layout, setLayout] = useState(deviceLayout);
  useEffect(() => {
    const media = matchMedia(PHONE_QUERY), update = () => setLayout(deviceLayout());
    window.addEventListener('resize', update); media.addEventListener('change', update);
    screen.orientation?.addEventListener('change', update);
    return () => { window.removeEventListener('resize', update); media.removeEventListener('change', update); screen.orientation?.removeEventListener('change', update); };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.layout = layout;
    root.toggleAttribute('data-tablet', layout === 'tablet');
    root.toggleAttribute('data-phone', layout === 'phone');
    root.toggleAttribute('data-touch', layout !== 'desktop');
    const viewport = window.visualViewport;
    const update = () => {
      root.style.setProperty('--visible-height', `${viewport?.height ?? innerHeight}px`);
      root.style.setProperty('--visible-top', `${viewport?.offsetTop ?? 0}px`);
    };
    update(); viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update);
    return () => { viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); };
  }, [layout]);
  useEffect(() => {
    if (!isNative || !isAndroid) return;
    let alive = true, request = 0;
    const update = () => {
      const current = ++request;
      void invoke<{ bottom: number }>('android_safe_area').then(insets => {
        if (alive && current === request && Number.isFinite(insets.bottom)) document.documentElement.style.setProperty('--native-safe-bottom', `${Math.max(0, insets.bottom)}px`);
      }).catch(() => {});
    };
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.addEventListener('folio:system-bars-changed', update);
    return () => { alive = false; window.removeEventListener('resize', update); window.visualViewport?.removeEventListener('resize', update); window.removeEventListener('folio:system-bars-changed', update); };
  }, []);
  return layout;
}

export function visibleBounds() {
  const viewport = window.visualViewport, styles = getComputedStyle(document.documentElement);
  const safe = (edge: string) => parseFloat(styles.getPropertyValue(`--phone-safe-${edge}`)) || 0;
  const left = (viewport?.offsetLeft || 0) + safe('left'), top = (viewport?.offsetTop || 0) + safe('top');
  return { left, top, right: (viewport?.offsetLeft || 0) + (viewport?.width || innerWidth) - safe('right'), bottom: (viewport?.offsetTop || 0) + (viewport?.height || innerHeight) - safe('bottom') };
}

export function usePhoneLayout() { return useDeviceLayout() === 'phone'; }
