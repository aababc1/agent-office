// Deployment config.
//   'worker' = this page is served by the Agent Office Worker (login, API and live updates come from it)
//   'github' = static host + the person's own GitHub token (no Worker)
//   'static' = read ./data/ next to this page (local use)
window.OFFICE_MODE = 'worker';
window.OFFICE_POLL_MS = 30000;
