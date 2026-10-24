// localStorage can throw (private mode, blocked storage); the app must work without it.
export function load(key: string): string | null {
  try {
    return localStorage.getItem(`checksum.${key}`);
  } catch {
    return null;
  }
}

export function save(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(`checksum.${key}`);
    else localStorage.setItem(`checksum.${key}`, value);
  } catch {
    /* preference just won't persist */
  }
}
