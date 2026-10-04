import { useEffect, useState } from 'react';

// A phone keeps the same controls when rotated. A narrow desktop window can
// use the compact layout too, without changing the platform's file commands.
const PHONE_QUERY = '(max-width: 760px), (max-width: 1024px) and (pointer: coarse)';

export function visibleBounds() {
  const viewport = window.visualViewport, styles = getComputedStyle(document.documentElement);
  const safe = (edge: string) => parseFloat(styles.getPropertyValue(`--phone-safe-${edge}`)) || 0;
  const left = (viewport?.offsetLeft || 0) + safe('left'), top = (viewport?.offsetTop || 0) + safe('top');
  return { left, top, right: (viewport?.offsetLeft || 0) + (viewport?.width || innerWidth) - safe('right'), bottom: (viewport?.offsetTop || 0) + (viewport?.height || innerHeight) - safe('bottom') };
}

export function usePhoneLayout() {
  const [phone, setPhone] = useState(() => matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const media = matchMedia(PHONE_QUERY), update = () => setPhone(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!phone) return;
    document.documentElement.dataset.phone = 'true';
    const viewport = window.visualViewport;
    const update = () => {
      document.documentElement.style.setProperty('--visible-height', `${viewport?.height ?? innerHeight}px`);
      document.documentElement.style.setProperty('--visible-top', `${viewport?.offsetTop ?? 0}px`);
    };
    update(); viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      delete document.documentElement.dataset.phone;
      document.documentElement.style.removeProperty('--visible-height'); document.documentElement.style.removeProperty('--visible-top');
      viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update);
    };
  }, [phone]);
  return phone;
}
