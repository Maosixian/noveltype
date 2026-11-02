export function effectiveMotion(preference, systemReduced) {
  if (preference === 'off') return 'off';
  return preference === 'reduced' || systemReduced ? 'reduced' : 'full';
}

if (typeof document !== 'undefined') {
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const select = document.getElementById('motion-preference');
  const dialog = document.getElementById('appearance-dialog');
  let preference = 'full';
  try { preference = localStorage.getItem('noveltype-motion') || 'full'; } catch {}
  if (!['full', 'reduced', 'off'].includes(preference)) preference = 'full';
  select.value = preference;
  function apply() {
    const motion = effectiveMotion(preference, media.matches);
    document.documentElement.dataset.motion = motion;
    document.getElementById('motion-system-note').hidden = !media.matches;
    window.dispatchEvent(new CustomEvent('noveltype:motion-change', { detail: { motion } }));
  }
  select.addEventListener('change', () => {
    preference = select.value;
    try { localStorage.setItem('noveltype-motion', preference); } catch {}
    apply();
  });
  media.addEventListener('change', apply);
  document.getElementById('open-appearance').addEventListener('click', () => {
    // A dialog is a deliberate pause boundary, including for keyboard-only users.
    window.dispatchEvent(new CustomEvent('noveltype:appearance-open'));
    dialog.showModal();
  });
  document.getElementById('appearance-close').addEventListener('click', () => dialog.close());
  apply();
}
