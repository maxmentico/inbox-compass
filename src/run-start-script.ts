// The main Run now action opens a lightweight CSRF-validated page immediately; that page
// starts the real job asynchronously in the browser and navigates to its persistent progress URL.
// The standard POST remains authoritative for locks, account snapshots, and persistence.

export const RUN_START_SCRIPT = `(function () {
  "use strict";
  var preflight = document.getElementById("run-start-form");
  if (preflight && window.fetch && window.FormData) {
    var status = document.getElementById("run-start-status");
    var button = preflight.querySelector('button[type="submit"]');
    var busy = false;
    if (button) button.hidden = true;

    function start(event) {
      if (event) event.preventDefault();
      if (busy) return;
      busy = true;
      if (button) button.hidden = true;
      if (status) status.textContent = "Starting your mailboxes…";
      fetch(preflight.action, {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        body: new FormData(preflight)
      }).then(function (res) {
        var type = res.headers.get("content-type") || "";
        if (res.redirected || type.indexOf("application/json") !== 0) throw new Error("Your session expired. Reload and sign in.");
        return res.json().then(function (data) { return { res: res, data: data }; });
      }).then(function (out) {
        var url = out.data && out.data.url;
        if ((out.res.ok || out.res.status === 409) && typeof url === "string" &&
            url.indexOf("/app/run/") === 0 && url.length === 31 &&
            /^[A-Za-z0-9_-]{22}$/.test(url.slice(9))) {
          window.location.replace(url);
          return;
        }
        throw new Error("Could not start the run. Please try again.");
      }).catch(function (error) {
        busy = false;
        if (button) button.hidden = false;
        if (status) status.textContent = error.message || "Could not start the run. Please try again.";
      });
    }

    preflight.addEventListener("submit", start);
    start();
    return;
  }

  // Other forms (including test runs) retain their ordinary POST/redirect flow.
  Array.prototype.forEach.call(document.querySelectorAll('form[action="/app/run"], form[action="/app/run/prepare"]'), function (form) {
    form.addEventListener("submit", function (event) {
      if (event.defaultPrevented || form.dataset.starting === "1") return;
      form.dataset.starting = "1";
      var button = event.submitter || form.querySelector('button[type="submit"]');
      if (button) {
        button.textContent = "Starting…";
        button.setAttribute("aria-busy", "true");
      }
      var note = document.createElement("span");
      note.setAttribute("role", "status");
      note.className = "note run-start-status";
      note.textContent = "Opening run progress…";
      form.appendChild(note);
    });
  });
})();`;

/** Both scripts are admitted by their exact SHA-256 hashes in the CSP. */
export const RUN_START_SCRIPT_HASH = "sha256-Z2LQOXh+ZHMUhvfF9oFY5z2TRp4RLXK5QZA3DPWYd5A=";
