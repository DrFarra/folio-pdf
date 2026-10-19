/** A stored preference, or `fallback` when there is none or storage is unavailable. */
export const preference = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
