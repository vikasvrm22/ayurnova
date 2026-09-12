document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("change-password-btn");
  if (!btn) return;

  btn.addEventListener("click", () => {
    const backdrop = document.createElement("div");
    backdrop.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:998;";
    backdrop.innerHTML = `
      <div style="background:#fff;border-radius:10px;padding:22px;width:340px;">
        <h3 style="margin-top:0;">Change Password</h3>
        <div class="form-field"><label>Current Password</label><input type="password" id="cp-current"></div>
        <div class="form-field" style="margin-top:8px;"><label>New Password</label><input type="password" id="cp-new"></div>
        <div class="form-field" style="margin-top:8px;"><label>Confirm New Password</label><input type="password" id="cp-confirm"></div>
        <div id="cp-error" style="color:#b91c1c; font-size:12px; margin-top:8px; min-height:14px;"></div>
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:14px;">
          <button class="btn btn-outline" id="cp-cancel">Cancel</button>
          <button class="btn btn-primary" id="cp-save">Update Password</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.querySelector("#cp-cancel").onclick = () => backdrop.remove();
    backdrop.querySelector("#cp-save").onclick = async () => {
      const errEl = backdrop.querySelector("#cp-error");
      errEl.textContent = "";
      const current = backdrop.querySelector("#cp-current").value;
      const next = backdrop.querySelector("#cp-new").value;
      const confirm = backdrop.querySelector("#cp-confirm").value;
      if (next !== confirm) { errEl.textContent = "New passwords do not match."; return; }
      try {
        await Api.post("/auth/change-password", { currentPassword: current, newPassword: next });
        Toast.show("Password updated", "success");
        backdrop.remove();
      } catch (e) {
        errEl.textContent = e.message;
      }
    };
  });
});
