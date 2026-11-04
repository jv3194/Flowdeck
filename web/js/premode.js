// Runs before the first paint so a light theme doesn't flash dark while the app loads.
try {
  const m = localStorage.getItem('flowdeck-mode');
  if (m === 'light' || m === 'dark') document.documentElement.dataset.mode = m;
} catch {
  /* storage unavailable: the app sets the mode as soon as it starts */
}
