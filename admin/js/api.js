window.Api = (function () {
  function token() { return localStorage.getItem("ayur_admin_token"); }

  async function request(method, path, body, isFormData) {
    const headers = { ...(token() ? { Authorization: `Bearer ${token()}` } : {}) };
    if (!isFormData) headers["Content-Type"] = "application/json";

    const resp = await fetch(`/api/admin${path}`, {
      method,
      headers,
      body: body !== undefined ? (isFormData ? body : JSON.stringify(body)) : undefined,
    });

    // The login endpoint itself returns 401 for "invalid credentials" - a
    // distinct meaning from "your existing bearer token is invalid/expired".
    // It never carries a token (the user isn't logged in yet), so it must
    // never be treated as a session-expiry event or have its real error
    // message (e.g. "Invalid credentials") replaced below.
    if (resp.status === 401 && path !== "/auth/login") {
      localStorage.removeItem("ayur_admin_token");
      localStorage.removeItem("ayur_admin_user");
      if (!location.pathname.endsWith("login.html")) location.href = "login.html";
      throw new Error("Session expired");
    }

    const isJson = (resp.headers.get("content-type") || "").includes("application/json");
    const data = isJson ? await resp.json() : await resp.text();
    if (!resp.ok) {
      const err = new Error((data && data.error) || "Request failed");
      err.fields = data && data.fields;
      throw err;
    }
    return data;
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    postForm: (path, formData) => request("POST", path, formData, true),
    put: (path, body) => request("PUT", path, body),
    del: (path) => request("DELETE", path),
    currentUser: () => JSON.parse(localStorage.getItem("ayur_admin_user") || "null"),
    setSession: (t, user) => {
      localStorage.setItem("ayur_admin_token", t);
      localStorage.setItem("ayur_admin_user", JSON.stringify(user));
    },
    clearSession: () => {
      localStorage.removeItem("ayur_admin_token");
      localStorage.removeItem("ayur_admin_user");
    },
  };
})();

window.Toast = (function () {
  let timer = null;
  return {
    show(message, type = "success") {
      let el = document.getElementById("toast");
      if (!el) {
        el = document.createElement("div");
        el.id = "toast";
        document.body.appendChild(el);
      }
      el.textContent = message;
      el.className = `toast-msg ${type}`;
      el.style.cssText = `position:fixed;top:18px;right:18px;padding:12px 18px;border-radius:8px;color:#fff;font-size:13px;z-index:999;background:${type === "error" ? "#b91c1c" : "#0e7a33"};`;
      clearTimeout(timer);
      timer = setTimeout(() => el.remove(), 3500);
    },
  };
})();

/** Include at the top of every admin page except login.html/complete-setup.html. */
function requireAdminAuth() {
  if (!localStorage.getItem("ayur_admin_token")) {
    location.href = "login.html";
    return false;
  }
  const user = Api.currentUser();
  const nameEl = document.querySelector(".sidebar-user .name");
  const roleEl = document.querySelector(".sidebar-user .role-badge");
  if (nameEl && user) nameEl.textContent = user.name;
  if (roleEl && user) roleEl.textContent = user.role;

  const topbarName = document.getElementById("topbar-name");
  const topbarRole = document.getElementById("topbar-role");
  const topbarAvatar = document.getElementById("topbar-avatar");
  const welcomeHeading = document.getElementById("welcome-heading");
  if (user) {
    if (topbarName) topbarName.textContent = user.name;
    if (topbarRole) topbarRole.textContent = user.role;
    if (topbarAvatar) topbarAvatar.textContent = (user.name || "?").trim().slice(0, 1).toUpperCase();
    if (welcomeHeading) welcomeHeading.textContent = `Welcome back, ${(user.name || "Admin").split(" ")[0]}!`;
  }
  return true;
}
